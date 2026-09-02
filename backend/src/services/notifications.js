const supabase = require('../config/supabase');
const {
  NOTIFICATION_TYPE,
  NOTIFICATION_STATUS,
  SMS_MODE,
  EMAIL_MODE,
  MODE_SOURCE,
} = require('../constants/notifications');
const resend = require('./resend');

// ===========================================================================
// NOTIFICATIONS
//
// Replaces the old console-log stub. Every send now writes a row to the
// notifications table (Chapter 3, Table 17) recording who it was for, where
// it was addressed, what was said, and what happened.
//
// SMS IS NEVER ACTUALLY SENT. SMS_MODE defaults to SIMULATED, which composes
// and records the message and stops there — no provider, no API key, no HTTP
// request. Those rows are marked SIMULATED, never SENT, so the screen cannot
// claim a message was delivered when it was not.
//
// EMAIL IS THE ONE EXCEPTION, and only when EMAIL_MODE=RESEND. Password reset
// is a link that has to reach a real inbox, so it cannot be simulated and
// still be a feature. EMAIL_MODE is its OWN variable — see MODE_SOURCE in
// constants/notifications.js — so an SMS setting can never route email and an
// email setting can never claim an SMS was sent.
//
// DISPATCH IS ON `type`, NOT ON A SINGLE SHARED MODE. PROVIDERS is keyed
// type -> mode -> adapter, so the two types cannot reach each other's
// adapters even by mistake.
//
// THIS MODULE NEVER THROWS. See notify() — the entire body is wrapped, and
// failures are returned rather than raised. A notification is the last thing
// that happens after a document is approved, a payment recorded or a fine
// raised, and it must never be able to undo any of them.
// ===========================================================================

/**
 * The delivery mode in force for a type, read from that type's own variable.
 * Defaults to SMS so the pre-existing callers (routes/notifications.js, which
 * reports the mode to the Secretary's screen) keep their meaning unchanged.
 */
function currentMode(type = NOTIFICATION_TYPE.SMS) {
  const source = MODE_SOURCE[type] || MODE_SOURCE[NOTIFICATION_TYPE.SMS];
  return (process.env[source.env] || source.fallback).toUpperCase();
}

// --------------------------------------------------------------------------
// Provider adapters, keyed type -> mode. One function body each — this is the
// seam.
//
// TO GO LIVE WITH SEMAPHORE: implement the SMS SEMAPHORE adapter below and set
// SMS_MODE=SEMAPHORE in backend/.env. Nothing else in the codebase changes —
// not the call sites, not the routes, not the screen.
// --------------------------------------------------------------------------
const PROVIDERS = {
  [NOTIFICATION_TYPE.SMS]: {
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
  },

  [NOTIFICATION_TYPE.EMAIL]: {
    [EMAIL_MODE.SIMULATED]: async (destination, message, { subject } = {}) => {
      console.log(`[EMAIL SIMULATED] to ${destination} | ${subject || '(no subject)'}: ${message}`);
      return {
        status: NOTIFICATION_STATUS.SIMULATED,
        providerResponse: 'SIMULATED — composed and recorded, nothing was sent',
      };
    },

    // THE ONE ADAPTER THAT REALLY SENDS.
    [EMAIL_MODE.RESEND]: async (destination, message, { subject, html } = {}) => {
      // A missing key does NOT stop the API booting (unlike
      // SUPABASE_SERVICE_ROLE_KEY, which every query depends on and whose
      // absence produces a SILENTLY EMPTY result set). This one breaks exactly
      // one feature, loudly and locally: a recorded FAILED row naming the
      // reason. Refusing to boot over it would take document requests,
      // payments, attendance, reports and login down with it.
      if (!resend.isConfigured()) {
        return {
          status: NOTIFICATION_STATUS.FAILED,
          providerResponse: 'RESEND_API_KEY / RESEND_FROM are not configured — no request was made',
        };
      }
      try {
        const result = await resend.sendEmail({
          to: destination,
          subject: subject || '(no subject)',
          html: html || escapeHtml(message).replace(/\n/g, '<br>'),
          text: message,
        });
        return {
          status: NOTIFICATION_STATUS.SENT,
          // The provider's message id, which is what a delivery is traced by
          // in the Resend dashboard. Never the key, never the body.
          providerResponse: `Resend id ${result?.id || '(none returned)'}`,
        };
      } catch (err) {
        return {
          status: NOTIFICATION_STATUS.FAILED,
          providerResponse: `Resend refused the message: ${err.message}`,
        };
      }
    },
  },
};

function providerFor(type, mode) {
  const family = PROVIDERS[type] || PROVIDERS[NOTIFICATION_TYPE.SMS];
  const fallbackMode = (MODE_SOURCE[type] || MODE_SOURCE[NOTIFICATION_TYPE.SMS]).fallback;
  // An unrecognised mode falls back to that TYPE'S simulated adapter, never to
  // another type's. The worst case is a message that is recorded and not sent.
  return family[mode] || family[fallbackMode];
}

// Why a message had nowhere to go. VARIES BY TYPE: this used to be the single
// hardcoded string "No contact number on record", which was already the wrong
// sentence the moment a second type existed.
//
// The EMAIL branch is effectively unreachable — users.email is NOT NULL, so an
// account always has an address to skip to. It is written anyway because the
// alternative is a row that states something untrue about itself, and because
// "unreachable today" is not the same as "unreachable after the next schema
// change".
const SKIPPED_REASON = {
  [NOTIFICATION_TYPE.SMS]: 'No contact number on record',
  [NOTIFICATION_TYPE.EMAIL]: 'No email address on record',
};

const skippedReason = (type) => SKIPPED_REASON[type] || 'No destination on record';

// ===========================================================================
// THE REDACTION SPLIT
//
// notify() takes the message that is SENT and the message that is RECORDED
// separately. They are the same string for nine of the ten call sites, and
// they MUST NOT BE for password reset.
//
// The reason is an account-takeover path, not tidiness. Any Secretary can open
// /secretary/notifications, which renders notifications.message on screen. A
// reset link stored in that column is therefore a working password-reset URL
// for another person's account, readable by every Secretary and by anyone who
// gets a look at that screen. Hashing the token in password_resets does not
// help in the slightest: the RAW token would be sitting in plain text one
// column over.
//
// Structurally, the split is enforced by buildRow never seeing the sent
// message at all — notify() resolves the recorded text first and passes only
// that down. The check below is a BACKSTOP for the case where someone adds a
// second link-bearing message later and forgets: it refuses to write the row
// rather than write a live token into a screen-rendered column. Since notify()
// never throws, the effect is a FAILED result and a loud log line, and the
// business action that triggered it is untouched.
// ===========================================================================
const SECRET_IN_LOG_RE = /[?&]token=/i;

function assertNotSecret(recorded) {
  if (SECRET_IN_LOG_RE.test(String(recorded))) {
    throw new Error(
      'Refusing to record a notification whose logged message carries a token. ' +
        'Pass logMessage to notify() with the link removed — notifications.message ' +
        'is rendered on the Secretary notifications screen.'
    );
  }
}

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Rows are built here so the simulated path and the real one cannot drift
// apart in what they record.
//
// It receives `message` already resolved to the RECORDED text. The sent text
// is not a parameter and never reaches this function.
function buildRow({ type, userId, householdId, destination, subject, message, relatedType, relatedTo, status, providerResponse }) {
  assertNotSecret(message);
  const now = new Date().toISOString();
  return {
    type: type || NOTIFICATION_TYPE.SMS,
    user_id: userId ?? null,
    household_id: householdId ?? null,
    // destination is NOT NULL in the schema; an empty string is how "there
    // was nowhere to send this" is stored, with the status carrying the why.
    destination: destination || '',
    // varchar(255). SMS has no subject and stores null, which is what all 66
    // rows written before email existed already hold.
    subject: subject ? String(subject).slice(0, 255) : null,
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

// Composes, sends per the mode in force for the TYPE, and records the outcome.
//
// Returns { ok, status } and NEVER throws — every caller is a business action
// that has already committed by the time this runs.
//
// @param message    what is SENT to the provider.
// @param logMessage what is RECORDED in notifications.message. Defaults to
//                   `message`, so a caller with nothing to hide writes exactly
//                   what it sent and the nine existing call sites are
//                   unchanged. Pass it ONLY to redact, and see the block above
//                   for why that is not optional for reset links.
// @param subject    email subject; ignored by SMS, which has no such concept.
// @param html       optional HTML body for email. Never recorded — the row
//                   stores logMessage and nothing else.
async function notify({
  type = NOTIFICATION_TYPE.SMS,
  userId = null,
  householdId = null,
  destination,
  subject = null,
  message,
  logMessage = null,
  html = null,
  relatedType = null,
  relatedTo = null,
} = {}) {
  try {
    const dest = typeof destination === 'string' ? destination.trim() : '';
    // Resolved ONCE, here, before anything can be written. Everything
    // downstream of this line sees only `recorded`.
    const recorded = logMessage ?? message;

    // Nothing to send to. Recorded rather than dropped: this is the barangay's
    // list of residents it cannot reach, which is the reason to collect
    // numbers in the first place.
    if (!dest) {
      await insertRows([
        buildRow({
          type, userId, householdId, destination: '', subject, message: recorded, relatedType, relatedTo,
          status: NOTIFICATION_STATUS.SKIPPED,
          providerResponse: skippedReason(type),
        }),
      ]);
      return { ok: false, status: NOTIFICATION_STATUS.SKIPPED };
    }

    const result = await providerFor(type, currentMode(type))(dest, message, { subject, html });
    await insertRows([
      buildRow({
        type, userId, householdId, destination: dest, subject, message: recorded, relatedType, relatedTo,
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
      const type = item.type || NOTIFICATION_TYPE.SMS;
      const dest = typeof item.destination === 'string' ? item.destination.trim() : '';
      const recorded = item.logMessage ?? item.message;
      if (!dest) {
        rows.push(buildRow({
          ...item, type, destination: '', message: recorded,
          status: NOTIFICATION_STATUS.SKIPPED,
          providerResponse: skippedReason(type),
        }));
        continue;
      }
      const result = await providerFor(type, currentMode(type))(dest, item.message, {
        subject: item.subject,
        html: item.html,
      });
      rows.push(buildRow({
        ...item, type, destination: dest, message: recorded,
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
//
// SMS ONLY. Email has no segment cost and no restricted alphabet, so the reset
// templates are deliberately not held to it.
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

module.exports = { notify, notifyMany, isGsmSafe, smsSegments, currentMode, escapeHtml, PROVIDERS };
