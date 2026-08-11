const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD } = require('../constants/charges');
const { notify } = require('../services/notifications');
const { RELATED_TYPE } = require('../constants/notifications');
const {
  createCheckoutSession,
  retrieveCheckoutSession,
  paidPaymentOf,
  verifyWebhookSignature,
  toCentavos,
  isTestMode,
} = require('../services/paymongo');

const router = express.Router();

// The GCash gateway is an ADDITIONAL option on top of the manual flow, not a
// replacement: a resident can still pay cash at the barangay hall, or declare
// a GCash reference for the Treasurer to verify. Nothing here changes the
// charges/payments model — a gateway payment produces exactly the same kind of
// `payments` row a verified manual payment does, so it lands on the Treasurer's
// normal screen. The only difference is received_by_user_id, which stays NULL
// because no staff member recorded it (Table 16: "null for online automated
// payments").

const CHARGE_FIELDS = `
  charge_id, charge_type, amount, status, user_id,
  paymongo_session_id, paymongo_payment_id,
  document_requests ( request_id, document_types ( name ),
    resident_records ( contact_number ) ),
  rental_requests ( request_id, rental_items ( name ) ),
  payer:users ( profiles ( resident_records ( contact_number ) ) )
`;

const embedded = (value) => (Array.isArray(value) ? value[0] : value);

// What the resident sees on PayMongo's hosted page.
function chargeLabel(charge) {
  const doc = embedded(charge.document_requests);
  const rental = embedded(charge.rental_requests);
  if (doc?.document_types?.name) return doc.document_types.name;
  if (rental?.rental_items?.name) return `${rental.rental_items.name} rental`;
  if (charge.charge_type === CHARGE_TYPE.RENTAL) return 'Facility rental';
  if (charge.charge_type === CHARGE_TYPE.FINE) return 'Barangay fine';
  return 'Barangay fee';
}

function contactFor(charge) {
  // Documents carry the resident record directly; rentals only reach it
  // through the paying user's profile (same lookup charges.js uses).
  return (
    embedded(charge.document_requests)?.resident_records?.contact_number ||
    charge.payer?.profiles?.resident_records?.contact_number ||
    null
  );
}

const frontendOrigin = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

// Every outcome settlePaidCharge can return. Named in one place so the two
// caller-facing message maps below cannot drift from it or from each other —
// a new outcome without wording would otherwise fall back to a message that
// misstates what happened (which is exactly the bug this replaced).
const SETTLE_OUTCOME = {
  RECORDED: 'recorded',
  ALREADY_RECORDED: 'already_recorded',
  ALREADY_PROCESSED: 'already_processed',
  ALREADY_PAID_MANUALLY: 'already_paid_manually',
  VOID: 'void',
  UNDERPAID: 'underpaid',
};

// Wording for the CHECKOUT-RESUME interlock (see the checkout route). These
// must never claim the charge is settled when it is not: `underpaid` and
// `void` mean the money did NOT get applied, and telling a resident otherwise
// would send them away believing they had paid.
const RESUME_MESSAGES = {
  [SETTLE_OUTCOME.RECORDED]: 'Your earlier GCash payment has been confirmed — this charge is now paid.',
  [SETTLE_OUTCOME.ALREADY_RECORDED]: 'This charge has already been paid.',
  [SETTLE_OUTCOME.ALREADY_PROCESSED]: 'This charge has just been settled.',
  [SETTLE_OUTCOME.ALREADY_PAID_MANUALLY]: 'This charge has already been paid.',
  [SETTLE_OUTCOME.VOID]:
    'This charge has been voided, so your GCash payment could not be applied to it — please contact the Barangay Office.',
  [SETTLE_OUTCOME.UNDERPAID]:
    'PayMongo reports a smaller amount than this charge, so it has NOT been marked paid — please contact the Barangay Office.',
};

// Wording for the Treasurer's reconciliation action.
const RECONCILE_MESSAGES = {
  [SETTLE_OUTCOME.RECORDED]: 'Payment confirmed with PayMongo and recorded — the charge is now paid.',
  [SETTLE_OUTCOME.ALREADY_RECORDED]: 'This payment was already recorded. Nothing changed.',
  [SETTLE_OUTCOME.ALREADY_PROCESSED]: 'This charge was settled by another process just now. Nothing changed.',
  [SETTLE_OUTCOME.ALREADY_PAID_MANUALLY]:
    'This charge was already marked paid manually — no second payment was recorded.',
  [SETTLE_OUTCOME.VOID]: 'This charge is void, so the payment was not applied. Please review it manually.',
  [SETTLE_OUTCOME.UNDERPAID]:
    'PayMongo reports a smaller amount than the charge — not marked paid. Please review it manually.',
};

// ---------------------------------------------------------------------------
// Recording a confirmed online payment.
//
// ONE implementation behind ALL THREE triggers that can settle a charge — the
// signature-verified webhook, the Treasurer's reconciliation action, and the
// checkout-resume interlock — so a charge is settled identically however the
// news arrives, and adding a trigger can never introduce a second way to
// double-record.
//
// IDEMPOTENCY, in three layers:
//   1. an early no-op if this exact PayMongo payment is already recorded;
//   2. a status-guarded claim (UPDATE ... WHERE status = 'UNPAID') — the same
//      pattern manual verification uses, so concurrent deliveries serialise and
//      only one can win;
//   3. UNIQUE(charges.paymongo_payment_id) as the database backstop, which
//      turns any duplicate that slips past (2) into a 23505 we treat as
//      "already recorded" rather than a second payments row.
// ---------------------------------------------------------------------------
async function settlePaidCharge(charge, payment, { source }) {
  if (charge.paymongo_payment_id === payment.paymentId && charge.status === CHARGE_STATUS.PAID) {
    return { outcome: SETTLE_OUTCOME.ALREADY_RECORDED };
  }
  if (charge.status === CHARGE_STATUS.VOID) return { outcome: SETTLE_OUTCOME.VOID };
  if (charge.status === CHARGE_STATUS.PAID) {
    // Someone (probably the Treasurer, manually) already settled this. Do NOT
    // write a second payment — the money is recorded once either way.
    return { outcome: SETTLE_OUTCOME.ALREADY_PAID_MANUALLY };
  }

  const expected = toCentavos(charge.amount);
  if (payment.amountCentavos < expected) {
    console.warn(
      `[paymongo] charge ${charge.charge_id} NOT marked paid — received ${payment.amountCentavos} centavos, expected ${expected}`
    );
    return { outcome: SETTLE_OUTCOME.UNDERPAID, expected, received: payment.amountCentavos };
  }

  const { data: claimed, error: claimError } = await supabase
    .from('charges')
    .update({ status: CHARGE_STATUS.PAID, paymongo_payment_id: payment.paymentId })
    .eq('charge_id', charge.charge_id)
    .eq('status', CHARGE_STATUS.UNPAID)
    .select('charge_id')
    .maybeSingle();
  if (claimError) {
    // Unique violation on paymongo_payment_id: this payment is already
    // recorded elsewhere, so a duplicate delivery — not an error.
    if (claimError.code === '23505') return { outcome: SETTLE_OUTCOME.ALREADY_RECORDED };
    throw new Error(`Failed to mark charge paid: ${claimError.message}`);
  }
  if (!claimed) return { outcome: SETTLE_OUTCOME.ALREADY_PROCESSED };

  const { data: paymentRow, error: payError } = await supabase
    .from('payments')
    .insert({
      charge_id: charge.charge_id,
      amount: payment.amountPesos,
      payment_method: PAYMENT_METHOD.GCASH,
      reference_no: payment.paymentId, // the PayMongo payment id is the reference
      received_by_user_id: null, // automated — no staff member received this
      created_at: new Date().toISOString(),
    })
    .select('payment_id, charge_id, amount, payment_method, reference_no, created_at')
    .single();
  if (payError) {
    await supabase
      .from('charges')
      .update({ status: CHARGE_STATUS.UNPAID, paymongo_payment_id: null })
      .eq('charge_id', charge.charge_id);
    throw new Error(`Charge reverted to UNPAID — failed to record payment: ${payError.message}`);
  }

  // Recorded, not sent (SMS_MODE=SIMULATED). Deliberately after the payment
  // row is committed: settlePaidCharge is the single funnel all three settle
  // triggers pass through, and notify() cannot throw, so a notification
  // problem can never strand a charge that PayMongo has already collected.
  const isRental = !!embedded(charge.rental_requests);
  await notify({
    userId: charge.user_id ?? null,
    householdId: charge.household_id ?? null,
    destination: contactFor(charge),
    relatedType: RELATED_TYPE.CHARGE,
    relatedTo: charge.charge_id,
    message: isRental
      ? `BrgyServe: your GCash payment of PHP ${Number(charge.amount).toFixed(2)} for the ${chargeLabel(charge)} booking has been received.`
      : `BrgyServe: your GCash payment of PHP ${Number(charge.amount).toFixed(2)} for the ${chargeLabel(charge)} request has been received. Please wait for the release notice.`,
  });
  console.log(`[paymongo] charge ${charge.charge_id} PAID via ${source} (payment ${payment.paymentId})`);

  return { outcome: SETTLE_OUTCOME.RECORDED, payment: paymentRow };
}

const loadCharge = async (chargeId) => {
  const { data, error } = await supabase
    .from('charges')
    .select(CHARGE_FIELDS)
    .eq('charge_id', chargeId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load charge: ${error.message}`);
  return data;
};

// ---------------------------------------------------------------------------
// WEBHOOK — unauthenticated by nature (PayMongo is not logged in), so the
// SIGNATURE IS THE AUTHENTICATION. Nothing in the payload is trusted until it
// verifies, otherwise anyone who guessed this url could mark charges paid for
// free.
//
// Mounted in server.js with a RAW body parser and BEFORE express.json(),
// because the signature is computed over the exact bytes PayMongo sent —
// re-serialising parsed JSON would break verification on every genuine call.
// ---------------------------------------------------------------------------
async function webhookHandler(req, res) {
  const verdict = verifyWebhookSignature(
    req.body,
    req.headers['paymongo-signature'],
    process.env.PAYMONGO_WEBHOOK_SECRET
  );
  if (!verdict.ok) {
    console.warn(`[paymongo] webhook REJECTED — ${verdict.reason}`);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const attributes = event?.data?.attributes;
  const eventType = attributes?.type;

  // Test keys must never act on live events, or the reverse.
  const expectLivemode = !isTestMode();
  if (typeof attributes?.livemode === 'boolean' && attributes.livemode !== expectLivemode) {
    console.warn(
      `[paymongo] webhook ignored — event livemode=${attributes.livemode} but the configured keys expect livemode=${expectLivemode}`
    );
    return res.json({ received: true, ignored: 'livemode mismatch' });
  }

  // Only one event is subscribed, but be explicit rather than assume.
  if (eventType !== 'checkout_session.payment.paid') {
    return res.json({ received: true, ignored: eventType || 'unknown event' });
  }

  const session = attributes.data;
  const payment = paidPaymentOf(session);
  // The charge is resolved from the session's metadata rather than from a
  // stored session id, so a late callback for an abandoned-then-recreated
  // checkout still lands on the right charge.
  const chargeId = Number(session?.attributes?.metadata?.charge_id);

  if (!payment || !Number.isInteger(chargeId)) {
    console.warn(`[paymongo] webhook for session ${session?.id} had no paid payment or no charge_id metadata`);
    return res.json({ received: true, ignored: 'nothing actionable in payload' });
  }

  const charge = await loadCharge(chargeId);
  if (!charge) {
    console.warn(`[paymongo] webhook referenced charge ${chargeId}, which does not exist`);
    return res.json({ received: true, ignored: 'charge not found' });
  }

  const result = await settlePaidCharge(charge, payment, { source: 'webhook' });
  // Always 2xx once the signature is valid — retrying will not change any of
  // these outcomes, and PayMongo disables endpoints that keep failing.
  return res.json({ received: true, outcome: result.outcome });
}

// ---------------------------------------------------------------------------
// Everything below is authenticated.
// ---------------------------------------------------------------------------
router.use(authenticate);

// POST /api/payments/gcash/checkout — start a hosted GCash checkout for one
// unpaid charge. Only the resident who owns the charge may start it.
router.post('/gcash/checkout', async (req, res) => {
  const chargeId = Number(req.body?.charge_id);
  if (!Number.isInteger(chargeId)) {
    return res.status(400).json({ error: 'A valid charge_id is required' });
  }

  const charge = await loadCharge(chargeId);
  // Same 404-not-403 treatment the resident routes use: someone else's charge
  // simply does not exist as far as this user is concerned.
  if (!charge || charge.user_id !== req.user.user_id) {
    return res.status(404).json({ error: 'Charge not found' });
  }
  if (charge.status === CHARGE_STATUS.PAID) {
    return res.status(409).json({ error: 'This charge is already paid' });
  }
  if (charge.status === CHARGE_STATUS.VOID) {
    return res.status(409).json({ error: 'This charge is void and cannot be paid' });
  }
  if (Number(charge.amount) <= 0) {
    return res.status(409).json({ error: 'There is nothing to pay for this charge' });
  }

  const label = chargeLabel(charge);
  const successUrl = `${frontendOrigin()}/resident/payment-result?charge=${chargeId}&result=success`;
  const cancelUrl = `${frontendOrigin()}/resident/payment-result?charge=${chargeId}&result=cancelled`;

  // Reuse an in-flight session instead of opening a second one for the same
  // charge.
  if (charge.paymongo_session_id) {
    try {
      const existing = await retrieveCheckoutSession(charge.paymongo_session_id);
      const paid = paidPaymentOf(existing);
      if (paid) {
        // CHECKOUT-RESUME INTERLOCK — the third trigger that can settle a
        // charge. PayMongo says this charge was already paid, so we must not
        // hand back a checkout page: the resident would pay a second time for
        // something already collected. Settling here rather than only refusing
        // means we record what we have just proven true, instead of knowingly
        // holding the charge UNPAID until a webhook that may never arrive.
        // It runs through settlePaidCharge like every other trigger, so it
        // cannot double-record.
        const result = await settlePaidCharge(charge, paid, { source: 'checkout-resume' });
        return res.status(409).json({
          error:
            RESUME_MESSAGES[result.outcome] ||
            'This charge cannot be paid online right now — please contact the Barangay Office.',
          outcome: result.outcome,
        });
      }
      const url = existing?.attributes?.checkout_url;
      if (url && existing?.attributes?.status !== 'expired') {
        return res.json({ checkout_url: url, session_id: existing.id, resumed: true });
      }
    } catch {
      // Unusable (expired or gone) — fall through and create a fresh one.
    }
  }

  let session;
  try {
    session = await createCheckoutSession({
      amount: charge.amount,
      description: `${label} — Barangay Ubujan`,
      lineItemName: label,
      referenceNumber: `CHG-${chargeId}`,
      successUrl,
      cancelUrl,
      // How the webhook finds its way back to this charge.
      metadata: { charge_id: String(chargeId), charge_type: charge.charge_type },
    });
  } catch (e) {
    if (e.paymongo) return res.status(502).json({ error: `GCash checkout could not be started: ${e.message}` });
    throw e;
  }

  const { error: saveError } = await supabase
    .from('charges')
    .update({ paymongo_session_id: session.id })
    .eq('charge_id', chargeId)
    .eq('status', CHARGE_STATUS.UNPAID);
  if (saveError) {
    throw new Error(`Failed to store the checkout session: ${saveError.message}`);
  }

  res.json({ checkout_url: session.attributes.checkout_url, session_id: session.id, resumed: false });
});

// GET /api/payments/gcash/status/:chargeId — what the resident's return page
// polls. The redirect from PayMongo is NOT proof of payment; this reports the
// charge's real state, which only the verified webhook (or reconciliation)
// can change.
router.get('/gcash/status/:chargeId', async (req, res) => {
  const chargeId = Number(req.params.chargeId);
  if (!Number.isInteger(chargeId)) {
    return res.status(400).json({ error: 'Invalid charge id' });
  }
  const charge = await loadCharge(chargeId);
  if (!charge || charge.user_id !== req.user.user_id) {
    return res.status(404).json({ error: 'Charge not found' });
  }
  res.json({
    charge_id: charge.charge_id,
    status: charge.status,
    amount: charge.amount,
    label: chargeLabel(charge),
    paid_online: !!charge.paymongo_payment_id,
  });
});

// POST /api/payments/gcash/reconcile/:chargeId — Treasurer/Secretary safety
// net. PayMongo disables a webhook endpoint after repeated delivery failures
// and never replays the events missed in the meantime, so a tunnel or server
// outage could otherwise leave a genuinely paid charge stuck UNPAID forever.
// This re-checks the charge's checkout session directly and settles it through
// the SAME code path the webhook uses.
router.post('/gcash/reconcile/:chargeId', requireRole('treasurer', 'secretary'), async (req, res) => {
  const chargeId = Number(req.params.chargeId);
  if (!Number.isInteger(chargeId)) {
    return res.status(400).json({ error: 'Invalid charge id' });
  }

  const charge = await loadCharge(chargeId);
  if (!charge) return res.status(404).json({ error: 'Charge not found' });
  if (!charge.paymongo_session_id) {
    return res.status(409).json({ error: 'No online checkout was ever started for this charge' });
  }

  let session;
  try {
    session = await retrieveCheckoutSession(charge.paymongo_session_id);
  } catch (e) {
    return res.status(502).json({ error: `Could not reach PayMongo: ${e.message}` });
  }

  const payment = paidPaymentOf(session);
  if (!payment) {
    return res.json({
      settled: false,
      message: 'PayMongo has no completed payment for this charge yet — it remains unpaid.',
    });
  }

  const result = await settlePaidCharge(charge, payment, { source: `reconcile by ${req.user.username}` });
  res.json({
    settled: result.outcome === SETTLE_OUTCOME.RECORDED,
    outcome: result.outcome,
    message: RECONCILE_MESSAGES[result.outcome] || 'Checked with PayMongo.',
    payment: result.payment || null,
  });
});

// SETTLE_OUTCOME and the two message maps are exported for the regression
// test, which asserts every outcome has accurate wording in both.
module.exports = { router, webhookHandler, SETTLE_OUTCOME, RESUME_MESSAGES, RECONCILE_MESSAGES };
