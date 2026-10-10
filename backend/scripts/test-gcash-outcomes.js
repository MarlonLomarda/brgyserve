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
// Makes NO network calls — no database, no PayMongo, no tunnel, and the API
// does not need to be running. The Supabase URL and key below are dead values
// set BEFORE .env loads (dotenv never overrides a variable that is already
// set), fetch throws if anything calls it, and section 6 replaces
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

(async () => {
  await declareRouteChecks();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
