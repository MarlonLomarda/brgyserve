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
//
// SEARCH (15 Oct 2026). The search box (components/ListToolbar.jsx) filters
// the same list, as you type, before the tabs split it. It matches the way
// the Payments and Document requests searches do, with utils/chargeSearch.js's
// normalise, searchTerms and matchesTerms as they are: case and accents
// ignored, extra spaces dropped, and every word required, in any order, each
// anywhere in the booking's text, part of a word included ("cru" finds
// "Cruz"). That text is what the row shows of who and what (searchParts):
// the name in the Booked for column, the @account under it, and the item.
// The row reads the name and the account from here too, so the two cannot
// disagree.
//
// ORDER (15 Oct 2026). The page keeps the list in one order (orderBookings),
// before the search, the tabs and the pager: the route's, newest start first,
// with bookings that start together settled by booking number, so the pager
// never shows a row twice or leaves one out between loads.
//
// PAYMENT AND NUMBER (15 Oct 2026). Each row also shows its booking number,
// "#12" as the Edit and Mark returned panels name it (bookingNumber), which
// the search reads too, and where the booking stands with its fee
// (paymentMarker), which it does not. The marker is the Document requests
// list's own function (utils/requestList.js), handed on here as it is: it
// reads only the charge a row carries, and a booking carries its charge in
// the same shape a request does.
//
// FILTERS (15 Oct 2026). The filters row (components/ListFilters.jsx)
// narrows what the search leaves, before the tabs split it: Item, Payment and
// Starts. Their choices are the loaded rows', and each matches what a row
// shows: the item's whole name, which a booking reads live from its item (a
// booking stores no copy of it, so a renamed item is one choice under its new
// name, and a deactivated item is still offered while a booking holds it);
// the payment marker's word, through the Document requests list's own
// paymentOptions and matchesPayment, handed on as they are; and the Manila
// day the booking starts on (a booking runs within one day), through
// utils/chargeFilters.js's manilaDay and backwards, as they are, with presets
// both ways, since bookings are made ahead and looked back on. On a phone they
// sit behind a Filters button, which says how many are on (filterCount).
//
// COLUMNS (15 Oct 2026). Above 640px the table's columns have fixed widths
// (index.css), so each row's schedule is drawn as two lines, the date with
// its comma over the times (scheduleParts), the break in the same place in
// every row.
//
// TYPE (27 Oct 2026, step C2). A fourth filter, first in the row: the item's
// type, Facility, Equipment or Furniture (TYPE_OPTIONS, matchesType), read
// from the type the booking's item carries. It narrows with the others, so
// the tab counts and the heading follow it as they follow Item. The Item
// choices stay every item the rows hold: a Type and an Item that disagree
// (Facility and Tent) show nothing, with the filters' own empty text.
import {
  displayStatus,
  formatSchedule,
  ITEM_TYPE_LABELS,
} from "../constants/rentals";
import { ANY, backwards, manilaDay } from "./chargeFilters";
import { matchesTerms, normalise, searchTerms } from "./chargeSearch";
import { matchesPayment, paymentMarker, paymentOptions } from "./requestList";

// Where a booking stands with its fee, for the marker under its status badge:
// { label, className }. The Document requests list's function, as it is, read
// from the charge alone (the list embeds one per booking), never from the
// booking's status and never from its item's fee, which is what the item
// costs today, not what the booking was billed:
//   no charge                 "Not billed": every booking is billed when it is
//                             made, so only one cancelled before rentals were
//                             billed has none (live booking 9)
//   a PAID charge of PHP 0    "No fee": a free item's booking is billed so
//   any other charge          its status in the charge badges' words and
//                             colours (CHARGE_META): "Paid", "Unpaid", or
//                             "Void", which cancelling a booking leaves of an
//                             unpaid charge
// The Payment filter's choices and its match are the Document requests
// list's too, as they are: "Any payment", then Paid, Unpaid, No fee and Not
// billed, and Void last, only while a loaded booking's marker says Void (on
// the live list five do); a booking matches a choice when its marker says
// that word, so the filter and the row cannot disagree.
export { matchesPayment, paymentMarker, paymentOptions };

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

// THE LIST'S ONE ORDER. The route sends the bookings newest start first
// (start_datetime, descending) and orders by nothing else, so bookings that
// start at the same moment (four on the live list) can come back in another
// order on every load, and a page could then repeat a row the page before it
// showed, or leave one out. This keeps the route's order and settles the
// ties: among bookings that start together, the higher booking number
// (request_id, the table's key) first. The times are compared, not the text,
// so one moment written two ways is one start; a start that cannot be read
// goes last. A new array: the list given is left as it is.
export function orderBookings(bookings) {
  const start = (booking) => {
    const time = Date.parse(booking.start_datetime);
    return Number.isNaN(time) ? -Infinity : time;
  };
  return [...bookings].sort(
    (a, b) => start(b) - start(a) || b.request_id - a.request_id,
  );
}

// A person's name as the list shows it: first, middle and last name, then
// ", suffix". null when there is no name at all.
function personName(p) {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name]
    .filter(Boolean)
    .join(" ");
  if (!name) return null;
  return p.suffix ? `${name}, ${p.suffix}` : name;
}

// A guest's booking: someone from another barangay, typed in at the counter
// by name and contact number, with no resident record. Their row says "Guest"
// and the number under the name, never an account.
export function isGuest(booking) {
  return Boolean(booking.outside_borrower_name);
}

// WHO THE BOOKING IS FOR, as the Booked for column shows it: the borrower,
// not the requester. Since migration 022 a row names its borrower directly
// (resident_records for a resident, outside_borrower_name for a guest) and the
// requester is only who FILED it; for a walk-in that is the Secretary. The
// requester's name, then "@username", are kept as the last fallbacks for rows
// the server did not embed a borrower on (none on the live list). null when
// there is nothing to name; the row then shows "—".
export function bookedForName(booking) {
  return (
    personName(booking.resident_records) ||
    booking.outside_borrower_name ||
    personName(booking.requester?.profiles) ||
    (booking.requester?.username ? `@${booking.requester.username}` : null)
  );
}

// The @handle the Booked for column shows under a resident's name: the
// BORROWER'S account, never the requester's (on a walk-in the requester is the
// Secretary). `account` arrives inside resident_records when the server sends
// it, as it does for all three roles today (one projection, MANAGE_FIELDS in
// routes/rentalRequests.js); this tests the key, never the viewer's role.
// null when the key is absent, and when the resident has no online account,
// which the row says in words instead.
export function accountHandle(record) {
  if (!record || !("account" in record)) return null;
  return record.account?.username ? `@${record.account.username}` : null;
}

// The booking's number as its row shows it under the name, and as the Edit
// and Mark returned panels name the booking ("Edit booking #12"): "#12". No
// thousands separator.
export function bookingNumber(booking) {
  return `#${booking.request_id}`;
}

// The Schedule column's two lines: the date with its comma, "Sep 24, 2026,",
// and the times, "8:00 AM – 8:00 PM", cut from formatSchedule's own text
// (constants/rentals.js) after its last comma, so the row's words stay
// formatSchedule's: the two with a space between are the whole of it. Above
// 640px each is a line of its own (index.css), so every row breaks after the
// year. null when the booking has no start or no end, where formatSchedule
// writes "—".
export function scheduleParts(booking) {
  const text = formatSchedule(booking.start_datetime, booking.end_datetime);
  const cut = text.lastIndexOf(", ");
  if (cut < 0) return null;
  return { date: text.slice(0, cut + 1), times: text.slice(cut + 2) };
}

// What a search reads of one booking: what its row shows of who and what,
// each its own part. The name in the Booked for column (bookedForName); the
// @account the row shows under it, and only there (a guest's row shows
// "Guest" and the contact number instead); the booking number under them,
// "#12", so "12" and "#12" find it and part of it matches, as the Payments
// search reads its charge number; and the item. NEVER the purpose or a return
// note, which are free text; never a guest's contact number, which the row
// shows but is a phone number, not a name; never an email, the filer or the
// returner; never a status or the payment marker, whose words would match
// every row of a tab; and never the words "Guest" and "No online account".
export function searchParts(booking) {
  return [
    bookedForName(booking),
    isGuest(booking) ? null : accountHandle(booking.resident_records),
    bookingNumber(booking),
    booking.rental_items?.name,
  ].filter(Boolean);
}

// The bookings that hold every word of `query`, in the order given. A blank
// query, or spaces only, keeps them all.
export function matchingBookings(bookings, query) {
  const terms = searchTerms(query);
  if (terms.length === 0) return bookings;
  return bookings.filter((booking) =>
    matchesTerms(normalise(searchParts(booking).join("\n")), terms),
  );
}

// The heading while a search is on: "4 of 7 overdue bookings match", "1 of 7
// overdue bookings matches", "12 of 28 bookings match" on All. `matched` is
// how many of the tab's bookings match, `total` how many the tab holds with no
// search. Document requests' words (utils/requestList.js), which are the
// Payments totals line's: the verb agrees with the first number, the noun
// with the second ("0 of 1 overdue booking match").
export function searchHeading(tab, matched, total) {
  const verb = matched === 1 ? "matches" : "match";
  return `${matched.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${tabWords(tab)}booking${total === 1 ? "" : "s"} ${verb}`;
}

// What takes the place of the rows when a search matches none of the tab's:
// 'No overdue bookings match "zzz"', 'No bookings match "zzz"' on All. It
// names the tab, as the empty text without a search does ("No overdue
// bookings."), because another tab may hold matches, as its count shows. The
// search is quoted as typed, its spaces tidied.
export function noMatchText(tab, query) {
  const typed = String(query ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return `No ${tabWords(tab)}bookings match "${typed}"`;
}

// The box's placeholder says what a search can find, and promises an account
// only where the rows carry one: decided from the data, as the row's account
// note is, never from the viewer's role. Every role's list carries accounts
// today; a list with none (guests only, or a projection that withholds them)
// is not offered a search it cannot make.
export function searchPlaceholder(bookings) {
  const accounts = bookings.some(
    (booking) =>
      !isGuest(booking) &&
      booking.resident_records &&
      "account" in booking.resident_records,
  );
  return accounts ? "Search name, account or item" : "Search name or item";
}

// "Any item": no Item filter. Empty, because an item always has a name (the
// Secretary's form requires one), where "any", the value of the Payment and
// Starts filters' Any (chargeFilters.js's ANY), could be one.
export const ANY_ITEM = "";

// The Item choices: "Any item", then each item the loaded bookings hold,
// once, sorted by name with case ignored ("stick" comes before "Tables"). An
// item is offered by its name, the words its rows show. A booking reads its
// item's name live, through its item_id (it stores no copy), so every booking
// of an item shows the same name, the current one; and no two items, active
// or not, may share a name (the Secretary's form refuses it, case ignored),
// so a name is one item. A deactivated item is still offered while a loaded
// booking holds it: the choices are the bookings', not the active items list.
export function itemOptions(bookings) {
  const names = [
    ...new Set(bookings.map((b) => b.rental_items?.name).filter(Boolean)),
  ];
  names.sort((a, b) => a.localeCompare(b, "en"));
  return [
    { value: ANY_ITEM, label: "Any item" },
    ...names.map((name) => ({ value: name, label: name })),
  ];
}

// A booking matches an item when its item has that whole name: "Tables"
// never takes "Folding Tables".
export function matchesItem(booking, choice) {
  return choice === ANY_ITEM || booking.rental_items?.name === choice;
}

// The Type choices: "Any type", then the three types in the words the Edit
// panel uses for them (ITEM_TYPE_LABELS). A fixed list, as Starts' is, so
// every type is offered whether or not a loaded booking has one.
export const TYPE_OPTIONS = [
  { value: ANY, label: "Any type" },
  ...Object.entries(ITEM_TYPE_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
];

// A booking matches a type when its item is of that type.
export function matchesType(booking, choice) {
  return choice === ANY || booking.rental_items?.type === choice;
}

// The Starts choices. Bookings are made ahead and looked back on, so the
// presets go both ways, and each counts today: Next 7 days is today and the 6
// days after it, Last 7 days today and the 6 before it (Payments' Last 7
// days), and likewise for 30.
export const STARTS_OPTIONS = [
  { value: ANY, label: "Any date" },
  { value: "today", label: "Today" },
  { value: "next7", label: "Next 7 days" },
  { value: "next30", label: "Next 30 days" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "custom", label: "Choose dates" },
];

// A day plus n days, counted on the calendar (UTC midnights, so no clock's
// daylight saving can move it). chargeFilters.js's own, which it does not
// export.
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The days a Starts choice covers, { from, to } in Manila days ("YYYY-MM-DD",
// as chargeFilters.js counts them), either null for no bound; null when it
// restricts nothing. `today` is a Manila day (chargeFilters.js's
// manilaToday). Choose dates with no date yet restricts nothing, though it is
// a filter on.
export function startsRange(choice, from, to, today) {
  switch (choice) {
    case "today":
      return { from: today, to: today };
    case "next7":
      return { from: today, to: addDays(today, 6) };
    case "next30":
      return { from: today, to: addDays(today, 29) };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "custom":
      return from || to ? { from: from || null, to: to || null } : null;
    default:
      return null;
  }
}

// Whether a booking starts within `range` (startsRange's). Both ends are
// included. The day is the Manila day of start_datetime, whatever clock the
// viewer's computer keeps; a booking with no start is never guessed into a
// range, and a start after the end matches nothing, never swapped.
export function matchesStarts(booking, range) {
  if (!range) return true;
  const day = manilaDay(booking.start_datetime);
  if (!day || backwards(range)) return false;
  return (!range.from || day >= range.from) && (!range.to || day <= range.to);
}

// What takes the place of the rows when the filters, with or without a
// search, leave a tab nothing: 'No overdue bookings match your search or
// filters.', 'No bookings match your search or filters.' on All. The Payments
// page's words, naming the tab as this list's other empty texts do. A search
// alone keeps noMatchText.
export function filtersNoMatchText(tab) {
  return `No ${tabWords(tab)}bookings match your search or filters.`;
}

// How many filters are on, for the "(2)" on a phone's Filters button: each of
// Type, Item, Payment and Starts that is off its Any choice. From and To are
// Starts' own ("Choose dates"), so they never count apart from it.
export function filterCount({ type = ANY, item, payment, date }) {
  const on = [type !== ANY, item !== ANY_ITEM, payment !== ANY, date !== ANY];
  return on.filter(Boolean).length;
}
