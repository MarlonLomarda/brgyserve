// Canonical rental-item type values — lowercase, matching the role/status
// convention. 'facility' means a whole venue booked as one unit
// (quantity_total is forced to 1); 'equipment' and 'furniture' are countable.

const ITEM_TYPE = {
  FACILITY: 'facility',
  EQUIPMENT: 'equipment',
  FURNITURE: 'furniture',
};

const ITEM_TYPES = Object.values(ITEM_TYPE);

// Canonical rental-request status values — the single source of truth.
// Rentals are SELF-SERVICE: the conflict check runs at submission and a
// passing request is confirmed instantly, so there is deliberately no
// 'pending'/'approved' (unlike document requests).
//
//   confirmed  booked; holds the slot/units against future conflict checks
//   cancelled  called off (resident or Secretary, later stage); frees the slot
//   completed  the rental took place and is closed — terminal (set by a
//              later stage; kept in the vocabulary so history reads clearly)

const RENTAL_STATUS = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};

const RENTAL_STATUSES = Object.values(RENTAL_STATUS);

module.exports = { ITEM_TYPE, ITEM_TYPES, RENTAL_STATUS, RENTAL_STATUSES };
