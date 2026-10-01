// ===========================================================================
// ROUTE ROLE GUARDS — resident records + document requests + disputes +
// the activity log.
//
//   cd backend && npm run roles:test
//
// disputes.js joined when residents gained GET /mine, the first route in that
// file a resident may call. Its scoping — own cases only — is tested by
// disputes:test; this file checks who may reach each route, and that /mine is
// declared before /:id.
//
// activityLogs.js joined with the Activity Log page: Secretary and Punong
// Barangay only, GET only. Its payload is checked here too — the deny-list
// applied again on read, personal values withheld (withholdPersonal, unit-
// tested directly), an explicit users embed, and the true total on a page
// past the end. Those checks run the real handler against a FAKE table with a
// crafted row, so they do not depend on what the live log happens to hold;
// the live log is then read once per viewer and swept the same way.
//
// WHY THIS EXISTS. Both files used to be Secretary-only: residentRecords.js
// opened with `router.use(authenticate, requireRole('secretary'))`, so every
// route in it failed closed by default. Giving the Punong Barangay and Staff
// read access meant moving that gate onto each route individually — and the
// moment it moved, the file stopped failing closed. A route added later with
// no requireRole(...) is now readable by ANY authenticated user, residents
// included, and nothing about the code would look wrong.
//
// So this test does not check that the guards are *written*; it checks what
// they *do*. Every route is probed with each of the five roles through its
// real middleware chain, and the permitted set is compared against the table
// below. A new route with no entry here FAILS rather than passing silently.
//
// It also asserts the data-minimization rule end to end by invoking the real
// GET handlers as a Staff user and as a Punong Barangay user and diffing the
// keys that come back.
//
// No server is started and no port is opened. Nothing is written to the
// database: the only queries are the SELECTs the GET handlers themselves run.
// ===========================================================================
const path = require('path');
const { createRequire } = require('module');
const beRequire = createRequire(path.join(__dirname, '..', 'package.json'));
beRequire('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const residentRecords = require(path.join(__dirname, '..', 'src', 'routes', 'residentRecords.js'));
const documentRequests = require(path.join(__dirname, '..', 'src', 'routes', 'documentRequests.js'));
const disputes = require(path.join(__dirname, '..', 'src', 'routes', 'disputes.js'));
const activityLogs = require(path.join(__dirname, '..', 'src', 'routes', 'activityLogs.js'));
const supabase = require(path.join(__dirname, '..', 'src', 'config', 'supabase.js'));
const { withholdPersonal } = require(path.join(__dirname, '..', 'src', 'services', 'activityLog.js'));
const { isSensitiveKey, isPersonalKey, PERSONAL_FIELDS } = require(path.join(__dirname, '..', 'src', 'constants', 'activityLog.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

const ALL_ROLES = ['secretary', 'punong_barangay', 'treasurer', 'staff', 'resident'];
const VIEWERS = ['secretary', 'punong_barangay', 'staff'];
const SECRETARY_ONLY = ['secretary'];
// Blotter records: the Secretary manages, the Punong Barangay views. Staff and
// the Treasurer are refused everywhere in disputes.js.
const BLOTTER_VIEWERS = ['secretary', 'punong_barangay'];
const RESIDENT_ONLY = ['resident'];
// The activity log: old and new values can hold contact numbers and
// birthdates, so Staff, the Treasurer and residents are refused.
const LOG_VIEWERS = ['secretary', 'punong_barangay'];

// Routes whose access is scoped by OWNERSHIP — the caller's profiles.resident_id
// matched against the row's resident_id — rather than by role. (They matched
// requested_by_user_id until c07d19c rescoped all four /mine routes, so that a
// walk-in the Secretary encoded shows up for the resident it is for.) They
// carry no requireRole by design and are listed explicitly so "no guard" is a
// recorded decision here rather than an omission that slipped through.
const OWNERSHIP_SCOPED = ALL_ROLES;

// The authority. method + path -> exactly which roles the chain admits.
const EXPECTED = {
  'residentRecords.js': {
    'GET /': VIEWERS,
    'GET /export': SECRETARY_ONLY,           // the whole list with every contact detail
    'POST /import/preview': SECRETARY_ONLY,  // writes nothing, but it is the import's first step
    'POST /import/commit': SECRETARY_ONLY,
    'GET /:id': VIEWERS,
    'POST /check-duplicates': SECRETARY_ONLY,
    'POST /': SECRETARY_ONLY,
    'PUT /:id': SECRETARY_ONLY,
    'POST /:id/archive': SECRETARY_ONLY,
    'POST /:id/unarchive': SECRETARY_ONLY,
  },
  'documentRequests.js': {
    'POST /': ['secretary', 'resident'],  // resident files their own; the Secretary encodes a walk-in (c07d19c)
    'GET /mine': OWNERSHIP_SCOPED,        // scoped by resident_id, not requested_by_user_id (c07d19c)
    'GET /mine/:id': OWNERSHIP_SCOPED,
    'POST /mine/:id/cancel': OWNERSHIP_SCOPED,
    'POST /mine/:id/pay': OWNERSHIP_SCOPED,
    'GET /': VIEWERS,
    'GET /:id': VIEWERS,
    'POST /:id/approve': SECRETARY_ONLY,
    'POST /:id/reject': SECRETARY_ONLY,
    'POST /:id/ready-for-release': SECRETARY_ONLY,
    'POST /:id/claim': SECRETARY_ONLY,
  },
  'disputes.js': {
    'GET /': BLOTTER_VIEWERS,
    'GET /mine': RESIDENT_ONLY,             // own party entries only; scoping is disputes:test's job
    'GET /:id': BLOTTER_VIEWERS,
    'POST /': SECRETARY_ONLY,
    'PUT /:id': SECRETARY_ONLY,
    'PATCH /:id/settle': SECRETARY_ONLY,     // settle AND reopen: one route, is_settled true/false
  },
  'activityLogs.js': {
    'GET /': LOG_VIEWERS,                    // read-only; there is no other route and must not be
  },
};

// Columns Staff must never receive on a resident record, from the agreed
// data-minimization decision. `account` / `linked_accounts` are covered
// separately because they are response keys, not table columns.
const RESTRICTED = ['birthplace', 'sex', 'civil_status', 'religion', 'educational_attainment', 'contact_number'];

// The two registration dates, swept separately because neither is a personal
// detail in the way the RESTRICTED list is — they are withheld from Staff for
// the same data-minimization reason, but the argument is "no Staff task needs
// it" rather than "this is private". masterlist_registered_on (migration 018)
// drives the six-month residency judgement, which belongs to the Secretary.
// Withholding one registration date while exposing the other would be
// incoherent, so both are asserted by name here.
const RESTRICTED_DATES = ['date_registered', 'masterlist_registered_on'];

// ---------------------------------------------------------------------------
// Probing the real middleware chain
// ---------------------------------------------------------------------------

// Everything on a route layer except the final handler is a guard. Run the
// guards for one role and report whether the chain would reach the handler.
function admits(layer, role) {
  const guards = layer.route.stack.slice(0, -1).map((s) => s.handle);
  // authenticate is async and hits the network; it is not a role guard, so it
  // is skipped by arity/name and asserted separately below.
  const roleGuards = guards.filter((g) => g.name !== 'authenticate');
  const req = { user: { user_id: 1, username: 'probe', role } };
  let reached = true;
  for (const guard of roleGuards) {
    let passed = false;
    const res = { status() { return this; }, json() { return this; } };
    guard(req, res, () => { passed = true; });
    if (!passed) { reached = false; break; }
  }
  return reached;
}

function routesOf(router) {
  return router.stack.filter((l) => l.route).map((l) => ({
    layer: l,
    keys: Object.keys(l.route.methods).filter((m) => l.route.methods[m])
      .map((m) => `${m.toUpperCase()} ${l.route.path}`),
  }));
}

function auditRouter(fileLabel, router) {
  section(fileLabel);
  const expected = EXPECTED[fileLabel];
  const seen = new Set();

  for (const { layer, keys } of routesOf(router)) {
    for (const key of keys) {
      seen.add(key);
      const permitted = ALL_ROLES.filter((r) => admits(layer, r));
      const want = expected[key];

      if (!want) {
        check(`${key} is declared in the expectation table`, false,
          `UNDECLARED ROUTE — permits [${permitted.join(', ')}]. Add it to EXPECTED or give it a guard.`);
        continue;
      }
      const same = permitted.length === want.length && permitted.every((r) => want.includes(r));
      check(`${key}`, same, same ? `permits ${permitted.join(', ')}` : `expected [${want.join(', ')}] but permits [${permitted.join(', ')}]`);
    }
  }

  // The other direction: a route removed from the file but left in the table.
  for (const key of Object.keys(expected)) {
    if (!seen.has(key)) check(`${key} still exists on the router`, false, 'declared in EXPECTED but not found');
  }
}

// ---------------------------------------------------------------------------
// Invoking the real GET handlers
// ---------------------------------------------------------------------------
function handlerFor(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`${method.toUpperCase()} ${routePath} not found`);
}

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    const req = { user, params, body, query };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const asUser = (role) => ({ user_id: 1, username: `probe_${role}`, role });

(async () => {
  console.log('Route role guards — resident records + document requests + disputes + activity log');
  console.log('No server started. No writes.');

  auditRouter('residentRecords.js', residentRecords);
  auditRouter('documentRequests.js', documentRequests);
  auditRouter('disputes.js', disputes);
  auditRouter('activityLogs.js', activityLogs);

  // -- every route carries authenticate at the router level -----------------
  section('router-level authenticate');
  for (const [label, router] of [['residentRecords.js', residentRecords], ['documentRequests.js', documentRequests], ['disputes.js', disputes], ['activityLogs.js', activityLogs]]) {
    const hasAuth = router.stack.some((l) => !l.route && l.handle?.name === 'authenticate');
    check(`${label} mounts authenticate at the router level`, hasAuth);
  }

  // -- route ORDER, which admits() cannot see ---------------------------------
  // admits() runs each route's own guards and never matches a URL, so it would
  // pass with /mine declared after /:id — where /:id catches every request for
  // /mine: a resident gets 403 from its VIEW_ROLES guard and the Secretary 400
  // "Invalid case id". Express matches in declaration order, so the index in
  // the stack is the whole question.
  section('route order');
  const indexOf = (router, method, routePath) =>
    router.stack.findIndex((l) => l.route?.path === routePath && l.route.methods[method]);
  const mineAt = indexOf(disputes, 'get', '/mine');
  const byIdAt = indexOf(disputes, 'get', '/:id');
  check('disputes.js registers GET /mine before GET /:id', mineAt !== -1 && byIdAt !== -1 && mineAt < byIdAt,
    `GET /mine at stack index ${mineAt}, GET /:id at ${byIdAt}`);

  // -- data minimization, against the real handlers --------------------------
  section('GET /resident-records — staff projection');
  const listHandler = handlerFor(residentRecords, 'get', '/');
  const staffList = await invoke(listHandler, { user: asUser('staff'), query: { per_page: '5' } });
  const pbList = await invoke(listHandler, { user: asUser('punong_barangay'), query: { per_page: '5' } });

  check('staff list returns 200', staffList.status === 200, String(staffList.status));
  check('staff list is non-empty (needed for the column checks)', (staffList.body.records || []).length > 0,
    `${(staffList.body.records || []).length} row(s)`);

  const staffRow = staffList.body.records?.[0] || {};
  const pbRow = pbList.body.records?.[0] || {};
  for (const col of RESTRICTED) {
    check(`  staff row omits ${col}`, !(col in staffRow));
  }
  for (const col of RESTRICTED_DATES) {
    check(`  staff row omits ${col}`, !(col in staffRow));
  }

  // WITHHELD MEANS ABSENT. `account: null` used to be the one field that was
  // withheld by being nulled rather than removed, which made a withheld value
  // indistinguishable from a genuine absence — the client cannot tell, so it
  // rendered a column of em dashes asserting nobody had registered.
  check('  staff row does NOT contain the key "account"', !('account' in staffRow),
    Object.keys(staffRow).join(', '));
  check('  PB row DOES contain the key "account"', 'account' in pbRow,
    Object.keys(pbRow).join(', '));

  check('  PB row DOES include contact_number', 'contact_number' in pbRow);
  for (const col of RESTRICTED_DATES) {
    check(`  PB row DOES include ${col}`, col in pbRow);
  }

  // EXACTLY the eight, not merely "at least" — an extra key is what this whole
  // section exists to catch.
  const PERMITTED_8 = ['resident_id', 'first_name', 'middle_name', 'last_name', 'suffix', 'birthdate', 'address', 'is_archived'];
  const staffRowKeys = Object.keys(staffRow);
  check('  staff row has EXACTLY the 8 permitted columns',
    staffRowKeys.length === 8 && PERMITTED_8.every((c) => staffRowKeys.includes(c)),
    `${staffRowKeys.length} key(s): ${staffRowKeys.join(', ')}`);

  // Whole-payload sweep, same reasoning as the document-request list below:
  // catches a contact detail arriving through an embed nothing here names.
  const staffResListRaw = JSON.stringify(staffList.body);
  check('  no "email" key anywhere in the staff resident-list payload', !/"email"/.test(staffResListRaw));
  check('  no email address anywhere in the staff resident-list payload', !/@[\w.-]+\.\w+/.test(staffResListRaw));
  for (const col of RESTRICTED) {
    check(`  "${col}" appears nowhere in the staff resident-list payload`,
      !new RegExp(`"${col}"`).test(staffResListRaw));
  }

  section('GET /resident-records/:id — staff projection');
  const { data: sample } = await supabase
    .from('resident_records').select('resident_id').eq('is_archived', false).limit(1);
  const rid = sample?.[0]?.resident_id;
  check('found a resident record to probe', !!rid, rid ? `resident_id ${rid}` : 'none');

  if (rid) {
    const detailHandler = handlerFor(residentRecords, 'get', '/:id');
    const staffDetail = await invoke(detailHandler, { user: asUser('staff'), params: { id: String(rid) } });
    const pbDetail = await invoke(detailHandler, { user: asUser('punong_barangay'), params: { id: String(rid) } });

    check('staff detail returns 200', staffDetail.status === 200, String(staffDetail.status));
    for (const col of RESTRICTED) {
      check(`  staff detail omits ${col}`, !(col in (staffDetail.body.record || {})));
    }
    // WITHHELD MEANS ABSENT. These two replace an earlier pair that asserted
    // linked_accounts was an empty array for staff and that the shape stayed
    // "stable" across roles. That stability was the bug: [] is the positive
    // claim "this resident has no account", indistinguishable from a real
    // empty result, and it rendered as "has not registered online" on records
    // that have one. A varying shape a client can detect beats a constant one
    // that lies.
    check('  staff detail does NOT contain the key "linked_accounts"',
      !('linked_accounts' in staffDetail.body), Object.keys(staffDetail.body).join(', '));
    check('  PB detail DOES contain the key "linked_accounts"',
      'linked_accounts' in pbDetail.body, Object.keys(pbDetail.body).join(', '));
    check('  PB linked_accounts is a real array', Array.isArray(pbDetail.body.linked_accounts));
    for (const col of RESTRICTED) {
      check(`  PB detail INCLUDES ${col}`, col in (pbDetail.body.record || {}));
    }
  }

  section('GET /document-requests — staff LIST embeds');
  const drList = handlerFor(documentRequests, 'get', '/');
  const staffDrList = await invoke(drList, { user: asUser('staff'), query: {} });
  const pbDrList = await invoke(drList, { user: asUser('punong_barangay'), query: {} });

  check('staff list returns 200', staffDrList.status === 200, String(staffDrList.status));
  check('staff list is non-empty (needed for the embed checks)',
    (staffDrList.body.requests || []).length > 0, `${(staffDrList.body.requests || []).length} row(s)`);

  const staffDrRow = staffDrList.body.requests?.[0] || {};
  const pbDrRow = pbDrList.body.requests?.[0] || {};
  const staffListRequester = staffDrRow.requester || {};
  const pbListRequester = pbDrRow.requester || {};

  check('  staff list requester HAS user_id', 'user_id' in staffListRequester);
  check('  staff list requester HAS username', 'username' in staffListRequester);
  check('  staff list requester does NOT have email', !('email' in staffListRequester),
    Object.keys(staffListRequester).join(', '));
  check('  PB list requester DOES have email', 'email' in pbListRequester,
    Object.keys(pbListRequester).join(', '));
  for (const col of RESTRICTED) {
    check(`  staff list resident embed omits ${col}`, !(col in (staffDrRow.resident_records || {})));
  }

  // Belt and braces: serialise the WHOLE staff list and look for an address.
  // An embed added later that carries one would be caught here even if no
  // assertion above names it.
  const staffListRaw = JSON.stringify(staffDrList.body);
  check('  no "email" key anywhere in the staff list payload', !/"email"/.test(staffListRaw));
  check('  no email address anywhere in the staff list payload', !/@[\w.-]+\.\w+/.test(staffListRaw));

  section('GET /document-requests/:id — staff resident embed');
  const { data: anyReq } = await supabase
    .from('document_requests').select('request_id').limit(1);
  const reqId = anyReq?.[0]?.request_id;
  check('found a document request to probe', !!reqId, reqId ? `request_id ${reqId}` : 'none');

  if (reqId) {
    const drDetail = handlerFor(documentRequests, 'get', '/:id');
    const staffReq = await invoke(drDetail, { user: asUser('staff'), params: { id: String(reqId) } });
    const pbReq = await invoke(drDetail, { user: asUser('punong_barangay'), params: { id: String(reqId) } });
    const staffRes = staffReq.body.request?.resident_records || {};
    const pbRes = pbReq.body.request?.resident_records || {};

    check('staff detail returns 200', staffReq.status === 200, String(staffReq.status));
    for (const col of ['birthplace', 'sex', 'civil_status', 'contact_number', ...RESTRICTED_DATES]) {
      check(`  staff resident embed omits ${col}`, !(col in staffRes));
    }
    check('  staff resident embed keeps name + birthdate + address',
      ['resident_id', 'first_name', 'last_name', 'birthdate', 'address'].every((c) => c in staffRes),
      Object.keys(staffRes).join(', '));
    check('  PB resident embed INCLUDES contact_number', 'contact_number' in pbRes);

    // The requester embed. Staff keep the filer's IDENTITY and lose their
    // CONTACT DETAIL: email is withheld for the same reason contact_number is.
    // Without this pair of assertions the narrowing on the resident screen is
    // undone one click away, which is exactly what HTTP verification caught.
    const staffRequester = staffReq.body.request?.requester || {};
    const pbRequester = pbReq.body.request?.requester || {};
    check('  staff still sees the requester (identity kept)', !!staffReq.body.request?.requester);
    check('  staff requester HAS user_id', 'user_id' in staffRequester);
    check('  staff requester HAS username', 'username' in staffRequester);
    check('  staff requester does NOT have email', !('email' in staffRequester),
      Object.keys(staffRequester).join(', '));
    check('  PB requester DOES have email', 'email' in pbRequester,
      Object.keys(pbRequester).join(', '));
  }

  // ===========================================================================
  // THE ACTIVITY LOG
  // ===========================================================================
  section('activityLogs.js — read-only');
  const logRouteKeys = routesOf(activityLogs).flatMap((r) => r.keys);
  check('every route on activityLogs.js is a GET — no write counterpart',
    logRouteKeys.length > 0 && logRouteKeys.every((k) => k.startsWith('GET ')), logRouteKeys.join(', '));

  // Every key at every depth, for the sweeps below.
  const keysDeep = (v, out = []) => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
    return out;
  };
  const ENTRY_KEYS = ['log_id', 'timestamp', 'actor', 'action', 'table_name', 'record_id', 'old_value', 'new_value', 'withheld_fields'];
  const ACTOR_KEYS = ['name', 'role', 'user_id', 'username'];
  const sameKeys = (o, keys) => !!o && Object.keys(o).sort().join() === [...keys].sort().join();

  section('withholdPersonal — personal values withheld for display');
  {
    const input = {
      status: 'pending',
      contact_number: '0917',
      nested: { Address: 'Purok 1', ok: 1, deeper: { birthdate: '1990-01-01', keep: true } },
      list: [{ religion: 'x', fine: 2 }, 'plain', 3],
      contact_number_note: 'not on the list, so kept',
    };
    const snapshot = JSON.stringify(input);
    const { value, withheld } = withholdPersonal(input);
    check('a top-level personal key is dropped — absent, not nulled', !('contact_number' in value));
    check('  a key at depth is dropped, matched case-insensitively', !('Address' in value.nested) && !('birthdate' in value.nested.deeper));
    check('  inside an array too', !('religion' in value.list[0]));
    check('  everything else survives untouched',
      value.status === 'pending' && value.nested.ok === 1 && value.nested.deeper.keep === true
        && value.list[0].fine === 2 && value.list[1] === 'plain' && value.list[2] === 3
        && value.contact_number_note === 'not on the list, so kept');
    check('  withheld names every dropped key once, lowercase, in the order met',
      JSON.stringify(withheld) === JSON.stringify(['contact_number', 'address', 'birthdate', 'religion']), JSON.stringify(withheld));
    check('  the caller\'s object is not modified', JSON.stringify(input) === snapshot);
    const twice = withholdPersonal({ a: { contact_number: 1 }, b: [{ contact_number: 2 }] });
    check('  a key met twice is reported once', JSON.stringify(twice.withheld) === '["contact_number"]', JSON.stringify(twice.withheld));
    const nothing = withholdPersonal({ status: 'approved', fee: 50 });
    check('a row with nothing personal comes back whole, with an empty list',
      JSON.stringify(nothing.value) === '{"status":"approved","fee":50}' && nothing.withheld.length === 0);
    check('null passes through as null', withholdPersonal(null).value === null && withholdPersonal(null).withheld.length === 0);
    check('every PERSONAL_FIELDS name is recognised', PERSONAL_FIELDS.every((k) => isPersonalKey(k) && isPersonalKey(k.toUpperCase())));
  }

  // The real handler against a FAKE activity_logs, so the checks below hold
  // whatever the live log contains. Every query the route builds is recorded.
  const logsHandler = handlerFor(activityLogs, 'get', '/');
  const fakeTable = (results) => {
    const calls = [];
    const from = (table) => {
      const call = { table, select: '', options: {}, filters: [] };
      const index = calls.push(call) - 1;
      const q = {
        select(s, o) { call.select = s; call.options = o || {}; return q; },
        eq(c, v) { call.filters.push(`eq ${c} ${v}`); return q; },
        gte(c, v) { call.filters.push(`gte ${c} ${v}`); return q; },
        lt(c, v) { call.filters.push(`lt ${c} ${v}`); return q; },
        order() { return q; },
        range(a, b) { call.range = [a, b]; return q; },
        then(resolve, reject) {
          return Promise.resolve(results[index] || { data: [], error: null, count: 0 }).then(resolve, reject);
        },
      };
      return q;
    };
    return { from, calls };
  };
  const withFakeTable = async (results, fn) => {
    const real = supabase.from;
    const fake = fakeTable(results);
    supabase.from = fake.from;
    try { return { result: await fn(), calls: fake.calls }; } finally { supabase.from = real; }
  };

  section('GET /activity-logs — a crafted row through the real handler');
  {
    // As if inserted by hand in SQL: credentials the write path would have
    // removed, personal values at every depth, and an actor embed carrying
    // more columns than were asked for.
    const CRAFTED = {
      log_id: 9001, timestamp: '2026-10-01T02:00:00+00:00', user_id: 5, action: 'UPDATE',
      table_name: 'resident_records', record_id: 77,
      old_value: {
        status: 'pending', contact_number: '09170000001', nested: { Address: 'Purok Uno', ok: 1 },
        list: [{ birthdate: '1990-01-01', fine: 2 }], password_hash: 'hash-secret-1', reset_link: 'https://x.test/r?token=abc1',
      },
      new_value: {
        status: 'approved', contact_number: '09170000002', token: 'tok-secret-2', purpose: 'Private purpose text',
        note: 'see https://x.test/r?token=abc2',
      },
      users: {
        user_id: 5, username: 'probe_actor', role: 'secretary', email: 'leak@example.test', password_hash: 'hash-secret-3',
        profiles: { first_name: 'Ana', middle_name: null, last_name: 'Cruz', suffix: null },
      },
    };
    const PLAIN = {
      log_id: 9002, timestamp: '2026-10-01T01:00:00+00:00', user_id: 6, action: 'APPROVE',
      table_name: 'document_requests', record_id: 89, old_value: { status: 'pending' }, new_value: { status: 'approved' },
      users: { user_id: 6, username: 'no_profile', role: 'secretary', profiles: null },
    };
    const { result: r, calls } = await withFakeTable([{ data: [CRAFTED, PLAIN], error: null, count: 2 }],
      () => invoke(logsHandler, { user: asUser('secretary'), query: {} }));
    const raw = JSON.stringify(r.body);
    const [crafted, plain] = r.body.logs || [];

    check('returns 200 with both rows', r.status === 200 && r.body.logs?.length === 2, `${r.status}`);
    check('  no personal VALUE reaches the payload',
      !['09170000001', '09170000002', 'Purok Uno', '1990-01-01', 'Private purpose text'].some((v) => raw.includes(v)));
    check('  no personal KEY at any depth of old_value / new_value',
      [...keysDeep(crafted?.old_value), ...keysDeep(crafted?.new_value)].every((k) => !isPersonalKey(k)));
    check('  withheld_fields names exactly what was dropped',
      JSON.stringify([...(crafted?.withheld_fields || [])].sort()) === JSON.stringify(['address', 'birthdate', 'contact_number', 'purpose']),
      JSON.stringify(crafted?.withheld_fields));
    check('  the deny-list is applied again on read — no credential key anywhere',
      keysDeep(r.body).every((k) => !isSensitiveKey(k)), keysDeep(r.body).filter(isSensitiveKey).join(', '));
    check('  no credential VALUE or reset link either',
      !['hash-secret', 'tok-secret', 'token=abc'].some((v) => raw.includes(v)));
    check('  non-personal values survive',
      crafted?.old_value?.status === 'pending' && crafted?.new_value?.status === 'approved'
        && crafted?.old_value?.nested?.ok === 1 && crafted?.old_value?.list?.[0]?.fine === 2);
    check('  the actor is exactly { user_id, name, username, role }', sameKeys(crafted?.actor, ACTOR_KEYS),
      Object.keys(crafted?.actor || {}).join(', '));
    check('  no email anywhere, though the embed carried one', !raw.includes('leak@example.test') && !keysDeep(r.body).includes('email'));
    check('  the actor is named from the profile', crafted?.actor?.name === 'Ana Cruz', crafted?.actor?.name);
    check('  …and falls back to @username with no profile', plain?.actor?.name === '@no_profile', plain?.actor?.name);
    check('  a row with nothing withheld has NO withheld_fields key', plain && !('withheld_fields' in plain));
    check('  every entry carries only the documented keys',
      (r.body.logs || []).every((e) => Object.keys(e).every((k) => ENTRY_KEYS.includes(k))));
    const sel = calls[0]?.select || '';
    check('the select names its columns — never users(*), never a bare *', sel.length > 0 && !sel.includes('*'), sel.replace(/\s+/g, ' '));
    check('  and never asks for email or a password hash', !/\b(email|password_hash)\b/.test(sel));
    check('  a plain embed when no role filter is set', /users \(/.test(sel) && !sel.includes('!inner'));
  }

  section('GET /activity-logs — filters');
  {
    for (const [label, query] of [
      ['an unknown action', { action: 'MAKE_TEA' }],
      ['an unknown record type', { table: 'payments_ledger' }],
      ['an unknown role', { role: 'mayor' }],
      ['record_id without table', { record_id: '89' }],
      ['a non-integer user_id', { user_id: 'abc' }],
      ['a malformed date', { from: '01/10/2026' }],
      ['a date that does not exist', { to: '2026-02-30' }],
      ['from after to', { from: '2026-10-02', to: '2026-10-01' }],
    ]) {
      const { result: r, calls } = await withFakeTable([], () => invoke(logsHandler, { user: asUser('secretary'), query }));
      check(`${label} is a 400, before any query`, r.status === 400 && calls.length === 0, r.body?.error);
    }
    const { result: r, calls } = await withFakeTable([{ data: [], error: null, count: 0 }], () => invoke(logsHandler, {
      user: asUser('punong_barangay'),
      query: { action: 'approve', table: 'document_requests', record_id: '89', user_id: '1', role: 'secretary', from: '2026-10-01', to: '2026-10-01' },
    }));
    const f = calls[0]?.filters || [];
    check('every filter reaches the query', r.status === 200 && [
      'eq action APPROVE', 'eq table_name document_requests', 'eq record_id 89', 'eq user_id 1', 'eq users.role secretary',
    ].every((x) => f.includes(x)), f.join(' | '));
    check('  a Manila day: from its midnight (UTC+8) up to the next one, so all of "to" is included',
      f.includes('gte timestamp 2026-09-30T16:00:00.000Z') && f.includes('lt timestamp 2026-10-01T16:00:00.000Z'));
    check('  the role filter uses an INNER embed, so it removes rows', (calls[0]?.select || '').includes('users!inner'));
  }

  section('GET /activity-logs — a page past the end keeps the true total');
  {
    const { result: r, calls } = await withFakeTable([
      { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' }, count: null },
      { data: null, error: null, count: 42 },
    ], () => invoke(logsHandler, { user: asUser('secretary'), query: { page: '9', action: 'CREATE', role: 'staff' } }));
    check('an empty page with the real total, not 0', r.status === 200 && r.body.logs?.length === 0 && r.body.total === 42,
      JSON.stringify({ total: r.body.total, total_pages: r.body.total_pages }));
    check('  so the pager still has pages to show', r.body.total_pages === 2 && r.body.page === 9);
    check('  the count is a separate head-only query with the same filters',
      calls[1]?.options?.head === true && calls[1]?.filters.includes('eq action CREATE') && calls[1]?.filters.includes('eq users.role staff')
        && (calls[1]?.select || '').includes('users!inner'));
  }

  section('GET /activity-logs — live, read-only, as each viewer');
  {
    // Pass-through wrapper: the real query runs; its select string is kept.
    const realFrom = supabase.from;
    const selects = [];
    supabase.from = (table) => {
      const q = realFrom.call(supabase, table);
      const realSelect = q.select.bind(q);
      q.select = (s, o) => { selects.push(s); return realSelect(s, o); };
      return q;
    };
    try {
      for (const role of LOG_VIEWERS) {
        const r = await invoke(logsHandler, { user: asUser(role), query: {} });
        const logs = r.body.logs || [];
        const keys = keysDeep(r.body);
        check(`${role}: 200 with a page of the log`, r.status === 200 && Array.isArray(logs) && typeof r.body.total === 'number',
          `${logs.length} row(s) of ${r.body.total}`);
        check(`  ${role}: no credential key and no email anywhere`, keys.every((k) => !isSensitiveKey(k)) && !keys.includes('email'));
        check(`  ${role}: no personal key inside any old_value / new_value`,
          logs.every((e) => [...keysDeep(e.old_value), ...keysDeep(e.new_value)].every((k) => !isPersonalKey(k))));
        check(`  ${role}: every actor is exactly { user_id, name, username, role }`, logs.every((e) => sameKeys(e.actor, ACTOR_KEYS)));
        check(`  ${role}: withheld_fields only ever names PERSONAL_FIELDS`,
          logs.every((e) => !('withheld_fields' in e) || (e.withheld_fields.length > 0 && e.withheld_fields.every(isPersonalKey))));
        if (r.body.total > 0) {
          const past = await invoke(logsHandler, { user: asUser(role), query: { page: '999' } });
          check(`  ${role}: page 999 is empty but keeps the true total`,
            past.status === 200 && past.body.logs.length === 0 && past.body.total === r.body.total, `${past.body.total} vs ${r.body.total}`);
        }
      }
      const bySecretary = await invoke(logsHandler, { user: asUser('secretary'), query: { role: 'secretary' } });
      check('the role filter returns only that role\'s actions', bySecretary.status === 200
        && bySecretary.body.logs.every((e) => e.actor.role === 'secretary'), `${bySecretary.body.logs.length} row(s)`);
      check('no live query asked for every column', selects.length > 0 && selects.every((s) => !s.includes('*')), `${selects.length} select(s)`);
    } finally {
      supabase.from = realFrom;
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
