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
// A resident may DECLARE only 'onsite' (POST /mine/:id/pay on documents and
// rentals). 'gcash' reaches payments.payment_method when staff record a GCash
// payment with the reference they type, or through the PayMongo gateway
// (routes/payments.js). Residents declared GCash references themselves until
// 10 Oct 2026, so a charge from before then may still hold one.
const PAYMENT_METHOD = {
  ONSITE: 'onsite', // cash at the barangay hall
  GCASH: 'gcash',   // recorded by staff with its reference, or paid online through PayMongo
};

module.exports = { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD };
