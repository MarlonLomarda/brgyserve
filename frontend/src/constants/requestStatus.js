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

// Charge statuses are UPPERCASE (mirrors backend/src/constants/charges.js).
export const CHARGE_META = {
  UNPAID: { label: 'Unpaid', className: 'status-pending' },
  PAID: { label: 'Paid', className: 'status-claimed' },
  VOID: { label: 'Void', className: 'status-cancelled' },
};

export function chargeMeta(status) {
  return CHARGE_META[status] || { label: status, className: 'gray' };
}

// The charges embed arrives as an array (or object once the UNIQUE
// constraint lets PostgREST detect one-to-one) — normalize to one-or-null.
export function chargeOf(request) {
  const c = request?.charges;
  return Array.isArray(c) ? c[0] || null : c || null;
}
