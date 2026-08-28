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

// ===========================================================================
// RESIDENCY — how long a resident has been on the barangay masterlist.
//
// DISPLAY-ONLY AND NEVER STORED, the same rule as deriveStatus() in
// routes/rentalRequests.js and routes/events.js: the time comparison lives in
// exactly one place, GETs stay read-only, and no scheduler is needed because
// nothing has to be recomputed on a clock.
//
// It lives HERE rather than in a route file (which is where the two
// deriveStatus() precedents sit) because TWO route files serve it —
// residentRecords.js for the master list and secretary.js for the review
// screen. Putting it beside RESIDENCY_MINIMUM_MONTHS also keeps the threshold
// next to RESIDENCY_TOO_SHORT, the reason code it justifies.
//
// IT IS ADVISORY. Nothing in the codebase blocks, disables or gates anything
// on meets_minimum. The Secretary reads it and decides.
// ===========================================================================

const RESIDENCY_MINIMUM_MONTHS = 6;

// Manila is UTC+8 with no DST, so shifting the epoch by +8h and reading the
// UTC parts gives the Manila calendar date without a timezone library. Same
// approach as the explicit +08:00 composition used elsewhere in the backend.
function manilaToday() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Elapsed time since the masterlist registration date.
 *
 * RETURNS null WHEN THERE IS NO DATE ON FILE, AND THAT IS THE ONLY CORRECT
 * ANSWER. It must never return a shape with meets_minimum: false for a
 * missing date. `false` is a POSITIVE CLAIM — "we checked, they do not meet
 * the six months" — and a client cannot tell it apart from "there was nothing
 * to check". Every record the barangay simply has no date for would render an
 * under-six-months badge, and the Secretary would decline people for failing a
 * test that never ran. This is the same defect as `account: null` on the
 * resident list and `linked_accounts: []` on its detail (see the Standing
 * Rules in CLAUDE.md), in a new place: a value that looks like an answer
 * standing in for the absence of one.
 *
 * @param {string|null} masterlistRegisteredOn - 'YYYY-MM-DD' or null
 * @returns {{ months: number, days: number, meets_minimum: boolean }|null}
 */
function deriveResidency(masterlistRegisteredOn) {
  if (!masterlistRegisteredOn) return null;

  const parts = DATE_ONLY_RE.exec(String(masterlistRegisteredOn).slice(0, 10));
  // Unparseable is treated exactly like absent: showing nothing beats showing
  // a number derived from something the code did not understand.
  if (!parts) return null;

  const from = { y: Number(parts[1]), m: Number(parts[2]), d: Number(parts[3]) };
  const today = manilaToday();

  let months = (today.y - from.y) * 12 + (today.m - from.m);
  // The day-of-month anniversary has not come round yet this month.
  if (today.d < from.d) months -= 1;

  // Defensive only: validateOptionalDate rejects a future date on both the add
  // and edit paths, so this is unreachable through the API. A future date
  // certainly does not meet a six-month minimum, and reporting negative
  // elapsed time would be worse than reporting none.
  if (months < 0) return { months: 0, days: 0, meets_minimum: false };

  // Days since that anniversary. Date's own month arithmetic rolls overflow
  // forward (31 Jan + 1 month lands in March), which can put the anniversary
  // marginally past today for end-of-month dates — clamped rather than shown
  // as negative, since this is a display remainder and not a calculation
  // anything depends on.
  const anniversary = Date.UTC(from.y, from.m - 1 + months, from.d);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  const days = Math.max(0, Math.round((todayUtc - anniversary) / 86400000));

  // >= : exactly six months COUNTS as meeting the rule, which is what "at
  // least six months" means.
  return { months, days, meets_minimum: months >= RESIDENCY_MINIMUM_MONTHS };
}

// Attaches the derived value to a row carrying masterlist_registered_on.
// Mirrors withStatus()/withDerived() in the events and rentals routes.
const withResidency = (row) =>
  (row ? { ...row, residency: deriveResidency(row.masterlist_registered_on) } : row);

module.exports = {
  REJECTION_REASON,
  REJECTION_REASONS,
  REJECTION_REASON_META,
  isRejectionReason,
  reasonRequiresNote,
  rejectionMessage,
  RESIDENCY_MINIMUM_MONTHS,
  deriveResidency,
  withResidency,
};
