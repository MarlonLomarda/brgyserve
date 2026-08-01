// Canonical household vocabulary (schema Table 3, household_members.role).
//
// Chapter 3 documents "Head, Spouse, Child, Relative"; 'Other' is included so
// real households that don't fit those four (a boarder, a ward) can still be
// recorded rather than forced into a wrong role.
//
// Households are identified by their HEAD, not by address — two households may
// legitimately share an address, and there is no head column on
// household_records: the head is derived from the member whose role is 'Head'.
const HOUSEHOLD_ROLE = {
  HEAD: 'Head',
  SPOUSE: 'Spouse',
  CHILD: 'Child',
  RELATIVE: 'Relative',
  OTHER: 'Other',
};

const HOUSEHOLD_ROLES = Object.values(HOUSEHOLD_ROLE);

// Display order for a household's member list: the head always first, then the
// rest in household seniority order.
const ROLE_ORDER = Object.fromEntries(HOUSEHOLD_ROLES.map((role, i) => [role, i]));

module.exports = { HOUSEHOLD_ROLE, HOUSEHOLD_ROLES, ROLE_ORDER };
