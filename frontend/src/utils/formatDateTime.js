// A timestamp in the browser's own locale, "—" when there is none, and the
// value as it came when it does not parse. One copy, shared by Resident
// review and the Staff accounts page.
export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
