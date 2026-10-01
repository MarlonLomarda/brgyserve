const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { ACTIONS, LOGGED_TABLES } = require('../constants/activityLog');
const { scrub, withholdPersonal } = require('../services/activityLog');
const { parsePaging, pageResponse, isRangeError } = require('../utils/listQuery');

const router = express.Router();

// ===========================================================================
// ACTIVITY LOG — the read-only view of activity_logs (Table 18).
//
// The Secretary and the Punong Barangay only. A log row's old and new values
// can hold a resident's contact number, birthdate or address, so Staff, the
// Treasurer and residents get 403.
//
// READ-ONLY BY DESIGN. GET / is the only route and there must never be a
// write one: rows are written only by services/activityLog.js, after the
// action they describe. Nothing here edits, deletes or re-sends anything.
//
// The guard sits ON THE ROUTE, not on router.use — the disputes layout — so
// roles:test can see it: its probe runs each route's own guards, and a
// router-level requireRole would be invisible to it.
//
// What leaves this file:
//   - the actor as exactly { user_id, name, username, role } — no email, and
//     the users embed names its columns, so a password hash is never even
//     read. Never select users(*).
//   - old_value / new_value scrubbed AGAIN (rows written before a key joined
//     the deny-list, or inserted by hand in SQL, never went through
//     buildRow), then with every PERSONAL_FIELDS key removed and its name
//     listed in withheld_fields. The page shows "Contact number changed",
//     never the number.
//   - NO free-text search over the values. Matching a phone number would
//     reveal which rows hold it, which is the withheld value by another route.
// ===========================================================================

router.use(authenticate);

const LOG_VIEWERS = ['secretary', 'punong_barangay'];
const ROLES = ['secretary', 'punong_barangay', 'treasurer', 'staff', 'resident'];
const ACTION_CODES = Object.values(ACTIONS);

const LOG_FIELDS = 'log_id, timestamp, user_id, action, table_name, record_id, old_value, new_value';
const ACTOR_FIELDS = 'user_id, username, role, profiles ( first_name, middle_name, last_name, suffix )';
// !inner only when filtering on the actor's role: that filter lives on the
// embedded users row, and only an inner embed lets it remove the log row.
const selectFor = (byRole) => `${LOG_FIELDS}, users${byRole ? '!inner' : ''} ( ${ACTOR_FIELDS} )`;

const embedded = (v) => (Array.isArray(v) ? v[0] : v) || null;

// Same as notifications.js.
const personName = (p) => {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
  return p.suffix ? `${name}, ${p.suffix}` : name || null;
};

// Manila calendar days, the convention parseRange in reports.js uses:
// "YYYY-MM-DD" means that day in Manila, and the range is half-open, so the
// whole "to" day is included. Unlike parseRange there is no default window and
// either end may be left open — a log is read from today backwards.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const manilaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
function manilaDayStart(value) {
  if (!DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00+08:00`);
  // A date that does not exist (2026-02-30) rolls over; refuse it instead.
  if (Number.isNaN(d.getTime()) || manilaDate.format(d) !== value) return null;
  return d;
}

const positiveInt = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const given = (raw) => raw !== undefined && String(raw).trim() !== '';

// Every filter, validated before any query runs. An unknown value is a 400,
// never ignored: a filter that silently matched everything would put rows on
// screen under a heading that says they were filtered.
function parseFilters(query) {
  const f = {};

  const action = String(query.action ?? '').trim().toUpperCase();
  if (action && action !== 'ALL') {
    if (!ACTION_CODES.includes(action)) return { error: `Unknown action '${action}'` };
    f.action = action;
  }

  const table = String(query.table ?? '').trim().toLowerCase();
  if (table && table !== 'all') {
    if (!LOGGED_TABLES.includes(table)) return { error: `Unknown record type '${table}'` };
    f.table = table;
  }

  const role = String(query.role ?? '').trim().toLowerCase();
  if (role && role !== 'all') {
    if (!ROLES.includes(role)) return { error: `Unknown role '${role}'` };
    f.role = role;
  }

  if (given(query.user_id)) {
    f.userId = positiveInt(query.user_id);
    if (!f.userId) return { error: 'user_id must be a positive whole number' };
  }

  if (given(query.record_id)) {
    f.recordId = positiveInt(query.record_id);
    if (!f.recordId) return { error: 'record_id must be a positive whole number' };
    // An id means nothing without its table: 89 is a document request, a
    // charge and an account all at once.
    if (!f.table) return { error: 'record_id needs table too' };
  }

  const from = String(query.from ?? '').trim();
  const to = String(query.to ?? '').trim();
  if (from) {
    const d = manilaDayStart(from);
    if (!d) return { error: 'from must be a real date in YYYY-MM-DD format' };
    f.fromIso = d.toISOString();
  }
  if (to) {
    const d = manilaDayStart(to);
    if (!d) return { error: 'to must be a real date in YYYY-MM-DD format' };
    // Manila keeps no daylight saving, so the next day starts 24 hours later.
    f.toIso = new Date(d.getTime() + 24 * 3600e3).toISOString();
  }
  if (from && to && from > to) return { error: 'from must not be after to' };

  return { filters: f };
}

function applyFilters(query, f) {
  let q = query;
  if (f.action) q = q.eq('action', f.action);
  if (f.table) q = q.eq('table_name', f.table);
  if (f.recordId) q = q.eq('record_id', f.recordId);
  if (f.userId) q = q.eq('user_id', f.userId);
  if (f.role) q = q.eq('users.role', f.role);
  if (f.fromIso) q = q.gte('timestamp', f.fromIso);
  if (f.toIso) q = q.lt('timestamp', f.toIso);
  return q;
}

function toEntry(row) {
  const user = embedded(row.users);
  const before = withholdPersonal(scrub(row.old_value));
  const after = withholdPersonal(scrub(row.new_value));
  const withheld = [...new Set([...before.withheld, ...after.withheld])];
  const entry = {
    log_id: row.log_id,
    timestamp: row.timestamp,
    actor: {
      user_id: row.user_id,
      name: personName(embedded(user?.profiles)) || (user?.username ? `@${user.username}` : null),
      username: user?.username ?? null,
      role: user?.role ?? null,
    },
    action: row.action,
    table_name: row.table_name,
    record_id: row.record_id,
    old_value: before.value,
    new_value: after.value,
  };
  // Present only when something was withheld; absent means nothing was.
  if (withheld.length) entry.withheld_fields = withheld;
  return entry;
}

// GET /api/activity-logs?page=&per_page=&action=&table=&record_id=&user_id=&role=&from=&to=
router.get('/', requireRole(...LOG_VIEWERS), async (req, res) => {
  const parsed = parseFilters(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const f = parsed.filters;
  const { page, perPage, from, to } = parsePaging(req.query);

  const { data, error, count } = await applyFilters(
    supabase.from('activity_logs').select(selectFor(Boolean(f.role)), { count: 'exact' }),
    f,
  )
    .order('timestamp', { ascending: false })
    .order('log_id', { ascending: false })
    .range(from, to);

  if (error) {
    // A page past the end is an empty page — but with the TRUE total, so the
    // pager still shows and the screen can step back. supabase-js reports
    // count as null on this error, so ask for the count on its own.
    if (isRangeError(error)) {
      const { count: total, error: countError } = await applyFilters(
        supabase.from('activity_logs').select(f.role ? 'log_id, users!inner ( role )' : 'log_id', { count: 'exact', head: true }),
        f,
      );
      if (countError) throw new Error(`Failed to count the activity log: ${countError.message}`);
      return res.json(pageResponse('logs', [], total, page, perPage));
    }
    throw new Error(`Failed to load the activity log: ${error.message}`);
  }

  res.json(pageResponse('logs', (data || []).map(toEntry), count, page, perPage));
});

module.exports = router;
