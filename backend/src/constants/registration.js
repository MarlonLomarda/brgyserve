// Canonical vocabulary for declining a resident self-registration.
// Single source of truth — routes and the screen must not invent strings.
//
// UPPERCASE codes, matching charges and notifications (the other two fixed
// vocabularies stored in a varchar column) rather than the lowercase
// convention used for workflow statuses and roles.
//
// THE BARANGAY'S ELIGIBILITY RULE, confirmed with the Secretary: an applicant
// must be in the barangay masterlist AND must have been registered in that
// masterlist for at least six months. The two codes below are the two ways
// that rule fails; OTHER covers everything else and is the only code that
// requires a note.
//
// NOTE ON THE SIX-MONTH RULE: nothing in this file or in the routes computes
// it. resident_records.date_registered is the timestamp the row entered
// BrgyServe, not the barangay's own registration date — measured against the
// live data, every non-archived record would fail a six-month test. Adding a
// column that holds the real date is a separate, later task; today the
// Secretary applies the rule and records RESIDENCY_TOO_SHORT when it fails.

const REJECTION_REASON = {
  NOT_IN_MASTERLIST: 'NOT_IN_MASTERLIST',
  RESIDENCY_TOO_SHORT: 'RESIDENCY_TOO_SHORT',
  OTHER: 'OTHER',
};

// Per code: the Secretary-facing label, the sentence the APPLICANT is shown at
// login, and whether a note is mandatory.
//
// The applicant sentences must say what to do NEXT, not just state the
// verdict — a rejected applicant with no next step simply comes back to the
// same dead login. They deliberately do NOT tell anyone to register again:
// the account still exists and the username is taken, so re-registering would
// fail. The route back in is the Barangay Office and an un-reject.
//
// Every sentence is inside the GSM 03.38 alphabet (no em dash, no peso sign,
// no times sign) because the same string is sent as an SMS on rejection, and
// one character outside that set drops an SMS segment from 160 characters to
// 70. Each currently composes to a single segment once prefixed.
const REJECTION_REASON_META = {
  [REJECTION_REASON.NOT_IN_MASTERLIST]: {
    label: 'Not on the barangay masterlist',
    applicantMessage:
      'Your registration was not approved: your name is not on the barangay masterlist. Please visit the Barangay Office with a valid ID to be added.',
    requiresNote: false,
  },
  [REJECTION_REASON.RESIDENCY_TOO_SHORT]: {
    label: 'Less than six months of residency',
    applicantMessage:
      'Your registration was not approved: barangay records show under six months of residency. Please visit the Barangay Office to update your record.',
    requiresNote: false,
  },
  [REJECTION_REASON.OTHER]: {
    // The generic code carries a generic sentence on purpose. The specifics
    // live in the Secretary's note, which is never shown to the applicant, so
    // the note can name a record or a circumstance without that becoming a
    // message to the person it concerns.
    label: 'Other reason',
    applicantMessage:
      'Your registration was not approved. Please visit the Barangay Office for details.',
    requiresNote: true,
  },
};

const REJECTION_REASONS = Object.values(REJECTION_REASON);

const isRejectionReason = (code) => REJECTION_REASONS.includes(code);

// A note is mandatory only for OTHER: the two specific codes already say why.
const reasonRequiresNote = (code) => REJECTION_REASON_META[code]?.requiresNote === true;

// The sentence shown to the applicant at login, and (prefixed) sent as the
// rejection SMS. Falls back to the OTHER wording rather than returning
// undefined, so an unrecognised stored code can never render a blank message
// on the login screen.
const rejectionMessage = (code) =>
  REJECTION_REASON_META[code]?.applicantMessage ||
  REJECTION_REASON_META[REJECTION_REASON.OTHER].applicantMessage;

module.exports = {
  REJECTION_REASON,
  REJECTION_REASONS,
  REJECTION_REASON_META,
  isRejectionReason,
  reasonRequiresNote,
  rejectionMessage,
};
