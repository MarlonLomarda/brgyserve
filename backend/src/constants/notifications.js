// Canonical vocabularies for the notifications table (Chapter 3, Table 17).
// Single source of truth — routes and the service must not invent strings.

const NOTIFICATION_TYPE = {
  SMS: 'SMS',
  EMAIL: 'EMAIL', // reserved; nothing sends email yet
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
// enforced FK — one column has to point at four different tables.
const RELATED_TYPE = {
  DOCUMENT_REQUEST: 'DOCUMENT_REQUEST',
  RENTAL_REQUEST: 'RENTAL_REQUEST',
  CHARGE: 'CHARGE',
  EVENT: 'EVENT',
};

// Provider modes, read from SMS_MODE. SIMULATED is the default and the only
// one implemented; see services/notifications.js for the seam.
const SMS_MODE = {
  SIMULATED: 'SIMULATED',
  SEMAPHORE: 'SEMAPHORE',
};

module.exports = {
  NOTIFICATION_TYPE,
  NOTIFICATION_STATUS,
  DELIVERED_STATUSES,
  RELATED_TYPE,
  SMS_MODE,
  NOTIFICATION_STATUSES: Object.values(NOTIFICATION_STATUS),
  RELATED_TYPES: Object.values(RELATED_TYPE),
};
