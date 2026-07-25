// Display metadata for Events & Activities (mirrors backend/src/constants/events.js).
// One table, two kinds: a timed `activity` and an untimed `announcement`.
// Status is derived server-side (`status` on every row) — never stored.

export const EVENT_TYPE_LABELS = {
  announcement: 'Announcement',
  activity: 'Activity',
};

export const EVENT_STATUS_META = {
  posted: { label: 'Posted', className: 'status-approved' },
  upcoming: { label: 'Upcoming', className: 'status-pending' },
  ongoing: { label: 'Ongoing', className: 'status-approved' },
  past: { label: 'Past', className: 'status-claimed' },
};

export function eventStatusMeta(status) {
  return EVENT_STATUS_META[status] || { label: status, className: 'gray' };
}

export const EVENT_VIEWS = [
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past activities' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

const dateFmt = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' });

// "Aug 3, 2026, 8:00 AM – 5:00 PM" for a same-day activity, or
// "Aug 3, 2026, 8:00 AM – Aug 5, 2026, 12:00 PM" when it spans days.
// Announcements with no window show an em dash.
export function formatWindow(start, end) {
  if (!start && !end) return '—';
  if (!start || !end) {
    const only = new Date(start || end);
    return `${dateFmt.format(only)}, ${timeFmt.format(only)}`;
  }
  const s = new Date(start);
  const e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString();
  return sameDay
    ? `${dateFmt.format(s)}, ${timeFmt.format(s)} – ${timeFmt.format(e)}`
    : `${dateFmt.format(s)}, ${timeFmt.format(s)} – ${dateFmt.format(e)}, ${timeFmt.format(e)}`;
}

// ISO -> the value a <input type="datetime-local"> expects, in local time.
const pad = (n) => String(n).padStart(2, '0');
export function toDateTimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
