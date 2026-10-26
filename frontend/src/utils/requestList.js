// The Document requests list's status tabs (SecretaryRequestsPage.jsx): which
// tabs there are, how many requests each holds, which requests a tab shows,
// and the heading over them. No React: the page wires these up, and
// components/ListTabs.jsx draws the strip.
//
// The list is loaded once, every request (GET /document-requests?status=all),
// and the tabs filter it in the browser. The statuses and their labels are
// constants/requestStatus.js's; this file adds only their order, and All.
//
// SEARCH (13 Oct 2026). The search box (components/ListToolbar.jsx) filters the
// same list, as you type, before the tabs split it. It matches the way the
// Payments search does, with utils/chargeSearch.js's normalise, searchTerms and
// matchesTerms as they are: case and accents ignored, extra spaces dropped,
// and every word required, in any order, each anywhere in the request's text,
// part of a word included ("cru" finds "Cruz"). That text is what the row
// shows of who and what (searchParts), and nothing else.
//
// PAYMENT AND NUMBER (13 Oct 2026). Each row also shows its request number,
// "#91" as the detail names it (requestNumber), which the search reads too,
// and where the request stands with its fee (paymentMarker), which it does
// not.
//
// FILTERS (14 Oct 2026). The filters row (components/ListFilters.jsx)
// narrows what the search leaves, before the tabs split it: Document, Payment
// and Submitted. Their choices are the loaded rows', and each matches what a
// row shows: the document type's whole name; the payment marker's word,
// through paymentMarker itself; and the Manila day the request was submitted,
// through utils/chargeFilters.js's manilaDay and backwards, as they are. On a
// phone they sit behind a Filters button, which says how many are on
// (filterCount).
import { chargeMeta, chargeOf, statusMeta } from "../constants/requestStatus";
import { ANY, backwards, manilaDay } from "./chargeFilters";
import { isNoFeeCharge } from "./chargeMethod";
import { matchesTerms, normalise, searchTerms } from "./chargeSearch";

export const ALL = "all";

// The statuses in the order a request moves through them, then the two it can
// end on instead of being claimed.
const ORDER = [
  "pending",
  "approved",
  "ready_for_release",
  "claimed",
  "rejected",
  "cancelled",
];

// The tabs, in order. `key` is the status a tab shows, or ALL.
export const REQUEST_TABS = [
  ...ORDER.map((key) => ({ key, label: statusMeta(key).label })),
  { key: ALL, label: "All" },
];

// All takes every request; a status tab only its own.
export function inTab(request, tab) {
  return tab === ALL || request.status === tab;
}

// How many requests each tab would show. The page passes the whole list, so
// the counts are the same whichever tab is chosen. A status outside the six
// is counted under All only.
export function tabCounts(requests) {
  const counts = Object.fromEntries(REQUEST_TABS.map((t) => [t.key, 0]));
  for (const request of requests) {
    counts[ALL] += 1;
    if (request.status !== ALL && Object.hasOwn(counts, request.status)) {
      counts[request.status] += 1;
    }
  }
  return counts;
}

// A tab's status as the headings and the empty text say it, lower case with a
// space after it ("pending "), and nothing for All.
function tabWords(tab) {
  return tab === ALL ? "" : `${statusMeta(tab).label.toLowerCase()} `;
}

// The heading over a tab's rows: "6 pending requests", "1 approved request",
// "77 requests" on All. The status reads as it does in the empty text ("No
// pending requests."), in lower case.
export function tabHeading(tab, count) {
  return `${count.toLocaleString("en-US")} ${tabWords(tab)}request${count === 1 ? "" : "s"}`;
}

// A person's name as the list and the detail show it: first, middle and last
// name, then ", suffix". null for no record.
export function personName(p) {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name]
    .filter(Boolean)
    .join(" ");
  return p.suffix ? `${name}, ${p.suffix}` : name;
}

// The name in the Requester column: the resident's, whom the request is for
// (on a walk-in the filer is the Secretary, whom the row never names), or,
// for a request with no resident name, the filer's @username in its place.
export function requesterName(request) {
  return (
    personName(request.resident_records) || `@${request.requester?.username}`
  );
}

// The @handle the Requester column shows under the name: the resident's own
// account. `account` arrives inside resident_records only when the server
// sends it: the Staff projection withholds it, and its key is absent. null
// means the resident has no online account, which the row says in words.
// Either way there is no handle.
export function accountHandle(record) {
  if (!record || !("account" in record)) return null;
  return record.account?.username ? `@${record.account.username}` : null;
}

// The request's number as its row shows it under the requester, and as the
// detail names the request ("Request #91"): "#91". No thousands separator.
export function requestNumber(request) {
  return `#${request.request_id}`;
}

// Where a request stands with its fee, for the marker under its status badge:
// { label, className }, the class a .charge-word colour. Read from the charge
// the list carries (charge_id, amount, status), never from the request's
// status or from what the resident declared:
//   no charge                 "Not billed": approval bills a request, so a
//                             pending, rejected or cancelled one has none, and
//                             so do two approved before approval billed (6, 9)
//   a PAID charge of PHP 0    "No fee", through isNoFeeCharge, as My requests
//                             and the detail say it (utils/chargeMethod.js)
//   any other charge          its status as the detail's charge badge words
//                             and colours it (CHARGE_META): "Paid", "Unpaid",
//                             "Void" (no route voids a document charge, but
//                             the column allows it), or an unknown status as
//                             it is, never blank
export function paymentMarker(request) {
  const charge = chargeOf(request);
  if (!charge) return { label: "Not billed", className: "gray" };
  if (isNoFeeCharge(charge)) return { label: "No fee", className: "gray" };
  const meta = chargeMeta(charge.status);
  return { label: meta.label, className: meta.className };
}

// What a search reads of one request: what its row shows of who and what,
// each its own part. The requester's name as the row shows it; the @account
// the row shows under it, and only there (never on Staff's rows, whose
// payload has no resident account but still carries the filer's username,
// which on a self-service request is that same account); the request number
// under them, "#91", so "91" and "#91" find it and part of it matches, as the
// Payments search reads its charge number; and the document type. NEVER the
// purpose or the rejection reason, which are free text; never an email; never
// the status or the payment marker, whose words would match every row of a
// tab.
export function searchParts(request) {
  return [
    requesterName(request),
    accountHandle(request.resident_records),
    requestNumber(request),
    request.document_types?.name,
  ].filter(Boolean);
}

// The requests that hold every word of `query`, in the order given. A blank
// query, or spaces only, keeps them all.
export function matchingRequests(requests, query) {
  const terms = searchTerms(query);
  if (terms.length === 0) return requests;
  return requests.filter((request) =>
    matchesTerms(normalise(searchParts(request).join("\n")), terms),
  );
}

// The heading while a search is on: "2 of 6 pending requests match", "1 of 3
// pending requests matches", "12 of 77 requests match" on All. `matched` is
// how many of the tab's requests match, `total` how many the tab holds with
// no search. The words are the Payments totals line's ("12 of 89 charges
// match", utils/chargeTotals.js): the verb agrees with the first number, the
// noun with the second.
export function searchHeading(tab, matched, total) {
  const verb = matched === 1 ? "matches" : "match";
  return `${matched.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${tabWords(tab)}request${total === 1 ? "" : "s"} ${verb}`;
}

// What takes the place of the rows when a search matches none of the tab's:
// 'No pending requests match "zzz"', 'No requests match "zzz"' on All. It
// names the tab, as the empty text without a search does ("No pending
// requests."), because another tab may hold matches, as its count shows. The
// search is quoted as typed, its spaces tidied.
export function noMatchText(tab, query) {
  const typed = String(query ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return `No ${tabWords(tab)}requests match "${typed}"`;
}

// The box's placeholder says what a search can find, and promises an account
// only where the rows carry one: Staff's rows have none, so Staff are not
// offered a search they cannot make. Decided from the data, as the row's
// account note is, never from the viewer's role.
export function searchPlaceholder(requests) {
  const accounts = requests.some(
    (request) =>
      request.resident_records && "account" in request.resident_records,
  );
  return accounts
    ? "Search name, account or document"
    : "Search name or document";
}

// "Any document": no Document filter. Empty, because a document type always
// has a name (the Secretary's form requires one), where "any", the value of
// the Payment and Submitted filters' Any (chargeFilters.js's ANY), could be
// one.
export const ANY_DOCUMENT = "";

// The Document choices: "Any document", then each type the loaded requests
// hold, once, sorted by name with case ignored ("efef21" comes before
// "First-time jobseeker"). A type is offered by its name, the words its rows
// show; the Secretary's form refuses a second type of the same name.
export function documentOptions(requests) {
  const names = [
    ...new Set(requests.map((r) => r.document_types?.name).filter(Boolean)),
  ];
  names.sort((a, b) => a.localeCompare(b, "en"));
  return [
    { value: ANY_DOCUMENT, label: "Any document" },
    ...names.map((name) => ({ value: name, label: name })),
  ];
}

// A request matches a type when its type has that whole name: "Barangay
// Clearance" never takes "Barangay Clearance for Business".
export function matchesDocument(request, choice) {
  return choice === ANY_DOCUMENT || request.document_types?.name === choice;
}

// The marker's word for a request whose charge is `charges`. The Payment
// choices are made of these, so a choice and the marker it takes are never
// spelled two ways.
function markerFor(charges) {
  return paymentMarker({ charges }).label;
}

const PAYMENT_WORDS = [
  markerFor({ status: "PAID", amount: 1 }), // Paid
  markerFor({ status: "UNPAID", amount: 1 }), // Unpaid
  markerFor({ status: "PAID", amount: 0 }), // No fee
  markerFor(null), // Not billed
];

const VOID_WORD = markerFor({ status: "VOID", amount: 1 });

// The Payment choices: "Any payment", then Paid, Unpaid, No fee and Not
// billed, and Void last, only when a loaded request is void (no route voids a
// document charge, so only one set by hand would be). A charge status outside
// the vocabulary is never a choice; its rows show under Any payment.
export function paymentOptions(requests) {
  const words = requests.some((r) => paymentMarker(r).label === VOID_WORD)
    ? [...PAYMENT_WORDS, VOID_WORD]
    : PAYMENT_WORDS;
  return [
    { value: ANY, label: "Any payment" },
    ...words.map((word) => ({ value: word, label: word })),
  ];
}

// A request matches a Payment choice when its marker says that word: the row
// and the filter read the same function, so they cannot disagree.
export function matchesPayment(request, choice) {
  return choice === ANY || paymentMarker(request).label === choice;
}

// Whether a request was submitted within `range`, chargeFilters.js's
// dateRange: { from, to } in Manila days, either null for no bound, or null
// for no range. Both ends are included. The day is the Manila day of
// requested_at, whatever clock the viewer's computer keeps; a request with no
// time is never guessed into a range, and a start after the end matches
// nothing. Not chargeFilters.js's matchesDate, which reads a charge's own
// date (billed, or paid under Paid); its manilaDay and backwards, as they are.
export function matchesSubmitted(request, range) {
  if (!range) return true;
  const day = manilaDay(request.requested_at);
  if (!day || backwards(range)) return false;
  return (!range.from || day >= range.from) && (!range.to || day <= range.to);
}

// What takes the place of the rows when the filters, with or without a
// search, leave a tab nothing: 'No pending requests match your search or
// filters.', 'No requests match your search or filters.' on All. The Payments
// page's words, naming the tab as this list's other empty texts do. A search
// alone keeps noMatchText.
export function filtersNoMatchText(tab) {
  return `No ${tabWords(tab)}requests match your search or filters.`;
}

// How many filters are on, for the "(2)" on a phone's Filters button: each
// of Document, Payment and Submitted that is off its Any choice. From and To
// are Submitted's own ("Choose dates"), so they never count apart from it:
// "Choose dates" is one filter with both dates, and still one with none, as
// it is a filter on for Clear filters.
export function filterCount({ document, payment, date }) {
  const on = [document !== ANY_DOCUMENT, payment !== ANY, date !== ANY];
  return on.filter(Boolean).length;
}
