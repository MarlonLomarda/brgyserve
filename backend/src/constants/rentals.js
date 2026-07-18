// Canonical rental-item type values — lowercase, matching the role/status
// convention. 'facility' means a whole venue booked as one unit
// (quantity_total is forced to 1); 'equipment' and 'furniture' are countable.
// Rental-request statuses are added here in a later stage.

const ITEM_TYPE = {
  FACILITY: 'facility',
  EQUIPMENT: 'equipment',
  FURNITURE: 'furniture',
};

const ITEM_TYPES = Object.values(ITEM_TYPE);

module.exports = { ITEM_TYPE, ITEM_TYPES };
