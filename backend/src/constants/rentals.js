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
// Rentals are SELF-SERVICE: the conflict check runs at submission and a
// passing request is confirmed instantly, so there is deliberately no
// 'pending'/'approved' (unlike document requests).
//
// STORED statuses (written to rental_requests.status):
//   confirmed             booked; holds the slot/units against conflict checks
//   cancelled             called off (resident/Secretary); frees the slot
//   returned              physical item handed back on time, good condition
//   returned_late         handed back after the booked end time
//   returned_with_issue   handed back damaged / incomplete (see return_note)
//
// DERIVED display states (computed from a CONFIRMED booking once its end has
// passed — never stored; see deriveStatus in routes/rentalRequests.js):
//   completed  a FACILITY booking auto-completes (no physical return needed)
//   overdue    a PHYSICAL booking past its end, not yet marked returned

const RENTAL_STATUS = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  RETURNED: 'returned',
  RETURNED_LATE: 'returned_late',
  RETURNED_WITH_ISSUE: 'returned_with_issue',
  // derived-only (never written to the DB):
  COMPLETED: 'completed',
  OVERDUE: 'overdue',
};

// The three outcomes Staff can record when marking a physical item returned.
const RETURN_OUTCOMES = [
  RENTAL_STATUS.RETURNED,
  RENTAL_STATUS.RETURNED_LATE,
  RENTAL_STATUS.RETURNED_WITH_ISSUE,
];

// Statuses actually persisted in rental_requests.status — the valid values for
// the ?status= list filter (plus the virtual 'overdue'/'completed' the list
// handler derives, and 'all').
const STORED_RENTAL_STATUSES = [
  RENTAL_STATUS.CONFIRMED,
  RENTAL_STATUS.CANCELLED,
  ...RETURN_OUTCOMES,
];

module.exports = {
  ITEM_TYPE,
  ITEM_TYPES,
  RETURNABLE_TYPES,
  RENTAL_STATUS,
  RETURN_OUTCOMES,
  STORED_RENTAL_STATUSES,
};
