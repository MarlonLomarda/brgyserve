// Report catalogue + shared formatting for the Reporting module.
//
// Each role sees only the reports it is entitled to: the Secretary gets the
// administrative set, the Treasurer the financial set, and the Punong Barangay
// sees BOTH read-only (oversight). The backend enforces the same split — this
// list only decides what the UI offers.

export const REPORTS = [
  {
    key: 'document-requests',
    title: 'Document request summary',
    description: 'Requests received, how they were resolved, and which documents are most requested.',
    group: 'Administrative',
    roles: ['secretary', 'punong_barangay'],
  },
  {
    key: 'residents',
    title: 'Resident statistics',
    description: 'Population of the master list, demographic breakdowns, and new registrations.',
    group: 'Administrative',
    roles: ['secretary', 'punong_barangay'],
  },
  {
    key: 'facility-utilization',
    title: 'Facility utilization',
    description: 'How often each facility and item is booked, and which are never used.',
    group: 'Administrative',
    roles: ['secretary', 'punong_barangay'],
  },
  {
    key: 'collections',
    title: 'Collections summary',
    description: 'Money collected versus outstanding, by charge type and payment method.',
    group: 'Financial',
    roles: ['treasurer', 'punong_barangay'],
  },
];

export const reportsForRole = (role) => REPORTS.filter((r) => r.roles.includes(role));

// Default window mirrors the backend: the last 12 months.
export function defaultRange() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return { from: start.toISOString().slice(0, 10), to };
}

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
export const formatPeso = (n) => peso.format(Number(n || 0));
export const formatCount = (n) => new Intl.NumberFormat('en-PH').format(Number(n || 0));

// "2026-07" -> "Jul 2026" for chart axes.
export function monthLabel(month) {
  if (!month) return '';
  const [y, m] = month.split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return new Intl.DateTimeFormat('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// Turn a snake_case metric key into a readable label.
export const humanize = (key) =>
  String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// A calm, readable palette — no gimmicks. Used for categorical bars.
export const CHART_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#c2410c', '#15803d', '#b91c1c'];
