// Display metadata for rentals (mirrors backend/src/constants/rentals.js).
// Rentals are self-service (no pending/approved). Badge off derived_status —
// the backend adds it — so facilities read 'Completed' and physical items
// past due read 'Overdue' without the stored status changing.
export const RENTAL_META = {
  confirmed: { label: 'Confirmed', className: 'status-approved' },
  overdue: { label: 'Overdue', className: 'status-rejected' },
  completed: { label: 'Completed', className: 'status-claimed' },
  returned: { label: 'Returned', className: 'status-claimed' },
  returned_late: { label: 'Returned late', className: 'status-pending' },
  returned_with_issue: { label: 'Returned with issue', className: 'status-rejected' },
  cancelled: { label: 'Cancelled', className: 'status-cancelled' },
};

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

// "Jul 25, 2026, 2:00 PM – 6:00 PM" — bookings run within one day.
export function formatSchedule(start, end) {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  return `${dateFmt.format(s)}, ${timeFmt.format(s)} – ${timeFmt.format(e)}`;
}
