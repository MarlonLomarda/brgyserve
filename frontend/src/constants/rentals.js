// Display metadata for rentals (mirrors backend/src/constants/rentals.js).
// Badge off derived_status — the backend adds it — so facilities read
// 'Completed' and physical items past due read 'Overdue' without the stored
// status changing.
//
// Since migration 027 a booking can wait for the Secretary's approval:
// pending, then confirmed or declined, and a pending request whose start has
// passed is derived 'expired'. Since batch R2c every resident's booking is
// stored pending. The Activity Log reads these words through this table and
// keeps "Confirmed" for a stored-confirmed booking; the Rental bookings list
// (since R2b) and the resident's pages (since R2c) say "Approved" instead,
// through statusBadge() in utils/rentalList.js.
export const RENTAL_META = {
  pending: { label: 'Pending', className: 'status-pending' },
  confirmed: { label: 'Confirmed', className: 'status-approved' },
  declined: { label: 'Declined', className: 'status-rejected' },
  expired: { label: 'Expired', className: 'status-cancelled' },
  overdue: { label: 'Overdue', className: 'status-rejected' },
  completed: { label: 'Completed', className: 'status-claimed' },
  returned: { label: 'Returned', className: 'status-claimed' },
  returned_late: { label: 'Returned late', className: 'status-pending' },
  returned_with_issue: { label: 'Returned with issue', className: 'status-rejected' },
  cancelled: { label: 'Cancelled', className: 'status-cancelled' },
};

// The word a confirmed booking is shown with: "Approved". The stored status
// stays 'confirmed'. The Rental bookings list (batch R2b) and the resident's
// My rentals and Book a rental (batch R2c) use it, through statusBadge in
// utils/rentalList.js. RENTAL_META.confirmed keeps "Confirmed" for the
// Activity Log, whose rows describe what was stored ("Pending to
// Confirmed"), and which is to keep its own words.
export const APPROVED_LABEL = 'Approved';

export function rentalMeta(status) {
  return RENTAL_META[status] || { label: status, className: 'gray' };
}

// A booking's badge status: prefer the backend-derived value (completed /
// overdue), fall back to the stored status.
export const displayStatus = (booking) => booking?.derived_status || booking?.status;

export const ITEM_TYPE_LABELS = {
  facility: 'Facility',
  equipment: 'Equipment',
  furniture: 'Furniture',
};

// Physical/returnable item types — facilities have no return step.
const RETURNABLE_TYPES = ['equipment', 'furniture'];
export const isReturnable = (type) => RETURNABLE_TYPES.includes(type);

// The outcomes Staff pick when recording a return.
export const RETURN_OUTCOMES = [
  { value: 'returned', label: 'Returned — on time, good condition' },
  { value: 'returned_late', label: 'Returned late' },
  { value: 'returned_with_issue', label: 'Returned with an issue (damage/incomplete)' },
];

const dateFmt = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' });

// "Requested on Nov 6, 2026, 1:30 AM": when a request was made, in MANILA,
// whatever this computer's clock (batch R2c, My rentals). null when there is
// no time to give: the row then shows nothing, never a dash or "unknown".
// Formatted per call, as formatDate is, so the zone is the one asked for
// here and never the one the page happened to load in.
export function requestedOnText(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `Requested on ${d.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })}`;
}

// "Jul 25, 2026, 2:00 PM – 6:00 PM" — bookings run within one day.
export function formatSchedule(start, end) {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  return `${dateFmt.format(s)}, ${timeFmt.format(s)} – ${timeFmt.format(e)}`;
}
