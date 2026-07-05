// Canonical role values from docs/brgyserve-use-cases.md, mapped to each
// role's landing route.
export const ROLE_HOME = {
  secretary: '/secretary',
  punong_barangay: '/punong-barangay',
  treasurer: '/treasurer',
  staff: '/staff',
  resident: '/resident',
};

export const ROLE_LABELS = {
  secretary: 'Barangay Secretary',
  punong_barangay: 'Punong Barangay',
  treasurer: 'Barangay Treasurer',
  staff: 'Barangay Staff',
  resident: 'Barangay Resident',
};

// Staff-type roles the Secretary can create accounts for (residents
// self-register). Mirrors STAFF_ROLES in the backend secretary routes.
export const STAFF_ROLES = ['staff', 'treasurer', 'punong_barangay', 'secretary'];

export function roleHome(role) {
  return ROLE_HOME[role] || '/login';
}
