const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD } = require('../constants/charges');
const { logSmsNotification } = require('../services/smsNotification');

const router = express.Router();

// Payment verification is the Treasurer's job, with the Secretary supporting
// (both roles allowed, per the Stage 4 design).
router.use(authenticate, requireRole('treasurer', 'secretary'));

// Charges link to their source per type: DOCUMENT via document_requests,
// RENTAL via rental_requests (stage 4 of Facility Rentals), FINE via
// event_id + household_id (Events stage 3b) — whichever is null for a given
// row simply embeds as null. The payer's profile name covers rentals (no
// resident_records link on rental_requests).
//
// A FINE may have NO payer account at all: it is owed by a household, and
// most households have no linked account (charges.user_id is nullable for
// exactly this reason). Its household and event are embedded so the queue can
// still say who owes what; the head's name is resolved separately below.
const CHARGE_FIELDS = `
  charge_id, charge_type, amount, status, created_at,
  declared_method, declared_reference, declared_at,
  paymongo_session_id, paymongo_payment_id, household_id,
  payer:users ( user_id, username, email,
    profiles ( first_name, middle_name, last_name, suffix ) ),
  document_requests ( request_id, purpose, status,
    document_types ( name ),
    resident_records ( resident_id, first_name, middle_name, last_name, suffix, contact_number ) ),
  rental_requests ( request_id, quantity_requested, start_datetime, end_datetime, status,
    rental_items ( name ) ),
  events ( event_id, title, start_datetime, end_datetime ),
  household_records ( household_id, address )
`;

// The head's name lives two joins away from a charge (household_members ->
// resident_records) and cannot be embedded with a "current head only" filter,
// so it is resolved in one extra query over the charges actually being
// returned. Mutates the rows in place, adding household_records.head_name.
async function attachHouseholdHeads(charges) {
  const ids = [...new Set(charges.filter((c) => c.household_id).map((c) => c.household_id))];
  if (!ids.length) return;

  const { data: heads, error } = await supabase
    .from('household_members')
    .select('household_id, resident_records ( first_name, middle_name, last_name, suffix, contact_number )')
    .eq('role', 'Head')
    .is('date_ended', null)
    .in('household_id', ids);
  if (error) throw new Error(`Failed to load household heads: ${error.message}`);

  const byHousehold = new Map(
    (heads || []).map((h) => [
      h.household_id,
      Array.isArray(h.resident_records) ? h.resident_records[0] : h.resident_records,
    ])
  );
  for (const c of charges) {
    if (!c.household_records) continue;
    const r = byHousehold.get(c.household_id);
    const name = r ? [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') : null;
    c.household_records.head_name = r?.suffix && name ? `${name}, ${r.suffix}` : name || null;
    c.household_records.head_contact = r?.contact_number || null;
  }
}

// GET /api/charges?status=UNPAID|PAID|VOID|all — defaults to UNPAID (the
// verification queue: plain unpaid charges plus those with a submitted-but-
// unverified GCash reference, which stay UNPAID until verified). Oldest
// first, so the queue is worked in billing order.
router.get('/', async (req, res) => {
  const status = String(req.query.status || CHARGE_STATUS.UNPAID).toUpperCase();

  let query = supabase
    .from('charges')
    .select(CHARGE_FIELDS)
    .order('created_at', { ascending: true });

  if (status !== 'ALL') {
    if (!Object.values(CHARGE_STATUS).includes(status)) {
      return res.status(400).json({
        error: `Unknown status '${status}' (expected UNPAID, PAID, VOID, or all)`,
      });
    }
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load charges: ${error.message}`);
  }
  await attachHouseholdHeads(data || []);
  res.json({ charges: data });
});

// POST /api/charges/:id/verify — record/verify a payment: create the payments
// row (the verified financial record, with the verifier in
// received_by_user_id) and mark the charge PAID. payment_method/reference_no
// default from the resident's declaration but the verifier can override
// (e.g. resident declared GCash but showed up with cash).
router.post('/:id/verify', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid charge id' });
  }

  const { data: charge, error: loadError } = await supabase
    .from('charges')
    .select(`charge_id, charge_type, amount, status, declared_method, declared_reference, household_id,
      document_requests ( request_id, document_types ( name ), resident_records ( contact_number ) ),
      rental_requests ( request_id, rental_items ( name ) ),
      events ( event_id, title ),
      payer:users ( profiles ( resident_records ( contact_number ) ) )`)
    .eq('charge_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load charge: ${loadError.message}`);
  }
  if (!charge) {
    return res.status(404).json({ error: 'Charge not found' });
  }
  if (charge.status === CHARGE_STATUS.PAID) {
    return res.status(409).json({ error: 'This charge is already paid' });
  }
  if (charge.status === CHARGE_STATUS.VOID) {
    return res.status(409).json({ error: 'This charge is void and cannot be paid' });
  }

  const method = String(req.body?.payment_method || charge.declared_method || PAYMENT_METHOD.ONSITE).toLowerCase();
  if (method !== PAYMENT_METHOD.ONSITE && method !== PAYMENT_METHOD.GCASH) {
    return res.status(400).json({ error: "payment_method must be 'onsite' or 'gcash'" });
  }
  const reference = String(req.body?.reference_no ?? charge.declared_reference ?? '').trim() || null;
  if (method === PAYMENT_METHOD.GCASH && !reference) {
    return res.status(400).json({ error: 'A GCash reference number is required to verify a GCash payment' });
  }

  // Claim the charge first (status-guarded, so concurrent verifiers can't
  // both win), then insert the payment; revert the claim if the insert fails.
  const { data: claimed, error: claimError } = await supabase
    .from('charges')
    .update({ status: CHARGE_STATUS.PAID })
    .eq('charge_id', id)
    .eq('status', CHARGE_STATUS.UNPAID)
    .select('charge_id')
    .maybeSingle();
  if (claimError) {
    throw new Error(`Failed to update charge: ${claimError.message}`);
  }
  if (!claimed) {
    return res.status(409).json({ error: 'Charge was already processed by someone else' });
  }

  const { data: payment, error: payError } = await supabase
    .from('payments')
    .insert({
      charge_id: id,
      amount: charge.amount,
      payment_method: method,
      reference_no: reference,
      received_by_user_id: req.user.user_id,
      created_at: new Date().toISOString(),
    })
    .select('payment_id, charge_id, amount, payment_method, reference_no, created_at')
    .single();
  if (payError) {
    await supabase.from('charges').update({ status: CHARGE_STATUS.UNPAID }).eq('charge_id', id);
    throw new Error(`Charge reverted to UNPAID — failed to record payment: ${payError.message}`);
  }

  // SMS hook — stub only (see services/smsNotification.js). The use cases
  // call for a confirmation SMS when payment status is updated. Wording and
  // contact source depend on what the charge is for.
  const peso = `₱${Number(charge.amount).toFixed(2)}`;
  let contact =
    charge.document_requests?.resident_records?.contact_number ||
    charge.payer?.profiles?.resident_records?.contact_number;
  let message;
  if (charge.charge_type === CHARGE_TYPE.FINE) {
    // A fine is owed by a household, which often has no account at all — so
    // the contact comes from the household's head, not from the payer link.
    if (!contact && charge.household_id) {
      const { data: head } = await supabase
        .from('household_members')
        .select('resident_records ( contact_number )')
        .eq('household_id', charge.household_id)
        .eq('role', 'Head')
        .is('date_ended', null)
        .maybeSingle();
      const r = Array.isArray(head?.resident_records) ? head.resident_records[0] : head?.resident_records;
      contact = r?.contact_number;
    }
    message = `BrgyServe: your payment of ${peso} for the attendance fine for "${charge.events?.title || 'a barangay activity'}" has been received and verified. Thank you.`;
  } else if (charge.rental_requests) {
    message = `BrgyServe: your payment of ${peso} for the ${charge.rental_requests?.rental_items?.name || 'rental'} booking has been received and verified.`;
  } else {
    message = `BrgyServe: your payment of ${peso} for the ${charge.document_requests?.document_types?.name || 'document'} request has been received and verified. Please wait for the release notice.`;
  }
  logSmsNotification(contact, message);

  res.json({ message: 'Payment recorded — charge marked PAID', payment });
});

module.exports = router;
