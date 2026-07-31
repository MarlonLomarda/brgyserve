const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { CHARGE_STATUS, PAYMENT_METHOD } = require('../constants/charges');
const { logSmsNotification } = require('../services/smsNotification');

const router = express.Router();

// Payment verification is the Treasurer's job, with the Secretary supporting
// (both roles allowed, per the Stage 4 design).
router.use(authenticate, requireRole('treasurer', 'secretary'));

// Charges link to their source per type: DOCUMENT via document_requests,
// RENTAL via rental_requests (stage 4 of Facility Rentals) — whichever is
// null for a given row simply embeds as null. The payer's profile name covers
// rentals (no resident_records link on rental_requests).
const CHARGE_FIELDS = `
  charge_id, charge_type, amount, status, created_at,
  declared_method, declared_reference, declared_at,
  paymongo_session_id, paymongo_payment_id,
  payer:users ( user_id, username, email,
    profiles ( first_name, middle_name, last_name, suffix ) ),
  document_requests ( request_id, purpose, status,
    document_types ( name ),
    resident_records ( resident_id, first_name, middle_name, last_name, suffix, contact_number ) ),
  rental_requests ( request_id, quantity_requested, start_datetime, end_datetime, status,
    rental_items ( name ) )
`;

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
    .select(`charge_id, amount, status, declared_method, declared_reference,
      document_requests ( request_id, document_types ( name ), resident_records ( contact_number ) ),
      rental_requests ( request_id, rental_items ( name ) ),
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
  const isRental = !!charge.rental_requests;
  const contact =
    charge.document_requests?.resident_records?.contact_number ||
    charge.payer?.profiles?.resident_records?.contact_number;
  logSmsNotification(
    contact,
    isRental
      ? `BrgyServe: your payment of ₱${Number(charge.amount).toFixed(2)} for the ${charge.rental_requests?.rental_items?.name || 'rental'} booking has been received and verified.`
      : `BrgyServe: your payment of ₱${Number(charge.amount).toFixed(2)} for the ${charge.document_requests?.document_types?.name || 'document'} request has been received and verified. Please wait for the release notice.`
  );

  res.json({ message: 'Payment recorded — charge marked PAID', payment });
});

module.exports = router;
