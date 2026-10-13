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
import { statusMeta } from "../constants/requestStatus";
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

// What a search reads of one request: what its row shows of who and what,
// each its own part. The requester's name as the row shows it; the @account
// the row shows under it, and only there (never on Staff's rows, whose
// payload has no resident account but still carries the filer's username,
// which on a self-service request is that same account); and the document
// type. NEVER the purpose or the rejection reason, which are free text; never
// an email; never the status, whose words would match every row of its tab;
// and not the request number, which the rows do not show.
export function searchParts(request) {
  return [
    requesterName(request),
    accountHandle(request.resident_records),
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
