// The Rental bookings list's status tabs (RentalBookingsPage.jsx): which tabs
// there are, which bookings each holds and how many, the heading over them,
// the text when a tab holds none, and the tab the page opens on. No React: the
// page wires these up, and components/ListTabs.jsx draws the strip.
//
// The list is loaded once, every booking (GET /rental-requests?status=all),
// and the tabs split it in the browser. A booking's tab is decided by the
// status its badge reads, displayStatus in constants/rentals.js: the server's
// derived_status, which turns a confirmed booking whose end has passed into
// "overdue" (equipment or furniture not yet marked returned) or "completed"
// (a facility), and is the stored status otherwise. NEVER the stored status
// alone: every past confirmed booking would read as upcoming. The time
// comparison stays the server's (deriveStatus in routes/rentalRequests.js);
// this file only reads its answer, as the badge does.
import { displayStatus } from "../constants/rentals";

export const ALL = "all";

// The status tabs, in order, and the statuses each holds. Upcoming is a
// confirmed booking whose end is still ahead, begun or not (derived_status
// "confirmed", whose badge reads Confirmed). Returned holds the three return
// outcomes, which their badges tell apart. A status outside these seven is
// in All only.
const STATUS_TABS = [
  { key: "upcoming", label: "Upcoming", statuses: ["confirmed"] },
  { key: "overdue", label: "Overdue", statuses: ["overdue"] },
  { key: "completed", label: "Completed", statuses: ["completed"] },
  {
    key: "returned",
    label: "Returned",
    statuses: ["returned", "returned_late", "returned_with_issue"],
  },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

// The tabs, in order, as ListTabs takes them: `key` is the tab, or ALL.
export const RENTAL_TABS = [
  ...STATUS_TABS.map(({ key, label }) => ({ key, label })),
  { key: ALL, label: "All" },
];

// All takes every booking; a status tab only those whose badge status it
// holds.
export function inTab(booking, tab) {
  if (tab === ALL) return true;
  const statuses = STATUS_TABS.find((t) => t.key === tab)?.statuses;
  return Boolean(statuses?.includes(displayStatus(booking)));
}

// How many bookings each tab would show. The page passes the whole list, so
// the counts are the same whichever tab is chosen.
export function tabCounts(bookings) {
  return Object.fromEntries(
    RENTAL_TABS.map((t) => [
      t.key,
      bookings.filter((booking) => inTab(booking, t.key)).length,
    ]),
  );
}

// A tab as the headings and the empty text say it, lower case with a space
// after it ("overdue "), and nothing for All.
function tabWords(tab) {
  const label = RENTAL_TABS.find((t) => t.key === tab)?.label;
  return tab === ALL || !label ? "" : `${label.toLowerCase()} `;
}

// The heading over a tab's rows: "7 overdue bookings", "1 overdue booking",
// "0 upcoming bookings", "28 bookings" on All.
export function tabHeading(tab, count) {
  return `${count.toLocaleString("en-US")} ${tabWords(tab)}booking${count === 1 ? "" : "s"}`;
}

// What takes the place of the rows when a tab holds none: "No upcoming
// bookings.", "No bookings." on All.
export function emptyText(tab) {
  return `No ${tabWords(tab)}bookings.`;
}

// The tab the page opens on. Staff, who mark items returned (canReturn), open
// on Overdue, as the select they had did; the Secretary and the Punong
// Barangay on Upcoming, even while it is empty.
export function openingTab(canReturn) {
  return canReturn ? "overdue" : "upcoming";
}
