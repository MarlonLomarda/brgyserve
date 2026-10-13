// The Document requests list's status tabs (SecretaryRequestsPage.jsx): which
// tabs there are, how many requests each holds, which requests a tab shows,
// and the heading over them. No React: the page wires these up, and
// components/ListTabs.jsx draws the strip.
//
// The list is loaded once, every request (GET /document-requests?status=all),
// and the tabs filter it in the browser. The statuses and their labels are
// constants/requestStatus.js's; this file adds only their order, and All.
import { statusMeta } from "../constants/requestStatus";

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

// The heading over a tab's rows: "6 pending requests", "1 approved request",
// "77 requests" on All. The status reads as it does in the empty text ("No
// pending requests."), in lower case.
export function tabHeading(tab, count) {
  const status = tab === ALL ? "" : `${statusMeta(tab).label.toLowerCase()} `;
  return `${count.toLocaleString("en-US")} ${status}request${count === 1 ? "" : "s"}`;
}
