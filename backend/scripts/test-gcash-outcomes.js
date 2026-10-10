// Regression guard for the THREE triggers that can settle a charge.
//
// WHY THIS EXISTS: the checkout-resume interlock originally ignored
// settlePaidCharge's return value and always answered "This charge has
// already been paid" — including for the `underpaid` and `void` outcomes,
// where the money was NOT applied. Telling a resident they had paid when they
// had not is the worst failure this module can produce, so the wording is
// pinned here rather than left to a reviewer to notice.
//
// It also enforces the invariant that keeps this safe as the module grows:
// every outcome settlePaidCharge can return must have accurate wording in
// BOTH caller-facing maps. Adding a new outcome without wording fails here
// instead of silently falling back to a message that misstates what happened.
//
// Section 6 runs the two resident DECLARE routes (POST /mine/:id/pay on
// documents and rentals) through their real handlers, since a resident may
// declare only 'onsite' after the "I already paid via GCash" option was
// removed on 10 Oct 2026.
//
// Section 7 runs GET /api/charges, the Payments list, through its real
// handler: each charge carries its payment record, and the response carries a
// total, so a list cut short by Supabase's 1,000-row cap can be told apart
// from a complete one.
//
// Section 8 sweeps that list's whole payload for contact data: no email and
// no phone number, under any key or in any value, while the names, usernames,
// addresses and head names the Payments page shows are all still there.
//
// Makes NO network calls — no database, no PayMongo, no tunnel, and the API
// does not need to be running. The Supabase URL and key below are dead values
// set BEFORE .env loads (dotenv never overrides a variable that is already
// set), fetch throws if anything calls it, and sections 6, 7 and 8 replace
// supabase.from with in-memory tables. The live behaviour of the three
// triggers is exercised separately against the sandbox.
//
// Run with: npm run gateway:test   (from /backend)

// Never the real credentials: nothing in this file may reach the live
// database or PayMongo.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gateway-test-no-network';
process.env.JWT_SECRET = 'gateway-test-signing-key';
process.env.PAYMONGO_SECRET_KEY = 'sk_test_gateway-test-no-network';
globalThis.fetch = async (url) => {
  throw new Error(`gateway:test must not reach the network (${url})`);
};
require('dotenv').config();

const { SETTLE_OUTCOME, RESUME_MESSAGES, RECONCILE_MESSAGES } = require('../src/routes/payments');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
}

const OUTCOMES = Object.values(SETTLE_OUTCOME);

// Outcomes where the charge did NOT end up paid. Wording for these must never
// tell the resident their payment went through.
const NOT_SETTLED = [SETTLE_OUTCOME.VOID, SETTLE_OUTCOME.UNDERPAID];
// Phrases that assert the money is accounted for.
const CLAIMS_PAID = [/is now paid/i, /has already been paid/i, /already recorded/i, /just been settled/i];

console.log('outcomes under test:', OUTCOMES.join(', '), '\n');

// 1. Exhaustiveness — the invariant that stops the maps drifting.
for (const outcome of OUTCOMES) {
  check(`resume wording exists for '${outcome}'`, typeof RESUME_MESSAGES[outcome] === 'string' && RESUME_MESSAGES[outcome].length > 0);
  check(`reconcile wording exists for '${outcome}'`, typeof RECONCILE_MESSAGES[outcome] === 'string' && RECONCILE_MESSAGES[outcome].length > 0);
}

// No stray keys that no longer correspond to a real outcome.
for (const [name, map] of [['RESUME_MESSAGES', RESUME_MESSAGES], ['RECONCILE_MESSAGES', RECONCILE_MESSAGES]]) {
  const stray = Object.keys(map).filter((k) => !OUTCOMES.includes(k));
  check(`${name} has no keys outside SETTLE_OUTCOME`, stray.length === 0, stray.join(', ') || 'none');
}

// 2. THE ACTUAL BUG — an unsettled outcome must not claim payment succeeded.
console.log('');
for (const outcome of NOT_SETTLED) {
  for (const [name, map] of [['resume', RESUME_MESSAGES], ['reconcile', RECONCILE_MESSAGES]]) {
    const text = map[outcome];
    const lies = CLAIMS_PAID.find((re) => re.test(text));
    check(`${name} wording for '${outcome}' does NOT claim the charge is paid`, !lies, text);
  }
}

// 3. And it must point the resident somewhere, not leave them stuck.
for (const outcome of NOT_SETTLED) {
  check(
    `resume wording for '${outcome}' tells the resident what to do`,
    /Barangay Office/i.test(RESUME_MESSAGES[outcome]),
    RESUME_MESSAGES[outcome]
  );
}

// 4. The success wording must actually state the charge is settled — the
//    resume path reports it through a 409, so vague wording would read as a
//    failure to a resident who has just paid.
console.log('');
check(
  "resume wording for 'recorded' confirms the payment landed",
  /is now paid/i.test(RESUME_MESSAGES[SETTLE_OUTCOME.RECORDED]),
  RESUME_MESSAGES[SETTLE_OUTCOME.RECORDED]
);
check(
  "reconcile wording for 'recorded' confirms the payment landed",
  /now paid/i.test(RECONCILE_MESSAGES[SETTLE_OUTCOME.RECORDED]),
  RECONCILE_MESSAGES[SETTLE_OUTCOME.RECORDED]
);

// 5. Structural check: every `outcome:` literal returned by settlePaidCharge
//    is a declared SETTLE_OUTCOME value. This is what catches a future outcome
//    added straight into the function without wording — the failure mode the
//    two maps alone cannot detect.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
const literals = [...source.matchAll(/outcome:\s*'([a-z_]+)'/g)].map((m) => m[1]);
check(
  'settlePaidCharge returns no raw outcome strings (all via SETTLE_OUTCOME)',
  literals.length === 0,
  literals.join(', ') || 'none found'
);
const referenced = [...source.matchAll(/SETTLE_OUTCOME\.([A-Z_]+)/g)].map((m) => m[1]);
const undeclared = referenced.filter((k) => !(k in SETTLE_OUTCOME));
check('every SETTLE_OUTCOME.* reference is declared', undeclared.length === 0, undeclared.join(', ') || 'none');

// 6. The resident DECLARE routes. A resident may declare only 'onsite': a
//    GCash declaration is refused before anything is read or written, and an
//    onsite declaration still clears a GCash reference left on a charge from
//    before 10 Oct 2026 (charges 35 and 141 on the live system hold one).
//
//    The REAL handlers come from router.stack, past the router-level
//    authenticate, with req.user supplied. supabase.from is replaced by
//    in-memory tables that answer exactly the queries these routes make: the
//    caller's profile, the request or booking with its embedded charge, the
//    status-guarded charges update and the activity_logs insert. Every write
//    is recorded, and every call starts from fresh tables.
const supabase = require('../src/config/supabase');
const documentRequests = require('../src/routes/documentRequests');
const rentalRequests = require('../src/routes/rentalRequests');

const GCASH_REMOVED =
  'Submitting a GCash reference is no longer available. Choose Pay online via GCash, or pay at the Barangay Office.';
const ONSITE_NOTED = "Noted — please pay in cash at the barangay hall treasurer's desk.";
const CALLER = { user_id: 501, username: 'declare_probe', role: 'resident' };
const LEGACY_AT = '2026-10-01T02:00:00.000Z';

const DECLARE_ROUTES = [
  { name: 'documents', router: documentRequests, table: 'document_requests', fk: 'document_request_id',
    status: 'approved', notFound: 'Request not found', noun: 'request', base: 700 },
  { name: 'rentals', router: rentalRequests, table: 'rental_requests', fk: 'rental_request_id',
    status: 'confirmed', notFound: 'Booking not found', noun: 'booking', base: 710 },
];

// Request n belongs to charge base + 100 + n. Requests 1-4 are the caller's
// (resident 9001), request 5 is another resident's.
function freshDb(route) {
  const id = (n) => route.base + n;
  const charge = (n, status, extra = {}) => ({
    charge_id: route.base + 100 + n, amount: 150, status, [route.fk]: id(n),
    declared_method: null, declared_reference: null, declared_at: null, ...extra,
  });
  return {
    calls: [],
    afterRead: null,
    profiles: [
      { user_id: 501, resident_id: 9001 },
      { user_id: 502, resident_id: 9002 },
    ],
    [route.table]: [1, 2, 3, 4, 5].map((n) => ({ request_id: id(n), resident_id: n === 5 ? 9002 : 9001, status: route.status })),
    charges: [
      charge(1, 'UNPAID'),
      charge(2, 'UNPAID', { declared_method: 'gcash', declared_reference: 'LEGACY-REF-0001', declared_at: LEGACY_AT }),
      charge(3, 'PAID'),
      charge(4, 'VOID'),
      charge(5, 'UNPAID'),
    ],
    activity_logs: [],
  };
}

// The listed columns of a select string, embeds removed: "a, b, charges ( x )" gives [a, b].
const topColumns = (sel) => String(sel).replace(/\w+\s*\([^)]*\)/g, '').split(',').map((s) => s.trim()).filter(Boolean);
const pickCols = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));

// A query builder over db. A method these routes never call does not exist on
// it, so a route that starts making a new kind of query fails here loudly.
function fakeFrom(db, route) {
  return (table) => {
    if (!Array.isArray(db[table])) throw new Error(`unexpected table ${table}`);
    const q = { op: 'select', sel: '*', filters: [], patch: null, rows: null, single: false };
    const run = () => {
      if (q.op === 'insert') {
        db.calls.push({ table, op: 'insert' });
        db[table].push(...[].concat(q.rows).map((r) => structuredClone(r)));
        return { data: null, error: null };
      }
      const rows = db[table].filter((row) => q.filters.every(([c, v]) => row[c] === v));
      if (q.op === 'update') {
        db.calls.push({ table, op: 'update', filters: q.filters });
        for (const row of rows) Object.assign(row, q.patch);
      }
      const embed = /charges\s*\(([^)]*)\)/.exec(q.sel);
      const out = rows.map((row) => {
        const shaped = q.sel === '*' ? { ...row } : pickCols(row, topColumns(q.sel));
        if (embed) {
          const cols = embed[1].split(',').map((s) => s.trim()).filter(Boolean);
          shaped.charges = db.charges.filter((c) => c[route.fk] === row.request_id).map((c) => pickCols(c, cols));
        }
        return shaped;
      });
      // The race hook runs after the read has been answered, as a concurrent
      // write would land between the route's read and its update.
      if (q.op === 'select' && db.afterRead) db.afterRead(table);
      if (!q.single) return { data: out, error: null };
      if (out.length > 1) return { data: null, error: { message: 'more than one row' } };
      return { data: out[0] ?? null, error: null };
    };
    const b = {
      select(sel) { q.sel = sel ?? '*'; return b; },
      eq(c, v) { q.filters.push([c, v]); return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      insert(rows) { q.op = 'insert'; q.rows = rows; return b; },
      maybeSingle() { q.single = true; return b; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return b;
  };
}

const handlerFor = (router, method, routePath) => {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath} on the router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const invoke = (handler, req) => new Promise((resolve, reject) => {
  let done = false;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(body) { done = true; resolve({ status: this.statusCode, body }); return this; },
  };
  Promise.resolve(handler(req, res)).then(() => { if (!done) resolve({ status: 'no response', body: null }); }, reject);
});

const declaredOf = (c) => [c.declared_method, c.declared_reference, c.declared_at];

async function declareRouteChecks() {
  console.log('\n--- 6. the resident declare routes: real handlers, fake tables ---');
  const realFrom = supabase.from;
  try {
    for (const route of DECLARE_ROUTES) {
      let handler;
      try {
        handler = handlerFor(route.router, 'post', '/mine/:id/pay');
      } catch (e) {
        check(`${route.name}: POST /mine/:id/pay is on the router`, false, e.message);
        continue;
      }
      const tag = (s) => `${route.name}: ${s}`;

      // POSTs `body` for request n against fresh tables. `wrote` is true when a
      // log row was inserted or any charge's declaration changed.
      const call = async (n, body, setup) => {
        const db = freshDb(route);
        if (setup) setup(db);
        const before = JSON.stringify(db.charges.map(declaredOf));
        supabase.from = fakeFrom(db, route);
        let res;
        try {
          res = await invoke(handler, { user: CALLER, params: { id: String(route.base + n) }, body });
        } catch (e) {
          res = { status: 'threw', body: { error: e.message } };
        }
        const wrote = db.calls.some((c) => c.op === 'insert') || JSON.stringify(db.charges.map(declaredOf)) !== before;
        return { ...res, db, wrote, charge: db.charges.find((c) => c.charge_id === route.base + 100 + n) };
      };
      const said = (r) => `${r.status} ${r.body?.error || r.body?.message || ''}`.trim();

      // 1. GCash WITH a reference: refused before anything is written.
      let r = await call(1, { method: 'gcash', reference_no: 'GC-2026-0001' });
      check(tag('gcash with a reference gets the "no longer available" 400'),
        r.status === 400 && r.body?.error === GCASH_REMOVED, said(r));
      check(tag('  nothing is written'), !r.wrote, r.wrote ? JSON.stringify(r.charge) : '');
      check(tag('  no DECLARE_PAYMENT log'), !r.db.activity_logs.some((l) => l.action === 'DECLARE_PAYMENT'),
        `${r.db.activity_logs.length} log row(s)`);

      // 2. GCash with NO reference: the same 400, not the old "reference required".
      r = await call(1, { method: 'gcash' });
      check(tag('gcash without a reference gets the same 400'), r.status === 400 && r.body?.error === GCASH_REMOVED, said(r));
      check(tag('  nothing is written, no log'), !r.wrote && r.db.activity_logs.length === 0);

      // 3. Onsite: declared, cleared and logged with the method only.
      const t0 = Date.now();
      r = await call(1, { method: 'onsite' });
      check(tag('onsite succeeds with the onsite wording'), r.status === 200 && r.body?.message === ONSITE_NOTED, said(r));
      const at = Date.parse(r.charge?.declared_at);
      check(tag("  the charge holds 'onsite', a null reference and declared_at now, and is still UNPAID"),
        r.charge?.declared_method === 'onsite' && r.charge?.declared_reference === null
          && Number.isFinite(at) && Math.abs(at - t0) < 5000 && r.charge?.status === 'UNPAID'
          && r.body?.charge?.declared_method === 'onsite' && r.body?.charge?.declared_reference === null,
        JSON.stringify(r.charge));
      const logs = r.db.activity_logs;
      check(tag("  one DECLARE_PAYMENT log on that charge, by the caller, holding { method: 'onsite' } only"),
        logs.length === 1 && logs[0].action === 'DECLARE_PAYMENT' && logs[0].table_name === 'charges'
          && logs[0].record_id === route.base + 101 && logs[0].user_id === CALLER.user_id
          && logs[0].old_value === null && JSON.stringify(logs[0].new_value) === '{"method":"onsite"}',
        JSON.stringify(logs));

      // 4. Onsite on a charge still holding a GCash reference from before the change.
      r = await call(2, { method: 'onsite' });
      check(tag('onsite on a legacy GCash declaration clears the reference'),
        r.status === 200 && r.charge?.declared_method === 'onsite' && r.charge?.declared_reference === null
          && r.charge?.declared_at !== LEGACY_AT,
        JSON.stringify(r.charge));

      // 5. An unknown or missing method keeps the "method must be" 400.
      for (const [label, body] of [["an unknown method ('cash')", { method: 'cash' }], ['a missing method', {}]]) {
        r = await call(1, body);
        check(tag(`${label} gets the "method must be 'onsite'" 400, nothing written`),
          r.status === 400 && /^method must be 'onsite'/.test(r.body?.error || '') && !r.wrote
            && r.db.activity_logs.length === 0,
          said(r));
      }

      // 6. The existing refusals, unchanged.
      r = await call(3, { method: 'onsite' });
      check(tag('a PAID charge: 409 "This charge is already paid", nothing written'),
        r.status === 409 && r.body?.error === 'This charge is already paid' && !r.wrote, said(r));
      r = await call(4, { method: 'onsite' });
      check(tag('a VOID charge: 409 "This charge is already void", nothing written'),
        r.status === 409 && r.body?.error === 'This charge is already void' && !r.wrote, said(r));
      r = await call(5, { method: 'onsite' });
      check(tag(`someone else's ${route.noun}: 404 "${route.notFound}", nothing written`),
        r.status === 404 && r.body?.error === route.notFound && !r.wrote, said(r));
      // The update stays guarded by status = 'UNPAID': the charge is verified
      // between the route's read and its update.
      r = await call(1, { method: 'onsite' }, (db) => {
        db.afterRead = (table) => { if (table === route.table) db.charges[0].status = 'PAID'; };
      });
      check(tag('a charge verified between the read and the update: 409 "just processed", nothing written'),
        r.status === 409 && r.body?.error === 'This charge was just processed — refresh to see its status'
          && !r.wrote && r.db.activity_logs.length === 0,
        said(r));
    }
  } catch (err) {
    check('the declare-route section ran to the end', false, err.message);
  } finally {
    supabase.from = realFrom;
  }
}

// 7. GET /api/charges, the Payments list. Each charge carries its payment
//    record as an ARRAY, because payments.charge_id has no UNIQUE constraint.
//    A PayMongo payment has no recorder, since nobody received it, and a
//    charge with no payment row has an empty array. The response also carries
//    total, the number of charges the status filter matches, counted by the
//    same query: the list has no range, so past Supabase's cap of 1,000 rows
//    it would be cut silently, and total is how the page can tell.
//
//    The REAL handler runs against in-memory tables. The fake answers the two
//    queries it makes (the list, then the household heads) and honours the
//    select string, aliases and embeds included, the way PostgREST resolves
//    them from the foreign keys: a to-many embed is an array, a to-one embed
//    an object or null, and an unknown column or relationship comes back as
//    an error rather than a guess. It returns at most 1,000 rows, as Supabase
//    does by default, while count: 'exact' still counts every row the filters
//    match. Every call starts from fresh tables.
const { isDeepStrictEqual } = require('util');
const chargesRouter = require('../src/routes/charges');

const LIST_MAX_ROWS = 1000;
const LIST_CALLER = { user_id: 7201, username: 'treasurer_probe', role: 'treasurer' };

// Each embed PostgREST would resolve: the row's `local` column matched against
// the related table's `foreign` column. A `many` embed comes back as an array.
const LIST_RELATIONS = {
  charges: {
    users: { table: 'users', local: 'user_id', foreign: 'user_id', many: false },
    payments: { table: 'payments', local: 'charge_id', foreign: 'charge_id', many: true },
    document_requests: { table: 'document_requests', local: 'document_request_id', foreign: 'request_id', many: false },
    rental_requests: { table: 'rental_requests', local: 'rental_request_id', foreign: 'request_id', many: false },
    events: { table: 'events', local: 'event_id', foreign: 'event_id', many: false },
    household_records: { table: 'household_records', local: 'household_id', foreign: 'household_id', many: false },
  },
  payments: {
    users: { table: 'users', local: 'received_by_user_id', foreign: 'user_id', many: false },
  },
  users: {
    profiles: { table: 'profiles', local: 'user_id', foreign: 'user_id', many: false },
  },
  document_requests: {
    document_types: { table: 'document_types', local: 'document_type_id', foreign: 'document_type_id', many: false },
    resident_records: { table: 'resident_records', local: 'resident_id', foreign: 'resident_id', many: false },
  },
  rental_requests: {
    rental_items: { table: 'rental_items', local: 'item_id', foreign: 'item_id', many: false },
    resident_records: { table: 'resident_records', local: 'resident_id', foreign: 'resident_id', many: false },
  },
  household_members: {
    resident_records: { table: 'resident_records', local: 'resident_id', foreign: 'resident_id', many: false },
  },
};

// Fixture rows carry every column of the real table, so a select naming a
// column the table does not have fails here as it would against the database.
// The password hashes and the profile phone numbers must never reach the list.
const listUser = (user_id, username, role, email) => ({
  user_id, username, password_hash: `hash-not-for-any-payload-${user_id}`, email, email_verified: false, role,
  must_change_password: false, is_active: true, is_rejected: false, rejection_reason: null, rejection_note: null,
  rejected_at: null, rejected_by_user_id: null,
});
const listProfile = (user_id, first_name, middle_name, last_name, suffix, phone_number) => ({
  user_id, first_name, middle_name, last_name, suffix, phone_number, resident_id: null, birthdate: null, address: null,
});
const listResident = (resident_id, first_name, middle_name, last_name, suffix, contact_number) => ({
  resident_id, first_name, middle_name, last_name, suffix, birthdate: '1980-01-01', birthplace: null,
  address: 'Ubujan, Tagbilaran City', sex: null, civil_status: null, religion: null, educational_attainment: null,
  contact_number, date_registered: '2026-07-01T00:00:00+00:00', masterlist_registered_on: null, is_archived: false,
});
const listDocument = (request_id, document_type_id, requested_by_user_id, resident_id, purpose, status) => ({
  request_id, document_type_id, requested_by_user_id, resident_id, purpose, status, processed_by_user_id: 7202,
  claimed_at: null, requested_at: '2026-09-25T00:00:00+00:00', rejection_reason: null, processed_at: '2026-09-26T00:00:00+00:00',
});
const listRental = (request_id, item_id, requested_by_user_id, quantity_requested, status, borrower) => ({
  request_id, item_id, requested_by_user_id, quantity_requested, start_datetime: '2026-10-10T00:00:00+00:00',
  end_datetime: '2026-10-10T08:00:00+00:00', purpose: 'Birthday', status, processed_by_user_id: null, return_note: null,
  returned_at: null, returned_by_user_id: null, resident_id: null, outside_borrower_name: null,
  outside_borrower_contact: null, ...borrower,
});
const listCharge = (charge_id, charge_type, status, created_at, extra = {}) => ({
  charge_id, charge_type, amount: 100, status, household_id: null, user_id: null, event_id: null,
  document_request_id: null, rental_request_id: null, created_at, declared_method: null, declared_reference: null,
  declared_at: null, paymongo_session_id: null, paymongo_payment_id: null, ...extra,
});
const listPayment = (payment_id, charge_id, amount, payment_method, reference_no, received_by_user_id, created_at) => ({
  payment_id, charge_id, amount, payment_method, reference_no, received_by_user_id, created_at,
});

function listDb() {
  return {
    ran: [],
    faults: {},
    users: [
      listUser(7201, 'treasurer_probe', 'treasurer', 'teresita.recorder@example.invalid'),
      listUser(7202, 'secretary_probe', 'secretary', 'segundo.recorder@example.invalid'),
      listUser(7301, 'payer_pacita', 'resident', 'pacita.payer@example.invalid'),
      listUser(7302, 'payer_ramon', 'resident', 'ramon.payer@example.invalid'),
    ],
    profiles: [
      listProfile(7201, 'Teresita', 'Lim', 'Ocampo', null, '09175550001'),
      listProfile(7202, 'Segundo', null, 'Magbanua', 'III', '09175550002'),
      listProfile(7301, 'Pacita', 'Ramos', 'Dumaguete', null, '09175550003'),
      listProfile(7302, 'Ramon', null, 'Villaflor', null, '09175550004'),
    ],
    resident_records: [
      listResident(9401, 'Hermogenes', 'Pacana', 'Bulawan', 'Jr.', '09170009401'),
      listResident(9402, 'Lorenzo', 'Abad', 'Tirol', null, '09170009402'),
      listResident(9403, 'Rosalinda', 'Cruz', 'Bulawan', null, '09170009403'),
      listResident(9404, 'Natividad', null, 'Sarabia', null, null),
      listResident(9405, 'Crisanto', 'Ponce', 'Olaguer', null, '09170009405'),
      listResident(9411, 'Pacita', 'Ramos', 'Dumaguete', null, '09170009411'),
      listResident(9412, 'Ramon', null, 'Villaflor', null, null),
    ],
    household_records: [
      { household_id: 9501, address: 'Purok 1, Ubujan', registered_at: '2026-07-01T00:00:00+00:00', is_active: true },
      { household_id: 9502, address: 'Purok 2, Ubujan', registered_at: '2026-07-01T00:00:00+00:00', is_active: true },
      { household_id: 9503, address: 'Purok 3, Ubujan', registered_at: '2026-07-01T00:00:00+00:00', is_active: true },
    ],
    // Household 9501's current head is listed BEFORE its former head and a
    // spouse, so a heads query that lost its role or date_ended filter would
    // pick up one of the later rows instead. 9503's only head has left.
    household_members: [
      { membership_id: 9901, household_id: 9501, resident_id: 9401, role: 'Head', date_started: '2026-03-01', date_ended: null },
      { membership_id: 9902, household_id: 9501, resident_id: 9402, role: 'Head', date_started: '2019-05-01', date_ended: '2026-03-01' },
      { membership_id: 9903, household_id: 9501, resident_id: 9403, role: 'Spouse', date_started: '2026-03-01', date_ended: null },
      { membership_id: 9904, household_id: 9502, resident_id: 9404, role: 'Head', date_started: '2026-07-15', date_ended: null },
      { membership_id: 9905, household_id: 9503, resident_id: 9405, role: 'Head', date_started: '2021-01-10', date_ended: '2026-06-30' },
    ],
    events: [
      { event_id: 9801, title: 'General Assembly', description: null, start_datetime: '2026-10-03T00:00:00+00:00',
        end_datetime: '2026-10-03T08:00:00+00:00', location: 'Barangay Hall', date_created: '2026-09-20T00:00:00+00:00',
        type: 'activity', is_archived: false, attendance_required: true, fine_amount: 50 },
    ],
    document_types: [
      { document_type_id: 9651, name: 'Barangay Clearance', description: null, fee: 100, is_active: true },
      { document_type_id: 9652, name: 'Certificate of Residency', description: null, fee: 50, is_active: true },
    ],
    document_requests: [
      listDocument(9601, 9651, 7301, 9411, 'Employment', 'ready_for_release'),
      listDocument(9602, 9652, 7301, 9411, 'Scholarship', 'ready_for_release'),
      listDocument(9603, 9651, 7302, 9412, 'Travel', 'approved'),
      listDocument(9605, 9651, 7302, 9412, 'Business permit', 'claimed'),
    ],
    rental_items: [
      { item_id: 9751, name: 'Monobloc chairs', type: 'furniture', description: null, quantity_total: 100,
        quantity_available: 100, is_active: true, fee: 5 },
      { item_id: 9752, name: 'Covered court', type: 'facility', description: null, quantity_total: 1,
        quantity_available: 1, is_active: true, fee: 500 },
    ],
    rental_requests: [
      listRental(9701, 9752, 7302, 1, 'confirmed', { resident_id: 9412 }),
      listRental(9702, 9751, 7202, 10, 'cancelled',
        { outside_borrower_name: 'Dolores Pacquiao', outside_borrower_contact: '09181234567' }),
    ],
    // In charge_id order, so the three fines that share a created_at come out
    // newest first only if charge_id breaks the tie. 9004 is the newest charge
    // and 9009 one of the oldest, so charge_id alone gives the wrong order.
    charges: [
      listCharge(9001, 'DOCUMENT', 'PAID', '2026-10-01T01:00:00+00:00', { user_id: 7301, document_request_id: 9601 }),
      listCharge(9002, 'RENTAL', 'PAID', '2026-10-03T02:00:00+00:00', { amount: 500, user_id: 7302,
        rental_request_id: 9701, paymongo_session_id: 'cs_probe_9002', paymongo_payment_id: 'pay_probe_9002' }),
      // PAID with no payment row, as live charge #2 is.
      listCharge(9003, 'DOCUMENT', 'PAID', '2026-10-02T05:00:00+00:00', { amount: 50, user_id: 7301, document_request_id: 9602 }),
      listCharge(9004, 'DOCUMENT', 'UNPAID', '2026-10-05T08:00:00+00:00', { user_id: 7302, document_request_id: 9603,
        declared_method: 'onsite', declared_at: '2026-10-05T09:00:00+00:00' }),
      listCharge(9005, 'RENTAL', 'VOID', '2026-09-28T09:00:00+00:00', { amount: 50, rental_request_id: 9702 }),
      listCharge(9006, 'FINE', 'UNPAID', '2026-10-04T00:00:00+00:00', { amount: 50, event_id: 9801, household_id: 9501 }),
      listCharge(9007, 'FINE', 'PAID', '2026-10-04T00:00:00+00:00', { amount: 50, event_id: 9801, household_id: 9502 }),
      listCharge(9008, 'FINE', 'UNPAID', '2026-10-04T00:00:00+00:00', { amount: 50, event_id: 9801, household_id: 9503 }),
      listCharge(9009, 'DOCUMENT', 'PAID', '2026-09-30T04:00:00+00:00', { user_id: 7302, document_request_id: 9605,
        paymongo_session_id: 'cs_probe_9009', paymongo_payment_id: 'pay_probe_9009' }),
    ],
    // 9102 and 9105 are PayMongo payments, received by nobody. Charge 9009
    // has two rows, which the database allows.
    payments: [
      listPayment(9101, 9001, 100, 'onsite', 'OR-2026-0042', 7201, '2026-10-02T03:15:00+00:00'),
      listPayment(9102, 9002, 500, 'gcash', 'pay_probe_9002', null, '2026-10-03T02:20:00+00:00'),
      listPayment(9103, 9007, 50, 'onsite', 'OR-2026-0050', 7202, '2026-10-06T01:30:00+00:00'),
      listPayment(9104, 9009, 100, 'onsite', 'OR-2026-0031', 7201, '2026-09-30T06:00:00+00:00'),
      listPayment(9105, 9009, 100, 'gcash', 'pay_probe_9009', null, '2026-09-30T04:05:00+00:00'),
    ],
  };
}

// "a, alias:table ( b, c ( d ) )" as a tree of nodes. A hint (!inner, !fkey)
// is refused, so a select that starts using one fails here loudly.
function parseListSelect(src) {
  let i = 0;
  const list = () => {
    const nodes = [];
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i++;
      if (i >= src.length || src[i] === ')') return nodes;
      let token = '';
      while (i < src.length && !/[\s,()]/.test(src[i])) token += src[i++];
      if (token.includes('!')) throw new Error(`the fake does not support hints ("${token}")`);
      const [key, name] = token.includes(':') ? token.split(':') : [token, token];
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== '(') {
        nodes.push({ key, name });
        continue;
      }
      i++;
      const children = list();
      if (src[i] !== ')') throw new Error('unbalanced select string');
      i++;
      nodes.push({ key, name, children });
    }
  };
  const nodes = list();
  if (i < src.length) throw new Error('unbalanced select string');
  return nodes;
}

function projectListRow(db, table, row, nodes) {
  const out = {};
  for (const node of nodes) {
    if (!node.children) {
      if (!(node.name in row)) throw new Error(`column ${table}.${node.name} does not exist`);
      out[node.key] = row[node.name];
      continue;
    }
    const rel = LIST_RELATIONS[table]?.[node.name];
    if (!rel) throw new Error(`no relationship between ${table} and ${node.name}`);
    const related = row[rel.local] == null ? [] : db[rel.table].filter((r) => r[rel.foreign] === row[rel.local]);
    out[node.key] = rel.many
      ? related.map((r) => projectListRow(db, rel.table, r, node.children))
      : related[0] ? projectListRow(db, rel.table, related[0], node.children) : null;
  }
  return out;
}

// Postgres sorts NULL above every value: last ascending, first descending.
const compareListValues = (x, y) => {
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
};

// The query builder. Only what the list handler calls exists on it.
function listFrom(db) {
  return (table) => {
    if (!Array.isArray(db[table])) throw new Error(`unexpected table ${table}`);
    const q = { sel: null, count: null, filters: [], orders: [] };
    const columns = new Set(db[table].flatMap((row) => Object.keys(row)));
    const run = () => {
      db.ran.push({ table, sel: q.sel, count: q.count });
      if (db.faults[table]) return { data: null, error: { message: db.faults[table] }, count: null, status: 0, statusText: '' };
      const unknown = [...q.filters, ...q.orders].map((x) => x.col).find((c) => columns.size && !columns.has(c));
      let data;
      let rows;
      try {
        if (unknown) throw new Error(`column ${table}.${unknown} does not exist`);
        rows = db[table].filter((row) => q.filters.every((f) => f.test(row)));
        rows.sort((a, b) => {
          for (const o of q.orders) {
            const c = compareListValues(a[o.col], b[o.col]);
            if (c) return o.ascending ? c : -c;
          }
          return 0;
        });
        const nodes = parseListSelect(q.sel ?? '');
        data = rows.slice(0, LIST_MAX_ROWS).map((row) => projectListRow(db, table, row, nodes));
      } catch (e) {
        return { data: null, error: { message: e.message }, count: null, status: 400, statusText: 'Bad Request' };
      }
      return { data, error: null, count: q.count === 'exact' ? rows.length : null, status: 200, statusText: 'OK' };
    };
    const b = {
      select(sel, options = {}) {
        const { count, ...rest } = options;
        if (Object.keys(rest).length || ![undefined, 'exact'].includes(count)) {
          throw new Error(`the fake supports only { count: 'exact' } (got ${JSON.stringify(options)})`);
        }
        q.sel = sel;
        q.count = count ?? null;
        return b;
      },
      order(col, { ascending = true } = {}) { q.orders.push({ col, ascending }); return b; },
      eq(col, value) { q.filters.push({ col, test: (row) => row[col] === value }); return b; },
      is(col, value) {
        if (value !== null) throw new Error('the fake supports only is(column, null)');
        q.filters.push({ col, test: (row) => row[col] === null });
        return b;
      },
      in(col, values) { q.filters.push({ col, test: (row) => values.includes(row[col]) }); return b; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return b;
  };
}

async function chargesListChecks() {
  console.log('\n--- 7. GET /api/charges: payment record and total, real handler, fake tables ---');
  const realFrom = supabase.from;
  try {
    const handler = handlerFor(chargesRouter, 'get', '/');
    // GETs the list with `query` against `db` (fresh tables unless given).
    const list = async (query, db = listDb()) => {
      supabase.from = listFrom(db);
      try {
        return { ...(await invoke(handler, { user: LIST_CALLER, query })), db };
      } catch (e) {
        return { status: 'threw', body: { error: e.message }, db };
      }
    };
    const shown = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

    const all = await list({ status: 'all' });
    const byId = new Map((all.body?.charges || []).map((c) => [c.charge_id, c]));
    const paymentsOf = (id) => byId.get(id)?.payments;

    check('every charge in the list carries a payments array',
      all.status === 200 && byId.size === 9 && [...byId.values()].every((c) => Array.isArray(c.payments)),
      `${all.status}, ${byId.size} charge(s), the first one's payments: ${shown(all.body?.charges?.[0]?.payments)}`);

    const TREASURER_RECORDER = { username: 'treasurer_probe', role: 'treasurer',
      profiles: { first_name: 'Teresita', middle_name: 'Lim', last_name: 'Ocampo', suffix: null } };
    const SECRETARY_RECORDER = { username: 'secretary_probe', role: 'secretary',
      profiles: { first_name: 'Segundo', middle_name: null, last_name: 'Magbanua', suffix: 'III' } };
    check('a payment the Treasurer recorded: its method, reference, time and recorder',
      isDeepStrictEqual(paymentsOf(9001), [{ payment_id: 9101, payment_method: 'onsite', reference_no: 'OR-2026-0042',
        created_at: '2026-10-02T03:15:00+00:00', received_by_user_id: 7201, recorder: TREASURER_RECORDER }]),
      shown(paymentsOf(9001)));
    check('a payment the Secretary recorded names the Secretary',
      isDeepStrictEqual(paymentsOf(9007), [{ payment_id: 9103, payment_method: 'onsite', reference_no: 'OR-2026-0050',
        created_at: '2026-10-06T01:30:00+00:00', received_by_user_id: 7202, recorder: SECRETARY_RECORDER }]),
      shown(paymentsOf(9007)));
    check('a PayMongo payment has no recorder: received_by_user_id and recorder are both null',
      isDeepStrictEqual(paymentsOf(9002), [{ payment_id: 9102, payment_method: 'gcash', reference_no: 'pay_probe_9002',
        created_at: '2026-10-03T02:20:00+00:00', received_by_user_id: null, recorder: null }]),
      shown(paymentsOf(9002)));
    const both = Array.isArray(paymentsOf(9009))
      ? [...paymentsOf(9009)].sort((a, b) => a.payment_id - b.payment_id) : paymentsOf(9009);
    check('a charge with two payment rows carries both',
      isDeepStrictEqual(both, [
        { payment_id: 9104, payment_method: 'onsite', reference_no: 'OR-2026-0031', created_at: '2026-09-30T06:00:00+00:00',
          received_by_user_id: 7201, recorder: TREASURER_RECORDER },
        { payment_id: 9105, payment_method: 'gcash', reference_no: 'pay_probe_9009', created_at: '2026-09-30T04:05:00+00:00',
          received_by_user_id: null, recorder: null },
      ]),
      shown(paymentsOf(9009)));
    check('a PAID charge with no payment row (as live charge #2 is) carries an empty array',
      isDeepStrictEqual(paymentsOf(9003), []), shown(paymentsOf(9003)));
    check('the unpaid and void charges carry an empty array',
      [9004, 9005, 9006, 9008].every((id) => isDeepStrictEqual(paymentsOf(id), [])),
      [9004, 9005, 9006, 9008].map((id) => `${id}: ${shown(paymentsOf(id))}`).join(', '));

    // The recorder carries a name and a role, never a way to contact them.
    const raw = JSON.stringify(all.body ?? null);
    const leaked = ['teresita.recorder@example.invalid', 'segundo.recorder@example.invalid', '09175550001',
      '09175550002', '09175550003', '09175550004', 'hash-not-for-any-payload'].filter((s) => raw.includes(s));
    check("no recorder's email, no profile phone number and no password hash anywhere in the list",
      leaked.length === 0, leaked.join(', ') || 'none');

    // The status filter and the order, unchanged; total counts what the filter matches.
    for (const c of [
      { label: 'no status (the UNPAID default)', query: {}, ids: [9004, 9008, 9006], total: 3 },
      { label: 'status=UNPAID', query: { status: 'UNPAID' }, ids: [9004, 9008, 9006], total: 3 },
      { label: 'status=paid, in any case', query: { status: 'paid' }, ids: [9007, 9002, 9003, 9001, 9009], total: 5 },
      { label: 'status=VOID', query: { status: 'VOID' }, ids: [9005], total: 1 },
      { label: 'status=all', query: { status: 'all' }, ids: [9004, 9008, 9007, 9006, 9002, 9003, 9001, 9009, 9005], total: 9 },
    ]) {
      const r = await list(c.query);
      const ids = (r.body?.charges || []).map((x) => x.charge_id);
      check(`${c.label}: these charges, newest first, charge_id breaking a tie`,
        r.status === 200 && isDeepStrictEqual(ids, c.ids), `${r.status} [${ids.join(', ')}]`);
      check(`${c.label}: total is ${c.total}`, r.body?.total === c.total, `total ${shown(r.body?.total)}`);
    }

    const bad = await list({ status: 'pending' });
    check('an unknown status is a 400 naming it, and no query runs',
      bad.status === 400 && /Unknown status 'PENDING'/.test(bad.body?.error || '') && bad.db.ran.length === 0,
      `${bad.status} ${bad.body?.error || ''} (${bad.db.ran.length} quer${bad.db.ran.length === 1 ? 'y' : 'ies'} ran)`);

    // What fines:test reads off the list, which this file cannot run. The
    // head is named, never contacted: section 8 requires that no contact
    // number is sent.
    const fine = (id) => {
      const c = byId.get(id);
      return c && { title: c.events?.title, address: c.household_records?.address,
        head_name: c.household_records?.head_name };
    };
    check("each fine keeps its event title and household address, and names the household's CURRENT head",
      isDeepStrictEqual(fine(9006), { title: 'General Assembly', address: 'Purok 1, Ubujan',
        head_name: 'Hermogenes Pacana Bulawan, Jr.' })
        && isDeepStrictEqual(fine(9007), { title: 'General Assembly', address: 'Purok 2, Ubujan',
          head_name: 'Natividad Sarabia' }),
      `${shown(fine(9006))} ${shown(fine(9007))}`);
    check('a household whose only head has left has no head name',
      isDeepStrictEqual(fine(9008), { title: 'General Assembly', address: 'Purok 3, Ubujan', head_name: null }),
      shown(fine(9008)));

    // More unpaid charges than one response may carry.
    const big = listDb();
    big.charges = Array.from({ length: 1003 }, (_, k) => listCharge(20001 + k, 'DOCUMENT', 'UNPAID', '2026-08-01T00:00:00+00:00'));
    big.payments = [];
    const capped = await list({}, big);
    check('past the 1,000-row cap the list is cut, but total still counts all 1,003 unpaid charges',
      capped.body?.charges?.length === 1000 && capped.body?.total === 1003,
      `${capped.body?.charges?.length} row(s), total ${shown(capped.body?.total)}`);

    // A list that failed to load is an error, never an empty list with a total.
    const broken = listDb();
    broken.faults.charges = 'connection reset by peer';
    const failed = await list({ status: 'all' }, broken);
    check('a database error still reaches the error handler, never an empty list with a total of 0',
      failed.status === 'threw' && failed.body?.error === 'Failed to load charges: connection reset by peer',
      `${failed.status} ${failed.body?.error || shown(failed.body)}`);
  } catch (err) {
    check('the charges-list section ran to the end', false, err.message);
  } finally {
    supabase.from = realFrom;
  }
}

// 8. GET /api/charges sends no contact numbers and no emails. The Payments page
//    shows names, usernames, addresses and amounts and reads no contact field,
//    so the list carries none (data minimisation, CLAUDE.md). The real handler
//    runs on section 7's tables with a contact in every place one can occur:
//    the payer's and the recorder's email and profile phone, the resident
//    record on a document request and on a booking, a guest's contact and the
//    household head's, in each form the system accepts (09..., 639...,
//    +639...), and an email with no dot after the @, as one live account has.
//    The sweep covers every key and every value at every depth, so a contact
//    arriving through an embed nothing here names is caught too. The names
//    around the contacts must survive, so trimming too much fails as well.
const PERSONAL_KEY = /email|phone|mobile|contact|password/i;
const EMAIL_SHAPED = /[^\s@"]+@[^\s@"]+/;
// Spaces or dashes inside the number are allowed, so an older record typed
// that way is caught too.
const PH_MOBILE = /(?<![\d+])(?:\+?63[\s-]?|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/;

// Where the payload holds anything personal: each key path whose name looks
// like one, and each value path holding an email or a mobile number, counted.
function personalData(body) {
  const found = { keys: new Set(), emails: {}, phones: {} };
  const walk = (v, at) => {
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, `${at}[]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (PERSONAL_KEY.test(k)) found.keys.add(`${at}.${k}`);
        walk(x, `${at}.${k}`);
      }
      return;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return;
    if (EMAIL_SHAPED.test(String(v))) found.emails[at] = (found.emails[at] || 0) + 1;
    if (PH_MOBILE.test(String(v))) found.phones[at] = (found.phones[at] || 0) + 1;
  };
  walk(body, 'body');
  return found;
}

async function chargesListContactChecks() {
  console.log('\n--- 8. GET /api/charges: no contact numbers or emails, real handler, fake tables ---');
  const realFrom = supabase.from;
  try {
    const handler = handlerFor(chargesRouter, 'get', '/');
    const db = listDb();
    const edit = (table, idColumn, id, patch) => Object.assign(db[table].find((r) => r[idColumn] === id), patch);
    edit('users', 'user_id', 7302, { email: 'ramon@payer' });
    edit('resident_records', 'resident_id', 9412, { contact_number: '+639170009412' });
    edit('rental_requests', 'request_id', 9702, { outside_borrower_contact: '639181234567' });
    supabase.from = listFrom(db);
    const r = await invoke(handler, { user: LIST_CALLER, query: { status: 'all' } });
    const byId = new Map((r.body?.charges || []).map((c) => [c.charge_id, c]));
    const shown = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));
    const listed = (counts) => Object.entries(counts).map(([at, n]) => `${at} x${n}`).join(', ') || 'none';
    const found = personalData(r.body);

    // Without this, an empty or failed list would pass the sweep below.
    check('the list loads: 200 with all 9 charges', r.status === 200 && byId.size === 9, `${r.status}, ${byId.size} charge(s)`);
    check('no key named like email, phone, mobile, contact or password, at any depth',
      found.keys.size === 0, [...found.keys].join(', ') || 'none');
    check('no email-shaped value anywhere, one with no dot after the @ included',
      Object.keys(found.emails).length === 0, listed(found.emails));
    check('no Philippine mobile number anywhere, in any form the system accepts',
      Object.keys(found.phones).length === 0, listed(found.phones));

    // What the page shows must still arrive.
    const names = (p) => p && { resident_id: p.resident_id, first_name: p.first_name, middle_name: p.middle_name,
      last_name: p.last_name, suffix: p.suffix };
    const payer = byId.get(9001)?.payer;
    check("the payer's username and name parts are still sent",
      payer?.username === 'payer_pacita' && byId.get(9002)?.payer?.username === 'payer_ramon'
        && isDeepStrictEqual(payer?.profiles, { first_name: 'Pacita', middle_name: 'Ramos', last_name: 'Dumaguete', suffix: null }),
      shown(payer));
    const documentResident = byId.get(9001)?.document_requests?.resident_records;
    check('the resident on a document request is still named',
      isDeepStrictEqual(names(documentResident),
        { resident_id: 9411, first_name: 'Pacita', middle_name: 'Ramos', last_name: 'Dumaguete', suffix: null }),
      shown(documentResident));
    const booking = byId.get(9002)?.rental_requests;
    check('the resident on a booking is still named, with its resident_id',
      booking?.resident_id === 9412 && isDeepStrictEqual(names(booking?.resident_records),
        { resident_id: 9412, first_name: 'Ramon', middle_name: null, last_name: 'Villaflor', suffix: null }),
      shown(booking?.resident_records));
    check("a guest borrower's name is still sent",
      byId.get(9005)?.rental_requests?.outside_borrower_name === 'Dolores Pacquiao',
      shown(byId.get(9005)?.rental_requests?.outside_borrower_name));
    const household = (id) => byId.get(id)?.household_records;
    check('each fine still carries its household address and head name',
      household(9006)?.address === 'Purok 1, Ubujan' && household(9006)?.head_name === 'Hermogenes Pacana Bulawan, Jr.'
        && household(9007)?.address === 'Purok 2, Ubujan' && household(9007)?.head_name === 'Natividad Sarabia',
      `${shown(household(9006))} ${shown(household(9007))}`);
    const recorder = byId.get(9001)?.payments?.[0]?.recorder;
    check("a payment's recorder is still named",
      recorder?.username === 'treasurer_probe' && recorder?.role === 'treasurer'
        && isDeepStrictEqual(recorder?.profiles, { first_name: 'Teresita', middle_name: 'Lim', last_name: 'Ocampo', suffix: null }),
      shown(recorder));
  } catch (err) {
    check('the contact-data section ran to the end', false, err.message);
  } finally {
    supabase.from = realFrom;
  }
}

(async () => {
  await declareRouteChecks();
  await chargesListChecks();
  await chargesListContactChecks();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
