// The Payments page's Method and date filters (PaymentsPage.jsx). No React:
// the page wires these up.
//
// METHOD MIRRORS THE METHOD COLUMN. A charge matches when methodOf
// (utils/chargeMethod.js) gives it the chosen label, never by its raw
// payment_method: a PayMongo payment's is "gcash" too, so filtering on that
// would put every "Paid online" charge under "GCash". Which labels are offered
// depends on the status view, since an unpaid charge has no Cash and a paid
// one is never Online pending.
//
// DATES ARE MANILA DAYS, whatever clock the viewer's computer keeps: when a
// charge was billed or paid is a fact about the barangay's day, as the View
// panel's "Paid on" is. A day is "YYYY-MM-DD", the en-CA form, as in
// constants/activityLog.js, so days compare as plain strings. Both ends of a
// range are included.
import { latestPayment, methodOf } from "./chargeMethod";

// The value of "Any method" and "Any date": no filter.
export const ANY = "any";

const METHODS_BY_STATUS = {
  UNPAID: ["Online pending"],
  PAID: ["Cash", "GCash", "Paid online", "No fee"],
  VOID: [],
  all: ["Cash", "GCash", "Paid online", "No fee", "Online pending"],
};

// The Method choices for a status view, "Any method" first. A real method's
// value is its column label.
export function methodOptions(status) {
  return [
    { value: ANY, label: "Any method" },
    ...(METHODS_BY_STATUS[status] || []).map((m) => ({ value: m, label: m })),
  ];
}

export function methodOffered(status, method) {
  return methodOptions(status).some((o) => o.value === method);
}

export function matchesMethod(charge, method) {
  return method === ANY || methodOf(charge) === method;
}

export const DATE_OPTIONS = [
  { value: ANY, label: "Any date" },
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Choose dates" },
];

// "Today" comes from this one function, so a test can fix the day
// (scripts/test-auth-session.cjs does; nothing else changes it).
export const clock = { now: () => new Date() };

const MANILA = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" });

// The Manila day of a timestamp, or null when there is none or it does not
// parse: a charge with no date is never guessed into a range.
export function manilaDay(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : MANILA.format(date);
}

export function manilaToday() {
  return manilaDay(clock.now());
}

// A day plus n days, counted on the calendar (UTC midnights, so no clock's
// daylight saving can move it).
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Which date a status view filters on: the paid date under Paid, the billed
// date everywhere else.
export function dateKind(status) {
  return status === "PAID" ? "paid" : "billed";
}

// The timestamp a charge is filtered by. A paid charge's paid date is its
// latest payment row's created_at, the row the panel's "Paid on" shows; one
// with no row (approval creates a PHP 0 charge already paid) was paid when
// it was billed. An unpaid or void charge has only its billed date.
export function chargeDate(charge, kind) {
  if (kind === "paid" && charge.status === "PAID") {
    return latestPayment(charge)?.created_at ?? charge.created_at;
  }
  return charge.created_at;
}

// The days a date choice covers, { from, to }, either null for no bound; null
// when it restricts nothing. `today` is a Manila day. Last 7 days is today
// and the 6 days before it; This month, the 1st through today.
export function dateRange(choice, from, to, today) {
  switch (choice) {
    case "today":
      return { from: today, to: today };
    case "week":
      return { from: addDays(today, -6), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "custom":
      return from || to ? { from: from || null, to: to || null } : null;
    default:
      return null;
  }
}

// A start after the end: the page says so, and the range matches nothing.
// It is never swapped behind the person's back.
export function backwards(range) {
  return !!range?.from && !!range?.to && range.from > range.to;
}

export function matchesDate(charge, kind, range) {
  if (!range) return true;
  const day = manilaDay(chargeDate(charge, kind));
  if (!day || backwards(range)) return false;
  return (!range.from || day >= range.from) && (!range.to || day <= range.to);
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

function dayText(day, withYear) {
  const [y, m, d] = day.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}${withYear ? `, ${y}` : ""}`;
}

// The end of the totals line: which date it counts and over what range,
// "billed in the last 7 days" or "paid Oct 1 to Oct 12". Null when no date
// filter is on. A date outside this year carries its year, on both ends.
export function dateText(kind, choice, range, today) {
  if (!range) return null;
  if (choice === "today") return `${kind} today`;
  if (choice === "week") return `${kind} in the last 7 days`;
  if (choice === "month") return `${kind} this month`;
  const { from, to } = range;
  const year = today.slice(0, 4);
  const withYear = [from, to].some((d) => d && d.slice(0, 4) !== year);
  if (from && to) {
    return from === to
      ? `${kind} on ${dayText(from, withYear)}`
      : `${kind} ${dayText(from, withYear)} to ${dayText(to, withYear)}`;
  }
  return from
    ? `${kind} from ${dayText(from, withYear)}`
    : `${kind} up to ${dayText(to, withYear)}`;
}
