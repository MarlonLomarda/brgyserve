// ===========================================================================
// RENTAL EDIT AND CANCEL — the Secretary's Edit and Cancel, the resident's own
// cancel, and a GCash payment that arrives for a cancelled booking.
//
//   cd backend && npm run rentals:test
//
// The rules, decided 25 Oct 2026:
//   - Edit changes only the date, the times and the purpose of a booking that
//     has not started (stored confirmed, start still ahead). The quantity is
//     fixed, the charge is never touched, and the borrower is told.
//   - The Secretary cancels only a booking that has not started, and must give
//     a reason (3 to 300 characters), which the borrower is sent. An UNPAID
//     charge becomes VOID; a PAID one stays PAID and the refund is due by hand.
//     An open GCash checkout on the voided charge is expired, best effort.
//   - A resident cancels their OWN online booking only, at least 24 hours
//     before it starts, while it is unpaid (or a PHP 0 booking). They are not
//     notified: they just did it.
//   - A payment the webhook receives for a VOID charge writes one activity log
//     row, and nothing else.
//
// Makes NO network calls and touches NO database: the Supabase URL and key are
// dead values set before anything loads, fetch records its call and throws,
// and supabase.from is replaced by in-memory tables built fresh for every
// call. The real handlers run, taken from router.stack past the router-level
// authenticate, with req.user supplied. PayMongo's expire call is replaced on
// the module object, except in the one check that lets the real client reach
// the dead fetch to prove which url and method it would use.
// ===========================================================================
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'rentals-test-no-network';
process.env.JWT_SECRET = 'rentals-test-signing-key';
process.env.PAYMONGO_SECRET_KEY = 'sk_test_rentals-test-no-network';
process.env.PAYMONGO_WEBHOOK_SECRET = 'whsk_rentals_test_no_network';
process.env.SMS_MODE = 'SIMULATED';
process.env.EMAIL_MODE = 'SIMULATED';

const netCalls = [];
globalThis.fetch = async (url, init = {}) => {
  netCalls.push({ url: String(url), method: init.method || 'GET' });
  throw new Error(`rentals:test must not reach the network (${url})`);
};

const crypto = require('crypto');
const supabase = require('../src/config/supabase');
const paymongo = require('../src/services/paymongo');
const rentals = require('../src/routes/rentalRequests');
const { webhookHandler } = require('../src/routes/payments');

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

// --- time, as the routes format it ------------------------------------------
const HOUR = 3600 * 1000;
// Whole minutes, so a stored time and the HH:MM the edit form sends can agree.
const NOW = Math.floor(Date.now() / 60000) * 60000;
const TZ = 'Asia/Manila';
const timeFmt = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, dateStyle: 'medium' });
const manilaDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const iso = (ms) => new Date(ms).toISOString();
const at = (hoursFromNow) => iso(NOW + hoursFromNow * HOUR);
// A Manila calendar day `days` from now, as the edit form sends it.
const dayAhead = (days) => manilaDay.format(new Date(NOW + days * 24 * HOUR));
const manilaIso = (day, hhmm) => new Date(`${day}T${hhmm}:00+08:00`).toISOString();
const schedule = (startIso, endIso) =>
  `${dateFmt.format(new Date(startIso))}, ${timeFmt.format(new Date(startIso))} to ${timeFmt.format(new Date(endIso))}`;

const SEC = { user_id: 7001, username: 'rentals_probe_secretary', role: 'secretary' };
const RES_A = { user_id: 7101, username: 'rentals_probe_a', role: 'resident' };
const RES_B = { user_id: 7102, username: 'rentals_probe_b', role: 'resident' };
const RES_UNLINKED = { user_id: 7103, username: 'rentals_probe_unlinked', role: 'resident' };

const EDIT_DAY = dayAhead(5);
const CLASH_DAY = dayAhead(6);

// --- the tables ----------------------------------------------------------------
// Bookings 601-612 are chairs unless said otherwise; 620/621 share the court.
//   601 A online, +72h, UNPAID with an open checkout      607 started an hour ago
//   602 A online, +23h, UNPAID                            608 past, chairs: Overdue
//   603 A online, +72h, PAID PHP 50                       609 past, court: Completed
//   604 A online, +72h, PAID PHP 0 (no fee)               610 cancelled, charge VOID
//   605 B online, +72h, UNPAID                            611 a guest walk-in, UNPAID
//   606 A walk-in filed by the Secretary, UNPAID          612 A online, no charge at all
function freshDb() {
  const booking = (id, extra) => ({
    request_id: id, item_id: 802, requested_by_user_id: RES_A.user_id, resident_id: 9101,
    outside_borrower_name: null, outside_borrower_contact: null,
    quantity_requested: 10, start_datetime: at(72), end_datetime: at(75), purpose: 'Family reunion',
    status: 'confirmed', processed_by_user_id: null, cancellation_reason: null,
    return_note: null, returned_at: null, returned_by_user_id: null, ...extra,
  });
  const charge = (id, requestId, status, amount, extra = {}) => ({
    charge_id: id, charge_type: 'RENTAL', amount, status, user_id: RES_A.user_id, rental_request_id: requestId,
    document_request_id: null, household_id: null, paymongo_session_id: null, paymongo_payment_id: null,
    declared_method: null, declared_reference: null, declared_at: null, created_at: at(-48), ...extra,
  });
  return {
    calls: [],
    failWhen: null,
    afterUpdate: null,
    users: [SEC, RES_A, RES_B, RES_UNLINKED].map((u) => ({ ...u, email: null })),
    profiles: [
      { user_id: SEC.user_id, resident_id: null },
      { user_id: RES_A.user_id, resident_id: 9101 },
      { user_id: RES_B.user_id, resident_id: 9102 },
      { user_id: RES_UNLINKED.user_id, resident_id: null },
    ],
    resident_records: [
      { resident_id: 9101, first_name: 'Ana', middle_name: null, last_name: 'Probe', suffix: null, contact_number: '09170000001', is_archived: false },
      { resident_id: 9102, first_name: 'Ben', middle_name: null, last_name: 'Probe', suffix: null, contact_number: '09170000002', is_archived: false },
    ],
    rental_items: [
      { item_id: 801, name: 'Covered Court', type: 'facility', fee: 500, quantity_total: 1, quantity_available: 1, is_active: true },
      { item_id: 802, name: 'Monobloc Chair', type: 'furniture', fee: 5, quantity_total: 100, quantity_available: 100, is_active: true },
    ],
    rental_requests: [
      booking(601),
      booking(602, { start_datetime: at(23), end_datetime: at(25) }),
      booking(603),
      booking(604),
      booking(605, { requested_by_user_id: RES_B.user_id, resident_id: 9102 }),
      booking(606, { requested_by_user_id: SEC.user_id }),
      booking(607, { start_datetime: at(-1), end_datetime: at(2) }),
      booking(608, { start_datetime: at(-10), end_datetime: at(-5) }),
      booking(609, { item_id: 801, quantity_requested: 1, start_datetime: at(-10), end_datetime: at(-5) }),
      booking(610, { status: 'cancelled', processed_by_user_id: SEC.user_id }),
      booking(611, { requested_by_user_id: SEC.user_id, resident_id: null,
        outside_borrower_name: 'Pedro Guest', outside_borrower_contact: '09179990000' }),
      booking(612),
      booking(620, { item_id: 801, quantity_requested: 1,
        start_datetime: manilaIso(CLASH_DAY, '08:00'), end_datetime: manilaIso(CLASH_DAY, '10:00') }),
      booking(621, { item_id: 801, quantity_requested: 1,
        start_datetime: manilaIso(CLASH_DAY, '12:00'), end_datetime: manilaIso(CLASH_DAY, '14:00') }),
    ],
    charges: [
      charge(1601, 601, 'UNPAID', 50, { paymongo_session_id: 'cs_test_601' }),
      charge(1602, 602, 'UNPAID', 50),
      charge(1603, 603, 'PAID', 50),
      charge(1604, 604, 'PAID', 0),
      charge(1605, 605, 'UNPAID', 50, { user_id: RES_B.user_id }),
      charge(1606, 606, 'UNPAID', 50),
      charge(1607, 607, 'UNPAID', 50),
      charge(1608, 608, 'UNPAID', 50),
      charge(1609, 609, 'UNPAID', 500),
      charge(1610, 610, 'VOID', 50, { paymongo_session_id: 'cs_test_610' }),
      charge(1611, 611, 'UNPAID', 50, { user_id: null }),
      charge(1620, 620, 'UNPAID', 500),
      charge(1621, 621, 'UNPAID', 500),
    ],
    payments: [],
    notifications: [],
    activity_logs: [],
  };
}

// --- a PostgREST-shaped query builder over those tables -------------------------
// Answers only the shapes these routes use. Embeds are resolved by name for the
// relations modelled below; any other embed (the requester, the account hop)
// comes back null, which the routes tolerate.
const RELATIONS = {
  rental_requests: {
    rental_items: { table: 'rental_items', local: 'item_id', foreign: 'item_id' },
    resident_records: { table: 'resident_records', local: 'resident_id', foreign: 'resident_id' },
    charges: { table: 'charges', local: 'request_id', foreign: 'rental_request_id', many: true },
  },
  charges: {
    rental_requests: { table: 'rental_requests', local: 'rental_request_id', foreign: 'request_id' },
  },
};

// Splits "a, b ( c, d ), e" at the top level only.
function splitTop(sel) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(sel)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function shape(db, table, row, sel) {
  if (sel === '*') return { ...row };
  const out = {};
  for (const token of splitTop(sel)) {
    const open = token.indexOf('(');
    if (open === -1) { out[token] = row[token] ?? null; continue; }
    const head = token.slice(0, open).trim();
    const inner = token.slice(open + 1, token.lastIndexOf(')'));
    if (head.startsWith('...')) continue;
    const [alias, target] = head.includes(':') ? head.split(':') : [head, head];
    const rel = RELATIONS[table]?.[target.split('!')[0]];
    if (!rel || alias !== target) { out[alias] = null; continue; }
    const matches = db[rel.table].filter((r) => r[rel.foreign] === row[rel.local]);
    out[alias] = rel.many
      ? matches.map((m) => shape(db, rel.table, m, inner))
      : (matches[0] ? shape(db, rel.table, matches[0], inner) : null);
  }
  return out;
}

const cmp = (a, b) => {
  const da = Date.parse(a);
  const dbv = Date.parse(b);
  return Number.isNaN(da) || Number.isNaN(dbv) ? (a < b ? -1 : a > b ? 1 : 0) : da - dbv;
};

function fakeFrom(db) {
  return (table) => {
    if (!Array.isArray(db[table])) throw new Error(`unexpected table ${table}`);
    const q = { op: 'select', sel: '*', filters: [], patch: null, rows: null, single: false };
    const matches = (row) => q.filters.every(([op, c, v]) => {
      if (op === 'eq') return row[c] === v;
      if (op === 'neq') return row[c] !== v;
      if (op === 'lt') return cmp(row[c], v) < 0;
      if (op === 'gt') return cmp(row[c], v) > 0;
      if (op === 'in') return v.includes(row[c]);
      throw new Error(`unmodelled filter ${op}`);
    });
    const run = () => {
      const injected = db.failWhen?.({ table, op: q.op, patch: q.patch, filters: q.filters });
      if (injected) {
        db.calls.push({ table, op: q.op, patch: q.patch, filters: q.filters, failed: true });
        return { data: null, error: injected };
      }
      if (q.op === 'insert') {
        db.calls.push({ table, op: 'insert', rows: q.rows });
        db[table].push(...[].concat(q.rows).map((r) => structuredClone(r)));
        return { data: null, error: null };
      }
      const rows = db[table].filter(matches);
      if (q.op === 'update') {
        db.calls.push({ table, op: 'update', patch: q.patch, filters: q.filters });
        for (const row of rows) Object.assign(row, q.patch);
        if (db.afterUpdate) db.afterUpdate({ table, patch: q.patch, filters: q.filters });
      }
      if (q.op === 'delete') {
        db.calls.push({ table, op: 'delete', filters: q.filters });
        db[table] = db[table].filter((r) => !rows.includes(r));
      }
      const out = rows.map((row) => shape(db, table, row, q.sel));
      if (!q.single) return { data: out, error: null };
      if (out.length > 1) return { data: null, error: { message: 'more than one row' } };
      return { data: out[0] ?? null, error: null };
    };
    const b = {
      select(sel) { q.sel = sel ?? '*'; return b; },
      eq(c, v) { q.filters.push(['eq', c, v]); return b; },
      neq(c, v) { q.filters.push(['neq', c, v]); return b; },
      lt(c, v) { q.filters.push(['lt', c, v]); return b; },
      gt(c, v) { q.filters.push(['gt', c, v]); return b; },
      in(c, v) { q.filters.push(['in', c, v]); return b; },
      order() { return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      insert(rows) { q.op = 'insert'; q.rows = rows; return b; },
      delete() { q.op = 'delete'; return b; },
      maybeSingle() { q.single = true; return b; },
      single() { q.single = true; return b; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return b;
  };
}

// --- calling the real handlers -------------------------------------------------
const handlerFor = (router, method, routePath) => {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath} on the router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const realExpire = paymongo.expireCheckoutSession;

// Runs one request against fresh tables. `setup(db)` adjusts them first;
// `expire` stands in for PayMongo's expire call ('real' leaves the client alone).
async function call({ method, path, user, id, body = {}, setup, expire, req: extraReq }) {
  const db = freshDb();
  if (setup) setup(db);
  supabase.from = fakeFrom(db);
  const expireCalls = [];
  if (expire !== 'real') {
    paymongo.expireCheckoutSession = async (sessionId) => {
      expireCalls.push(sessionId);
      if (expire) return expire(sessionId);
      return {};
    };
  } else {
    paymongo.expireCheckoutSession = realExpire;
  }
  const consoleSeen = { warn: [], error: [] };
  const origWarn = console.warn;
  const origError = console.error;
  const origLog = console.log;
  console.warn = (...a) => consoleSeen.warn.push(a.join(' '));
  console.error = (...a) => consoleSeen.error.push(a.join(' '));
  console.log = () => {}; // the simulated SMS provider's own line
  const netBefore = netCalls.length;
  let res;
  try {
    const handler = handlerFor(rentals, method, path);
    res = await new Promise((resolve, reject) => {
      let done = false;
      const resObj = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { done = true; resolve({ status: this.statusCode, body: b }); return this; },
      };
      const req = { user, params: { id: String(id) }, body, query: {}, headers: {}, ...extraReq };
      Promise.resolve(handler(req, resObj)).then(() => { if (!done) resolve({ status: 'no response', body: null }); }, reject);
    });
  } catch (e) {
    res = { status: 'threw', body: { error: e.message } };
  } finally {
    console.warn = origWarn;
    console.error = origError;
    console.log = origLog;
    paymongo.expireCheckoutSession = realExpire;
  }
  const booking = (n) => db.rental_requests.find((r) => r.request_id === n);
  const chargeOfBooking = (n) => db.charges.find((c) => c.rental_request_id === n);
  return { ...res, db, booking, chargeOfBooking, expireCalls, consoleSeen, net: netCalls.slice(netBefore) };
}

const said = (r) => `${r.status} ${r.body?.error || r.body?.message || ''}`.trim();
const editBody = (extra = {}) => ({
  date: EDIT_DAY, start_time: '08:00', end_time: '10:00', purpose: 'Family reunion', quantity_requested: 10, ...extra,
});
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOT_STARTED_EDIT = 'Only a booking that has not started can be changed.';
const QUANTITY_FIXED = 'The quantity cannot be changed. Cancel this booking and book again.';
const NOT_STARTED_CANCEL = 'Only a booking that has not started can be cancelled.';
const VOID_FAILED = 'Could not cancel this booking; nothing was changed.';
const INTERRUPTED = 'Cancel was interrupted; tell the developer.';
const TOO_LATE = 'A booking can be cancelled online only until 24 hours before it starts. Please go to the barangay hall.';
const PAID_HALL = 'A paid booking can only be cancelled at the barangay hall, so your refund can be arranged.';
const WALK_IN_HALL = 'This booking was made at the barangay hall, so it can only be changed there.';
const REASON = 'Hall needed for an emergency meeting';

(async () => {
  console.log('Rental Edit and Cancel — real handlers, fake tables, no network');

  // ======================================================================== Edit
  section('PUT /:id — Secretary Edit');
  const edit = (id, body, opts = {}) => call({ method: 'put', path: '/:id', user: SEC, id, body, ...opts });

  for (const [id, what] of [[607, 'a started booking'], [608, 'an Overdue booking'], [609, 'a Completed booking'], [610, 'a cancelled booking']]) {
    const r = await edit(id, editBody({ quantity_requested: id === 609 ? 1 : 10 }));
    check(`Edit refuses ${what} with the not-started 409`, r.status === 409 && r.body?.error === NOT_STARTED_EDIT, said(r));
    check(`  ${what} is left as it was`, r.booking(id).start_datetime === freshDb().rental_requests.find((b) => b.request_id === id).start_datetime);
  }

  let r = await edit(601, editBody({ quantity_requested: 12 }));
  check('Edit refuses a changed quantity with the cancel-and-book-again 400', r.status === 400 && r.body?.error === QUANTITY_FIXED, said(r));
  check('  the booking keeps its quantity and schedule', r.booking(601).quantity_requested === 10 && r.booking(601).start_datetime === at(72));

  r = await edit(601, editBody());
  const newStart = manilaIso(EDIT_DAY, '08:00');
  const newEnd = manilaIso(EDIT_DAY, '10:00');
  check('Edit accepts the unchanged quantity the old screen still sends', r.status === 200, said(r));
  check('  the schedule moved', r.booking(601).start_datetime === newStart && r.booking(601).end_datetime === newEnd,
    `${r.booking(601).start_datetime} – ${r.booking(601).end_datetime}`);
  check('  the quantity is still 10', r.booking(601).quantity_requested === 10);
  check('  the charge is untouched (UNPAID, no charges write at all)',
    sameJson(r.chargeOfBooking(601), freshDb().charges.find((c) => c.charge_id === 1601))
      && !r.db.calls.some((c) => c.table === 'charges' && c.op !== 'select'));
  check('  processed_by_user_id is not written by an edit', r.booking(601).processed_by_user_id === null);
  const editNote = r.db.notifications;
  const editText = `BrgyServe: your booking of Monobloc Chair was changed by the barangay. It is now ${schedule(newStart, newEnd)}.`;
  check('  the borrower is notified once', editNote.length === 1, `${editNote.length} notification(s)`);
  check('  with the exact text', editNote[0]?.message === editText, editNote[0]?.message || '(none)');
  check('  to the resident\'s account and number', editNote[0]?.user_id === RES_A.user_id && editNote[0]?.destination === '09170000001'
    && editNote[0]?.related_type === 'RENTAL_REQUEST' && editNote[0]?.related_to === 601);
  check('  the text has no peso sign, em dash or multiplication sign', !/[₱—×]/.test(editNote[0]?.message || ''));
  const editLog = r.db.activity_logs;
  check('  one UPDATE row on rental_requests #601 by the Secretary',
    editLog.length === 1 && editLog[0].action === 'UPDATE' && editLog[0].table_name === 'rental_requests'
      && editLog[0].record_id === 601 && editLog[0].user_id === SEC.user_id, JSON.stringify(editLog.map((l) => l.action)));
  check('  holding the before and after of the changed columns only',
    sameJson(editLog[0]?.old_value, { start_datetime: at(72), end_datetime: at(75) })
      && sameJson(editLog[0]?.new_value, { start_datetime: newStart, end_datetime: newEnd }),
    JSON.stringify([editLog[0]?.old_value, editLog[0]?.new_value]));

  r = await edit(601, editBody({ quantity_requested: undefined }));
  check('Edit with no quantity in the body keeps the stored quantity (not 1)', r.status === 200 && r.booking(601).quantity_requested === 10,
    `${said(r)}; quantity ${r.booking(601).quantity_requested}`);

  r = await edit(603, editBody());
  check('Edit of a PAID booking leaves its charge exactly as it was',
    r.status === 200 && sameJson(r.chargeOfBooking(603), freshDb().charges.find((c) => c.charge_id === 1603))
      && !r.db.calls.some((c) => c.table === 'charges' && c.op !== 'select'), said(r));

  r = await edit(611, editBody());
  check('Edit of a guest booking notifies the guest\'s number, with no account',
    r.status === 200 && r.db.notifications.length === 1 && r.db.notifications[0].destination === '09179990000'
      && r.db.notifications[0].user_id === null, JSON.stringify(r.db.notifications[0] || null));
  check('  the guest\'s name and number are not in the log row',
    !JSON.stringify(r.db.activity_logs).includes('Pedro') && !JSON.stringify(r.db.activity_logs).includes('09179990000'));

  r = await edit(601, editBody(), {
    setup: (db) => Object.assign(db.rental_requests.find((b) => b.request_id === 601), { start_datetime: newStart, end_datetime: newEnd }),
  });
  check('Edit that changes nothing sends no notification and logs nothing', r.status === 200 && r.db.notifications.length === 0
    && r.db.activity_logs.length === 0, `${said(r)}; ${r.db.notifications.length} notification(s)`);

  r = await edit(620, editBody({ date: CLASH_DAY, start_time: '12:30', end_time: '13:30', quantity_requested: 1 }));
  check('Edit still refuses a clash with another booking', r.status === 409 && /already booked/.test(r.body?.error || ''), said(r));
  check('  the booking keeps its slot, nobody is notified', r.booking(620).start_datetime === manilaIso(CLASH_DAY, '08:00')
    && r.db.notifications.length === 0);

  r = await edit(620, editBody({ date: CLASH_DAY, start_time: '15:00', end_time: '16:00', quantity_requested: 1, purpose: 'Basketball' }), {
    setup: (db) => {
      db.afterUpdate = ({ table, patch }) => {
        if (table !== 'rental_requests' || patch.start_datetime !== manilaIso(CLASH_DAY, '15:00')) return;
        db.afterUpdate = null;
        db.rental_requests.push({ ...db.rental_requests.find((b) => b.request_id === 621), request_id: 699,
          start_datetime: manilaIso(CLASH_DAY, '15:00'), end_datetime: manilaIso(CLASH_DAY, '17:00') });
      };
    },
  });
  check('Edit that loses a race after its update answers 409', r.status === 409, said(r));
  check('  and puts the date, times and purpose back', r.booking(620).start_datetime === manilaIso(CLASH_DAY, '08:00')
    && r.booking(620).end_datetime === manilaIso(CLASH_DAY, '10:00') && r.booking(620).purpose === 'Family reunion');
  check('  nobody is notified and nothing is logged', r.db.notifications.length === 0 && r.db.activity_logs.length === 0);

  // ============================================================ Secretary cancel
  section('POST /:id/cancel — Secretary Cancel');
  const cancel = (id, body, opts = {}) => call({ method: 'post', path: '/:id/cancel', user: SEC, id, body, ...opts });

  for (const [body, what] of [[{}, 'no reason'], [{ reason: '  ab  ' }, 'a 2-character reason'], [{ reason: 'x'.repeat(301) }, 'a 301-character reason']]) {
    r = await cancel(605, body);
    check(`Cancel refuses ${what} with a 400`, r.status === 400 && /reason/i.test(r.body?.error || ''), said(r));
    check('  the booking and charge are left alone', r.booking(605).status === 'confirmed' && r.chargeOfBooking(605).status === 'UNPAID'
      && r.db.notifications.length === 0 && r.db.activity_logs.length === 0);
  }
  r = await cancel(605, { reason: 'x'.repeat(300) });
  check('Cancel accepts a 300-character reason', r.status === 200, said(r));
  r = await cancel(605, { reason: 'abc' });
  check('Cancel accepts a 3-character reason', r.status === 200, said(r));

  for (const [id, what] of [[607, 'a started booking'], [608, 'an Overdue booking'], [609, 'a Completed booking'], [610, 'an already cancelled booking']]) {
    r = await cancel(id, { reason: REASON });
    check(`Cancel refuses ${what} with the not-started 409`, r.status === 409 && r.body?.error === NOT_STARTED_CANCEL, said(r));
    check(`  ${what} keeps its status and charge`, r.booking(id).status === freshDb().rental_requests.find((b) => b.request_id === id).status
      && r.chargeOfBooking(id).status === freshDb().charges.find((c) => c.rental_request_id === id).status);
  }

  r = await cancel(605, { reason: `  ${REASON}  ` });
  check('Cancel of an UNPAID booking answers 200', r.status === 200, said(r));
  check('  the booking is cancelled by the Secretary, reason stored trimmed',
    r.booking(605).status === 'cancelled' && r.booking(605).processed_by_user_id === SEC.user_id
      && r.booking(605).cancellation_reason === REASON, JSON.stringify([r.booking(605).status, r.booking(605).cancellation_reason]));
  check('  the charge is VOID', r.chargeOfBooking(605).status === 'VOID');
  const cancelText = `BrgyServe: your booking of Monobloc Chair on ${dateFmt.format(new Date(at(72)))} was cancelled by the barangay. Reason: ${REASON}.`;
  check('  the borrower is notified with the exact text', r.db.notifications.length === 1 && r.db.notifications[0].message === cancelText,
    r.db.notifications[0]?.message || '(none)');
  check('  to resident B\'s account and number', r.db.notifications[0]?.user_id === RES_B.user_id && r.db.notifications[0]?.destination === '09170000002');
  check('  the text has no peso sign, em dash or multiplication sign', !/[₱—×]/.test(r.db.notifications[0]?.message || ''));
  const cLog = r.db.activity_logs;
  check('  one CANCEL row by the Secretary on rental_requests #605',
    cLog.length === 1 && cLog[0].action === 'CANCEL' && cLog[0].user_id === SEC.user_id && cLog[0].record_id === 605,
    JSON.stringify(cLog.map((l) => l.action)));
  check('  before { status: confirmed }, after with the charge outcome, no checkout, a reason given',
    sameJson(cLog[0]?.old_value, { status: 'confirmed' })
      && sameJson(cLog[0]?.new_value, { status: 'cancelled', charge_outcome: 'VOID', session_expired: 'not_needed', reason_given: true }),
    JSON.stringify(cLog[0]?.new_value));
  check('  the reason\'s text is not in the log row', !JSON.stringify(cLog).includes('emergency'));
  check('  no expire call for a charge without a checkout', r.expireCalls.length === 0);
  check('  the response carries no PayMongo field', !JSON.stringify(r.body).includes('paymongo'));

  r = await cancel(603, { reason: REASON });
  check('Cancel of a PAID PHP 50 booking answers 200 and keeps the charge PAID',
    r.status === 200 && r.booking(603).status === 'cancelled' && r.chargeOfBooking(603).status === 'PAID', said(r));
  check('  the notification adds the refund sentence', r.db.notifications[0]?.message
    === `BrgyServe: your booking of Monobloc Chair on ${dateFmt.format(new Date(at(72)))} was cancelled by the barangay. Reason: ${REASON}. You paid PHP 50.00. Please contact the barangay about your refund.`,
  r.db.notifications[0]?.message || '(none)');
  check('  the log says a refund of 50 is due', sameJson(r.db.activity_logs[0]?.new_value,
    { status: 'cancelled', charge_outcome: 'PAID_REFUND_DUE', refund_due: 50, session_expired: 'not_needed', reason_given: true }),
  JSON.stringify(r.db.activity_logs[0]?.new_value));

  r = await cancel(603, { reason: REASON }, { setup: (db) => { db.charges.find((c) => c.charge_id === 1603).paymongo_session_id = 'cs_test_603'; } });
  check('Cancel of a PAID booking with a checkout makes no expire call', r.status === 200 && r.expireCalls.length === 0, `${r.expireCalls.length} call(s)`);

  r = await cancel(604, { reason: REASON });
  check('Cancel of a PHP 0 PAID booking leaves the charge untouched',
    r.status === 200 && sameJson(r.chargeOfBooking(604), freshDb().charges.find((c) => c.charge_id === 1604))
      && !r.db.calls.some((c) => c.table === 'charges' && c.op !== 'select'), said(r));
  check('  no refund sentence, charge outcome NONE', !/refund/.test(r.db.notifications[0]?.message || '')
    && r.db.activity_logs[0]?.new_value?.charge_outcome === 'NONE', JSON.stringify(r.db.activity_logs[0]?.new_value));

  r = await cancel(612, { reason: REASON });
  check('Cancel of a booking with no charge answers 200, outcome NONE', r.status === 200 && r.db.activity_logs[0]?.new_value?.charge_outcome === 'NONE', said(r));

  r = await cancel(611, { reason: REASON });
  check('Cancel of a guest booking notifies the guest\'s number', r.status === 200 && r.db.notifications[0]?.destination === '09179990000'
    && r.db.notifications[0]?.user_id === null, said(r));

  const voidFails = (db) => { db.failWhen = ({ table, op }) => (table === 'charges' && op === 'update' ? { message: 'forced charge failure' } : null); };
  r = await cancel(605, { reason: REASON }, { setup: voidFails });
  check('A failed void answers the nothing-was-changed 500', r.status === 500 && r.body?.error === VOID_FAILED, said(r));
  check('  the booking is back to confirmed, with no processor and no reason',
    r.booking(605).status === 'confirmed' && r.booking(605).processed_by_user_id === null && r.booking(605).cancellation_reason === null,
    JSON.stringify([r.booking(605).status, r.booking(605).processed_by_user_id, r.booking(605).cancellation_reason]));
  check('  the charge is still UNPAID, nobody is notified, nothing is logged',
    r.chargeOfBooking(605).status === 'UNPAID' && r.db.notifications.length === 0 && r.db.activity_logs.length === 0);

  r = await cancel(605, { reason: REASON }, {
    setup: (db) => {
      db.failWhen = ({ table, op, patch }) => {
        if (table === 'charges' && op === 'update') return { message: 'forced charge failure' };
        if (table === 'rental_requests' && op === 'update' && patch?.status === 'confirmed') return { message: 'forced revert failure' };
        return null;
      };
    },
  });
  check('A failed revert answers the interrupted 500', r.status === 500 && r.body?.error === INTERRUPTED, said(r));
  check('  and says so on the console with the booking id', r.consoleSeen.error.some((l) => l.includes('605')), r.consoleSeen.error.join(' | ') || '(nothing)');

  r = await cancel(601, { reason: REASON });
  check('Cancel of an UNPAID booking with an open checkout expires it once', r.status === 200 && sameJson(r.expireCalls, ['cs_test_601']),
    JSON.stringify(r.expireCalls));
  check('  after the void (the charge is VOID)', r.chargeOfBooking(601).status === 'VOID');
  check('  and the log says it expired', r.db.activity_logs[0]?.new_value?.session_expired === true, JSON.stringify(r.db.activity_logs[0]?.new_value));

  r = await cancel(601, { reason: REASON }, { expire: async () => { const e = new Error('Checkout session is already paid'); e.status = 400; throw e; } });
  check('A rejected expire never blocks the cancel', r.status === 200 && r.booking(601).status === 'cancelled' && r.chargeOfBooking(601).status === 'VOID', said(r));
  check('  the log says it failed, with a short reason', r.db.activity_logs[0]?.new_value?.session_expired === false
    && /already paid/.test(r.db.activity_logs[0]?.new_value?.session_expire_failure || ''), JSON.stringify(r.db.activity_logs[0]?.new_value));
  check('  the borrower is still notified', r.db.notifications.length === 1);

  r = await cancel(601, { reason: REASON }, { expire: () => { throw new Error('synchronous failure'); } });
  check('An expire that throws outright never blocks the cancel', r.status === 200 && r.booking(601).status === 'cancelled'
    && r.db.activity_logs[0]?.new_value?.session_expired === false, said(r));

  r = await cancel(601, { reason: REASON }, { expire: 'real' });
  check('The real client asks PayMongo to expire with POST /v1/checkout_sessions/{id}/expire',
    r.net.length === 1 && r.net[0].url === 'https://api.paymongo.com/v1/checkout_sessions/cs_test_601/expire' && r.net[0].method === 'POST',
    JSON.stringify(r.net));
  check('  and its network failure never blocks the cancel', r.status === 200 && r.booking(601).status === 'cancelled'
    && r.db.activity_logs[0]?.new_value?.session_expired === false, said(r));

  // ============================================================ resident cancel
  section('POST /mine/:id/cancel — the resident\'s own cancel');
  const mine = (id, body = {}, opts = {}) => call({ method: 'post', path: '/mine/:id/cancel', user: RES_A, id, ...opts, body });

  r = await mine(601);
  check('A resident cancels their own unpaid online booking 72 hours ahead', r.status === 200, said(r));
  check('  cancelled, processed by nobody, no reason stored', r.booking(601).status === 'cancelled'
    && r.booking(601).processed_by_user_id === null && r.booking(601).cancellation_reason === null,
  JSON.stringify([r.booking(601).status, r.booking(601).processed_by_user_id, r.booking(601).cancellation_reason]));
  check('  the charge is VOID and the open checkout is expired', r.chargeOfBooking(601).status === 'VOID' && sameJson(r.expireCalls, ['cs_test_601']),
    JSON.stringify(r.expireCalls));
  check('  no notification is sent', r.db.notifications.length === 0, `${r.db.notifications.length}`);
  check('  one CANCEL row with the resident as actor', r.db.activity_logs.length === 1 && r.db.activity_logs[0].action === 'CANCEL'
    && r.db.activity_logs[0].user_id === RES_A.user_id && r.db.activity_logs[0].new_value?.reason_given === false,
  JSON.stringify(r.db.activity_logs[0] || null));
  check('  the response carries no PayMongo field', !JSON.stringify(r.body).includes('paymongo'));

  r = await mine(601, { reason: '  Change of plans  ' });
  check('An optional reason is stored trimmed', r.status === 200 && r.booking(601).cancellation_reason === 'Change of plans',
    `${said(r)}; ${JSON.stringify(r.booking(601).cancellation_reason)}`);
  r = await mine(601, { reason: 'ab' });
  check('A reason that is given must be 3 to 300 characters', r.status === 400 && r.booking(601).status === 'confirmed', said(r));

  r = await mine(602);
  check('23 hours before the start is refused', r.status === 409 && r.body?.error === TOO_LATE, said(r));
  check('  and nothing changes', r.booking(602).status === 'confirmed' && r.chargeOfBooking(602).status === 'UNPAID' && r.db.activity_logs.length === 0);

  r = await mine(605);
  check('Another resident\'s booking is a 404', r.status === 404 && r.body?.error === 'Booking not found', said(r));
  check('  and nothing changes', r.booking(605).status === 'confirmed' && r.chargeOfBooking(605).status === 'UNPAID');

  r = await mine(611);
  check('A guest booking is a 404 to a resident', r.status === 404, said(r));

  r = await mine(606);
  check('A walk-in the Secretary filed for the resident is refused', r.status === 409 && r.body?.error === WALK_IN_HALL, said(r));
  check('  and nothing changes', r.booking(606).status === 'confirmed' && r.chargeOfBooking(606).status === 'UNPAID');

  r = await mine(603);
  check('A paid booking is refused', r.status === 409 && r.body?.error === PAID_HALL, said(r));
  check('  and its charge stays PAID', r.booking(603).status === 'confirmed' && r.chargeOfBooking(603).status === 'PAID');

  r = await mine(604);
  check('A PHP 0 booking can be cancelled online', r.status === 200 && r.booking(604).status === 'cancelled', said(r));
  r = await mine(612);
  check('A booking with no charge can be cancelled online', r.status === 200 && r.booking(612).status === 'cancelled', said(r));

  r = await mine(607);
  check('A started booking is refused', r.status === 409 && r.booking(607).status === 'confirmed', said(r));
  r = await mine(610);
  check('An already cancelled booking is refused', r.status === 409, said(r));

  r = await mine(601, {}, { user: RES_UNLINKED });
  check('An account with no resident record gets a 404', r.status === 404, said(r));

  r = await mine(601, {}, { setup: voidFails });
  check('The resident route uses the same revert on a failed void', r.status === 500 && r.body?.error === VOID_FAILED
    && r.booking(601).status === 'confirmed', said(r));

  // ================================================================ the reads
  // What the pages are told, so neither guesses (step B2). My rentals shows its
  // Cancel booking button from can_cancel_online and its note from
  // cancel_online_note; Rental bookings shows Edit and Cancel from
  // not_started. Each flag is checked against the route it stands for, booking
  // by booking, so the list and the route cannot disagree.
  section('GET /mine and the Secretary\'s reads — what the pages are told');
  const read = (path, user, id, setup) => call({ method: 'get', path, user, id, setup });
  const withReason = (db) => { db.rental_requests.find((b) => b.request_id === 610).cancellation_reason = 'Typhoon signal no. 2'; };
  r = await read('/mine', RES_A, '', withReason);
  const mineRows = r.body?.requests || [];
  const mineById = Object.fromEntries(mineRows.map((b) => [b.request_id, b]));
  check('GET /mine answers 200 with resident A\'s bookings', r.status === 200 && mineRows.length > 0, `${said(r)}; ${mineRows.length} row(s)`);
  const WANT_MINE = {
    601: [true, null], 602: [false, TOO_LATE], 603: [false, PAID_HALL], 604: [true, null], 606: [false, WALK_IN_HALL],
    607: [false, null], 608: [false, null], 609: [false, null], 610: [false, null], 612: [true, null],
  };
  for (const [id, [can, note]] of Object.entries(WANT_MINE)) {
    const b = mineById[id];
    check(`  #${id}: can_cancel_online ${can}, cancel_online_note ${note ? JSON.stringify(note.slice(0, 32) + '…') : 'null'}`,
      b?.can_cancel_online === can && b?.cancel_online_note === note,
      JSON.stringify(b ? { can: b.can_cancel_online, note: b.cancel_online_note } : 'missing'));
  }
  check('  every row carries both keys, and cancellation_reason', mineRows.every((b) => 'can_cancel_online' in b
    && 'cancel_online_note' in b && 'cancellation_reason' in b));
  check('  the cancelled booking\'s reason is there as text', mineById[610]?.cancellation_reason === 'Typhoon signal no. 2',
    JSON.stringify(mineById[610]?.cancellation_reason));
  check('  requested_by_user_id is ABSENT from every row (read to decide, never sent)',
    mineRows.every((b) => !('requested_by_user_id' in b)), JSON.stringify(mineRows.filter((b) => 'requested_by_user_id' in b).map((b) => b.request_id)));
  check('  no PayMongo field and no other resident\'s booking', !JSON.stringify(mineRows).includes('paymongo')
    && mineRows.every((b) => b.request_id !== 605 && b.request_id !== 611));
  // The flag against the route, for every one of A's bookings: true exactly
  // when POST /mine/:id/cancel succeeds, and a note exactly the route's 409.
  const drift = [];
  for (const b of mineRows) {
    const tried = await mine(b.request_id);
    const routeSays = tried.status === 200 ? null : tried.body?.error;
    const listSays = b.can_cancel_online ? null : (b.cancel_online_note ?? 'NO_NOTE');
    const agrees = b.can_cancel_online ? tried.status === 200
      : tried.status !== 200 && (b.cancel_online_note === null || b.cancel_online_note === routeSays);
    if (!agrees) drift.push({ id: b.request_id, list: listSays, route: `${tried.status} ${routeSays}` });
  }
  check('  can_cancel_online and cancel_online_note agree with POST /mine/:id/cancel on every booking', drift.length === 0,
    JSON.stringify(drift) || `${mineRows.length} compared`);

  r = await read('/mine', RES_UNLINKED, '');
  check('GET /mine for an account with no record is still an empty list', r.status === 200 && JSON.stringify(r.body) === '{"requests":[]}', said(r));

  r = await read('/', SEC, '', withReason);
  const secRows = r.body?.requests || [];
  const secById = Object.fromEntries(secRows.map((b) => [b.request_id, b]));
  check('GET / (the Secretary\'s list) answers 200 with every booking', r.status === 200 && secRows.length === freshDb().rental_requests.length,
    `${said(r)}; ${secRows.length} row(s)`);
  const STARTED = [607, 608, 609, 610];
  check('  not_started is true for a booking that has not started and false for started, Overdue, Completed and cancelled',
    secRows.every((b) => b.not_started === !STARTED.includes(b.request_id)),
    JSON.stringify(secRows.map((b) => [b.request_id, b.not_started])));
  check('  every row carries cancellation_reason; #610\'s is its text', secRows.every((b) => 'cancellation_reason' in b)
    && secById[610]?.cancellation_reason === 'Typhoon signal no. 2', JSON.stringify(secById[610]?.cancellation_reason));
  const secDrift = [];
  for (const b of secRows) {
    const tried = await cancel(b.request_id, { reason: REASON });
    const refusedAsStarted = tried.status === 409 && tried.body?.error === NOT_STARTED_CANCEL;
    if (b.not_started === refusedAsStarted) secDrift.push({ id: b.request_id, not_started: b.not_started, route: said(tried) });
  }
  check('  not_started agrees with POST /:id/cancel\'s not-started refusal on every booking', secDrift.length === 0,
    JSON.stringify(secDrift) || `${secRows.length} compared`);
  check('  the list sends no PayMongo field', !JSON.stringify(secRows).includes('paymongo'));

  r = await read('/:id', SEC, 610, withReason);
  check('GET /:id carries cancellation_reason and not_started', r.status === 200
    && r.body?.request?.cancellation_reason === 'Typhoon signal no. 2' && r.body?.request?.not_started === false, said(r));
  r = await read('/:id', SEC, 601);
  check('  and an upcoming booking reads not_started true, cancellation_reason null', r.body?.request?.not_started === true
    && r.body?.request?.cancellation_reason === null, JSON.stringify(r.body?.request && {
    not_started: r.body.request.not_started, reason: r.body.request.cancellation_reason }));

  // ======================================================================= webhook
  section('the PayMongo webhook — a payment for a cancelled booking');
  const signed = (event) => {
    const raw = Buffer.from(JSON.stringify(event));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET).update(`${t}.${raw.toString('utf8')}`).digest('hex');
    return { body: raw, headers: { 'paymongo-signature': `t=${t},te=${sig},li=` } };
  };
  const paidEvent = (chargeId, sessionId, paymentId, centavos) => ({
    data: { attributes: { type: 'checkout_session.payment.paid', livemode: false, data: { id: sessionId, attributes: {
      metadata: { charge_id: String(chargeId) },
      payments: [{ id: paymentId, attributes: { status: 'paid', amount: centavos, currency: 'PHP' } }],
    } } } },
  });
  const hook = async (event) => {
    const db = freshDb();
    supabase.from = fakeFrom(db);
    const seen = { warn: [], error: [], log: [] };
    const orig = { warn: console.warn, error: console.error, log: console.log };
    console.warn = (...a) => seen.warn.push(a.join(' '));
    console.error = (...a) => seen.error.push(a.join(' '));
    console.log = (...a) => seen.log.push(a.join(' '));
    let res;
    try {
      res = await new Promise((resolve, reject) => {
        const resObj = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
        Promise.resolve(webhookHandler(signed(event), resObj)).catch(reject);
      });
    } finally {
      Object.assign(console, orig);
    }
    return { ...res, db, seen };
  };

  r = await hook(paidEvent(1610, 'cs_test_610', 'pay_test_late_610', 5000));
  check('A payment for a VOID charge still answers 200 { received: true, outcome: void }',
    r.status === 200 && sameJson(r.body, { received: true, outcome: 'void' }), `${r.status} ${JSON.stringify(r.body)}`);
  check('  no payments row is written', r.db.payments.length === 0, `${r.db.payments.length}`);
  check('  the charge is not changed', sameJson(r.db.charges.find((c) => c.charge_id === 1610), freshDb().charges.find((c) => c.charge_id === 1610)));
  check('  nobody is notified', r.db.notifications.length === 0, `${r.db.notifications.length}`);
  const late = r.db.activity_logs;
  check('  exactly one activity row, PAYMENT_ON_VOID_CHARGE on charges #1610', late.length === 1
    && late[0].action === 'PAYMENT_ON_VOID_CHARGE' && late[0].table_name === 'charges' && late[0].record_id === 1610,
  JSON.stringify(late.map((l) => [l.action, l.table_name, l.record_id])));
  check('  holding the charge id, the PayMongo payment id and the amount', sameJson(late[0]?.new_value,
    { charge_id: 1610, gateway_payment_id: 'pay_test_late_610', amount: 50 }), JSON.stringify(late[0]?.new_value));
  check('  recorded against the resident who paid (the charge\'s account)', late[0]?.user_id === RES_A.user_id, String(late[0]?.user_id));
  check('  and a console warning', r.seen.warn.some((l) => l.includes('1610')), r.seen.warn.join(' | ') || '(none)');

  r = await hook(paidEvent(1605, 'cs_test_605', 'pay_test_ok_605', 5000));
  check('A payment for an UNPAID charge is recorded as before', r.status === 200 && r.body?.outcome === 'recorded'
    && r.db.payments.length === 1 && r.db.charges.find((c) => c.charge_id === 1605).status === 'PAID', `${r.status} ${JSON.stringify(r.body)}`);
  check('  with its notification and no activity row', r.db.notifications.length === 1 && r.db.activity_logs.length === 0,
    `${r.db.notifications.length} notification(s), ${r.db.activity_logs.length} log row(s)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
