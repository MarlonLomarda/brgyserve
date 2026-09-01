// Canonical vocabularies for the notifications table (Chapter 3, Table 17).
// Single source of truth — routes and the service must not invent strings.

const NOTIFICATION_TYPE = {
  SMS: 'SMS',
  EMAIL: 'EMAIL',
};

// PENDING / SENT / FAILED come from Table 17. Two more were added when the
// simulated provider was built:
//
//   SIMULATED — the message was composed and addressed but deliberately NOT
//     sent, because SMS_MODE is SIMULATED. It is a separate status rather
//     than SENT on purpose: recording "SENT" for a message nobody sent would
//     make the Notifications screen state something untrue, which is exactly
//     what this whole approach exists to avoid.
//
//   SKIPPED — there was nothing to send to. Most residents have no contact
//     number on record, and that gap is worth showing rather than hiding:
//     the row records who the barangay could not reach and why.
const NOTIFICATION_STATUS = {
  PENDING: 'PENDING',
  SIMULATED: 'SIMULATED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
};

// Statuses that mean the message actually left the building. SIMULATED is
// deliberately NOT one of them.
const DELIVERED_STATUSES = [NOTIFICATION_STATUS.SENT];

// Polymorphic pointer (notifications.related_type / related_to). Not an
// enforced FK — one column has to point at five different tables.
//
// ACCOUNT points at users.user_id and was added for registration rejection.
// It is the only member that is not about a transaction: the others all name
// something the resident asked for, while this one is about the account
// itself. related_type is varchar(50) with no CHECK, so adding it needed no
// migration — but frontend/src/constants/notifications.js must gain the
// matching entry or the rows are unfilterable on the notifications screen.
const RELATED_TYPE = {
  DOCUMENT_REQUEST: 'DOCUMENT_REQUEST',
  RENTAL_REQUEST: 'RENTAL_REQUEST',
  CHARGE: 'CHARGE',
  EVENT: 'EVENT',
  ACCOUNT: 'ACCOUNT',
};

// Provider modes. There is ONE PER TYPE, read from its own environment
// variable, and they are deliberately NOT a single shared setting.
//
// The reason is that the two types are at different stages and always will be
// at some point: SMS is simulated because sending it costs PHP 560 up front
// for a demo of twenty messages, while email is really sent through Resend.
// A single mode would mean the decision for one is the decision for the other
// — setting SMS_MODE=SEMAPHORE would silently route password reset emails
// through an SMS provider, and EMAIL_MODE=RESEND would claim SMS was sent.
// Neither can happen when each type reads its own variable.
//
// Both default to SIMULATED, so a missing value can never send anything.
const SMS_MODE = {
  SIMULATED: 'SIMULATED',
  SEMAPHORE: 'SEMAPHORE',
};

const EMAIL_MODE = {
  SIMULATED: 'SIMULATED',
  RESEND: 'RESEND',
};

// type -> { env, modes, default }. currentMode() reads this rather than
// branching on the type, so adding a third type is a table entry.
const MODE_SOURCE = {
  [NOTIFICATION_TYPE.SMS]: { env: 'SMS_MODE', modes: SMS_MODE, fallback: SMS_MODE.SIMULATED },
  [NOTIFICATION_TYPE.EMAIL]: { env: 'EMAIL_MODE', modes: EMAIL_MODE, fallback: EMAIL_MODE.SIMULATED },
};

module.exports = {
  NOTIFICATION_TYPE,
  NOTIFICATION_STATUS,
  DELIVERED_STATUSES,
  RELATED_TYPE,
  SMS_MODE,
  EMAIL_MODE,
  MODE_SOURCE,
  NOTIFICATION_STATUSES: Object.values(NOTIFICATION_STATUS),
  RELATED_TYPES: Object.values(RELATED_TYPE),
};
