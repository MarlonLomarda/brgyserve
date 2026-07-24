// Dashboard nav tabs per role, shared by every page of that role's area.
export const SECRETARY_NAV = [
  { to: '/secretary', label: 'Resident review', end: true },
  { to: '/secretary/residents', label: 'Resident records' },
  { to: '/secretary/requests', label: 'Document requests' },
  { to: '/secretary/payments', label: 'Payments' },
  { to: '/secretary/document-types', label: 'Document types' },
  { to: '/secretary/rental-items', label: 'Rental items' },
  { to: '/secretary/rentals', label: 'Rentals' },
  { to: '/secretary/blotter', label: 'Blotter' },
];

export const RESIDENT_NAV = [
  { to: '/resident', label: 'My requests', end: true },
  { to: '/resident/request', label: 'Request a document' },
  { to: '/resident/rentals', label: 'My rentals' },
  { to: '/resident/book-rental', label: 'Book a facility' },
];

export const TREASURER_NAV = [{ to: '/treasurer', label: 'Payments', end: true }];

export const STAFF_NAV = [{ to: '/staff', label: 'Rental bookings', end: true }];

export const PUNONG_BARANGAY_NAV = [
  { to: '/punong-barangay', label: 'Rental bookings', end: true },
  { to: '/punong-barangay/blotter', label: 'Blotter' },
];
