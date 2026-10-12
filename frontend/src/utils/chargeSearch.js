// What the Payments page's search box and type tabs keep in view
// (PaymentsPage.jsx). No React: the page wires these up.
//
// A search matches as you type, ignoring case and accents ("nino" finds
// "Niño"), and every word in it is required, in any order. It reads only
// what staff can see for a charge: the payer name and the "For" text as the
// page shows them (the page passes both in, so the search can never disagree
// with the row), the @username, the charge number with its "#", and the
// references the View panel can show. NEVER the purpose, which is the
// resident's own free text, and never a contact number or email, which the
// list does not send at all.

// Lower case with the accents taken off: "Peñaflor" becomes "penaflor".
export function normalise(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// The words of a search, each one required. A blank search has none, and
// matches every charge.
export function searchTerms(query) {
  return normalise(query).split(/\s+/).filter(Boolean);
}

// One charge's searchable text. `shown` is { name, forText }, what the page
// shows in its Resident and For columns. Each part is its own line, so a
// word can never match across two of them.
export function chargeSearchText(charge, shown) {
  const parts = [
    shown.name,
    charge.payer?.username ? `@${charge.payer.username}` : null,
    `#${charge.charge_id}`,
    // Every payment row's reference (an OR number, a GCash reference, a
    // PayMongo pay_ id), the charge's own pay_ id, and a declared reference.
    ...(charge.payments || []).map((p) => p.reference_no),
    charge.paymongo_payment_id,
    charge.declared_reference,
    shown.forText,
  ];
  return normalise(parts.filter(Boolean).join("\n"));
}

// Whether a charge's text (chargeSearchText) holds every word.
export function matchesTerms(text, terms) {
  return terms.every((term) => text.includes(term));
}

// The type tabs, in order. `key` is the charge_type a tab shows.
export const TYPE_TABS = [
  { key: "all", label: "All" },
  { key: "DOCUMENT", label: "Documents" },
  { key: "RENTAL", label: "Rentals" },
  { key: "FINE", label: "Fines" },
];

export function inTab(charge, tab) {
  return tab === "all" || charge.charge_type === tab;
}

// How many of `charges` each tab would show. The page passes the charges
// that match the search, whatever tab is selected, so staff can see where
// the matches are.
export function tabCounts(charges) {
  const counts = Object.fromEntries(TYPE_TABS.map((t) => [t.key, 0]));
  for (const charge of charges) {
    counts.all += 1;
    if (charge.charge_type in counts) counts[charge.charge_type] += 1;
  }
  return counts;
}
