// Household member roles — mirrors backend/src/constants/households.js.
// Keep the two in sync; the backend is the enforcing copy.
export const HOUSEHOLD_ROLE = {
  HEAD: 'Head',
  SPOUSE: 'Spouse',
  CHILD: 'Child',
  RELATIVE: 'Relative',
  OTHER: 'Other',
};

export const HOUSEHOLD_ROLES = Object.values(HOUSEHOLD_ROLE);

// Roles selectable in the UI. 'Head' is excluded everywhere a role is chosen:
// headship changes only through the "Make head" action, so a household can
// never end up with two heads via a role edit.
export const ASSIGNABLE_ROLES = HOUSEHOLD_ROLES.filter((r) => r !== HOUSEHOLD_ROLE.HEAD);
