// PayMongo API client + webhook signature verification.
//
// Scope: GCash through PayMongo CHECKOUT SESSIONS — PayMongo hosts the payment
// page, so no card/e-wallet credentials ever touch BrgyServe. This is an
// ADDITIONAL payment option; the manual flow (cash onsite, or a resident-
// declared GCash reference verified by the Treasurer) is untouched and remains
// the fallback.
//
// PAYMONGO_SECRET_KEY is server-only: it is read from the environment here,
// never logged, and never sent to the frontend. The frontend only ever
// receives a checkout_url.
const crypto = require('crypto');

const API = 'https://api.paymongo.com/v1';

// PayMongo works in the smallest currency unit. Every amount crossing this
// boundary goes through these two helpers so a x100 error cannot creep in.
const toCentavos = (pesos) => Math.round(Number(pesos) * 100);
const toPesos = (centavos) => Number(centavos) / 100;

function secretKey() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new Error('PAYMONGO_SECRET_KEY is not configured');
  return key;
}

// True when the configured key is a test-mode key. Used to refuse webhook
// events whose livemode does not match the keys we are running with.
const isTestMode = () => String(process.env.PAYMONGO_SECRET_KEY || '').startsWith('sk_test_');

async function call(endpoint, init = {}) {
  const res = await fetch(API + endpoint, {
    ...init,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${secretKey()}:`).toString('base64'),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (res.status >= 300) {
    // Surface PayMongo's own wording (e.g. an amount below their minimum) —
    // it is more useful to the resident than a generic failure. Never include
    // anything key-related.
    const detail = (body?.errors || []).map((e) => e.detail).filter(Boolean).join('; ');
    const err = new Error(detail || `PayMongo request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.paymongo = true;
    throw err;
  }
  return body;
}

// Creates the hosted checkout page for one charge.
// `amount` is in PESOS here and converted once, at this boundary.
async function createCheckoutSession({ amount, description, lineItemName, referenceNumber, successUrl, cancelUrl, metadata }) {
  const body = await call('/checkout_sessions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        attributes: {
          // GCash only — this module is the GCash gateway. Adding other
          // methods later is a change here, not to the charges model.
          payment_method_types: ['gcash'],
          line_items: [
            {
              name: lineItemName,
              amount: toCentavos(amount),
              currency: 'PHP',
              quantity: 1,
            },
          ],
          description,
          reference_number: referenceNumber,
          success_url: successUrl,
          cancel_url: cancelUrl,
          send_email_receipt: false,
          show_description: true,
          show_line_items: true,
          metadata,
        },
      },
    }),
  });
  return body.data;
}

const retrieveCheckoutSession = (id) => call(`/checkout_sessions/${id}`).then((b) => b.data);

// Pulls the successful payment out of a checkout session resource, in the
// shape both the webhook and the Treasurer's reconciliation action need.
// Returns null when the session has not been paid.
function paidPaymentOf(session) {
  const payments = session?.attributes?.payments || [];
  const paid = payments.find((p) => p?.attributes?.status === 'paid');
  if (!paid) return null;
  return {
    paymentId: paid.id,
    amountCentavos: paid.attributes.amount,
    amountPesos: toPesos(paid.attributes.amount),
    currency: paid.attributes.currency,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification — the ONLY authentication this endpoint has.
//
// PayMongo sends:   Paymongo-Signature: t=<unix>,te=<test sig>,li=<live sig>
// The signed string is `${t}.${rawBody}` and the HMAC key is the WEBHOOK's own
// secret_key (PAYMONGO_WEBHOOK_SECRET), NOT PAYMONGO_SECRET_KEY.
//
// This mirrors PayMongo's own SDK, with two deliberate hardenings it lacks:
// a timing-safe comparison, and a timestamp freshness check so a captured
// request cannot be replayed later.
// ---------------------------------------------------------------------------
const REPLAY_TOLERANCE_SECONDS = 300;

function verifyWebhookSignature(rawBody, signatureHeader, secret, { toleranceSeconds = REPLAY_TOLERANCE_SECONDS } = {}) {
  if (!secret) return { ok: false, reason: 'PAYMONGO_WEBHOOK_SECRET is not configured' };
  if (!rawBody || !Buffer.isBuffer(rawBody)) return { ok: false, reason: 'raw request body unavailable' };

  const parts = String(signatureHeader || '').split(',');
  if (parts.length < 3) return { ok: false, reason: 'malformed Paymongo-Signature header' };

  const timestamp = (parts[0].split('=')[1] || '').trim();
  const testSignature = (parts[1].split('=')[1] || '').trim();
  const liveSignature = (parts[2].split('=')[1] || '').trim();
  // Live wins when present, matching PayMongo's SDK.
  const provided = liveSignature || testSignature;
  if (!timestamp || !provided) return { ok: false, reason: 'signature header missing timestamp or signature' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    return { ok: false, reason: `signature timestamp is outside the ${toleranceSeconds}s tolerance (replay?)` };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

module.exports = {
  createCheckoutSession,
  retrieveCheckoutSession,
  paidPaymentOf,
  verifyWebhookSignature,
  toCentavos,
  toPesos,
  isTestMode,
};
