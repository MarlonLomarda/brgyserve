// Dashboard nav tabs per role, shared by every page of that role's area.
export const SECRETARY_NAV = [
  { to: '/secretary', label: 'Resident review', end: true },
  { to: '/secretary/requests', label: 'Document requests' },
  { to: '/secretary/payments', label: 'Payments' },
  { to: '/secretary/document-types', label: 'Document types' },
  { to: '/secretary/rental-items', label: 'Rental items' },
];

export const RESIDENT_NAV = [
  { to: '/resident', label: 'My requests', end: true },
  { to: '/resident/request', label: 'Request a document' },
];

export const TREASURER_NAV = [{ to: '/treasurer', label: 'Payments', end: true }];
