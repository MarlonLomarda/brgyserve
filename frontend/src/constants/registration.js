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

// ---------------------------------------------------------------------------
// RESIDENCY — display only.
//
// The server derives { months, days, meets_minimum } and sends `residency`,
// or NULL when there is no masterlist date on file. THE CALLER MUST TEST FOR
// THE OBJECT AND RENDER NOTHING WHEN IT IS ABSENT — no date, no badge, no
// "unknown" pill. A placeholder in that slot reads as "under six months" to
// anyone glancing at the screen, which would have the Secretary decline people
// for failing a test that never ran.
//
// Presence is the only thing checked. NEVER the viewer's role: the server has
// already decided what to send, and a role check here would be a second
// opinion free to disagree with it.
//
// The six-month threshold is NOT duplicated here. `meets_minimum` arrives
// decided from the server, so this file cannot drift out of step with the rule.
// ---------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "7 years 6 months" / "4 months 22 days" / "18 days"
export function formatResidency(residency) {
  if (!residency) return null;
  const { months = 0, days = 0 } = residency;

  if (months >= 12) {
    const years = Math.floor(months / 12);
    const rem = months % 12;
    return rem ? `${plural(years, 'year')} ${plural(rem, 'month')}` : plural(years, 'year');
  }
  if (months > 0) {
    return days ? `${plural(months, 'month')} ${plural(days, 'day')}` : plural(months, 'month');
  }
  return plural(days, 'day');
}

// Advisory badge. Reuses the amber .badge.status-pending variant already in
// index.css rather than introducing a colour — it is a caution, not an error,
// and it never gates anything.
export const RESIDENCY_BADGE = {
  label: 'Under 6 months',
  className: 'status-pending',
  title: 'Registered in the barangay masterlist less than six months ago. Advisory only — you can still activate this account.',
};
