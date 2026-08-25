// ===========================================================================
// ROUTE ROLE GUARDS — resident records + document requests.
//
//   cd backend && npm run roles:test
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
const supabase = require(path.join(__dirname, '..', 'src', 'config', 'supabase.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

const ALL_ROLES = ['secretary', 'punong_barangay', 'treasurer', 'staff', 'resident'];
const VIEWERS = ['secretary', 'punong_barangay', 'staff'];
const SECRETARY_ONLY = ['secretary'];

// Routes whose access is scoped by OWNERSHIP (profiles.resident_id /
// requested_by_user_id) rather than by role. They carry no requireRole by
// design and are listed explicitly so "no guard" is a recorded decision here
// rather than an omission that slipped through.
const OWNERSHIP_SCOPED = ALL_ROLES;

// The authority. method + path -> exactly which roles the chain admits.
const EXPECTED = {
  'residentRecords.js': {
    'GET /': VIEWERS,
    'GET /:id': VIEWERS,
    'POST /check-duplicates': SECRETARY_ONLY,
    'POST /': SECRETARY_ONLY,
    'PUT /:id': SECRETARY_ONLY,
    'POST /:id/archive': SECRETARY_ONLY,
    'POST /:id/unarchive': SECRETARY_ONLY,
  },
  'documentRequests.js': {
    'POST /': OWNERSHIP_SCOPED,           // resident submits; scoped by profiles.resident_id
    'GET /mine': OWNERSHIP_SCOPED,        // scoped by requested_by_user_id
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
};

// Columns Staff must never receive on a resident record, from the agreed
// data-minimization decision. `account` / `linked_accounts` are covered
// separately because they are response keys, not table columns.
const RESTRICTED = ['birthplace', 'sex', 'civil_status', 'religion', 'educational_attainment', 'contact_number'];

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
  console.log('Route role guards — resident records + document requests');
  console.log('No server started. No writes.');

  auditRouter('residentRecords.js', residentRecords);
  auditRouter('documentRequests.js', documentRequests);

  // -- every route carries authenticate at the router level -----------------
  section('router-level authenticate');
  for (const [label, router] of [['residentRecords.js', residentRecords], ['documentRequests.js', documentRequests]]) {
    const hasAuth = router.stack.some((l) => !l.route && l.handle?.name === 'authenticate');
    check(`${label} mounts authenticate at the router level`, hasAuth);
  }

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
  check('  staff row omits date_registered', !('date_registered' in staffRow));

  // WITHHELD MEANS ABSENT. `account: null` used to be the one field that was
  // withheld by being nulled rather than removed, which made a withheld value
  // indistinguishable from a genuine absence — the client cannot tell, so it
  // rendered a column of em dashes asserting nobody had registered.
  check('  staff row does NOT contain the key "account"', !('account' in staffRow),
    Object.keys(staffRow).join(', '));
  check('  PB row DOES contain the key "account"', 'account' in pbRow,
    Object.keys(pbRow).join(', '));

  check('  PB row DOES include contact_number', 'contact_number' in pbRow);
  check('  PB row DOES include date_registered', 'date_registered' in pbRow);

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
    for (const col of ['birthplace', 'sex', 'civil_status', 'contact_number', 'date_registered']) {
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

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
