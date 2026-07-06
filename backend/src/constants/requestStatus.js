// Canonical document-request status values — the single source of truth for
// the WHOLE workflow, agreed as: resident submits → Secretary approves or
// rejects → payment (record/verify) → release. The Punong Barangay only
// views/signs. Lowercase values, matching the role-value convention.
//
//   pending            resident submitted; awaiting Secretary review
//   approved           Secretary approved; awaiting payment (later stage)
//   rejected           Secretary rejected — terminal
//   ready_for_release  payment verified and document signed; awaiting pickup
//   claimed            released to the resident (claimed_at set) — terminal
//   cancelled          withdrawn by the resident before processing — terminal
//
// Later stages (Secretary processing, payments, release) must use these
// values — do not invent new status strings elsewhere.

const REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  READY_FOR_RELEASE: 'ready_for_release',
  CLAIMED: 'claimed',
  CANCELLED: 'cancelled',
};

const REQUEST_STATUSES = Object.values(REQUEST_STATUS);

module.exports = { REQUEST_STATUS, REQUEST_STATUSES };
