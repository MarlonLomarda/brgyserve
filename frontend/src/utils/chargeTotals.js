// The Payments page's totals line (PaymentsPage.jsx): how many charges are
// in view and what they add up to. No React: the page wires it up.
//
// IN WHOLE CENTAVOS. Amounts arrive as numbers or numeric strings, and adding
// pesos as floating point drifts (0.1 + 0.2 is 0.30000000000000004), so each
// amount becomes an integer number of centavos first and only integers are
// added. The total covers EVERY charge the page passes in, all of the ones
// that match the search and tab, never just the page of 25 on screen.
//
// THE ROWS DO NOT USE THIS FORMATTER. They still show "₱1500.00"
// (Number(amount).toFixed(2), PaymentsPage.jsx); totals read "₱1,500.00".
import { methodOf } from "./chargeMethod";

// An amount in centavos. A missing, blank or non-numeric amount adds
// nothing: a total is no place to guess.
export function toCentavos(amount) {
  const value =
    typeof amount === "number"
      ? amount
      : typeof amount === "string" && amount.trim() !== ""
        ? Number(amount)
        : NaN;
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

export function sumCentavos(charges) {
  return charges.reduce((sum, charge) => sum + toCentavos(charge.amount), 0);
}

// "₱1,500.00": thousands separators and two decimals.
export function formatPeso(centavos) {
  const sign = centavos < 0 ? "-" : "";
  const whole = Math.floor(Math.abs(centavos) / 100);
  const cents = String(Math.abs(centavos) % 100).padStart(2, "0");
  return `${sign}₱${whole.toLocaleString("en-US")}.${cents}`;
}

function formatCount(n) {
  return n.toLocaleString("en-US");
}

function charges(n) {
  return `${formatCount(n)} ${n === 1 ? "charge" : "charges"}`;
}

const STATUS_WORD = { UNPAID: "unpaid", PAID: "paid", VOID: "void" };

// How paid charges were paid, by their Method label (utils/chargeMethod.js):
// Cash, GCash and Paid online always, then "No payment record" and any other
// label only when they add up to more than 0. "No fee" is never listed: such
// a charge is 0 by definition.
function paidSplit(paid) {
  const byLabel = new Map();
  for (const charge of paid) {
    const label = methodOf(charge);
    byLabel.set(label, (byLabel.get(label) || 0) + toCentavos(charge.amount));
  }
  const parts = ["Cash", "GCash", "Paid online"].map(
    (label) => `${label} ${formatPeso(byLabel.get(label) || 0)}`,
  );
  const noRecord = byLabel.get("No record") || 0;
  if (noRecord > 0) parts.push(`No payment record ${formatPeso(noRecord)}`);
  for (const [label, sum] of byLabel) {
    if (["Cash", "GCash", "Paid online", "No record", "No fee"].includes(label))
      continue;
    if (sum > 0) parts.push(`${label} ${formatPeso(sum)}`);
  }
  return parts.join(" · ");
}

// The totals line: `heading` (the page's h2) and `detail` (the smaller line
// under it, or null).
//   status    the status view: "UNPAID", "PAID", "VOID" or "all"
//   shown     every charge that matches the search and tab, on any page
//   received  how many charges the page received for the status view
//   total     how many the server says there are; more than `received` when
//             its 1,000-row cap cut the list, and then the line says "newest"
//             rather than claim to cover everything
//   filtered  whether a search or a tab other than All is narrowing the view
export function totalsLine({ status, shown, received, total, filtered }) {
  if (received === 0) return { heading: "0 charges", detail: null };
  const capped = Number.isFinite(total) && total > received;
  const n = shown.length;

  let count;
  if (filtered) {
    const verb = n === 1 ? "matches" : "match";
    count = capped
      ? `${formatCount(n)} of the newest ${charges(received)} ${verb}`
      : `${formatCount(n)} of ${charges(received)} ${verb}`;
  } else {
    count = capped
      ? `Newest ${formatCount(received)} of ${charges(total)}`
      : charges(n);
  }
  if (n === 0) return { heading: count, detail: null };

  if (status === "all") {
    const sums = ["PAID", "UNPAID", "VOID"].map(
      (s) =>
        `${formatPeso(sumCentavos(shown.filter((c) => c.status === s)))} ${STATUS_WORD[s]}`,
    );
    return { heading: count, detail: sums.join(" · ") };
  }
  return {
    heading: `${count} · ${formatPeso(sumCentavos(shown))} ${STATUS_WORD[status] || ""}`.trim(),
    detail: status === "PAID" ? paidSplit(shown) : null,
  };
}
