// Display metadata for the notifications log. Reuses the existing badge
// variants in index.css rather than introducing new colours.

export const NOTIFICATION_STATUS_META = {
  PENDING: { label: 'Pending', className: 'status-pending' },
  // Deliberately its own badge, and worded as "Simulated" everywhere: a row
  // that was never sent must never look like one that was.
  SIMULATED: { label: 'Simulated', className: 'status-ready' },
  SENT: { label: 'Sent', className: 'status-claimed' },
  FAILED: { label: 'Failed', className: 'status-rejected' },
  SKIPPED: { label: 'No contact number', className: 'gray' },
};

export function notificationStatusMeta(status) {
  return NOTIFICATION_STATUS_META[status] || { label: status || '—', className: 'gray' };
}

export const NOTIFICATION_STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'SIMULATED', label: 'Simulated' },
  { value: 'SKIPPED', label: 'No contact number' },
  { value: 'SENT', label: 'Sent' },
  { value: 'FAILED', label: 'Failed' },
];

export const RELATED_TYPE_LABELS = {
  DOCUMENT_REQUEST: 'Document request',
  RENTAL_REQUEST: 'Facility rental',
  CHARGE: 'Payment',
  EVENT: 'Event',
};

export const RELATED_TYPE_FILTERS = [
  { value: 'all', label: 'All kinds' },
  { value: 'DOCUMENT_REQUEST', label: 'Document requests' },
  { value: 'RENTAL_REQUEST', label: 'Facility rentals' },
  { value: 'CHARGE', label: 'Payments' },
  { value: 'EVENT', label: 'Events' },
];

export function relatedLabel(row) {
  const kind = RELATED_TYPE_LABELS[row.related_type];
  if (!kind) return '—';
  return row.related_to ? `${kind} #${row.related_to}` : kind;
}
