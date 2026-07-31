// PayMongo webhook registration/sync — the piece that makes a random-URL
// tunnel workable.
//
// WHY THIS EXISTS: PayMongo validates the webhook url when it is registered
// (a placeholder is rejected with "url could not be resolved"), and a
// cloudflared quick tunnel hands out a NEW random *.trycloudflare.com
// hostname on every start. Re-creating the webhook each time would leave a
// trail of hooks PayMongo can only disable, never delete.
//
// So we create ONE webhook and update its url in place with
// PUT /v1/webhooks/{id}. Verified empirically against the test account:
//   - the url really does change on PUT, and `events` is preserved
//   - the webhook's secret_key SURVIVES the PUT unchanged
//   - secret_key is also readable from GET, so it can always be recovered
//     (it is not creation-only)
// Those three facts are what let the backend keep one stable
// PAYMONGO_WEBHOOK_SECRET across tunnel restarts, with no restart needed.
//
// Secrets are never printed — only a short SHA-256 fingerprint, which proves
// "same value" without revealing it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.paymongo.com/v1';
const WEBHOOK_PATH = '/api/payments/gcash/webhook';
// Only the paid event matters: a checkout the resident abandons should leave
// the charge exactly as it was, which is what happens if we never hear about it.
const EVENTS = ['checkout_session.payment.paid'];

const ENV_PATH = path.join(__dirname, '..', '.env');

const fingerprint = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : null);

function authHeader() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new Error('PAYMONGO_SECRET_KEY is not set in backend/.env');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function call(endpoint, init = {}) {
  const res = await fetch(API + endpoint, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function apiError(label, { status, body }) {
  const detail = (body?.errors || []).map((e) => e.detail).join('; ') || JSON.stringify(body);
  return new Error(`${label} failed (HTTP ${status}): ${detail}`);
}

// Rewrites keys in backend/.env in place, preserving every other line and any
// comments. Values are written verbatim, never echoed to the console.
function writeEnvVars(vars) {
  let raw = fs.readFileSync(ENV_PATH, 'utf8');
  const changed = [];
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(raw)) {
      if (raw.match(pattern)[0] !== line) changed.push(key);
      raw = raw.replace(pattern, line);
    } else {
      raw = `${raw}${raw.endsWith('\n') ? '' : '\n'}${line}\n`;
      changed.push(key);
    }
  }
  fs.writeFileSync(ENV_PATH, raw);
  return changed;
}

// Creates the webhook on first run, updates its url on every run after that.
// Returns { id, secretRotated } so the caller can tell the user whether the
// backend needs restarting (it only does when the secret actually changed).
async function syncWebhook(baseUrl) {
  const url = baseUrl.replace(/\/+$/, '') + WEBHOOK_PATH;
  const knownId = process.env.PAYMONGO_WEBHOOK_ID || null;
  const knownSecretFp = fingerprint(process.env.PAYMONGO_WEBHOOK_SECRET);

  let hook = null;
  if (knownId) {
    const res = await call(`/webhooks/${knownId}`);
    if (res.status === 200) hook = res.body.data;
    else if (res.status === 404) console.log(`  stored webhook ${knownId} no longer exists — creating a new one`);
    else throw apiError('Retrieving the webhook', res);
  }

  if (!hook) {
    const res = await call('/webhooks', {
      method: 'POST',
      body: JSON.stringify({ data: { attributes: { url, events: EVENTS } } }),
    });
    if (res.status !== 200 || !res.body?.data) throw apiError('Creating the webhook', res);
    hook = res.body.data;
    console.log(`  created webhook ${hook.id}`);
  } else if (hook.attributes.url !== url) {
    const res = await call(`/webhooks/${hook.id}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { attributes: { url } } }),
    });
    if (res.status !== 200 || !res.body?.data) throw apiError('Updating the webhook url', res);
    hook = res.body.data;
    console.log(`  updated webhook ${hook.id} to the current tunnel url`);
  } else {
    console.log(`  webhook ${hook.id} already points at this url`);
  }

  // PayMongo auto-disables a webhook after 12 failed retries on each of 3
  // consecutive events — which is exactly what a dead tunnel causes. Re-enable
  // it, otherwise payments would silently stop being confirmed.
  if (hook.attributes.status !== 'enabled') {
    const res = await call(`/webhooks/${hook.id}/enable`, { method: 'POST' });
    if (res.status !== 200 || !res.body?.data) throw apiError('Re-enabling the webhook', res);
    hook = res.body.data;
    console.log(`  re-enabled the webhook (PayMongo had disabled it: ${hook.attributes.disabled_reason || 'reason not given'})`);
  }

  const secret = hook.attributes.secret_key;
  if (!secret) throw new Error('PayMongo returned no secret_key — signatures could not be verified without it');
  const secretRotated = knownSecretFp !== null && fingerprint(secret) !== knownSecretFp;

  writeEnvVars({
    PUBLIC_BASE_URL: baseUrl.replace(/\/+$/, ''),
    PAYMONGO_WEBHOOK_ID: hook.id,
    PAYMONGO_WEBHOOK_SECRET: secret,
  });

  return {
    id: hook.id,
    url: hook.attributes.url,
    status: hook.attributes.status,
    livemode: hook.attributes.livemode,
    events: hook.attributes.events,
    secretFingerprint: fingerprint(secret),
    secretRotated,
  };
}

module.exports = { syncWebhook, writeEnvVars, fingerprint, WEBHOOK_PATH, EVENTS };

// Standalone: point the webhook at a base url without starting a tunnel —
//     npm run tunnel:sync                      (uses PUBLIC_BASE_URL)
//     npm run tunnel:sync https://api.example  (explicit, e.g. after deploying)
if (require.main === module) {
  require('dotenv').config();
  const base = process.argv[2] || process.env.PUBLIC_BASE_URL;
  if (!base) {
    console.error('No base url. Pass one as an argument or set PUBLIC_BASE_URL in backend/.env.');
    process.exit(1);
  }
  syncWebhook(base)
    .then((hook) => {
      console.log(`webhook ${hook.id} -> ${hook.url}`);
      console.log(`status ${hook.status}, livemode ${hook.livemode}, events ${hook.events.join(', ')}`);
      console.log(`secret fingerprint ${hook.secretFingerprint} (written to backend/.env, never printed)`);
      if (hook.secretRotated) console.log('!! secret changed — restart the API');
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
