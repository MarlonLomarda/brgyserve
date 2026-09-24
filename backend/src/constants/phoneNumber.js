// A Philippine MOBILE number, in one of three forms and nothing else:
// 09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX — digits only, no spaces or
// dashes, the plus allowed only before 63.
//
// One pattern for every place a number is typed in by someone outside the
// barangay office, so the rule cannot differ between them:
//   routes/rentalRequests.js — a guest borrower's contact on a walk-in booking
//   routes/auth.js           — the contact number claimed at registration
//
// Registration is the one that matters for the CSV export. contact_number is
// the column the masterlist export deliberately leaves out of its formula
// guard (utils/csv.js), because a real number may begin with +. A number that
// has to match this pattern cannot begin with =, - or @, and the only + it may
// carry is the one in front of 63 — so the claimed number that create-and-link
// copies into resident_records never needs that guard.
const PH_MOBILE_RE = /^(09\d{9}|\+?639\d{9})$/;

// The accepted forms, for error messages — kept beside the pattern so the two
// cannot disagree.
const PH_MOBILE_FORMS = '09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX, digits only';

module.exports = { PH_MOBILE_RE, PH_MOBILE_FORMS };
