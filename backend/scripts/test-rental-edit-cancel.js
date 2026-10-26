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
// And since step C1b (26 Oct 2026), migration 024: the database decides
// whether a slot is free. POST / books through create_rental_booking, PUT /:id
// moves a booking through update_rental_booking_time, and GET /availability
// reads rental_availability. The rule itself (the 24-hour rest, stuck items,
// the row lock) is proven against Postgres by the SQL test; here supabase.rpc
// is faked too, and the checks are about what each ROUTE does with each
// answer: the arguments it sends, the status and words it gives each refusal,
// the charge, notification and log around a booking, and what it never sends
// back.
//
// Makes NO network calls and touches NO database: the Supabase URL and key are
// dead values set before anything loads, fetch records its call and throws,
// and supabase.from and supabase.rpc are replaced by in-memory tables built
// fresh for every call. The real handlers run, taken from router.stack past
// the router-level authenticate, with req.user supplied (GET /availability
// runs its whole route chain, role guard included). PayMongo's expire call is
// replaced on the module object, except in the one check that lets the real
// client reach the dead fetch to prove which url and method it would use.
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
    rpcCalls: [],
    rpcAnswer: {},
    rpcError: null,
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
      if (q.op === 'select') db.calls.push({ table, op: 'select', filters: q.filters });
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

// --- migration 024's functions, faked ------------------------------------------
// The real rule (the 24-hour rest, stuck items, the item row lock) is proven
// against Postgres by the SQL test. These only answer, so the checks are about
// what the ROUTE does with each answer. db.rpcAnswer[name] replaces a
// function's answer: a value is sent as it is, a function is asked
// (args, db). Unscripted, each does what the real one does when the slot is
// free; db.rpcError makes the call itself fail.
const RPC_DEFAULTS = {
  create_rental_booking(a, db) {
    const row = {
      request_id: Math.max(...db.rental_requests.map((r) => r.request_id)) + 1,
      item_id: a.p_item_id, requested_by_user_id: a.p_requested_by_user_id, resident_id: a.p_resident_id,
      outside_borrower_name: a.p_outside_borrower_name, outside_borrower_contact: a.p_outside_borrower_contact,
      quantity_requested: a.p_quantity, start_datetime: a.p_start, end_datetime: a.p_end, purpose: a.p_purpose,
      status: 'confirmed', processed_by_user_id: null, cancellation_reason: null,
      return_note: null, returned_at: null, returned_by_user_id: null,
    };
    db.rental_requests.push(row);
    // The whole new row, as to_jsonb sends it: contact and purpose included.
    return { ok: true, request: { ...row } };
  },
  update_rental_booking_time(a, db) {
    const row = db.rental_requests.find((r) => r.request_id === a.p_request_id);
    if (!row) return { ok: false, code: 'BOOKING_NOT_FOUND' };
    if (row.status !== 'confirmed' || Date.parse(row.start_datetime) <= Date.now()) {
      return { ok: false, code: 'BOOKING_STARTED', status: row.status };
    }
    const before = { start_datetime: row.start_datetime, end_datetime: row.end_datetime, purpose: row.purpose };
    Object.assign(row, { start_datetime: a.p_start, end_datetime: a.p_end, purpose: a.p_purpose });
    return { ok: true, before, request: { ...row } };
  },
  rental_availability() {
    return { ok: true, item_type: 'furniture', total: 100, used: 0, booked: 0, stuck: 0, resting: 0, left: 100 };
  },
};

function fakeRpc(db) {
  return async (name, args) => {
    db.rpcCalls.push({ name, args: structuredClone(args) });
    if (db.rpcError) return { data: null, error: db.rpcError };
    const scripted = db.rpcAnswer[name];
    if (scripted !== undefined) {
      return { data: typeof scripted === 'function' ? scripted(args, db) : structuredClone(scripted), error: null };
    }
    if (!RPC_DEFAULTS[name]) return { data: null, error: { message: `Could not find the function public.${name}` } };
    return { data: RPC_DEFAULTS[name](args, db), error: null };
  };
}

// --- calling the real handlers -------------------------------------------------
const routeLayer = (router, method, routePath) => {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath} on the router`);
  return layer;
};
const handlerFor = (router, method, routePath) => {
  const layer = routeLayer(router, method, routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
// The route's whole own chain, its role guard first, then the handler. A guard
// calls next() without returning it, so every step's promise is kept and
// awaited: otherwise the handler would still be running into the next call's
// tables.
const chainFor = (router, method, routePath) => {
  const handles = routeLayer(router, method, routePath).route.stack.map((s) => s.handle);
  return async (req, res) => {
    const running = [];
    let i = 0;
    const next = () => {
      const h = handles[i++];
      if (h) running.push(h(req, res, next));
    };
    next();
    for (let k = 0; k < running.length; k += 1) await running[k];
  };
};

const realExpire = paymongo.expireCheckoutSession;

// Runs one request against fresh tables. `setup(db)` adjusts them first;
// `expire` stands in for PayMongo's expire call ('real' leaves the client alone).
async function call({ method, path, user, id, body = {}, query = {}, chain = false, setup, expire, req: extraReq }) {
  const db = freshDb();
  if (setup) setup(db);
  supabase.from = fakeFrom(db);
  supabase.rpc = fakeRpc(db);
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
    const handler = chain ? chainFor(rentals, method, path) : handlerFor(rentals, method, path);
    res = await new Promise((resolve, reject) => {
      let done = false;
      const resObj = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { done = true; resolve({ status: this.statusCode, body: b }); return this; },
      };
      const req = { user, params: { id: String(id) }, body, query, headers: {}, ...extraReq };
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
  const rpcCalls = () => db.rpcCalls;
  return { ...res, db, booking, chargeOfBooking, rpcCalls, expireCalls, consoleSeen, net: netCalls.slice(netBefore) };
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

// The route's words for each refusal (parseBookingBody's and the old JS
// conflict check's sentences, kept since migration 024 took over the check).
const END_NOT_AFTER = 'End time must be after the start time (bookings run within one day)';
const PAST_START = 'The booking must start in the future';
const BELOW_ONE = 'quantity_requested must be a whole number of at least 1';
const ITEM_GONE = 'Rental item not found';
const ITEM_OFF = 'That item is not currently available for rental';
// Postgres's own timestamptz text, as the functions' jsonb carries it.
const pgTime = (isoText) => isoText.replace(/\.\d{3}Z$/, '+00:00');
const sortedJson = (o) => JSON.stringify(Object.keys(o ?? {}).sort().reduce((acc, k) => ({ ...acc, [k]: o[k] }), {}));
// RENTAL_FIELDS' columns plus derived_status: what POST / answers with.
const RENTAL_KEYS = ['cancellation_reason', 'charges', 'derived_status', 'end_datetime', 'purpose', 'quantity_requested',
  'rental_items', 'request_id', 'return_note', 'returned_at', 'start_datetime', 'status'];

(async () => {
  console.log('Rental Edit and Cancel — real handlers, fake tables, no network');

  // ==================================================================== Book
  section('POST / — booking through create_rental_booking (migration 024)');
  const BOOK_DAY = dayAhead(5);
  const bookStart = manilaIso(BOOK_DAY, '08:00');
  const bookEnd = manilaIso(BOOK_DAY, '10:00');
  const bookBody = (extra = {}) => ({
    item_id: 802, date: BOOK_DAY, start_time: '08:00', end_time: '10:00', purpose: 'Birthday party', quantity_requested: 3, ...extra,
  });
  const book = (user, body, opts = {}) => call({ method: 'post', path: '/', user, id: '', body, ...opts });
  const NEW_ID = 622;
  const nothingWritten = (res) => !res.db.calls.some((c) => c.op === 'insert' || c.op === 'update' || c.op === 'delete')
    && res.db.notifications.length === 0 && res.db.activity_logs.length === 0
    && res.db.rental_requests.length === freshDb().rental_requests.length;
  const overlapQuery = (res) => res.db.calls.some((c) => c.table === 'rental_requests' && c.op === 'select'
    && c.filters.some(([op]) => op === 'lt' || op === 'gt'));

  let r = await book(RES_A, bookBody());
  check('A resident\'s booking calls create_rental_booking once, with their own record and account',
    r.rpcCalls().length === 1 && r.rpcCalls()[0].name === 'create_rental_booking'
      && sortedJson(r.rpcCalls()[0].args) === sortedJson({
        p_item_id: 802, p_requested_by_user_id: RES_A.user_id, p_resident_id: 9101,
        p_outside_borrower_name: null, p_outside_borrower_contact: null,
        p_quantity: 3, p_start: bookStart, p_end: bookEnd, p_purpose: 'Birthday party',
      }), JSON.stringify(r.rpcCalls()));
  check('  answers 201 "Booking confirmed: …"', r.status === 201 && /^Booking confirmed: Monobloc Chair on /.test(r.body?.message || ''), said(r));
  check('  the route inserts no booking itself and runs no overlap query of its own (the function does both)',
    !r.db.calls.some((c) => c.table === 'rental_requests' && c.op === 'insert') && !overlapQuery(r),
    JSON.stringify(r.db.calls.filter((c) => c.table === 'rental_requests').map((c) => c.op)));
  check('  and deletes nothing afterwards (no post-insert race guard)', !r.db.calls.some((c) => c.op === 'delete')
    && r.booking(NEW_ID)?.status === 'confirmed');
  const newCharge = r.chargeOfBooking(NEW_ID);
  check('  one RENTAL charge, UNPAID, fee x quantity (PHP 15), on the resident\'s account',
    newCharge?.charge_type === 'RENTAL' && newCharge?.amount === 15 && newCharge?.status === 'UNPAID'
      && newCharge?.user_id === RES_A.user_id, JSON.stringify(newCharge));
  const bookNote = r.db.notifications;
  check('  the borrower is notified once, in today\'s words, to their account and number',
    bookNote.length === 1 && bookNote[0].user_id === RES_A.user_id && bookNote[0].destination === '09170000001'
      && bookNote[0].message === `BrgyServe: your booking is CONFIRMED - 3x Monobloc Chair on ${dateFmt.format(new Date(bookStart))}, ${timeFmt.format(new Date(bookStart))} to ${timeFmt.format(new Date(bookEnd))}.`,
    bookNote[0]?.message || '(none)');
  check('  one CREATE row by the resident, with no purpose in it',
    r.db.activity_logs.length === 1 && r.db.activity_logs[0].action === 'CREATE' && r.db.activity_logs[0].record_id === NEW_ID
      && r.db.activity_logs[0].user_id === RES_A.user_id && sortedJson(r.db.activity_logs[0].new_value) === sortedJson({
      item_id: 802, resident_id: 9101, guest: false, walk_in: false, quantity_requested: 3,
      start_datetime: bookStart, end_datetime: bookEnd, status: 'confirmed' }), JSON.stringify(r.db.activity_logs[0]?.new_value));
  check('  the answer is the booking re-read with RENTAL_FIELDS (and derived_status), never the function\'s row',
    JSON.stringify(Object.keys(r.body?.request ?? {}).sort()) === JSON.stringify(RENTAL_KEYS)
      && r.body.request.request_id === NEW_ID && Array.isArray(r.body.request.charges) && r.body.request.charges.length === 1,
    JSON.stringify(Object.keys(r.body?.request ?? {}).sort()));

  r = await book(SEC, bookBody({ outside_borrower_name: '  Pedro Guest ', outside_borrower_contact: '09179990000' }));
  check('A guest walk-in calls the function with the guest\'s name and number, no resident, filed by the Secretary',
    r.status === 201 && sortedJson(r.rpcCalls()[0]?.args) === sortedJson({
      p_item_id: 802, p_requested_by_user_id: SEC.user_id, p_resident_id: null,
      p_outside_borrower_name: 'Pedro Guest', p_outside_borrower_contact: '09179990000',
      p_quantity: 3, p_start: bookStart, p_end: bookEnd, p_purpose: 'Birthday party',
    }), `${said(r)}; ${JSON.stringify(r.rpcCalls()[0]?.args)}`);
  check('  the answer carries no contact number, no outside_borrower_* key and no requester column',
    !JSON.stringify(r.body).includes('09179990000') && !/outside_borrower|requested_by_user_id|processed_by_user_id/.test(JSON.stringify(r.body)),
    JSON.stringify(r.body));
  check('  the charge has no account, and the guest\'s number gets the notice',
    r.chargeOfBooking(NEW_ID)?.user_id === null && r.db.notifications[0]?.destination === '09179990000');

  r = await book(SEC, bookBody({ resident_id: 9102 }));
  check('A walk-in for a registered resident calls the function with that resident, filed by the Secretary',
    r.status === 201 && r.rpcCalls()[0]?.args?.p_resident_id === 9102 && r.rpcCalls()[0]?.args?.p_requested_by_user_id === SEC.user_id
      && r.rpcCalls()[0]?.args?.p_outside_borrower_name === null, `${said(r)}; ${JSON.stringify(r.rpcCalls()[0]?.args)}`);
  check('  the charge goes on resident B\'s account, never the Secretary\'s', r.chargeOfBooking(NEW_ID)?.user_id === RES_B.user_id,
    JSON.stringify(r.chargeOfBooking(NEW_ID)));

  r = await book(RES_A, bookBody({ quantity_requested: 0 }));
  check('Body validation still runs first: quantity 0 is a 400 and the function is never called',
    r.status === 400 && r.body?.error === BELOW_ONE && r.rpcCalls().length === 0, said(r));
  r = await book(RES_A, bookBody({ start_time: '10:00', end_time: '09:00' }));
  check('  and so does an end before the start', r.status === 400 && r.body?.error === END_NOT_AFTER && r.rpcCalls().length === 0, said(r));
  r = await book(RES_UNLINKED, bookBody());
  check('  and so does who the borrower is (an account with no record: 409, no call)', r.status === 409 && r.rpcCalls().length === 0, said(r));

  const chargeFails = (db) => { db.failWhen = ({ table, op }) => (table === 'charges' && op === 'insert' ? { message: 'forced charge failure' } : null); };
  r = await book(RES_A, bookBody(), { setup: chargeFails });
  check('If the charge cannot be created, the booking the function made is deleted and the error is today\'s',
    r.status === 'threw' && /^Booking reverted — failed to create its charge: forced charge failure/.test(r.body?.error || '')
      && !r.booking(NEW_ID) && r.db.calls.some((c) => c.table === 'rental_requests' && c.op === 'delete'),
    `${said(r)}; booking ${JSON.stringify(r.booking(NEW_ID) ?? null)}`);
  check('  nobody is notified and nothing is logged', r.db.notifications.length === 0 && r.db.activity_logs.length === 0);

  r = await book(SEC, bookBody({ outside_borrower_name: 'Pedro Guest', outside_borrower_contact: '09179990000' }), {
    setup: (db) => { db.failWhen = ({ table, op }) => (table === 'rental_requests' && op === 'select' ? { message: 'forced read failure' } : null); },
  });
  check('If the re-read fails, the answer is still 201 and still carries only RENTAL_FIELDS\' columns, never the contact',
    r.status === 201 && !JSON.stringify(r.body).includes('09179990000')
      && JSON.stringify(Object.keys(r.body?.request ?? {}).sort()) === JSON.stringify(RENTAL_KEYS),
    `${said(r)}; ${JSON.stringify(r.body?.request)}`);

  // Each coded refusal: today's status and words, and nothing written.
  const clashA = { start: pgTime(manilaIso(BOOK_DAY, '08:00')), end: pgTime(manilaIso(BOOK_DAY, '10:00')) };
  const clashB = { start: pgTime(manilaIso(BOOK_DAY, '13:00')), end: pgTime(manilaIso(BOOK_DAY, '15:00')) };
  const notEnough = (extra) => ({ ok: false, code: 'NOT_ENOUGH_LEFT', quantity_available: 100, used: 97, left: 3, requested: 10,
    stuck: 0, resting: 0, ...extra });
  const ONLY3 = 'Only 3 of 100 Monobloc Chair are available for that time — you asked for 10.';
  const REFUSALS = [
    ['TIME_INVALID, end not after start', 802, { ok: false, code: 'TIME_INVALID', reason: 'END_NOT_AFTER_START' }, 400, END_NOT_AFTER],
    ['TIME_INVALID, start not in the future', 802, { ok: false, code: 'TIME_INVALID', reason: 'START_NOT_IN_FUTURE' }, 400, PAST_START],
    ['QUANTITY_INVALID BELOW_ONE', 802, { ok: false, code: 'QUANTITY_INVALID', reason: 'BELOW_ONE', requested: 0 }, 400, BELOW_ONE],
    ['QUANTITY_INVALID FACILITY_WHOLE', 801, { ok: false, code: 'QUANTITY_INVALID', reason: 'FACILITY_WHOLE', requested: 2 }, 400,
      'The Covered Court is booked as a whole — quantity must be 1'],
    ['QUANTITY_INVALID MORE_THAN_EXIST', 802, { ok: false, code: 'QUANTITY_INVALID', reason: 'MORE_THAN_EXIST', requested: 120,
      quantity_available: 100 }, 400, 'Only 100 units of Monobloc Chair exist — you asked for 120'],
    ['QUANTITY_INVALID MORE_THAN_EXIST, one unit', 802, { ok: false, code: 'QUANTITY_INVALID', reason: 'MORE_THAN_EXIST', requested: 2,
      quantity_available: 1 }, 400, 'Only 1 unit of Monobloc Chair exists — you asked for 2'],
    ['ITEM_NOT_FOUND', 999, { ok: false, code: 'ITEM_NOT_FOUND' }, 404, ITEM_GONE],
    ['ITEM_INACTIVE', 802, { ok: false, code: 'ITEM_INACTIVE' }, 400, ITEM_OFF],
    ['FACILITY_TAKEN (the first clash, in Manila time)', 801, { ok: false, code: 'FACILITY_TAKEN', clashes: [clashA, clashB] }, 409,
      `The Covered Court is already booked from ${timeFmt.format(new Date(clashA.start))} to ${timeFmt.format(new Date(clashA.end))} on that date — please pick a different time.`],
    ['NOT_ENOUGH_LEFT', 802, notEnough(), 409, ONLY3],
    ['NOT_ENOUGH_LEFT, one left', 802, notEnough({ left: 1, used: 99 }), 409,
      'Only 1 of 100 Monobloc Chair is available for that time — you asked for 10.'],
    ['NOT_ENOUGH_LEFT with 5 stuck', 802, notEnough({ stuck: 5 }), 409, `${ONLY3} 5 are overdue and not yet returned.`],
    ['NOT_ENOUGH_LEFT with 2 resting', 802, notEnough({ resting: 2 }), 409, `${ONLY3} 2 are resting for 24 hours after being returned.`],
    ['NOT_ENOUGH_LEFT with 1 stuck and 1 resting', 802, notEnough({ stuck: 1, resting: 1 }), 409,
      `${ONLY3} 1 is overdue and not yet returned. 1 is resting for 24 hours after being returned.`],
  ];
  for (const [what, itemId, answer, status, words] of REFUSALS) {
    r = await book(RES_A, bookBody({ item_id: itemId, quantity_requested: itemId === 801 ? 1 : 3 }),
      { setup: (db) => { db.rpcAnswer.create_rental_booking = answer; } });
    check(`${what}: ${status} "${words.length > 70 ? `${words.slice(0, 70)}…` : words}"`, r.status === status && r.body?.error === words, said(r));
    check('  no charge, no notification, no log, no booking', nothingWritten(r), JSON.stringify(r.db.calls.filter((c) => c.op !== 'select')));
  }
  r = await book(RES_A, bookBody(), { setup: (db) => { db.rpcAnswer.create_rental_booking = notEnough({ stuck: 0, resting: 0 }); } });
  check('No add-on when stuck and resting are 0', r.body?.error === ONLY3, said(r));
  r = await book(RES_A, bookBody(), { setup: (db) => { db.rpcAnswer.create_rental_booking = { ok: false, code: 'SOMETHING_NEW' }; } });
  check('An unknown refusal code is a 500, never a made-up sentence, and nothing is written', r.status === 'threw'
    && /SOMETHING_NEW/.test(r.body?.error || '') && nothingWritten(r), said(r));
  r = await book(RES_A, bookBody(), { setup: (db) => { db.rpcAnswer.create_rental_booking = { ok: false, code: 'TIME_INVALID', reason: 'NEW_REASON' }; } });
  check('  and so is a TIME_INVALID with an unknown reason', r.status === 'threw' && nothingWritten(r), said(r));
  r = await book(RES_A, bookBody(), { setup: (db) => { db.rpcError = { message: 'function exploded' }; } });
  check('A failed call to the function is a 500 and nothing is written', r.status === 'threw' && /function exploded/.test(r.body?.error || '')
    && nothingWritten(r), said(r));

  // ======================================================================== Edit
  section('PUT /:id — Secretary Edit');
  const edit = (id, body, opts = {}) => call({ method: 'put', path: '/:id', user: SEC, id, body, ...opts });

  for (const [id, what] of [[607, 'a started booking'], [608, 'an Overdue booking'], [609, 'a Completed booking'], [610, 'a cancelled booking']]) {
    const r = await edit(id, editBody({ quantity_requested: id === 609 ? 1 : 10 }));
    check(`Edit refuses ${what} with the not-started 409`, r.status === 409 && r.body?.error === NOT_STARTED_EDIT, said(r));
    check(`  ${what} is left as it was`, r.booking(id).start_datetime === freshDb().rental_requests.find((b) => b.request_id === id).start_datetime);
  }

  r = await edit(601, editBody({ quantity_requested: 12 }));
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
  check('  the move goes through update_rental_booking_time, once, with the booking, the new times and the purpose',
    r.rpcCalls().length === 1 && r.rpcCalls()[0].name === 'update_rental_booking_time'
      && sortedJson(r.rpcCalls()[0].args) === sortedJson({ p_request_id: 601, p_start: newStart, p_end: newEnd, p_purpose: 'Family reunion' }),
    JSON.stringify(r.rpcCalls()));
  check('  the route updates no booking row itself and runs no overlap query of its own',
    !r.db.calls.some((c) => c.table === 'rental_requests' && c.op === 'update') && !overlapQuery(r),
    JSON.stringify(r.db.calls.filter((c) => c.table === 'rental_requests').map((c) => c.op)));
  check('  the answer is the booking re-read with MANAGE_FIELDS (derived_status, its item), never the function\'s row',
    r.body?.request?.request_id === 601 && r.body.request.derived_status === 'confirmed' && r.body.request.rental_items?.name === 'Monobloc Chair'
      && !('requested_by_user_id' in r.body.request) && !('processed_by_user_id' in r.body.request),
    JSON.stringify(Object.keys(r.body?.request ?? {})));

  // The function's `before` is the row as it was under the lock, so the
  // notification and the diff come from it, not from the route's earlier read.
  const viaBefore = (before) => (db) => {
    db.rpcAnswer.update_rental_booking_time = (a) => {
      const row = db.rental_requests.find((b) => b.request_id === 601);
      Object.assign(row, { start_datetime: a.p_start, end_datetime: a.p_end, purpose: a.p_purpose });
      return { ok: true, before, request: { ...row } };
    };
  };
  r = await edit(601, editBody(), { setup: viaBefore({ start_datetime: newStart, end_datetime: newEnd, purpose: 'Old purpose' }) });
  check('Edit diffs against the function\'s before: only the purpose changed there, so only the purpose is logged',
    r.status === 200 && r.db.activity_logs.length === 1 && sameJson(r.db.activity_logs[0].old_value, { purpose: 'Old purpose' })
      && sameJson(r.db.activity_logs[0].new_value, { purpose: 'Family reunion' }),
    JSON.stringify(r.db.activity_logs.map((l) => [l.old_value, l.new_value])));
  check('  and the borrower is told', r.db.notifications.length === 1, `${r.db.notifications.length}`);
  r = await edit(601, editBody(), { setup: viaBefore({ start_datetime: newStart, end_datetime: newEnd, purpose: 'Family reunion' }) });
  check('  when the function\'s before already equals the new values, nothing is notified or logged (the route\'s own read differs)',
    r.status === 200 && r.db.notifications.length === 0 && r.db.activity_logs.length === 0,
    `${r.db.notifications.length} notification(s), ${r.db.activity_logs.length} log row(s)`);

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

  // A clash with another booking: the function finds it (#621 on the court)
  // and the route says so in today's words. Before migration 024 the route
  // found it itself; the intent, a clash refused and nothing moved, is kept.
  const clash621 = { start: pgTime(manilaIso(CLASH_DAY, '12:00')), end: pgTime(manilaIso(CLASH_DAY, '14:00')) };
  r = await edit(620, editBody({ date: CLASH_DAY, start_time: '12:30', end_time: '13:30', quantity_requested: 1 }), {
    setup: (db) => { db.rpcAnswer.update_rental_booking_time = { ok: false, code: 'FACILITY_TAKEN', clashes: [clash621] }; },
  });
  check('Edit still refuses a clash with another booking, in today\'s words',
    r.status === 409 && r.body?.error === `The Covered Court is already booked from ${timeFmt.format(new Date(clash621.start))} to ${timeFmt.format(new Date(clash621.end))} on that date — please pick a different time.`,
    said(r));
  check('  the booking keeps its slot, nobody is notified, nothing is logged', r.booking(620).start_datetime === manilaIso(CLASH_DAY, '08:00')
    && r.db.notifications.length === 0 && r.db.activity_logs.length === 0);

  // A race lost: before migration 024 the route updated, re-checked, and put
  // the old values back on a clash. Now the check and the update are one
  // locked call, so a refusal means nothing moved, and the route has nothing
  // to put back: it writes no booking row at all.
  r = await edit(620, editBody({ date: CLASH_DAY, start_time: '15:00', end_time: '16:00', quantity_requested: 1, purpose: 'Basketball' }), {
    setup: (db) => { db.rpcAnswer.update_rental_booking_time = { ok: false, code: 'FACILITY_TAKEN', clashes: [clash621] }; },
  });
  check('Edit refused by the function writes no booking row itself (nothing to revert) and keeps date, times and purpose',
    r.status === 409 && !r.db.calls.some((c) => c.table === 'rental_requests' && c.op === 'update')
      && r.booking(620).start_datetime === manilaIso(CLASH_DAY, '08:00') && r.booking(620).end_datetime === manilaIso(CLASH_DAY, '10:00')
      && r.booking(620).purpose === 'Family reunion', said(r));
  check('  nobody is notified and nothing is logged', r.db.notifications.length === 0 && r.db.activity_logs.length === 0);

  // The function's own refusals, each in today's words; nothing is written.
  const EDIT_REFUSALS = [
    ['BOOKING_NOT_FOUND (gone under the lock)', { ok: false, code: 'BOOKING_NOT_FOUND' }, 404, 'Booking not found'],
    ['BOOKING_STARTED (started or cancelled under the lock)', { ok: false, code: 'BOOKING_STARTED', status: 'cancelled' }, 409, NOT_STARTED_EDIT],
    ['TIME_INVALID, end not after start', { ok: false, code: 'TIME_INVALID', reason: 'END_NOT_AFTER_START' }, 400, END_NOT_AFTER],
    ['TIME_INVALID, start not in the future', { ok: false, code: 'TIME_INVALID', reason: 'START_NOT_IN_FUTURE' }, 400, PAST_START],
    ['QUANTITY_INVALID MORE_THAN_EXIST (the item\'s stock lowered)', { ok: false, code: 'QUANTITY_INVALID', reason: 'MORE_THAN_EXIST',
      requested: 10, quantity_available: 5 }, 400, 'Only 5 units of Monobloc Chair exist — you asked for 10'],
    ['NOT_ENOUGH_LEFT with 2 stuck', { ok: false, code: 'NOT_ENOUGH_LEFT', quantity_available: 100, used: 95, left: 5, requested: 10,
      stuck: 2, resting: 0 }, 409, 'Only 5 of 100 Monobloc Chair are available for that time — you asked for 10. 2 are overdue and not yet returned.'],
    ['NOT_ENOUGH_LEFT with 3 resting', { ok: false, code: 'NOT_ENOUGH_LEFT', quantity_available: 100, used: 95, left: 5, requested: 10,
      stuck: 0, resting: 3 }, 409, 'Only 5 of 100 Monobloc Chair are available for that time — you asked for 10. 3 are resting for 24 hours after being returned.'],
  ];
  for (const [what, answer, status, words] of EDIT_REFUSALS) {
    r = await edit(601, editBody(), { setup: (db) => { db.rpcAnswer.update_rental_booking_time = answer; } });
    check(`Edit, ${what}: ${status} "${words.length > 60 ? `${words.slice(0, 60)}…` : words}"`, r.status === status && r.body?.error === words, said(r));
    check('  the booking is as it was, nobody notified, nothing logged', r.booking(601).start_datetime === at(72)
      && !r.db.calls.some((c) => c.table === 'rental_requests' && c.op === 'update')
      && r.db.notifications.length === 0 && r.db.activity_logs.length === 0);
  }
  r = await edit(601, editBody(), {
    setup: (db) => { db.rental_items.find((i) => i.item_id === 802).quantity_available = 5; },
  });
  check('Edit applies no quantity rule of its own: with the stock lowered below the booking, the function\'s answer stands (here, ok)',
    r.status === 200 && r.rpcCalls().length === 1, said(r));
  r = await edit(601, editBody(), { setup: (db) => { db.rpcAnswer.update_rental_booking_time = { ok: false, code: 'SOMETHING_NEW' }; } });
  check('Edit: an unknown refusal code is a 500 and nothing is written', r.status === 'threw' && r.db.notifications.length === 0
    && r.db.activity_logs.length === 0, said(r));
  r = await edit(601, editBody(), { setup: (db) => { db.rpcError = { message: 'function exploded' }; } });
  check('Edit: a failed call to the function is a 500', r.status === 'threw' && /function exploded/.test(r.body?.error || ''), said(r));

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

  // ============================================================ availability
  // What the booking forms ask before a booking (step C1b): numbers from
  // rental_availability, and nothing about any booking but its times.
  section('GET /availability — what is free, before booking');
  const ask = (user, query, opts = {}) => call({ method: 'get', path: '/availability', user, id: '', query, chain: true, ...opts });
  const AV_DAY = dayAhead(5);
  const avQuery = (extra = {}) => ({ item_id: '801', date: AV_DAY, start_time: '08:00', end_time: '10:00', ...extra });
  const STAFF = { user_id: 7201, username: 'rentals_probe_staff', role: 'staff' };
  const TREASURER = { user_id: 7202, username: 'rentals_probe_treasurer', role: 'treasurer' };
  const PB = { user_id: 7203, username: 'rentals_probe_pb', role: 'punong_barangay' };
  for (const user of [TREASURER, STAFF, PB]) {
    r = await ask(user, avQuery());
    check(`${user.role} is refused with 403 and the function is never called`, r.status === 403 && r.rpcCalls().length === 0, said(r));
  }
  for (const user of [RES_A, SEC]) {
    r = await ask(user, avQuery());
    check(`${user.role} gets 200`, r.status === 200 && r.rpcCalls().length === 1, said(r));
  }

  r = await ask(RES_A, avQuery());
  check('The date and times are read as Manila time, as POST reads them, and only the item and the two times are sent',
    sortedJson(r.rpcCalls()[0]?.args) === sortedJson({ p_item_id: 801, p_start: manilaIso(AV_DAY, '08:00'), p_end: manilaIso(AV_DAY, '10:00') }),
    JSON.stringify(r.rpcCalls()[0]?.args));
  check('  the route reads no booking itself (the function decides)', !r.db.calls.some((c) => c.table === 'rental_requests'),
    JSON.stringify(r.db.calls.map((c) => `${c.op} ${c.table}`)));
  r = await ask(RES_A, avQuery({ exclude_request_id: '601' }));
  check('  an exclude_request_id in the query is ignored (none is sent)', !('p_exclude_request_id' in (r.rpcCalls()[0]?.args ?? {}))
    && r.status === 200, JSON.stringify(r.rpcCalls()[0]?.args));

  const AV_BAD = [
    ['no item_id', { item_id: undefined }, 'An item_id is required'],
    ['a date not YYYY-MM-DD', { date: '11/02/2026' }, 'date must be in YYYY-MM-DD format'],
    ['a time not HH:MM', { start_time: '8am' }, 'start_time and end_time must be in HH:MM (24-hour) format'],
    ['an end not after the start', { start_time: '10:00', end_time: '10:00' }, END_NOT_AFTER],
    ['a date that does not exist', { date: '2026-13-45' }, 'Invalid date or time'],
  ];
  for (const [what, extra, words] of AV_BAD) {
    r = await ask(RES_A, avQuery(extra));
    check(`${what}: 400 "${words}", function not called`, r.status === 400 && r.body?.error === words && r.rpcCalls().length === 0, said(r));
  }
  r = await ask(RES_A, avQuery({ item_id: '999' }));
  check('An unknown item: 404 "Rental item not found", function not called', r.status === 404 && r.body?.error === ITEM_GONE
    && r.rpcCalls().length === 0, said(r));
  r = await ask(RES_A, avQuery({ item_id: '802' }), { setup: (db) => { db.rental_items.find((i) => i.item_id === 802).is_active = false; } });
  check('An inactive item: 400 in POST\'s words, function not called', r.status === 400 && r.body?.error === ITEM_OFF
    && r.rpcCalls().length === 0, said(r));
  r = await ask(RES_A, avQuery({ date: '2020-01-06' }));
  check('A start already past may still be asked about (it shows what is taken)', r.status === 200 && r.rpcCalls().length === 1, said(r));

  const LEAKY = {
    ok: true, item_type: 'facility', total: 1, used: 1, booked: 1, stuck: 0, resting: 0, left: 0,
    taken: [{ start: clashA.start, end: clashA.end, request_id: 620, purpose: 'Family reunion', name: 'Ana Probe', contact: '09170000001' }],
    names: ['Ana Probe'], contact: '09170000001', request_ids: [620], purpose: 'Family reunion',
  };
  r = await ask(SEC, avQuery(), { setup: (db) => { db.rpcAnswer.rental_availability = LEAKY; } });
  check('A facility answer carries exactly ok, item_type, total, used, booked, stuck, resting, left and taken',
    r.status === 200 && JSON.stringify(Object.keys(r.body ?? {}).sort())
      === JSON.stringify(['booked', 'item_type', 'left', 'ok', 'resting', 'stuck', 'taken', 'total', 'used']), JSON.stringify(r.body));
  check('  each taken entry is { start, end } only', JSON.stringify(r.body?.taken) === JSON.stringify([{ start: clashA.start, end: clashA.end }]),
    JSON.stringify(r.body?.taken));
  check('  no name, account, purpose, contact or booking id anywhere in it',
    !/Ana|Probe|0917|reunion|request_id|620/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
  check('  the numbers are the function\'s', r.body?.total === 1 && r.body?.used === 1 && r.body?.left === 0 && r.body?.ok === true);
  r = await ask(RES_A, avQuery({ item_id: '802' }), {
    setup: (db) => { db.rpcAnswer.rental_availability = { ok: true, item_type: 'furniture', total: 100, used: 40, booked: 25, stuck: 10,
      resting: 5, left: 60, names: ['Ana Probe'] }; },
  });
  check('An item answer carries the eight numbers and words, no taken, nothing else',
    r.status === 200 && JSON.stringify(r.body) === JSON.stringify({ ok: true, item_type: 'furniture', total: 100, used: 40, booked: 25,
      stuck: 10, resting: 5, left: 60 }), JSON.stringify(r.body));
  r = await ask(RES_A, avQuery(), { setup: (db) => { db.rpcAnswer.rental_availability = { ok: false, code: 'TIME_INVALID', reason: 'END_NOT_AFTER_START' }; } });
  check('The function refusing the times: 400 with its code', r.status === 400 && r.body?.code === 'TIME_INVALID'
    && r.body?.error === END_NOT_AFTER, said(r));
  r = await ask(RES_A, avQuery(), { setup: (db) => { db.rpcAnswer.rental_availability = { ok: false, code: 'ITEM_NOT_FOUND' }; } });
  check('The function not finding the item: 404', r.status === 404 && r.body?.error === ITEM_GONE, said(r));
  r = await ask(RES_A, avQuery(), { setup: (db) => { db.rpcAnswer.rental_availability = { ok: false, code: 'SOMETHING_NEW' }; } });
  check('An unknown code: 500', r.status === 'threw', said(r));
  r = await ask(RES_A, avQuery(), { setup: (db) => { db.rpcError = { message: 'function exploded' }; } });
  check('A failed call: 500', r.status === 'threw' && /function exploded/.test(r.body?.error || ''), said(r));
  r = await ask(RES_A, avQuery());
  check('Asking writes nothing', !r.db.calls.some((c) => c.op !== 'select') && r.db.notifications.length === 0
    && r.db.activity_logs.length === 0, JSON.stringify(r.db.calls.filter((c) => c.op !== 'select')));

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
