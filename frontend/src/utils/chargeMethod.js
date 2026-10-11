// How a charge was paid, in a word or two: the Payments page's Method column
// and the Method row of its View panel (PaymentsPage.jsx).
//
// A PAID charge is labelled from its payment record, never from what the
// resident declared. A payment nobody received was made through PayMongo:
// received_by_user_id is what tells the two kinds apart (Table 16), and a
// staff member who records a payment is always its receiver. Any other charge
// is still waiting: "Online pending" while a PayMongo checkout is open and
// unpaid, otherwise a dash.

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

export function methodOf(charge) {
  if (charge.status === "PAID") {
    const payment = latestPayment(charge);
    if (!payment) return "No record";
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
