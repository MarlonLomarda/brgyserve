// How a charge was paid, in a word or two: the Payments page's Method column
// and the Method row of its View panel (PaymentsPage.jsx).
//
// A PAID charge is labelled from its payment record, never from what the
// resident declared. A payment nobody received was made through PayMongo:
// received_by_user_id is what tells the two kinds apart (Table 16), and a
// staff member who records a payment is always its receiver. A PAID charge
// with no payment row is "No fee" when its amount is 0, because approval
// creates every PHP 0 document or rental charge PAID with no row, and "No
// record" otherwise, which would be a real gap. Any other charge is still
// waiting: "Online pending" while a PayMongo checkout is open and unpaid,
// otherwise a dash. isNoFeeCharge is the same zero test for My requests, My
// rentals and the request detail, which say "No fee" too.

// The methods a staff member records (backend/src/constants/charges.js).
// Anything else is shown as it is, so a new method is visible, never blank.
const RECORDED_METHOD_LABELS = {
  onsite: "Cash",
  gcash: "GCash",
};

// A payment that came through PayMongo, the webhook or a Re-check, rather
// than one a staff member recorded.
export function isAutomatic(payment) {
  return payment.received_by_user_id === null;
}

// The charge's payment row, or null when it has none. Nothing in the schema
// stops a second row (payments.charge_id is not UNIQUE), so with more than one
// it is the latest by created_at.
export function latestPayment(charge) {
  let latest = null;
  for (const payment of charge.payments || []) {
    if (!latest || new Date(payment.created_at) > new Date(latest.created_at)) {
      latest = payment;
    }
  }
  return latest;
}

// Whether the charge's amount is 0. It arrives as a number or as a numeric
// string such as "0.00", so it is compared as a number. A missing, null,
// blank or non-numeric amount is never 0: Number() reads null and "" as 0,
// which would call a malformed charge free.
export function isZeroFee(charge) {
  const amount = charge.amount;
  if (typeof amount === "number") return amount === 0;
  if (typeof amount === "string" && amount.trim() !== "") {
    return Number(amount) === 0;
  }
  return false;
}

// Whether the charge is a PAID one of PHP 0: approval creates a PHP 0
// document charge already paid, and a booking a PHP 0 rental charge, so there
// was no fee to pay. The request and rental pages say "No fee" for it rather
// than "₱0.00 — Paid". An unpaid or void PHP 0 charge is not one, and neither
// is no charge at all (null).
export function isNoFeeCharge(charge) {
  return charge?.status === "PAID" && isZeroFee(charge);
}

export function methodOf(charge) {
  if (charge.status === "PAID") {
    const payment = latestPayment(charge);
    if (!payment) return isZeroFee(charge) ? "No fee" : "No record";
    if (isAutomatic(payment)) return "Paid online";
    return (
      RECORDED_METHOD_LABELS[payment.payment_method] ||
      payment.payment_method ||
      "—"
    );
  }
  return charge.paymongo_session_id && !charge.paymongo_payment_id
    ? "Online pending"
    : "—";
}
