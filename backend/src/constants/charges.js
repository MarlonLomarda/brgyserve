// Canonical charge values from the schema (Table 15). Charge statuses are
// UPPERCASE by the thesis data dictionary, unlike the lowercase
// document-request statuses — do not mix the two vocabularies.
const CHARGE_STATUS = {
  UNPAID: 'UNPAID',
  PAID: 'PAID',
  VOID: 'VOID',
};

const CHARGE_TYPE = {
  FINE: 'FINE',
  DOCUMENT: 'DOCUMENT',
  RENTAL: 'RENTAL',
};

// Payment methods (lowercase canonical values, like request statuses).
// Record/verify only — there is NO payment gateway integration.
const PAYMENT_METHOD = {
  ONSITE: 'onsite', // cash at the barangay hall
  GCASH: 'gcash',   // resident submits a GCash reference number
};

module.exports = { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD };
