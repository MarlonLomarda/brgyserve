// Display metadata for rentals (mirrors backend/src/constants/rentals.js).
// Badge off derived_status — the backend adds it — so facilities read
// 'Completed' and physical items past due read 'Overdue' without the stored
// status changing.
//
// Since migration 027 a booking can wait for the Secretary's approval:
// pending, then confirmed or declined, and a pending request whose start has
// passed is derived 'expired'. No booking is stored pending yet (the batch
// that switches the approval on comes later); the Activity Log reads these
// three through this table, and since batch R2b the Rental bookings list
// (Pending and Not approved tabs) does too.
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

// The word a confirmed booking is shown with once the approval step is
// switched on: "Approved". The stored status stays 'confirmed'. Since batch
// R2b the Rental bookings list uses it (statusBadge in utils/rentalList.js);
// the resident's pages keep RENTAL_META's "Confirmed" until the batch that
// switches the approval on (R2c) puts it in RENTAL_META.confirmed.
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

// "Jul 25, 2026, 2:00 PM – 6:00 PM" — bookings run within one day.
export function formatSchedule(start, end) {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  return `${dateFmt.format(s)}, ${timeFmt.format(s)} – ${timeFmt.format(e)}`;
}
