// Canonical rental-item type values — lowercase, matching the role/status
// convention. 'facility' means a whole venue booked as one unit
// (quantity_total is forced to 1); 'equipment' and 'furniture' are countable.

const ITEM_TYPE = {
  FACILITY: 'facility',
  EQUIPMENT: 'equipment',
  FURNITURE: 'furniture',
};

const ITEM_TYPES = Object.values(ITEM_TYPE);

// Physical / returnable item types. Facilities are NOT returnable — they have
// no return step and auto-complete after their booked time (see deriveStatus
// in the routes). Equipment and furniture (chairs, tables, tents…) are handed
// out and must be returned, so Staff record their return in stage 5.
const RETURNABLE_TYPES = [ITEM_TYPE.EQUIPMENT, ITEM_TYPE.FURNITURE];

// Canonical rental-request status values — the single source of truth.
// Since migration 027 (28 Oct 2026) a booking CAN wait for the Secretary's
// approval: stored 'pending', then 'confirmed' (shown as "Approved") or
// 'declined'. A pending request holds nothing, and its charge is raised when
// it is approved (approve_rental_booking). Until the batch that switches it
// on, every booking, a resident's and a walk-in alike, is still stored
// 'confirmed' at once, as before.
//
// STORED statuses (written to rental_requests.status):
//   pending               a request waiting for the Secretary; holds NOTHING,
//                         has no charge. A resident may cancel it any time
//                         before it starts
//   confirmed             booked (approved); holds the slot/units against
//                         conflict checks, and carries its RENTAL charge
//   declined              the Secretary said no, with decline_reason
//                         (migration 027); holds nothing
//   cancelled             called off; frees the slot. A resident cancels their
//                         own online booking while it is unpaid, up to 24
//                         hours before it starts (a pending one: any time
//                         before it starts); the Secretary cancels any
//                         confirmed booking that has not started, with a
//                         reason (cancellation_reason, migration 023)
//   returned              physical item handed back on time, good condition
//   returned_late         handed back after the booked end time
//   returned_with_issue   handed back damaged / incomplete (see return_note)
//
// DERIVED display states (never stored, no scheduler; see deriveStatus in
// routes/rentalRequests.js):
//   completed  a CONFIRMED FACILITY booking whose end has passed (no physical
//              return needed)
//   overdue    a CONFIRMED PHYSICAL booking past its end, not yet returned
//   expired    a PENDING request whose start has passed; it can no longer be
//              approved

const RENTAL_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
  RETURNED: 'returned',
  RETURNED_LATE: 'returned_late',
  RETURNED_WITH_ISSUE: 'returned_with_issue',
  // derived-only (never written to the DB):
  COMPLETED: 'completed',
  OVERDUE: 'overdue',
  EXPIRED: 'expired',
};

// What a booking is for (rental_requests.purpose_type, migration 027). A
// funeral may be booked only for an item the Secretary marked
// funeral_eligible; what a funeral booking costs is decided later (batch 4).
const PURPOSE_TYPE = {
  GENERAL: 'general',
  FUNERAL: 'funeral',
};
const PURPOSE_TYPES = Object.values(PURPOSE_TYPE);

// A decline reason: trimmed, 3 to 300 characters, the CHECK migration 027
// put on rental_requests.decline_reason (as cancellation_reason's).
const DECLINE_REASON_MIN = 3;
const DECLINE_REASON_MAX = 300;

// The three outcomes Staff can record when marking a physical item returned.
const RETURN_OUTCOMES = [
  RENTAL_STATUS.RETURNED,
  RENTAL_STATUS.RETURNED_LATE,
  RENTAL_STATUS.RETURNED_WITH_ISSUE,
];

// Statuses actually persisted in rental_requests.status — the valid values for
// the ?status= list filter (plus the virtual 'overdue'/'completed'/'expired'
// the list handler derives, and 'all'). pending and declined come last so the
// order of the five older ones is unchanged.
const STORED_RENTAL_STATUSES = [
  RENTAL_STATUS.CONFIRMED,
  RENTAL_STATUS.CANCELLED,
  ...RETURN_OUTCOMES,
  RENTAL_STATUS.PENDING,
  RENTAL_STATUS.DECLINED,
];

module.exports = {
  ITEM_TYPE,
  ITEM_TYPES,
  RETURNABLE_TYPES,
  RENTAL_STATUS,
  RETURN_OUTCOMES,
  STORED_RENTAL_STATUSES,
  PURPOSE_TYPE,
  PURPOSE_TYPES,
  DECLINE_REASON_MIN,
  DECLINE_REASON_MAX,
};
