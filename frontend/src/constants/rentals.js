// Display metadata for rentals (mirrors backend/src/constants/rentals.js).
// Rentals are self-service: bookings confirm instantly, so there is no
// pending/approved — just confirmed | cancelled | completed.
export const RENTAL_META = {
  confirmed: { label: 'Confirmed', className: 'status-approved' },
  cancelled: { label: 'Cancelled', className: 'status-cancelled' },
  completed: { label: 'Completed', className: 'status-claimed' },
};

export function rentalMeta(status) {
  return RENTAL_META[status] || { label: status, className: 'gray' };
}

export const ITEM_TYPE_LABELS = {
  facility: 'Facility',
  equipment: 'Equipment',
  furniture: 'Furniture',
};

const dateFmt = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' });

// "Jul 25, 2026, 2:00 PM – 6:00 PM" — bookings run within one day.
export function formatSchedule(start, end) {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  return `${dateFmt.format(s)}, ${timeFmt.format(s)} – ${timeFmt.format(e)}`;
}
