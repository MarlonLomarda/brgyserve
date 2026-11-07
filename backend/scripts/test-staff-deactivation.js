// ===========================================================================
// DEACTIVATE AND REACTIVATE STAFF-TYPE ACCOUNTS (step O11)
//
//   cd backend && npm run staff:test
//
//   POST /api/secretary/staff-accounts/:userId/deactivate
//   POST /api/secretary/staff-accounts/:userId/reactivate
//
// WHAT THIS PINS:
//   1. WHO — the Punong Barangay, Treasurer and Staff accounts the Staff
//      accounts page lists (MANAGED_ROLES). A Secretary, a resident or an
//      unknown id is a 404; the caller's own id is a 409; only the Secretary
//      reaches either route at all.
//   2. THE LAST ACTIVE STAFF ACCOUNT — refused BEFORE any write (only Staff
//      can mark rental returns), and a failed count is a 500, never "none".
//      supabase-js has no transactions, so the route also recounts after the
//      write and puts the account back if two deactivations raced.
//   3. LINKS — deactivating retires every unused set-password link, so none
//      comes back to life on reactivation; if that fails, the account is put
//      back and nothing has changed. Reactivating touches no link, no
//      password and no must_change_password.
//   4. THE PAYLOAD AND THE LOG — { message, user_id } and nothing else; one
//      log row per action, with no credential, no personal data.
//   5. THE LOGIN MESSAGE — an inactive staff-type account is told it was
//      deactivated; the rejected, archived-resident and pending branches are
//      unchanged.
//
// Requests go through the REAL secretary router, router-level authenticate
// and requireRole('secretary') included. The login message runs the real
// POST /login handler (its rate limiter is left out: it keys on a connection
// this fake request does not have, and it is not what is being tested).
//
// No server, no port, no network, no writes, and NO LIVE ROWS. The Supabase
// client points at a dead address and supabase.from is replaced for the whole
// run by an in-memory fake (the disputes:test pattern). It supports exactly
// the calls these routes make and throws on anything else.
// ===========================================================================
const path = require('path');
const { createRequire } = require('module');
const beRequire = createRequire(path.join(__dirname, '..', 'package.json'));

// Never the real credentials: nothing here may reach the live database.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'staff-test-no-network';
process.env.JWT_SECRET = 'staff-test-signing-key';
process.env.EMAIL_MODE = 'SIMULATED';
process.env.SMS_MODE = 'SIMULATED';

const jwt = beRequire('jsonwebtoken');
const bcrypt = beRequire('bcryptjs');
const supabase = require(path.join(__dirname, '..', 'src', 'config', 'supabase.js'));
const secretary = require(path.join(__dirname, '..', 'src', 'routes', 'secretary.js'));
const auth = require(path.join(__dirname, '..', 'src', 'routes', 'auth.js'));
const { isSensitiveKey, ACTIONS } = require(path.join(__dirname, '..', 'src', 'constants', 'activityLog.js'));
const { rejectionMessage } = require(path.join(__dirname, '..', 'src', 'constants', 'registration.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

// ---------------------------------------------------------------------------
// Fixtures. password_hash and email values are distinctive strings, so the
// payload and log sweeps can look for them as plain text.
// ---------------------------------------------------------------------------
const PASS = 'Fixture-Pass-91!';
const HASH = bcrypt.hashSync(PASS, 4);
const MANAGED = ['punong_barangay', 'treasurer', 'staff'];

const SEC = 910;
const SEC_2 = 920;
const RESIDENT = 901;
const STAFF_A = 931;
const STAFF_B = 932;
const STAFF_OFF = 933;
const TREASURER = 941;
const PB = 951;
const STAFF_WAITING = 961;

const user = (user_id, username, role, extra = {}) => ({
  user_id, username, role,
  email: `${username}@example.invalid`,
  password_hash: `HASH-${username}`,
  is_active: true,
  must_change_password: false,
  is_rejected: false,
  rejection_reason: null,
  ...extra,
});

const FIXTURES = {
  users: [
    user(SEC, 'sec_main', 'secretary'),
    user(SEC_2, 'sec_other', 'secretary'),
    user(RESIDENT, 'res_active', 'resident'),
    user(STAFF_A, 'staff_alpha', 'staff'),
    user(STAFF_B, 'staff_bravo', 'staff'),
    user(STAFF_OFF, 'staff_off', 'staff', { is_active: false, password_hash: HASH }),
    user(TREASURER, 'treas_only', 'treasurer'),
    user(PB, 'pb_only', 'punong_barangay'),
    user(STAFF_WAITING, 'staff_waiting', 'staff', { must_change_password: true }),
    // Login-message accounts, all inactive, all with the real fixture hash.
    user(971, 'pb_off', 'punong_barangay', { is_active: false, password_hash: HASH }),
    user(972, 'treas_off', 'treasurer', { is_active: false, password_hash: HASH }),
    user(973, 'res_rejected', 'resident', { is_active: false, password_hash: HASH, is_rejected: true, rejection_reason: 'NOT_IN_MASTERLIST' }),
    user(974, 'res_archived', 'resident', { is_active: false, password_hash: HASH }),
    user(975, 'res_pending', 'resident', { is_active: false, password_hash: HASH }),
    user(976, 'res_pending_linked', 'resident', { is_active: false, password_hash: HASH }),
  ],
  profiles: [
    { user_id: 973, resident_id: null },
    { user_id: 974, resident_id: 501 },
    { user_id: 975, resident_id: null },
    { user_id: 976, resident_id: 502 },
  ],
  resident_records: [
    { resident_id: 501, is_archived: true },
    { resident_id: 502, is_archived: false },
  ],
  password_resets: [
    { reset_id: 1, user_id: STAFF_A, token_hash: 'TOKEN-HASH-1', used_at: null, expires_at: '2026-11-09T00:00:00Z', created_at: '2026-11-06T00:00:00Z' },
    { reset_id: 2, user_id: STAFF_A, token_hash: 'TOKEN-HASH-2', used_at: null, expires_at: '2026-11-01T00:00:00Z', created_at: '2026-10-29T00:00:00Z' },
    { reset_id: 3, user_id: STAFF_A, token_hash: 'TOKEN-HASH-3', used_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-04T00:00:00Z', created_at: '2026-10-01T00:00:00Z' },
    { reset_id: 4, user_id: STAFF_B, token_hash: 'TOKEN-HASH-4', used_at: null, expires_at: '2026-11-09T00:00:00Z', created_at: '2026-11-06T00:00:00Z' },
    { reset_id: 5, user_id: STAFF_OFF, token_hash: 'TOKEN-HASH-5', used_at: '2026-10-02T00:00:00Z', expires_at: '2026-10-05T00:00:00Z', created_at: '2026-10-02T00:00:00Z' },
  ],
  activity_logs: [],
};

const RELATIONS = {
  profiles: {
    resident_records: { table: 'resident_records', local: 'resident_id', foreign: 'resident_id', many: false },
  },
};

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------
let db;
let queries;
// A predicate over a query; a matching query fails with a database error.
let fault = null;
// Called with the query just before an update runs, and just after.
let beforeUpdate = null;
let afterUpdate = null;

function fresh() {
  db = JSON.parse(JSON.stringify(FIXTURES));
  queries = [];
  fault = null;
  beforeUpdate = null;
  afterUpdate = null;
}

function parseSelect(src) {
  let i = 0;
  const skip = () => { while (i < src.length && /[\s,]/.test(src[i])) i++; };
  const list = () => {
    const nodes = [];
    for (;;) {
      skip();
      if (i >= src.length || src[i] === ')') return nodes;
      let name = '';
      while (i < src.length && !/[\s,()]/.test(src[i])) name += src[i++];
      if (/[:!]/.test(name)) throw new Error(`fake database does not support aliases or hints ("${name}")`);
      skip();
      if (src[i] === '(') {
        i++;
        const children = list();
        if (src[i] !== ')') throw new Error('unbalanced select string');
        i++;
        nodes.push({ name, children });
      } else {
        nodes.push({ name });
      }
    }
  };
  const nodes = list();
  if (i < src.length) throw new Error('unbalanced select string');
  return nodes;
}

function project(table, row, nodes) {
  const out = {};
  for (const node of nodes) {
    if (node.name === '*') throw new Error(`fake database refuses select('*') on ${table}`);
    if (!node.children) {
      if (!(node.name in row)) throw new Error(`column ${table}.${node.name} does not exist`);
      out[node.name] = row[node.name];
      continue;
    }
    const rel = RELATIONS[table]?.[node.name];
    if (!rel) throw new Error(`no relationship between ${table} and ${node.name}`);
    const related = db[rel.table].filter((r) => r[rel.foreign] === row[rel.local]);
    out[node.name] = rel.many
      ? related.map((r) => project(rel.table, r, node.children))
      : related[0] ? project(rel.table, related[0], node.children) : null;
  }
  return out;
}

const MATCH = {
  eq: (v, x) => String(v) === String(x),
  neq: (v, x) => String(v) !== String(x),
  in: (v, xs) => xs.map(String).includes(String(v)),
  is: (v, x) => (x === null ? v === null || v === undefined : v === x),
};

function fakeFrom(table) {
  if (!db[table]) throw new Error(`fake database has no table "${table}"`);
  const q = { table, op: 'select', columns: null, filters: [], single: null, payload: null, order: null };
  queries.push(q);
  const run = () => {
    if (fault && fault(q)) return { data: null, error: { message: `forced failure on ${table} ${q.op}` } };
    if (q.op === 'insert') {
      const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
      db[table].push(...rows.map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    const matches = () => db[table].filter((r) => q.filters.every(([op, col, val]) => MATCH[op](r[col], val)));
    let rows;
    if (q.op === 'update') {
      if (beforeUpdate) beforeUpdate(q);
      rows = matches();
      for (const r of rows) Object.assign(r, q.payload);
      if (afterUpdate) afterUpdate(q);
      if (q.columns === null) return { data: null, error: null };
    } else {
      rows = matches();
      if (q.order) {
        const [col, asc] = q.order;
        rows = [...rows].sort((x, y) => (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0) * (asc ? 1 : -1));
      }
    }
    const nodes = parseSelect(q.columns);
    rows = rows.map((r) => project(table, r, nodes));
    if (q.single === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows returned' } };
      return { data: rows[0] ?? null, error: null };
    }
    if (q.single === 'one') {
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'expected one row' } };
    }
    return { data: rows, error: null };
  };
  const builder = {
    select(columns, opts) {
      if (opts) throw new Error('fake database: select options (count/head) are not supported');
      q.columns = columns;
      return builder;
    },
    update(payload) { q.op = 'update'; q.payload = payload; return builder; },
    insert(payload) { q.op = 'insert'; q.payload = payload; return builder; },
    eq(col, val) { q.filters.push(['eq', col, val]); return builder; },
    neq(col, val) { q.filters.push(['neq', col, val]); return builder; },
    in(col, vals) { q.filters.push(['in', col, vals]); return builder; },
    is(col, val) { q.filters.push(['is', col, val]); return builder; },
    order(col, { ascending = true } = {}) { q.order = [col, ascending]; return builder; },
    maybeSingle() { q.single = 'maybe'; return builder; },
    single() { q.single = 'one'; return builder; },
    then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
  };
  return builder;
}

supabase.from = fakeFrom;
supabase.rpc = () => { throw new Error('fake database: rpc is not available'); };

// console.error is captured, so the "say it loudly" cases can be asserted
// and the expected noise does not read as a failure.
let errorsLogged = [];
const realError = console.error;
console.error = (...args) => { errorsLogged.push(args.join(' ')); };

// ---------------------------------------------------------------------------
// Dispatching through the real routers
// ---------------------------------------------------------------------------
const tokenFor = (userId) => jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });

function call(router, method, url, { userId, body = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: userId ? { authorization: `Bearer ${tokenFor(userId)}` } : {},
      query: {},
      body,
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, forwarded: null }); return this; },
    };
    router(req, res, (err) => resolve({ status: null, body: null, forwarded: err || 'unhandled' }));
  });
}

const deactivate = (id, by = SEC) => call(secretary, 'POST', `/staff-accounts/${id}/deactivate`, { userId: by });
const reactivate = (id, by = SEC) => call(secretary, 'POST', `/staff-accounts/${id}/reactivate`, { userId: by });

// The real POST /login handler, without the limiter in front of it.
const loginLayer = auth.stack.find((l) => l.route?.path === '/login' && l.route.methods.post);
const loginHandler = loginLayer.route.stack[loginLayer.route.stack.length - 1].handle;
function login(username) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/login', headers: {}, body: { username, password: PASS } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(loginHandler(req, res)).catch((err) => resolve({ status: null, body: null, forwarded: err }));
  });
}

const said = (r) => (r.status === null ? `forwarded: ${r.forwarded?.message || r.forwarded}` : `${r.status} ${JSON.stringify(r.body)}`);
const row = (id) => db.users.find((u) => u.user_id === id);
const resetsOf = (id) => db.password_resets.filter((p) => p.user_id === id);
const logsFor = (id) => db.activity_logs.filter((l) => l.record_id === id);
const usersUpdates = () => queries.filter((q) => q.table === 'users' && q.op === 'update');
const snapshot = () => JSON.stringify({ users: db.users, password_resets: db.password_resets, activity_logs: db.activity_logs });
const exactlyMessageAndId = (r, id) => r.body && JSON.stringify(Object.keys(r.body).sort()) === '["message","user_id"]'
  && r.body.user_id === id && typeof r.body.message === 'string' && r.body.message.length > 0;
const LAST_STAFF_WORDS = /only active Staff account.*Only Staff can mark rental returns/s;

const responses = []; // every 200 body, swept at the end

(async () => {
  console.log('Deactivate and reactivate staff-type accounts — POST /api/secretary/staff-accounts/:userId/(de|re)activate');
  console.log('No server, no network, no writes: every query is answered by an in-memory fake.');

  // -------------------------------------------------------------------------
  section('deactivate: the happy path');
  fresh();
  const before931 = { ...row(STAFF_A) };
  let r = await deactivate(STAFF_A);
  responses.push(r.body);
  check('deactivating a Staff account while another Staff account is active answers 200', r.status === 200, said(r));
  check('  the response is exactly { message, user_id }', exactlyMessageAndId(r, STAFF_A), said(r));
  check('  the account is now inactive', row(STAFF_A).is_active === false);
  check('  and nothing else on it changed (password, must_change_password, role, email)',
    ['password_hash', 'must_change_password', 'role', 'email', 'username'].every((k) => row(STAFF_A)[k] === before931[k]));
  const retired = resetsOf(STAFF_A);
  check('  both of its unused set-password links are retired (used_at set)', retired.filter((p) => p.reset_id !== 3).every((p) => typeof p.used_at === 'string'),
    retired.map((p) => `${p.reset_id}:${p.used_at}`).join(', '));
  check('  its already-used link keeps its old used_at', resetsOf(STAFF_A).find((p) => p.reset_id === 3).used_at === '2026-10-01T00:00:00Z');
  check('  another account\'s unused link is untouched', resetsOf(STAFF_B)[0].used_at === null);
  const dLog = logsFor(STAFF_A);
  check('  one log row: DEACTIVATE on users, the target as record, the Secretary as actor',
    dLog.length === 1 && dLog[0].action === ACTIONS.DEACTIVATE && dLog[0].action === 'DEACTIVATE' && dLog[0].table_name === 'users'
      && dLog[0].record_id === STAFF_A && dLog[0].user_id === SEC, JSON.stringify(dLog));
  check('  with before { is_active: true } and after { is_active: false, links_retired: 2, username, role } (the account named since the O11 follow-up)',
    JSON.stringify(dLog[0]?.old_value) === '{"is_active":true}'
      && JSON.stringify(dLog[0]?.new_value) === '{"is_active":false,"links_retired":2,"username":"staff_alpha","role":"staff"}',
    `${JSON.stringify(dLog[0]?.old_value)} -> ${JSON.stringify(dLog[0]?.new_value)}`);
  const dUpdate = usersUpdates()[0];
  check('  the write is status-guarded: is_active = true, role in the managed list, by user_id',
    !!dUpdate && dUpdate.filters.some(([op, c, v]) => op === 'eq' && c === 'is_active' && v === true)
      && dUpdate.filters.some(([op, c, v]) => op === 'in' && c === 'role' && JSON.stringify([...v].sort()) === JSON.stringify([...MANAGED].sort()))
      && dUpdate.filters.some(([op, c, v]) => op === 'eq' && c === 'user_id' && Number(v) === STAFF_A),
    JSON.stringify(dUpdate?.filters));
  check('  and writes is_active only', JSON.stringify(dUpdate?.payload) === '{"is_active":false}', JSON.stringify(dUpdate?.payload));

  fresh();
  r = await deactivate(STAFF_B);
  check('an account with one unused link logs links_retired: 1',
    r.status === 200 && logsFor(STAFF_B)[0]?.new_value?.links_retired === 1, said(r));
  fresh();
  r = await deactivate(TREASURER);
  check('the last active Treasurer can be deactivated (no guard: the Secretary covers payments)',
    r.status === 200 && row(TREASURER).is_active === false && logsFor(TREASURER)[0]?.new_value?.links_retired === 0, said(r));
  check('  its log row names the account: username "treas_only", role "treasurer"',
    logsFor(TREASURER)[0]?.new_value?.username === 'treas_only' && logsFor(TREASURER)[0]?.new_value?.role === 'treasurer',
    JSON.stringify(logsFor(TREASURER)[0]?.new_value));
  fresh();
  r = await deactivate(PB);
  check('the last active Punong Barangay can be deactivated (no guard: approves nothing in the system)',
    r.status === 200 && row(PB).is_active === false, said(r));

  // -------------------------------------------------------------------------
  section('reactivate: the happy path');
  fresh();
  const before933 = JSON.stringify(row(STAFF_OFF));
  const resetsBefore = JSON.stringify(db.password_resets);
  r = await reactivate(STAFF_OFF);
  responses.push(r.body);
  check('reactivating an inactive Staff account answers 200', r.status === 200, said(r));
  check('  the response is exactly { message, user_id }', exactlyMessageAndId(r, STAFF_OFF), said(r));
  check('  the account is active again, and NOTHING else on it changed (same password, same must_change_password)',
    JSON.stringify({ ...row(STAFF_OFF), is_active: false }) === before933 && row(STAFF_OFF).is_active === true);
  check('  no set-password link was touched', JSON.stringify(db.password_resets) === resetsBefore);
  check('  no query touched password_resets at all', !queries.some((q) => q.table === 'password_resets'));
  const rLog = logsFor(STAFF_OFF);
  check('  one log row: REACTIVATE on users, before { is_active: false }, after { is_active: true, username, role }',
    rLog.length === 1 && rLog[0].action === 'REACTIVATE' && ACTIONS.REACTIVATE === 'REACTIVATE' && rLog[0].table_name === 'users'
      && rLog[0].user_id === SEC && JSON.stringify(rLog[0].old_value) === '{"is_active":false}'
      && JSON.stringify(rLog[0].new_value) === '{"is_active":true,"username":"staff_off","role":"staff"}', JSON.stringify(rLog));
  const rUpdate = usersUpdates()[0];
  check('  the write is status-guarded: is_active = false, role in the managed list',
    !!rUpdate && rUpdate.filters.some(([op, c, v]) => op === 'eq' && c === 'is_active' && v === false)
      && rUpdate.filters.some(([op, c, v]) => op === 'in' && c === 'role' && JSON.stringify([...v].sort()) === JSON.stringify([...MANAGED].sort()))
      && JSON.stringify(rUpdate.payload) === '{"is_active":true}', JSON.stringify(rUpdate));

  // -------------------------------------------------------------------------
  section('who: 404 outside the managed roles, 400 for a bad id, 409 for self');
  for (const [label, id] of [['a Secretary', SEC_2], ['a resident', RESIDENT], ['an unknown id', 99999]]) {
    for (const [verb, fn] of [['deactivate', deactivate], ['reactivate', reactivate]]) {
      fresh();
      const snap = snapshot();
      r = await fn(id);
      check(`${verb} ${label}: 404 and nothing written`, r.status === 404 && snapshot() === snap, said(r));
    }
  }
  for (const bad of ['abc', '0', '-3', '1.5']) {
    fresh();
    r = await deactivate(bad);
    const r2 = await reactivate(bad);
    check(`id "${bad}": 400 on both`, r.status === 400 && r2.status === 400, `${said(r)} / ${said(r2)}`);
  }
  fresh();
  r = await deactivate(SEC);
  let r2 = await reactivate(SEC);
  check('the Secretary\'s own id: 409 on both, nothing written',
    r.status === 409 && r2.status === 409 && usersUpdates().length === 0 && db.activity_logs.length === 0, `${said(r)} / ${said(r2)}`);

  // -------------------------------------------------------------------------
  section('409 when the account is already in that state, or changed underneath');
  fresh();
  r = await deactivate(STAFF_OFF);
  r2 = await reactivate(STAFF_A);
  check('deactivating an inactive account and reactivating an active one: 409, nothing written',
    r.status === 409 && r2.status === 409 && usersUpdates().length === 0 && db.activity_logs.length === 0, `${said(r)} / ${said(r2)}`);
  // Another request deactivates STAFF_A between this route's read and its
  // write: the status guard must make the write match nothing.
  fresh();
  beforeUpdate = (q) => {
    if (q.payload?.is_active === false) row(STAFF_A).is_active = false;
    beforeUpdate = null;
  };
  r = await deactivate(STAFF_A);
  check('a deactivation that lands between the read and the write: 409, no log row, no link retired',
    r.status === 409 && logsFor(STAFF_A).length === 0 && resetsOf(STAFF_A).filter((p) => p.used_at === null).length === 2, said(r));
  fresh();
  beforeUpdate = (q) => {
    if (q.payload?.is_active === true) row(STAFF_OFF).is_active = true;
    beforeUpdate = null;
  };
  r = await reactivate(STAFF_OFF);
  check('a reactivation that lands between the read and the write: 409, no log row', r.status === 409 && logsFor(STAFF_OFF).length === 0, said(r));

  // -------------------------------------------------------------------------
  section('the last active Staff account');
  fresh();
  row(STAFF_B).is_active = false;
  row(STAFF_WAITING).is_active = false;
  let snap = snapshot();
  r = await deactivate(STAFF_A);
  check('deactivating the last active Staff account: 409 with the plain reason', r.status === 409 && LAST_STAFF_WORDS.test(r.body?.error || ''), said(r));
  check('  refused BEFORE any write: no update to users was sent at all', usersUpdates().length === 0, `${usersUpdates().length} update(s)`);
  check('  and nothing changed (still active, links intact, no log row)', snapshot() === snap);
  fresh();
  row(STAFF_B).is_active = false;
  r = await deactivate(STAFF_A);
  check('another active Staff account (even one still waiting for its password) is enough: 200', r.status === 200, said(r));

  // A failed count must never read as "none" — or as "some".
  fresh();
  fault = (q) => q.table === 'users' && q.op === 'select' && q.filters.some(([op, c, v]) => op === 'eq' && c === 'role' && v === 'staff');
  snap = snapshot();
  r = await deactivate(STAFF_A);
  check('a failed count of the other Staff accounts is a 500 (forwarded to the error handler), never allowed',
    r.status === null && r.forwarded instanceof Error && snapshot() === snap && usersUpdates().length === 0, said(r));

  // Two deactivations at once: each counted the other as active.
  fresh();
  row(STAFF_WAITING).is_active = false;
  afterUpdate = (q) => {
    if (q.payload?.is_active === false) { row(STAFF_B).is_active = false; afterUpdate = null; }
  };
  errorsLogged = [];
  r = await deactivate(STAFF_A);
  check('two deactivations racing (the recount after the write finds no active Staff): the account is put back, same 409',
    r.status === 409 && LAST_STAFF_WORDS.test(r.body?.error || '') && row(STAFF_A).is_active === true, said(r));
  check('  the other request\'s write stands, no link was retired, no log row for this one',
    row(STAFF_B).is_active === false && resetsOf(STAFF_A).filter((p) => p.used_at === null).length === 2 && logsFor(STAFF_A).length === 0);
  check('  the put-back was guarded (is_active = false) and nothing was logged as an error', (() => {
    const back = usersUpdates().find((q) => q.payload?.is_active === true);
    return !!back && back.filters.some(([op, c, v]) => op === 'eq' && c === 'is_active' && v === false) && errorsLogged.length === 0;
  })(), errorsLogged.join(' | '));

  fresh();
  row(STAFF_WAITING).is_active = false;
  afterUpdate = (q) => {
    if (q.payload?.is_active === false) { row(STAFF_B).is_active = false; afterUpdate = null; }
  };
  fault = (q) => q.table === 'users' && q.op === 'update' && q.payload?.is_active === true;
  errorsLogged = [];
  r = await deactivate(STAFF_A);
  check('  if that put-back fails too: a 500 and a console.error saying so',
    r.status === 500 && errorsLogged.some((e) => /931/.test(e) && /by hand/i.test(e)), `${said(r)} | ${errorsLogged.join(' | ')}`);

  fresh();
  let counts = 0;
  fault = (q) => q.table === 'users' && q.op === 'select' && q.filters.some(([op, c, v]) => op === 'eq' && c === 'role' && v === 'staff') && ++counts === 2;
  r = await deactivate(STAFF_A);
  check('a failed recount after the write: the account is put back and the error reaches the handler (500)',
    r.status === null && r.forwarded instanceof Error && row(STAFF_A).is_active === true && logsFor(STAFF_A).length === 0, said(r));

  // -------------------------------------------------------------------------
  section('retiring the links');
  fresh();
  fault = (q) => q.table === 'password_resets' && q.op === 'update';
  errorsLogged = [];
  r = await deactivate(STAFF_A);
  check('if the links cannot be retired: 500 "nothing was changed", the account is active again, no log row',
    r.status === 500 && /nothing was changed/i.test(r.body?.error || '') && row(STAFF_A).is_active === true && logsFor(STAFF_A).length === 0, said(r));
  check('  and its links are still unused (nothing half-done)', resetsOf(STAFF_A).filter((p) => p.used_at === null).length === 2);
  fresh();
  fault = (q) => (q.table === 'password_resets' && q.op === 'update') || (q.table === 'users' && q.op === 'update' && q.payload?.is_active === true);
  errorsLogged = [];
  r = await deactivate(STAFF_A);
  check('  if putting it back fails as well: 500 and a console.error saying so',
    r.status === 500 && !/nothing was changed/i.test(r.body?.error || '') && errorsLogged.some((e) => /931/.test(e) && /by hand/i.test(e)),
    `${said(r)} | ${errorsLogged.join(' | ')}`);

  // -------------------------------------------------------------------------
  section('roles, through the real router');
  for (const [label, id] of [['resident', RESIDENT], ['staff', STAFF_B], ['treasurer', TREASURER], ['punong_barangay', PB]]) {
    fresh();
    snap = snapshot();
    r = await deactivate(STAFF_A, id);
    r2 = await reactivate(STAFF_OFF, id);
    check(`${label} gets 403 on both, nothing written`,
      r.status === 403 && r2.status === 403 && r.body?.error === 'Insufficient permissions' && snapshot() === snap, `${said(r)} / ${said(r2)}`);
  }
  fresh();
  r = await call(secretary, 'POST', `/staff-accounts/${STAFF_A}/deactivate`, {});
  check('no token gets 401', r.status === 401, said(r));

  // -------------------------------------------------------------------------
  section('the list the page reads: must_change_password on every row');
  // The page words Reactivate differently for an account still on
  // must_change_password (it may never have set a password, and deactivating
  // retired its links). The list already sends that flag; this pins it.
  fresh();
  r = await call(secretary, 'GET', '/staff-accounts', { userId: SEC });
  const listed = r.body?.accounts || [];
  check('GET /staff-accounts lists the managed accounts with a boolean must_change_password on every row',
    r.status === 200 && listed.length === FIXTURES.users.filter((u) => MANAGED.includes(u.role)).length
      && listed.every((a) => typeof a.must_change_password === 'boolean')
      && listed.find((a) => a.user_id === STAFF_WAITING)?.must_change_password === true
      && listed.find((a) => a.user_id === STAFF_A)?.must_change_password === false, said(r).slice(0, 200));
  check('  and never password_hash, on any row', listed.length > 0 && listed.every((a) => !('password_hash' in a))
    && !JSON.stringify(r.body).includes('HASH-'));

  // -------------------------------------------------------------------------
  section('the payloads and the log rows carry nothing else');
  const raw = JSON.stringify(responses);
  const leakedKeys = ['password_hash', 'email', 'last_link_sent_at', 'must_change_password', 'role', 'is_active', 'username']
    .filter((k) => raw.includes(`"${k}"`));
  check('no account field is a key in any 200 response', responses.length === 2 && leakedKeys.length === 0, leakedKeys.join(', ') || 'none');
  check('no password hash or email value anywhere in a 200 response',
    !FIXTURES.users.some((u) => raw.includes(u.password_hash) || raw.includes(u.email)));
  fresh();
  await deactivate(STAFF_A);
  await reactivate(STAFF_A);
  await reactivate(STAFF_OFF);
  await deactivate(TREASURER);
  // Since the O11 follow-up each row names the account it acted on, as the
  // staff CREATE row does: its username and role, and nothing more.
  const allowed = ['is_active', 'links_retired', 'username', 'role'];
  const logKeys = db.activity_logs.flatMap((l) => [...Object.keys(l.old_value || {}), ...Object.keys(l.new_value || {})]);
  check('every logged value is is_active, links_retired, username or role, and none is a deny-listed key',
    db.activity_logs.length === 4 && logKeys.every((k) => allowed.includes(k)) && !logKeys.some(isSensitiveKey), [...new Set(logKeys)].join(', '));
  check('  no logged key contains password, token or secret',
    !logKeys.some((k) => /password|token|secret/i.test(k)), [...new Set(logKeys)].join(', '));
  check('every row names the account it acted on: its own username and role, in new_value',
    db.activity_logs.every((l) => {
      const u = FIXTURES.users.find((x) => x.user_id === l.record_id);
      return u && l.new_value?.username === u.username && l.new_value?.role === u.role;
    }), JSON.stringify(db.activity_logs.map((l) => [l.record_id, l.new_value?.username, l.new_value?.role])));
  const logRaw = JSON.stringify(db.activity_logs);
  check('no email, hash or token hash in any log row',
    !FIXTURES.users.some((u) => logRaw.includes(u.email) || logRaw.includes(u.password_hash))
      && !db.password_resets.some((p) => logRaw.includes(p.token_hash)) && !logRaw.includes('"email"'));
  check('the actions, in order: DEACTIVATE, REACTIVATE, REACTIVATE, DEACTIVATE',
    db.activity_logs.map((l) => l.action).join(',') === 'DEACTIVATE,REACTIVATE,REACTIVATE,DEACTIVATE', db.activity_logs.map((l) => l.action).join(','));

  // -------------------------------------------------------------------------
  section('the login message for an inactive account');
  fresh();
  const DEACTIVATED = 'This account has been deactivated. Please contact the Barangay Office.';
  for (const name of ['staff_off', 'pb_off', 'treas_off']) {
    r = await login(name);
    check(`inactive ${name}: 403 "${DEACTIVATED}"`, r.status === 403 && r.body?.error === DEACTIVATED, said(r));
  }
  r = await login('res_rejected');
  check('a rejected resident still gets the reason\'s sentence (checked first)',
    r.status === 403 && r.body?.error === rejectionMessage('NOT_IN_MASTERLIST'), said(r));
  r = await login('res_archived');
  check('a resident linked to an archived record still gets the deactivated sentence', r.status === 403 && r.body?.error === DEACTIVATED, said(r));
  r = await login('res_pending');
  r2 = await login('res_pending_linked');
  check('a pending resident, unlinked or linked, still gets the pending-approval message',
    r.status === 403 && r.body?.error === 'Account is pending approval by the Barangay Secretary'
      && r2.status === 403 && r2.body?.error === 'Account is pending approval by the Barangay Secretary', `${said(r)} / ${said(r2)}`);

  console.error = realError;
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error = realError; console.error(e.stack || e.message); process.exit(1); });
