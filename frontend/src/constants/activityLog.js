// Display metadata for the Activity Log page (activity_logs, Table 18).
//
// The vocabulary mirrors backend/src/constants/activityLog.js — ACTIONS and
// LOGGED_TABLES. The backend is CommonJS and this is ESM, so it is copied
// rather than imported, and activity:test fails if an action or a table is
// missing here.
//
// summarize() turns a row's old_value / new_value into one readable line. It
// never prints raw JSON: anything it does not recognise falls back to field
// names. Personal values never reach this file at all — the server removes
// them and lists their names in withheld_fields — so a withheld field is
// reported by name only ("Contact number changed").
import { CHARGE_META, METHOD_LABELS, STATUS_META } from './requestStatus';
import { ITEM_TYPE_LABELS, RENTAL_META } from './rentals';
import { EVENT_TYPE_LABELS } from './events';
import { rejectionReasonLabel } from './registration';
import { ROLE_LABELS } from '../auth/roles';
import { formatPeso } from './reports';

// Badge colours reuse the request-status classes: blue adds or allows, cyan
// edits, green completes, yellow records money or a credential, red refuses
// or removes, grey withdraws.
export const ACTION_META = {
  CREATE: { label: 'Created', className: 'status-approved' },
  UPDATE: { label: 'Edited', className: 'status-ready' },
  ARCHIVE: { label: 'Archived', className: 'status-rejected' },
  UNARCHIVE: { label: 'Unarchived', className: 'status-approved' },
  APPROVE: { label: 'Approved', className: 'status-approved' },
  REJECT: { label: 'Rejected', className: 'status-rejected' },
  UNREJECT: { label: 'Rejection lifted', className: 'status-approved' },
  LINK: { label: 'Linked', className: 'status-approved' },
  ACTIVATE: { label: 'Activated', className: 'status-approved' },
  DEACTIVATE: { label: 'Deactivated', className: 'status-rejected' },
  RELEASE: { label: 'Ready for release', className: 'status-ready' },
  CLAIM: { label: 'Claimed', className: 'status-claimed' },
  CANCEL: { label: 'Cancelled', className: 'status-cancelled' },
  RETURN: { label: 'Returned', className: 'status-claimed' },
  VERIFY_PAYMENT: { label: 'Payment verified', className: 'status-claimed' },
  SETTLE_PAYMENT: { label: 'Payment settled', className: 'status-claimed' },
  DECLARE_PAYMENT: { label: 'Payment declared', className: 'status-pending' },
  RECORD_ATTENDANCE: { label: 'Attendance recorded', className: 'status-claimed' },
  REMOVE_ATTENDANCE: { label: 'Attendance removed', className: 'status-cancelled' },
  GENERATE_FINES: { label: 'Fines raised', className: 'status-pending' },
  VOID_FINE: { label: 'Fine voided', className: 'status-rejected' },
  SETTLE: { label: 'Settled', className: 'status-claimed' },
  REOPEN: { label: 'Reopened', className: 'status-ready' },
  PASSWORD_CHANGE: { label: 'Password changed', className: 'status-pending' },
  PASSWORD_RESET: { label: 'Password reset', className: 'status-pending' },
  IMPORT: { label: 'Imported', className: 'status-ready' },
};

export function actionMeta(action) {
  return ACTION_META[action] || { label: humanize(action || 'unknown'), className: 'gray' };
}

export const TABLE_LABELS = {
  users: 'Account',
  profiles: 'Account link',
  resident_records: 'Resident record',
  household_records: 'Household',
  household_members: 'Household membership',
  document_types: 'Document type',
  document_requests: 'Document request',
  charges: 'Charge',
  rental_items: 'Rental item',
  rental_requests: 'Rental booking',
  events: 'Event',
  event_attendees: 'Event attendance',
  dispute_records: 'Blotter case',
};

export const ACTION_FILTERS = [
  { value: 'all', label: 'All actions' },
  ...Object.entries(ACTION_META).map(([value, m]) => ({ value, label: m.label })),
];
export const TABLE_FILTERS = [
  { value: 'all', label: 'All record types' },
  ...Object.entries(TABLE_LABELS).map(([value, label]) => ({ value, label })),
];
export const ROLE_FILTERS = [
  { value: 'all', label: 'Anyone' },
  ...Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
];

// --- time: always Manila, never the browser's zone --------------------------
const TIME_ZONE = 'Asia/Manila';
const stampFmt = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE });
const dayFmt = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: TIME_ZONE });
const clockFmt = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
const manilaDay = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE });

export const formatLogTime = (iso) => (iso ? stampFmt.format(new Date(iso)) : '—');

function formatSpan(start, end) {
  if (!start || !end) return start || end ? formatLogTime(start || end) : null;
  const s = new Date(start);
  const e = new Date(end);
  return manilaDay.format(s) === manilaDay.format(e)
    ? `${dayFmt.format(s)}, ${clockFmt.format(s)} – ${clockFmt.format(e)}`
    : `${formatLogTime(start)} – ${formatLogTime(end)}`;
}

// --- which record ------------------------------------------------------------
// The record a row is about, as a plain label. There are no links: no screen
// opens a record from the URL, and the Punong Barangay cannot open half of
// them. The page turns a label with a record_id into "show this record's
// history" instead.
export function recordLabel(row) {
  const v = row.new_value || row.old_value || {};
  if (row.table_name === 'event_attendees') {
    return v.event_id != null ? `Attendance at event #${v.event_id}` : `Event attendance #${row.record_id}`;
  }
  if (row.record_id == null) {
    if (row.action === 'IMPORT') return 'Masterlist import';
    if (row.action === 'GENERATE_FINES' && v.event_id != null) return `Fines for event #${v.event_id}`;
    return TABLE_LABELS[row.table_name] || humanize(row.table_name);
  }
  if (row.table_name === 'users' || row.table_name === 'profiles') return `Account #${row.record_id}`;
  return `${TABLE_LABELS[row.table_name] || humanize(row.table_name)} #${row.record_id}`;
}

// --- one line per row ----------------------------------------------------------
const FIELD_LABELS = {
  barangay_case_no: 'Case number',
  nature_of_case: 'Nature of case',
  filed_for: 'Filed for',
  date_filed: 'Date filed',
  time_filed: 'Time filed',
  is_active: 'Status',
  is_archived: 'Archive',
  is_settled: 'Case status',
  attendance_required: 'Attendance required',
  fine_amount: 'Fine',
  start_datetime: 'Start',
  end_datetime: 'End',
  quantity_requested: 'Quantity',
  quantity_total: 'Total units',
  quantity_available: 'Units available',
  masterlist_registered_on: 'Masterlist registration date',
  educational_attainment: 'Educational attainment',
  civil_status: 'Civil status',
  contact_number: 'Contact number',
  outside_borrower_name: "Guest's name",
  outside_borrower_contact: "Guest's contact number",
  // A blotter edit's count of corrected walk-in names — the log keeps the
  // count, never the names (typedNamesCorrected in routes/disputes.js).
  parties_renamed: 'Party names corrected',
};

function humanize(key) {
  const words = String(key).toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const fieldLabel = (key) => FIELD_LABELS[key] || humanize(key);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const methodLabel = (m) => METHOD_LABELS[m] || m || 'an unknown method';

const BOOLEAN_WORDS = {
  is_active: ['Inactive', 'Active'],
  is_archived: ['Not archived', 'Archived'],
  is_settled: ['Open', 'Settled'],
};
const MONEY_KEYS = ['fee', 'fine_amount', 'amount', 'amount_each', 'total_amount'];
const TIME_KEYS = ['start_datetime', 'end_datetime', 'date_created', 'registered_at', 'timestamp'];

function statusLabel(table, value) {
  if (table === 'charges') return CHARGE_META[value]?.label || value;
  if (table === 'rental_requests') return RENTAL_META[value]?.label || value;
  return STATUS_META[value]?.label || value;
}

// A value as words, or null when it is too long or too shapeless to print —
// the caller then says only that the field changed.
function formatValue(table, key, v) {
  if (v === null || v === undefined || v === '') return 'blank';
  if (typeof v === 'boolean') return (BOOLEAN_WORDS[key] || ['No', 'Yes'])[v ? 1 : 0];
  if (MONEY_KEYS.includes(key) && !Number.isNaN(Number(v))) return formatPeso(v);
  if (TIME_KEYS.includes(key)) return formatLogTime(v);
  if (key === 'status') return statusLabel(table, v);
  if (key === 'type') return (table === 'rental_items' ? ITEM_TYPE_LABELS : EVENT_TYPE_LABELS)[v] || v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (v.length > 40) return null;
    return /^\d{4}-\d{2}-\d{2}$|^\d{2}:\d{2}/.test(v) ? v : `“${v}”`;
  }
  return null;
}

function transition(table, before, after) {
  if (before === undefined && after === undefined) return null;
  return `${statusLabel(table, before)} to ${statusLabel(table, after)}`;
}

function personName(v) {
  const name = [v.first_name, v.middle_name, v.last_name].filter(Boolean).join(' ');
  return v.suffix ? `${name}, ${v.suffix}` : name;
}

function partyCounts(parties) {
  if (!Array.isArray(parties)) return null;
  const c = parties.filter((p) => p.role === 'Complainant').length;
  const r = parties.filter((p) => p.role === 'Respondent').length;
  return `${plural(c, 'complainant')}, ${plural(r, 'respondent')}`;
}

function createSummary(table, v) {
  switch (table) {
    case 'users':
      return `${ROLE_LABELS[v.role] || humanize(v.role || 'unknown')} account @${v.username}`;
    case 'resident_records':
      return [
        `Added ${personName(v) || 'a resident record'}`,
        v.duplicate_matches_confirmed > 0 && `confirmed past ${plural(v.duplicate_matches_confirmed, 'possible duplicate')}`,
        v.linked_user_id && `linked to account #${v.linked_user_id}`,
      ];
    case 'document_requests':
      return [
        `Document type #${v.document_type_id}`,
        v.resident_id && `for resident record #${v.resident_id}`,
        v.walk_in && 'walk-in',
      ];
    case 'rental_requests':
      return [
        `Item #${v.item_id} × ${v.quantity_requested}`,
        formatSpan(v.start_datetime, v.end_datetime),
        v.guest ? 'guest from another barangay' : v.resident_id && `resident record #${v.resident_id}`,
        v.walk_in && 'walk-in',
      ];
    case 'dispute_records':
      return [
        `Case ${v.barangay_case_no}`,
        v.nature_of_case,
        v.filed_for && `“${v.filed_for}”`,
        partyCounts(v.parties),
      ];
    case 'household_records':
      return `Head: resident record #${v.head_resident_id}`;
    case 'household_members':
      return [
        `Resident record #${v.resident_id} added as ${v.role}`,
        v.transferred_from_household_id && `moved from household #${v.transferred_from_household_id}`,
      ];
    case 'document_types':
      return [v.name && `“${v.name}”`, v.fee != null && formatPeso(v.fee)];
    case 'rental_items':
      return [
        v.name && `“${v.name}”`,
        ITEM_TYPE_LABELS[v.type] || v.type,
        v.quantity_total != null && plural(v.quantity_total, 'unit'),
        v.fee != null && formatPeso(v.fee),
      ];
    case 'events':
      return [
        `${EVENT_TYPE_LABELS[v.type] || 'Event'} “${v.title}”`,
        v.type === 'activity' && formatSpan(v.start_datetime, v.end_datetime),
        v.attendance_required && 'attendance required',
        v.fine_amount != null && `fine ${formatPeso(v.fine_amount)}`,
      ];
    default:
      return fieldList(v);
  }
}

function fieldList(v) {
  const keys = Object.keys(v || {});
  return keys.length ? `Recorded: ${keys.map(fieldLabel).join(', ')}` : null;
}

// An edit: one phrase per changed field. Withheld fields are named, never
// valued; a field with nothing printable is named too.
function updateSummary(table, before, after, withheld) {
  if (table === 'household_members') {
    if ('head_membership_id' in after) {
      return [
        before.head_resident_id
          ? `Head changed from resident record #${before.head_resident_id} to resident record #${after.head_resident_id}`
          : `Resident record #${after.head_resident_id} made head`,
        after.previous_head_role && `previous head now ${after.previous_head_role}`,
      ];
    }
    if ('date_ended' in after) return `Membership ended ${after.date_ended}`;
    if ('role' in after && Object.keys(after).length === 1) {
      return before.role === after.role ? `Role unchanged (${after.role})` : `Role ${before.role} to ${after.role}`;
    }
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => k !== 'memberships_ended');
  const changes = keys.map((key) => {
    if (key === 'parties') return 'Parties changed';
    if (key === 'parties_renamed') {
      const n = Number(after.parties_renamed) || 0;
      return n === 1 ? 'Party name corrected (1)' : `Party names corrected (${n})`;
    }
    const was = formatValue(table, key, before[key]);
    const now = formatValue(table, key, after[key]);
    return was === null || now === null ? `${fieldLabel(key)} changed` : `${fieldLabel(key)} ${was} to ${now}`;
  });
  for (const key of withheld) changes.push(`${fieldLabel(key)} changed`);
  if (after.memberships_ended) changes.push(`${plural(after.memberships_ended, 'membership')} ended`);
  return changes.length ? changes.join('; ') : 'No fields changed';
}

function actionSummary(row, before, after, withheld) {
  const t = row.table_name;
  switch (row.action) {
    case 'PASSWORD_CHANGE':
      return 'Changed their password';
    case 'PASSWORD_RESET':
      return 'Reset their password with an emailed link';
    case 'IMPORT':
      return `${plural(after.inserted_count ?? 0, 'record')} imported, ${after.skipped_count ?? 0} skipped`;
    case 'GENERATE_FINES': {
      const made = after.created_count ?? 0;
      const head = made > 0
        ? `${plural(made, 'fine')} of ${formatPeso(after.amount_each)} raised (${formatPeso(after.total_amount)})`
        : 'No new fines raised';
      return after.already_fined_count > 0 ? `${head}; ${after.already_fined_count} already fined` : head;
    }
    case 'RECORD_ATTENDANCE':
      return `Household ${after.household_id} marked present, by ${after.via === 'qr_scan' ? 'QR scan' : 'manual entry'}`;
    case 'REMOVE_ATTENDANCE':
      return `Household ${before.household_id} no longer marked present`;
    case 'DECLARE_PAYMENT':
      return `Declared payment: ${methodLabel(after.method)}`;
    case 'VERIFY_PAYMENT':
      return [
        transition(t, before.status, after.status),
        after.payment_method && methodLabel(after.payment_method),
        after.payment_id && `payment #${after.payment_id}`,
      ];
    case 'SETTLE_PAYMENT':
      return [
        transition(t, before.status, after.status),
        'GCash',
        after.payment_id && `payment #${after.payment_id}`,
        after.via === 'recheck' && "confirmed by the resident's re-check",
        after.via === 'reconcile' && 'confirmed by Re-check with PayMongo',
      ];
    case 'VOID_FINE':
      return [
        transition(t, before.status, after.status),
        after.household_id && `household ${after.household_id}'s fine for event #${after.event_id}`,
      ];
    case 'SETTLE':
    case 'REOPEN':
      return after.is_settled ? 'Open to Settled' : 'Settled to Open';
    case 'ACTIVATE':
    case 'DEACTIVATE':
      if (t === 'users') return after.is_active ? 'Pending to Active' : 'Active to Inactive';
      return after.is_active ? 'Inactive to Active' : 'Active to Inactive';
    case 'ARCHIVE':
    case 'UNARCHIVE': {
      const words = after.is_archived ? 'Not archived to Archived' : 'Archived to Not archived';
      const ids = after.deactivated_user_ids || after.reactivated_user_ids;
      if (!Array.isArray(ids)) return words;
      const verb = after.deactivated_user_ids ? 'deactivated' : 'reactivated';
      return [words, ids.length ? `${plural(ids.length, 'linked account')} ${verb}` : 'no linked account'];
    }
    case 'REJECT':
      if (t === 'users') return `Registration rejected: ${rejectionReasonLabel(after.rejection_reason)}`;
      return transition(t, before.status, after.status);
    case 'UNREJECT':
      return before.rejection_reason
        ? `Rejection lifted (was: ${rejectionReasonLabel(before.rejection_reason)})`
        : 'Rejection lifted';
    case 'LINK':
      return [
        before.resident_id
          ? `Moved from resident record #${before.resident_id} to #${after.resident_id}`
          : `Linked to resident record #${after.resident_id}`,
        after.contact_backfilled && 'contact number copied from registration',
      ];
    case 'CREATE':
      return createSummary(t, after);
    case 'UPDATE':
      return updateSummary(t, before, after, withheld);
    default:
      if ('status' in before || 'status' in after) return transition(t, before.status, after.status);
      return fieldList({ ...before, ...after });
  }
}

export function summarize(row) {
  const before = row.old_value || {};
  const after = row.new_value || {};
  const withheld = row.withheld_fields || [];
  const raw = actionSummary(row, before, after, withheld);
  const parts = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
  // An edit already named its withheld fields; anything else says so here.
  if (row.action !== 'UPDATE' && withheld.length) parts.push(`${withheld.map(fieldLabel).join(', ')} not shown`);
  return parts.length ? parts.join(' · ') : 'No details recorded';
}
