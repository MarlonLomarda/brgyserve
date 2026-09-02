// Resend API client — the ONE place this project sends something for real.
//
// Everything under Notifications is SIMULATED: composed, addressed, recorded,
// and stopped. Password reset cannot work that way, because the whole feature
// is a link that has to reach an inbox the server does not control. So this is
// the exception, and it is deliberately narrow — one endpoint, one verb.
//
// RESEND_API_KEY IS SERVER-ONLY. It is read from the environment here, never
// logged, and never included in an error message or a provider_response. The
// only thing that crosses back to a caller is Resend's own wording and the id
// of the message.
//
// Mirrors services/paymongo.js in shape: a module-level base URL, a key
// accessor that throws a named error when the key is missing, and one `call`
// helper that turns a non-2xx into an Error carrying the provider's detail.
// No new dependency — Node 24 has global fetch, the same as the PayMongo
// client relies on.

const API = 'https://api.resend.com';

function apiKey() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured');
  return key;
}

// The From address, e.g. "BrgyServe <onboarding@resend.dev>".
//
// ON THE TEST SENDER: onboarding@resend.dev is Resend's shared sandbox
// address. It works with no DNS setup at all, and in exchange it will ONLY
// deliver to the email address that owns the Resend account — every other
// recipient is accepted by the API and then dropped. That is not a bug to
// debug when a reset email does not arrive; it is the sender. Verifying a
// domain and putting it here is what lifts the restriction.
function fromAddress() {
  const from = process.env.RESEND_FROM;
  if (!from) throw new Error('RESEND_FROM is not configured');
  return from;
}

async function call(endpoint, init = {}) {
  const res = await fetch(API + endpoint, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (res.status >= 300) {
    // Resend's own message is more useful than a generic failure ("domain is
    // not verified", "invalid to address"). Nothing key-related is ever in it.
    const err = new Error(body?.message || `Resend request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.resend = true;
    throw err;
  }
  return body;
}

/**
 * Sends one email. Returns Resend's response, whose `id` is what gets recorded
 * as the provider response so a delivery can be traced in their dashboard.
 *
 * `text` is sent alongside `html` on purpose: a plain-text alternative is what
 * keeps a message out of the spam folder in clients that penalise HTML-only
 * mail, and it is the version a screen reader gets.
 */
async function sendEmail({ to, subject, html, text }) {
  return call('/emails', {
    method: 'POST',
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject,
      html,
      ...(text ? { text } : {}),
    }),
  });
}

// True when both variables are present. Used to record a clear reason rather
// than an exception when the feature is simply not configured on this host.
const isConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);

module.exports = { sendEmail, isConfigured };
