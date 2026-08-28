// Display metadata for registration rejection, mirroring
// backend/src/constants/registration.js. Kept as a separate module for the
// same reason constants/notifications.js is: the backend is CommonJS and the
// frontend is ESM, so the vocabulary is duplicated rather than imported.
//
// THE BACKEND IS THE AUTHORITY on which codes exist and what a rejected
// applicant is told — this file only supplies Secretary-facing labels for the
// reject form and the rejected-card summary. The applicant-facing sentence is
// deliberately NOT copied here: it is never rendered by this app (the
// applicant sees it in the login 403), so a copy could only ever drift.

export const REJECTION_REASON_OPTIONS = [
  { value: 'NOT_IN_MASTERLIST', label: 'Not on the barangay masterlist', requiresNote: false },
  { value: 'RESIDENCY_TOO_SHORT', label: 'Less than six months of residency', requiresNote: false },
  { value: 'OTHER', label: 'Other reason', requiresNote: true },
];

export const REJECTION_REASON_LABELS = Object.fromEntries(
  REJECTION_REASON_OPTIONS.map((o) => [o.value, o.label])
);

export const rejectionReasonLabel = (code) => REJECTION_REASON_LABELS[code] || code || '—';

export const rejectionReasonRequiresNote = (code) =>
  REJECTION_REASON_OPTIONS.find((o) => o.value === code)?.requiresNote === true;

// Drives the ?status= filter on GET /api/secretary/pending-residents. The
// server rejects an unknown value with a 400 rather than falling back, so
// these three values must match the server's list exactly.
export const PENDING_STATUS_FILTERS = [
  { value: 'pending', label: 'Awaiting review' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];
