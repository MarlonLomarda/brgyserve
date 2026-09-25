// A Philippine MOBILE number, in one of three forms and nothing else:
// 09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX — digits only, no spaces or
// dashes, the plus allowed only before 63.
//
// One pattern for every path that writes a contact number, so the rule cannot
// differ between them:
//   routes/rentalRequests.js  — a guest borrower's contact on a walk-in booking
//   routes/auth.js            — the contact number claimed at registration
//   routes/residentRecords.js — validateBody: the Secretary's add and edit
//                               forms, and every row of the CSV import
//   routes/secretary.js       — the create-and-link contact_number override
// Everywhere it is OPTIONAL: only a non-blank value is checked.
//
// This is what lets the masterlist CSV export leave contact_number out of its
// formula guard (utils/csv.js), which it must, because a real number may begin
// with +. A number that has to match this pattern cannot begin with =, - or @,
// and the only + it may carry is the one in front of 63 — and since every path
// into resident_records.contact_number now checks it, the column never needs
// that guard.
const PH_MOBILE_RE = /^(09\d{9}|\+?639\d{9})$/;

// The accepted forms, for error messages — kept beside the pattern so the two
// cannot disagree.
const PH_MOBILE_FORMS = '09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX, digits only';

// The ONE wording for a resident's contact number, whichever path refused it,
// so the registration form, the Secretary's forms and the CSV import preview
// all say the same thing. (A guest borrower's contact is a different field
// with its own name, and rentalRequests.js builds that message from
// PH_MOBILE_FORMS.)
const CONTACT_NUMBER_ERROR = `Contact number must be a Philippine mobile number: ${PH_MOBILE_FORMS}.`;

module.exports = { PH_MOBILE_RE, PH_MOBILE_FORMS, CONTACT_NUMBER_ERROR };
