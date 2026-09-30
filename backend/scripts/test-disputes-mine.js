// ===========================================================================
// MY DISPUTES — GET /api/disputes/mine, a resident's own blotter cases.
//
//   cd backend && npm run disputes:test
//
// WHY THIS EXISTS. Residents were refused every blotter route until this one.
// It is read-only, but it hands case data to the people named in it, so the
// test pins the three things that make it safe:
//
//   1. SCOPE — a resident sees only cases where a dispute_parties row carries
//      their OWN linked resident_id, and nothing a client sends can widen it.
//   2. ALLOW-LIST — the payload carries the case's label fields and the
//      caller's role(s), and no other party's name, no birthdate, no
//      contact_number, no time_filed, no dispute_id.
//   3. HONEST EMPTY STATES — an unlinked account gets a reason, a database
//      error reaches the error handler, and neither reads as "no cases".
//
// Requests are dispatched through the REAL router, router-level authenticate
// and route order included — which roles:test cannot do, because it probes
// each route's guards in isolation and never matches a URL.
//
// No server, no port, no network, no writes, and NO LIVE ROWS. The Supabase
// client points at a dead address and supabase.from is replaced for the whole
// run by an in-memory fake built from the fixtures below (the pattern
// test-notifications.js uses to sabotage one table, applied to all of them).
// The fake honours the select string, embeds included, so a handler that asks
// for more columns really receives them and the payload sweep can see it.
// ===========================================================================
const path = require('path');
const { createRequire } = require('module');
const beRequire = createRequire(path.join(__dirname, '..', 'package.json'));

// Never the real credentials: nothing here may reach the live database.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'disputes-test-no-network';
process.env.JWT_SECRET = 'disputes-test-signing-key';

const jwt = beRequire('jsonwebtoken');
const supabase = require(path.join(__dirname, '..', 'src', 'config', 'supabase.js'));
const disputes = require(path.join(__dirname, '..', 'src', 'routes', 'disputes.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

// ---------------------------------------------------------------------------
// Fixtures. Every name, birthdate and contact number is distinctive so the
// payload sweep can look for it as a plain string.
// ---------------------------------------------------------------------------
const TABLES = {
  users: [
    { user_id: 901, username: 'res_a', email: 'a@example.invalid', role: 'resident', is_active: true, must_change_password: false },
    { user_id: 902, username: 'res_b', email: 'b@example.invalid', role: 'resident', is_active: true, must_change_password: false },
    { user_id: 903, username: 'res_c', email: 'c@example.invalid', role: 'resident', is_active: true, must_change_password: false },
    { user_id: 904, username: 'res_unlinked', email: 'u@example.invalid', role: 'resident', is_active: true, must_change_password: false },
    { user_id: 905, username: 'res_no_cases', email: 'e@example.invalid', role: 'resident', is_active: true, must_change_password: false },
    { user_id: 910, username: 'sec', email: 's@example.invalid', role: 'secretary', is_active: true, must_change_password: false },
    { user_id: 911, username: 'pb', email: 'p@example.invalid', role: 'punong_barangay', is_active: true, must_change_password: false },
    { user_id: 912, username: 'staff', email: 't@example.invalid', role: 'staff', is_active: true, must_change_password: false },
    { user_id: 913, username: 'treas', email: 'r@example.invalid', role: 'treasurer', is_active: true, must_change_password: false },
  ],
  profiles: [
    { user_id: 901, resident_id: 101 },
    { user_id: 902, resident_id: 102 },
    { user_id: 903, resident_id: 103 },
    { user_id: 904, resident_id: null },
    { user_id: 905, resident_id: 105 },
    { user_id: 910, resident_id: null },
    { user_id: 911, resident_id: null },
    { user_id: 912, resident_id: null },
    { user_id: 913, resident_id: null },
  ],
  resident_records: [
    { resident_id: 101, first_name: 'Almira', middle_name: 'Quiapo', last_name: 'Aquinaldo', suffix: null, birthdate: '1971-02-03', address: 'Purok Uno', contact_number: '09170000101' },
    { resident_id: 102, first_name: 'Bernardo', middle_name: 'Ricafort', last_name: 'Bautizta', suffix: null, birthdate: '1972-04-05', address: 'Purok Dos', contact_number: '09170000102' },
    { resident_id: 103, first_name: 'Carmelita', middle_name: 'Sison', last_name: 'Cruzado', suffix: null, birthdate: '1973-06-07', address: 'Purok Tres', contact_number: '09170000103' },
    { resident_id: 104, first_name: 'Dionisio', middle_name: 'Tabada', last_name: 'Diazon', suffix: null, birthdate: '1974-08-09', address: 'Purok Kwatro', contact_number: '09170000104' },
    // Linked to an account, party to no case.
    { resident_id: 105, first_name: 'Esperanza', middle_name: 'Ubay', last_name: 'Ecleo', suffix: null, birthdate: '1975-10-11', address: 'Purok Singko', contact_number: '09170000105' },
  ],
  dispute_records: [
    { dispute_id: 1, barangay_case_no: 'CASE-A1', date_filed: '2026-09-01', time_filed: '09:15:00', filed_for: 'Unjust Vexation', nature_of_case: 'Civil', is_settled: false },
    { dispute_id: 2, barangay_case_no: 'CASE-B2', date_filed: '2026-09-10', time_filed: '10:25:00', filed_for: 'Theft', nature_of_case: 'Criminal', is_settled: false },
    { dispute_id: 3, barangay_case_no: 'CASE-C3', date_filed: '2026-08-01', time_filed: '11:35:00', filed_for: 'Noise', nature_of_case: 'Others', is_settled: true },
    { dispute_id: 4, barangay_case_no: 'CASE-A4', date_filed: '2026-09-20', time_filed: '13:45:00', filed_for: 'Trespass', nature_of_case: 'Criminal', is_settled: false },
    // Same date as CASE-A1: the internal id breaks the tie, newest first.
    { dispute_id: 5, barangay_case_no: 'CASE-A5', date_filed: '2026-09-01', time_filed: '14:55:00', filed_for: 'Slander', nature_of_case: 'Civil', is_settled: true },
  ],
  dispute_parties: [
    { dispute_party_id: 11, dispute_id: 1, resident_id: 101, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 12, dispute_id: 1, resident_id: 102, first_name: null, last_name: null, role: 'Respondent' },
    { dispute_party_id: 21, dispute_id: 2, resident_id: 102, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 22, dispute_id: 2, resident_id: null, first_name: 'Perfecto', last_name: 'Typedname', role: 'Respondent' },
    // Resident C three times in one case — twice as Complainant, once as
    // Respondent. validateParties allows it; the response must collapse it.
    { dispute_party_id: 31, dispute_id: 3, resident_id: 103, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 32, dispute_id: 3, resident_id: 103, first_name: null, last_name: null, role: 'Respondent' },
    { dispute_party_id: 33, dispute_id: 3, resident_id: 103, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 34, dispute_id: 3, resident_id: 104, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 41, dispute_id: 4, resident_id: 101, first_name: null, last_name: null, role: 'Respondent' },
    { dispute_party_id: 42, dispute_id: 4, resident_id: 104, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 43, dispute_id: 4, resident_id: null, first_name: 'Quirino', last_name: 'Walkinez', role: 'Respondent' },
    { dispute_party_id: 51, dispute_id: 5, resident_id: 102, first_name: null, last_name: null, role: 'Complainant' },
    { dispute_party_id: 52, dispute_id: 5, resident_id: 101, first_name: null, last_name: null, role: 'Respondent' },
  ],
};

// The embeds PostgREST would resolve from the foreign keys.
const RELATIONS = {
  dispute_parties: {
    dispute_records: { table: 'dispute_records', local: 'dispute_id', foreign: 'dispute_id', many: false },
    resident_records: { table: 'resident_records', local: 'resident_id', foreign: 'resident_id', many: false },
  },
  dispute_records: {
    dispute_parties: { table: 'dispute_parties', local: 'dispute_id', foreign: 'dispute_id', many: true },
  },
};

// Strings that must never reach a resident: every party name, every
// birthdate, every contact number and every filing time in the fixtures.
const FORBIDDEN_VALUES = [
  ...TABLES.resident_records.flatMap((r) => [r.first_name, r.middle_name, r.last_name, r.birthdate, r.contact_number, r.address]),
  ...TABLES.dispute_parties.flatMap((p) => [p.first_name, p.last_name]).filter(Boolean),
  ...TABLES.dispute_records.map((d) => d.time_filed.slice(0, 5)),
];
const FORBIDDEN_KEYS = ['dispute_id', 'time_filed', 'resident_id', 'first_name', 'middle_name', 'last_name',
  'birthdate', 'contact_number', 'address', 'dispute_parties', 'resident_records', 'dispute_party_id'];
const CASE_KEYS = ['barangay_case_no', 'date_filed', 'filed_for', 'nature_of_case', 'is_settled', 'my_roles'];

// ---------------------------------------------------------------------------
// The fake. Supports exactly what the routes on this path use — select (with
// embeds), eq, maybeSingle, single — and throws on anything else, so a handler
// that changes shape fails loudly here instead of passing against a fake that
// guessed.
// ---------------------------------------------------------------------------
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
    if (node.name === '*') { Object.assign(out, row); continue; }
    if (!node.children) {
      if (!(node.name in row)) throw new Error(`column ${table}.${node.name} does not exist`);
      out[node.name] = row[node.name];
      continue;
    }
    const rel = RELATIONS[table]?.[node.name];
    if (!rel) throw new Error(`no relationship between ${table} and ${node.name}`);
    const related = TABLES[rel.table].filter((r) => r[rel.foreign] === row[rel.local]);
    out[node.name] = rel.many
      ? related.map((r) => project(rel.table, r, node.children))
      : related[0] ? project(rel.table, related[0], node.children) : null;
  }
  return out;
}

const queries = [];       // every query issued, for the scoping assertions
const FAULTS = {};        // table -> error message, to simulate a database error

function fakeFrom(table) {
  if (!TABLES[table]) throw new Error(`fake database has no table "${table}"`);
  const q = { table, columns: '*', filters: [], single: null };
  queries.push(q);
  const run = () => {
    if (FAULTS[table]) return { data: null, error: { message: FAULTS[table] } };
    const nodes = parseSelect(q.columns);
    let rows = TABLES[table].filter((r) => q.filters.every(([col, val]) => String(r[col]) === String(val)));
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
    select(columns) { q.columns = columns; return builder; },
    eq(col, val) { q.filters.push([col, val]); return builder; },
    maybeSingle() { q.single = 'maybe'; return builder; },
    single() { q.single = 'one'; return builder; },
    then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
  };
  return builder;
}

supabase.from = fakeFrom;
supabase.rpc = () => { throw new Error('fake database: rpc is not available'); };

// ---------------------------------------------------------------------------
// Dispatching through the real router
// ---------------------------------------------------------------------------
const tokenFor = (userId) => jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });

// Resolves with the response the router sent, or with the error it forwarded
// to next() — which in the app is server.js's handler, answering 500.
function call(method, url, { userId, query = {}, body = {}, params } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: userId ? { authorization: `Bearer ${tokenFor(userId)}` } : {},
      query,
      body,
      ...(params ? { params } : {}),
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, forwarded: null }); return this; },
    };
    disputes(req, res, (err) => resolve({ status: null, body: null, forwarded: err || 'unhandled' }));
  });
}

const casesOf = (r) => (r.body?.cases || []).map((c) => `${c.barangay_case_no}[${(c.my_roles || []).join('+')}]`).join(', ');

(async () => {
  console.log('GET /api/disputes/mine — a resident\'s own blotter cases');
  console.log('No server, no network, no writes: every query is answered by an in-memory fake.');

  // -------------------------------------------------------------------------
  section('scope: each resident sees their own cases and nothing else');
  const a = await call('GET', '/mine', { userId: 901 });
  check('resident A gets 200', a.status === 200, String(a.status ?? a.forwarded));
  check('resident A sees exactly CASE-A4, CASE-A5, CASE-A1, newest first (same-day tie by newest case)',
    casesOf(a) === 'CASE-A4[Respondent], CASE-A5[Respondent], CASE-A1[Complainant]', casesOf(a));
  check('resident A does NOT see CASE-B2 or CASE-C3', !/CASE-B2|CASE-C3/.test(JSON.stringify(a.body)));

  const b = await call('GET', '/mine', { userId: 902 });
  check('resident B sees exactly CASE-B2, CASE-A5, CASE-A1 with their own roles',
    casesOf(b) === 'CASE-B2[Complainant], CASE-A5[Complainant], CASE-A1[Respondent]', casesOf(b));

  const partyQueries = queries.filter((q) => q.table === 'dispute_parties');
  check('every dispute_parties query was filtered by the caller\'s own resident_id and nothing else',
    partyQueries.length === 2
      && JSON.stringify(partyQueries[0].filters) === JSON.stringify([['resident_id', 101]])
      && JSON.stringify(partyQueries[1].filters) === JSON.stringify([['resident_id', 102]]),
    partyQueries.map((q) => JSON.stringify(q.filters)).join(' / '));

  // -------------------------------------------------------------------------
  section('scope: nothing the client sends changes the answer');
  const hostile = await call('GET', '/mine?resident_id=102&dispute_id=2&id=2&user_id=902', {
    userId: 901,
    query: { resident_id: '102', dispute_id: '2', id: '2', user_id: '902' },
    body: { resident_id: 102, dispute_id: 2, user_id: 902 },
    params: { id: '2', resident_id: '102' },
  });
  check('query string, body and params naming B and CASE-B2 change nothing for A',
    hostile.status === 200 && JSON.stringify(hostile.body) === JSON.stringify(a.body), casesOf(hostile));

  // -------------------------------------------------------------------------
  section('same resident more than once in one case');
  const c = await call('GET', '/mine', { userId: 903 });
  check('resident C listed three times in CASE-C3 gets ONE case', (c.body?.cases || []).length === 1, casesOf(c));
  check('  with my_roles de-duplicated, in canonical order: Complainant, Respondent',
    JSON.stringify(c.body?.cases?.[0]?.my_roles) === JSON.stringify(['Complainant', 'Respondent']),
    JSON.stringify(c.body?.cases?.[0]?.my_roles));

  // -------------------------------------------------------------------------
  section('allow-list: the payload carries nothing else');
  // Each check below also requires cases to be present, so none of them can
  // pass on an empty or refused response.
  check('linked response has exactly one top-level key, "cases"',
    JSON.stringify(Object.keys(a.body || {})) === JSON.stringify(['cases']), Object.keys(a.body || {}).join(', '));
  for (const [label, r] of [['A', a], ['B', b], ['C', c]]) {
    const list = r.body?.cases || [];
    const bad = list.filter((cs) => JSON.stringify(Object.keys(cs)) !== JSON.stringify(CASE_KEYS));
    check(`every case for ${label} has exactly the six allowed keys`, list.length > 0 && bad.length === 0,
      list.length === 0 ? 'no cases to inspect' : bad.length ? Object.keys(bad[0]).join(', ') : CASE_KEYS.join(', '));
  }
  const swept = [a, b, c].reduce((n, r) => n + (r.body?.cases || []).length, 0);
  const allRaw = [a, b, c].map((r) => JSON.stringify(r.body)).join('\n');
  const leakedKeys = FORBIDDEN_KEYS.filter((k) => allRaw.includes(`"${k}"`));
  check('no forbidden key anywhere (dispute_id, time_filed, resident_id, names, birthdate, contact_number, embeds)',
    swept > 0 && leakedKeys.length === 0, swept === 0 ? 'no cases to sweep' : leakedKeys.join(', ') || `none, across ${swept} case(s)`);
  const leakedValues = FORBIDDEN_VALUES.filter((v) => allRaw.includes(v));
  check('no party name, birthdate, contact number, address or filing time anywhere in any payload',
    swept > 0 && leakedValues.length === 0, swept === 0 ? 'no cases to sweep' : leakedValues.join(', ') || `none, across ${swept} case(s)`);

  const touched = [...new Set(queries.map((q) => q.table))].sort();
  check('the route read only users (authenticate), profiles and dispute_parties',
    JSON.stringify(touched) === JSON.stringify(['dispute_parties', 'profiles', 'users']), touched.join(', '));

  // -------------------------------------------------------------------------
  section('honest empty states');
  const u = await call('GET', '/mine', { userId: 904 });
  check('an unlinked resident gets 200, not an error', u.status === 200, String(u.status ?? u.forwarded));
  check('  with reason "no_resident_record" and an empty cases list',
    u.body?.reason === 'no_resident_record' && Array.isArray(u.body?.cases) && u.body.cases.length === 0,
    JSON.stringify(u.body));
  check('  and exactly those two keys', JSON.stringify(Object.keys(u.body || {}).sort()) === JSON.stringify(['cases', 'reason']));
  const e = await call('GET', '/mine', { userId: 905 });
  check('a linked resident with no cases gets 200 and a real, empty list with NO reason key',
    e.status === 200 && Array.isArray(e.body?.cases) && e.body.cases.length === 0 && !('reason' in e.body),
    `${e.status} ${JSON.stringify(e.body)}`);

  FAULTS.dispute_parties = 'forced failure — dispute_parties unavailable';
  const failed = await call('GET', '/mine', { userId: 901 });
  delete FAULTS.dispute_parties;
  check('a database error on dispute_parties sends NO response (no 200, no empty list)', failed.status === null,
    failed.status === null ? 'nothing sent' : `sent ${failed.status} ${JSON.stringify(failed.body)}`);
  check('  and is forwarded to the error handler (server.js answers 500)',
    failed.forwarded instanceof Error && /Failed to load your cases/.test(failed.forwarded.message),
    failed.forwarded instanceof Error ? failed.forwarded.message : String(failed.forwarded));

  FAULTS.profiles = 'forced failure — profiles unavailable';
  const failedProfile = await call('GET', '/mine', { userId: 901 });
  delete FAULTS.profiles;
  check('a database error resolving the resident is forwarded too, not read as "not linked"',
    failedProfile.status === null && failedProfile.forwarded instanceof Error
      && /Failed to load profile/.test(failedProfile.forwarded.message),
    failedProfile.status === null ? failedProfile.forwarded?.message : `sent ${failedProfile.status} ${JSON.stringify(failedProfile.body)}`);

  // -------------------------------------------------------------------------
  section('roles and route order, through the real router');
  for (const [label, userId] of [['secretary', 910], ['punong_barangay', 911], ['staff', 912], ['treasurer', 913]]) {
    const r = await call('GET', '/mine', { userId });
    check(`${label} gets 403 from /mine's own guard`, r.status === 403 && r.body?.error === 'Insufficient permissions',
      `${r.status} ${JSON.stringify(r.body)}`);
  }
  const anon = await call('GET', '/mine', {});
  check('no token gets 401 from router-level authenticate', anon.status === 401, `${anon.status}`);

  // A resident refused everywhere else — the writes answer 403 before any
  // handler runs, so the fake (which has no insert or update) is never reached.
  for (const [method, url] of [['GET', '/'], ['GET', '/1'], ['POST', '/'], ['PUT', '/1'], ['PATCH', '/1/settle']]) {
    const r = await call(method, url, { userId: 901, body: { is_settled: true } });
    check(`resident gets 403 on ${method} ${url}`, r.status === 403, `${r.status ?? r.forwarded}`);
  }
  const sec = await call('GET', '/1', { userId: 910 });
  check('the Secretary still reaches GET /:id (unchanged)', sec.status === 200 && sec.body?.dispute?.barangay_case_no === 'CASE-A1',
    `${sec.status ?? sec.forwarded}`);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
