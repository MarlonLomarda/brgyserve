// Display metadata for the canonical document-request status values
// (mirrors backend/src/constants/requestStatus.js).
export const STATUS_META = {
  pending: { label: 'Pending', className: 'status-pending' },
  approved: { label: 'Approved', className: 'status-approved' },
  rejected: { label: 'Rejected', className: 'status-rejected' },
  ready_for_release: { label: 'Ready for release', className: 'status-ready' },
  claimed: { label: 'Claimed', className: 'status-claimed' },
  cancelled: { label: 'Cancelled', className: 'status-cancelled' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status, className: 'gray' };
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
}
