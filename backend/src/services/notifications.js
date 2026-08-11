const supabase = require('../config/supabase');
const {
  NOTIFICATION_TYPE,
  NOTIFICATION_STATUS,
  SMS_MODE,
} = require('../constants/notifications');

// ===========================================================================
// NOTIFICATIONS
//
// Replaces the old console-log stub. Every send now writes a row to the
// notifications table (Chapter 3, Table 17) recording who it was for, where
// it was addressed, what was said, and what happened.
//
// NOTHING IS ACTUALLY SENT. SMS_MODE defaults to SIMULATED, which composes
// and records the message and stops there — no provider, no API key, no HTTP
// request. The rows are marked SIMULATED, never SENT, so the screen cannot
// claim a message was delivered when it was not.
//
// THIS MODULE NEVER THROWS. See notify() — the entire body is wrapped, and
// failures are returned rather than raised. A notification is the last thing
// that happens after a document is approved, a payment recorded or a fine
// raised, and it must never be able to undo any of them.
// ===========================================================================

const currentMode = () => (process.env.SMS_MODE || SMS_MODE.SIMULATED).toUpperCase();

// --------------------------------------------------------------------------
// Provider adapters. One function body each — this is the seam.
//
// TO GO LIVE WITH SEMAPHORE: implement the SEMAPHORE adapter below and set
// SMS_MODE=SEMAPHORE in backend/.env. Nothing else in the codebase changes —
// not the call sites, not the routes, not the screen.
// --------------------------------------------------------------------------
const PROVIDERS = {
  [SMS_MODE.SIMULATED]: async (destination, message) => {
    console.log(`[SMS SIMULATED] to ${destination}: ${message}`);
    return {
      status: NOTIFICATION_STATUS.SIMULATED,
      providerResponse: 'SIMULATED — composed and recorded, nothing was sent',
    };
  },

  [SMS_MODE.SEMAPHORE]: async () => {
    // NOT IMPLEMENTED ON PURPOSE — no account, no key, no request.
    //
    // The real body goes here and is roughly:
    //   POST https://api.semaphore.co/api/v4/messages
    //     { apikey: process.env.SEMAPHORE_API_KEY,
    //       number: destination, message, sendername: process.env.SEMAPHORE_SENDER }
    //   -> { status: SENT, providerResponse: JSON.stringify(body) }
    //   on a non-2xx or a throw -> { status: FAILED, providerResponse: ... }
    //
    // Note for whoever does it: a message beginning with "test" is silently
    // dropped by the Philippine networks, and PHP peso amounts must stay as
    // "PHP" rather than "₱" or every message costs 2-3 credits instead of 1.
    return {
      status: NOTIFICATION_STATUS.FAILED,
      providerResponse: 'SEMAPHORE is not configured yet — no request was made',
    };
  },
};

const providerFor = (mode) => PROVIDERS[mode] || PROVIDERS[SMS_MODE.SIMULATED];

// Rows are built here so the simulated path and a future real one cannot
// drift apart in what they record.
function buildRow({ type, userId, householdId, destination, message, relatedType, relatedTo, status, providerResponse }) {
  const now = new Date().toISOString();
  return {
    type: type || NOTIFICATION_TYPE.SMS,
    user_id: userId ?? null,
    household_id: householdId ?? null,
    // destination is NOT NULL in the schema; an empty string is how "there
    // was nowhere to send this" is stored, with the status carrying the why.
    destination: destination || '',
    subject: null,
    message,
    status,
    provider_response: providerResponse ?? null,
    related_type: relatedType ?? null,
    related_to: relatedTo ?? null,
    created_at: now,
    // Only a real delivery sets this. A SIMULATED row leaves it null, because
    // "when it was sent" has no honest answer when nothing was sent.
    sent_at: status === NOTIFICATION_STATUS.SENT ? now : null,
  };
}

// Composes, "sends" per the current mode, and records the outcome.
//
// Returns { ok, status } and NEVER throws — every caller is a business action
// that has already committed by the time this runs.
async function notify({
  type = NOTIFICATION_TYPE.SMS,
  userId = null,
  householdId = null,
  destination,
  message,
  relatedType = null,
  relatedTo = null,
} = {}) {
  try {
    const dest = typeof destination === 'string' ? destination.trim() : '';

    // Nothing to send to. Recorded rather than dropped: this is the barangay's
    // list of residents it cannot reach, which is the reason to collect
    // numbers in the first place.
    if (!dest) {
      await insertRows([
        buildRow({
          type, userId, householdId, destination: '', message, relatedType, relatedTo,
          status: NOTIFICATION_STATUS.SKIPPED,
          providerResponse: 'No contact number on record',
        }),
      ]);
      return { ok: false, status: NOTIFICATION_STATUS.SKIPPED };
    }

    const result = await providerFor(currentMode())(dest, message);
    await insertRows([
      buildRow({
        type, userId, householdId, destination: dest, message, relatedType, relatedTo,
        status: result.status,
        providerResponse: result.providerResponse,
      }),
    ]);
    return { ok: result.status === NOTIFICATION_STATUS.SENT, status: result.status };
  } catch (err) {
    // Deliberately swallowed. Logged loudly so it is not invisible, but never
    // re-thrown: the approval/payment/fine that triggered this is already
    // committed and must not be affected by a notification problem.
    console.error(`[notifications] suppressed failure: ${err.message}`);
    return { ok: false, status: NOTIFICATION_STATUS.FAILED, error: err.message };
  }
}

// Many recipients, ONE insert — fine generation can cover every household in
// the barangay, and that should not become a write per household.
async function notifyMany(items = []) {
  try {
    if (!items.length) return { ok: true, written: 0 };
    const rows = [];
    for (const item of items) {
      const dest = typeof item.destination === 'string' ? item.destination.trim() : '';
      if (!dest) {
        rows.push(buildRow({
          ...item, destination: '',
          status: NOTIFICATION_STATUS.SKIPPED,
          providerResponse: 'No contact number on record',
        }));
        continue;
      }
      const result = await providerFor(currentMode())(dest, item.message);
      rows.push(buildRow({
        ...item, destination: dest,
        status: result.status,
        providerResponse: result.providerResponse,
      }));
    }
    await insertRows(rows);
    return { ok: true, written: rows.length };
  } catch (err) {
    console.error(`[notifications] suppressed batch failure: ${err.message}`);
    return { ok: false, written: 0, error: err.message };
  }
}

async function insertRows(rows) {
  const { error } = await supabase.from('notifications').insert(rows);
  if (error) throw new Error(`Failed to record notification: ${error.message}`);
}

// GSM 03.38 coverage check, used by the tests. A message containing any
// character outside this set is sent as UCS-2, which drops the segment size
// from 160 characters to 70 — so a peso sign can triple what a message costs.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

function isGsmSafe(text) {
  return [...String(text)].every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
}

function smsSegments(text) {
  const s = String(text);
  if (!isGsmSafe(s)) return s.length <= 70 ? 1 : Math.ceil(s.length / 67);
  const units = [...s].reduce((n, c) => n + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

module.exports = { notify, notifyMany, isGsmSafe, smsSegments, currentMode, PROVIDERS };
