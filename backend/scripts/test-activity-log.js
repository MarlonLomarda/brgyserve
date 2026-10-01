// ===========================================================================
// ACTIVITY LOG — the helper, and every place that calls it.
//
//   cd backend && npm run activity:test
//
// WHY THIS EXISTS. activity_logs is an audit trail, so the two ways it can go
// wrong are both quiet: a credential copied into old_value/new_value, or a
// logging failure that takes the business action down with it. This pins
// both, and checks every call site in routes/ against the vocabulary and the
// real table names, so a typo cannot create a second spelling of an action.
//
// No server, no port, no network, no writes, no live rows. The Supabase
// client points at a dead address and supabase.from is replaced by fakes —
// the pattern test-notifications.js uses to sabotage a table.
// ===========================================================================
const fs = require('fs');
const path = require('path');

// Never the real credentials: nothing here may reach the live database.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'activity-test-no-network';
process.env.JWT_SECRET = 'activity-test-signing-key';

const supabase = require(path.join(__dirname, '..', 'src', 'config', 'supabase.js'));
const { logActivity, logActivityMany, diffFields, scrub } = require(path.join(__dirname, '..', 'src', 'services', 'activityLog.js'));
const { ACTIONS, isSensitiveKey, LOGGED_TABLES } = require(path.join(__dirname, '..', 'src', 'constants', 'activityLog.js'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

// Console noise from the helper's own warnings is captured, so the checks can
// assert that a skip or a suppressed failure DID announce itself.
const captured = { warn: [], error: [] };
const realWarn = console.warn;
const realError = console.error;
const quietConsole = () => {
  captured.warn = []; captured.error = [];
  console.warn = (...a) => captured.warn.push(a.join(' '));
  console.error = (...a) => captured.error.push(a.join(' '));
};
const loudConsole = () => { console.warn = realWarn; console.error = realError; };

// A fake activity_logs table: records what would have been inserted.
const inserts = [];
let insertBehaviour = 'ok'; // 'ok' | 'error' | 'throw'
const fakeFrom = (table) => {
  if (insertBehaviour === 'throw') throw new Error('forced: the client itself threw');
  if (table !== 'activity_logs') throw new Error(`unexpected table ${table}`);
  return {
    insert(rows) {
      if (insertBehaviour === 'error') return Promise.resolve({ error: { message: 'forced insert failure' } });
      inserts.push(rows);
      return Promise.resolve({ error: null });
    },
  };
};

(async () => {
  console.log('Activity log — helper, deny-list, and call sites');
  console.log('No server, no network, no writes.');

  // -------------------------------------------------------------------------
  section('deny-list: credentials are removed at every depth, any case');
  const before = {
    username: 'kept',
    Password_Hash: '$2a$10$abc',
    nested: { QR_TOKEN: 'uuid', keep: 1, deeper: { paymongo_session_id: 'cs_x', api_key: 'k', fine: true } },
    list: [{ token_hash: 'h', ok: 'yes' }, 'https://x/reset-password?token=abc', 'plain'],
    must_change_password: true,
    Authorization: 'Bearer x',
    checkout_url: 'https://checkout.paymongo.com/cs_x',
    message: 'BrgyServe: reset at https://x/reset?token=abc',
    note: 'reset link https://brgy/reset-password?token=zzz',
    status: 'PAID',
  };
  const snapshot = JSON.stringify(before);
  const cleaned = scrub(before);
  const raw = JSON.stringify(cleaned);
  check('the caller\'s object is not modified', JSON.stringify(before) === snapshot);
  for (const k of ['Password_Hash', 'QR_TOKEN', 'paymongo_session_id', 'api_key', 'token_hash',
    'must_change_password', 'Authorization', 'checkout_url', 'message']) {
    check(`  "${k}" is removed`, !raw.includes(`"${k}"`));
  }
  check('  a value carrying a reset link is removed whatever its key (note)', !('note' in cleaned));
  check('  a reset link inside an array is removed', !raw.includes('token=abc'));
  check('  ordinary keys survive at every depth',
    cleaned.username === 'kept' && cleaned.status === 'PAID' && cleaned.nested.keep === 1
      && cleaned.nested.deeper.fine === true && cleaned.list[0].ok === 'yes' && cleaned.list.includes('plain'),
    raw);
  check('  removed, not masked: no placeholder value anywhere', !/\*{3}|redacted|\[removed\]/i.test(raw));
  check('isSensitiveKey: exact, prefix and substring rules, case-insensitive',
    ['TOKEN', 'jwt', 'PayMongo_Payment_Id', 'webhook_secret', 'new_password', 'Signature', 'apikey'].every(isSensitiveKey)
      && !['username', 'role', 'status', 'resident_id', 'via', 'rejection_reason'].some(isSensitiveKey));

  // -------------------------------------------------------------------------
  section('diffFields');
  const d1 = diffFields({ a: 1, b: 'x', c: null, n: { k: 1 } }, { a: 1, b: 'y', c: null, n: { k: 2 } });
  check('only the changed keys, before and after',
    JSON.stringify(d1) === JSON.stringify({ before: { b: 'x', n: { k: 1 } }, after: { b: 'y', n: { k: 2 } } }),
    JSON.stringify(d1));
  const d2 = diffFields({ a: 1 }, { a: 1, only_after: 5 });
  check('a key present on one side only is ignored (not selected is not a change)',
    JSON.stringify(d2) === JSON.stringify({ before: {}, after: {} }), JSON.stringify(d2));
  const d3 = diffFields({ a: 1, b: 2 }, { a: 1, b: 2 });
  check('nothing changed gives { before: {}, after: {} }, not null', JSON.stringify(d3) === '{"before":{},"after":{}}');
  check('null on either side gives empty objects, never a throw',
    JSON.stringify(diffFields(null, { a: 1 })) === '{"before":{},"after":{}}');
  check('null to a value IS a change', JSON.stringify(diffFields({ c: null }, { c: 'x' }).after) === '{"c":"x"}');

  // -------------------------------------------------------------------------
  section('logActivity / logActivityMany against a fake table');
  supabase.from = fakeFrom;

  const t0 = Date.now();
  const r = await logActivity({ userId: 7, action: ACTIONS.UPDATE, table: 'charges', recordId: 12,
    before: { status: 'UNPAID', reference_no: 'kept-key-not-credential', password: 'p' }, after: { status: 'PAID' } });
  const row = inserts.at(-1);
  check('returns nothing the caller must check', r === undefined);
  check('inserts exactly the eight-minus-identity columns',
    JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['action', 'new_value', 'old_value', 'record_id', 'table_name', 'timestamp', 'user_id']),
    Object.keys(row).join(', '));
  check('sets timestamp itself, as an ISO string from now',
    typeof row.timestamp === 'string' && Math.abs(Date.parse(row.timestamp) - t0) < 5000, row.timestamp);
  check('user_id, action, table_name, record_id as given',
    row.user_id === 7 && row.action === 'UPDATE' && row.table_name === 'charges' && row.record_id === 12);
  check('values are scrubbed on the way in', !('password' in row.old_value) && row.new_value.status === 'PAID');

  const r2 = await logActivity({ userId: 7, action: ACTIONS.PASSWORD_CHANGE, table: 'users', recordId: 7 });
  check('no values gives null, not {}', inserts.at(-1).old_value === null && inserts.at(-1).new_value === null && r2 === undefined);

  const count = inserts.length;
  quietConsole();
  await logActivity({ action: ACTIONS.CREATE, table: 'users', recordId: 1 });
  await logActivity({ userId: null, action: ACTIONS.CREATE, table: 'users' });
  loudConsole();
  check('no userId: nothing inserted', inserts.length === count);
  check('  and a warning names the skip', captured.warn.length === 2 && /no user_id/.test(captured.warn[0]), captured.warn[0]);

  quietConsole();
  await logActivity({ userId: 'abc', action: ACTIONS.CREATE, table: 'users' });
  await logActivity({ userId: 3, action: '', table: 'users' });
  await logActivity({ userId: 3, action: ACTIONS.CREATE, table: 'x'.repeat(101) });
  await logActivity({ userId: 3, action: ACTIONS.CREATE, table: 'users', recordId: -4 });
  loudConsole();
  check('invalid user_id, action, table or record_id: skipped, nothing inserted', inserts.length === count && captured.warn.length === 4);

  insertBehaviour = 'error';
  quietConsole();
  let threw = false;
  try { await logActivity({ userId: 7, action: ACTIONS.CREATE, table: 'users', recordId: 1 }); } catch { threw = true; }
  loudConsole();
  check('an insert that returns an error does NOT throw', !threw);
  check('  and is reported in one console line', captured.error.length === 1 && /suppressed failure/.test(captured.error[0]), captured.error[0]);

  insertBehaviour = 'throw';
  quietConsole();
  threw = false;
  try { await logActivity({ userId: 7, action: ACTIONS.CREATE, table: 'users', recordId: 1 }); } catch { threw = true; }
  try { await logActivityMany([{ userId: 7, action: ACTIONS.CREATE, table: 'users' }]); } catch { threw = true; }
  loudConsole();
  check('a client that THROWS is caught too, single and batch', !threw && captured.error.length === 2, captured.error.join(' | '));
  insertBehaviour = 'ok';

  const before3 = inserts.length;
  quietConsole();
  await logActivityMany([
    { userId: 1, action: ACTIONS.CREATE, table: 'charges', recordId: 10, after: { a: 1, token: 't' } },
    { action: ACTIONS.CREATE, table: 'charges' }, // no user: skipped
    { userId: 2, action: ACTIONS.CREATE, table: 'charges', recordId: 11 },
  ]);
  loudConsole();
  const batch = inserts.at(-1);
  check('logActivityMany: ONE insert of the valid rows only', inserts.length === before3 + 1 && Array.isArray(batch) && batch.length === 2,
    `${Array.isArray(batch) ? batch.length : '?'} row(s)`);
  check('  each scrubbed and timestamped', !('token' in batch[0].new_value) && batch.every((b) => !!b.timestamp));
  const before4 = inserts.length;
  await logActivityMany([]);
  quietConsole();
  await logActivityMany('not an array');
  loudConsole();
  check('  an empty or bad list inserts nothing and does not throw', inserts.length === before4);

  // -------------------------------------------------------------------------
  section('every call site in routes/');
  const ROUTES = path.join(__dirname, '..', 'src', 'routes');
  const MIGRATIONS = path.join(__dirname, '..', 'migrations');
  const realTables = new Set();
  for (const f of fs.readdirSync(MIGRATIONS)) {
    for (const m of fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) {
      realTables.add(m[1]);
    }
  }

  // The object literal passed to a call, by brace matching from its "(".
  const callBodies = (src) => {
    const out = [];
    for (const m of src.matchAll(/logActivity(Many)?\(/g)) {
      let i = src.indexOf('{', m.index);
      const start = i;
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
      }
      out.push({ at: src.slice(0, m.index).split('\n').length, body: src.slice(start, i + 1) });
    }
    return out;
  };

  const FORBIDDEN_LITERAL_KEYS = /\b(email|contact_number|phone_number|phone|outside_borrower_name|outside_borrower_contact|birthdate|address|purpose|note|rejection_note|return_note|qr_token|reference_no|declared_reference|password|password_hash|token)\s*:/;
  const calls = [];
  for (const f of fs.readdirSync(ROUTES).sort()) {
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8').replace(/\r/g, '');
    for (const c of callBodies(src)) {
      // Comments stripped first, so a sentence in one cannot pass for a key.
      calls.push({ file: f, line: c.at, body: c.body.replace(/\/\/[^\n]*/g, '') });
    }
  }
  check('call sites found in routes/', calls.length >= 50, `${calls.length} call(s)`);

  // Every value the action expression can produce — the whole expression, or
  // both branches of a ternary — must be ACTIONS.<NAME> for a NAME that
  // exists. A string in the ternary's CONDITION is fine; a string as a value
  // is the typo this guards against.
  const actionValues = (expr) => {
    const q = expr.indexOf('?');
    return (q === -1 ? [expr] : expr.slice(q + 1).split(':')).map((s) => s.trim());
  };
  const badAction = calls.filter((c) => {
    const expr = (c.body.match(/action:\s*([^,\n]+)/) || [])[1] || '';
    return actionValues(expr).some((v) => {
      const m = v.match(/^ACTIONS\.([A-Z_]+)$/);
      return !m || !(m[1] in ACTIONS);
    });
  });
  check('every action value is an ACTIONS constant that exists — no string literals', badAction.length === 0,
    badAction.map((c) => `${c.file}:${c.line}`).join(', ') || `${calls.length} checked`);
  check('  the check rejects a string-literal action and an unknown constant',
    actionValues("'CREATE'").some((v) => !/^ACTIONS\./.test(v))
      && !('MAKE_TEA' in ACTIONS)
      && actionValues('x ? ACTIONS.SETTLE : ACTIONS.REOPEN').every((v) => /^ACTIONS\.[A-Z_]+$/.test(v)));

  const badTable = calls.filter((c) => {
    const t = (c.body.match(/table:\s*(['"])([a-z_]+)\1/) || [])[2];
    return !t || !realTables.has(t);
  });
  check('every table_name is a literal naming a table a migration creates', badTable.length === 0,
    badTable.map((c) => `${c.file}:${c.line}`).join(', ') || `${realTables.size} tables known`);

  // The Activity Log page filters by record type from LOGGED_TABLES and labels
  // every action and table from its own copy of the vocabulary, so all three
  // must cover exactly what the call sites write.
  const tablesLogged = [...new Set(calls.map((c) => (c.body.match(/table:\s*(['"])([a-z_]+)\1/) || [])[2]).filter(Boolean))].sort();
  check('LOGGED_TABLES (the page\'s record-type filter) lists exactly the tables call sites log',
    JSON.stringify(tablesLogged) === JSON.stringify([...LOGGED_TABLES].sort()),
    `logged: ${tablesLogged.join(', ')}`);
  const frontendVocab = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'constants', 'activityLog.js'), 'utf8');
  const unlabelled = [
    ...Object.keys(ACTIONS).filter((a) => !new RegExp(`^\\s*${a}:\\s*\\{\\s*label:`, 'm').test(frontendVocab)),
    ...LOGGED_TABLES.filter((t) => !new RegExp(`^\\s*${t}:\\s*'`, 'm').test(frontendVocab)),
  ];
  check('the frontend labels every action and every logged table', unlabelled.length === 0,
    unlabelled.join(', ') || `${Object.keys(ACTIONS).length} actions, ${LOGGED_TABLES.length} tables`);

  const badUser = calls.filter((c) => !/userId:\s*(req\.user\.user_id|user\.user_id)\b/.test(c.body));
  check('every userId is the session user, or the account the route just resolved (register, reset)',
    badUser.length === 0, badUser.map((c) => `${c.file}:${c.line}`).join(', ') || 'all');

  const personal = calls.filter((c) => FORBIDDEN_LITERAL_KEYS.test(c.body));
  check('no call site writes a personal, free-text, credential or reference key by name', personal.length === 0,
    personal.map((c) => `${c.file}:${c.line} ${(c.body.match(FORBIDDEN_LITERAL_KEYS) || [])[1]}`).join(', ') || 'none');

  // Routes that must never log, by the segment of source each one occupies.
  const segment = (src, marker) => {
    const start = src.indexOf(marker);
    if (start === -1) return null;
    const rest = src.slice(start + marker.length);
    const next = rest.search(/\n(router\.(get|post|put|patch|delete|use)\(|async function |function |module\.exports)/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const MUST_NOT_LOG = [
    ['auth.js', "router.post('/login'"],
    ['auth.js', "router.post('/forgot-password'"],
    ['payments.js', "router.post('/gcash/checkout'"],
    ['payments.js', 'async function webhookHandler'],
    ['payments.js', 'async function settlePaidCharge'],
    ['residentRecords.js', "router.post('/import/preview'"],
    ['residentRecords.js', "router.post('/check-duplicates'"],
  ];
  for (const [file, marker] of MUST_NOT_LOG) {
    const seg = segment(fs.readFileSync(path.join(ROUTES, file), 'utf8').replace(/\r/g, ''), marker);
    check(`${file} ${marker.replace(/^router\.post\(|^async function /, '')} does not log`, seg !== null && !seg.includes('logActivity'),
      seg === null ? 'marker not found' : '');
  }
  let getsWithLog = 0;
  for (const f of fs.readdirSync(ROUTES)) {
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8').replace(/\r/g, '');
    for (const m of src.matchAll(/router\.get\(\s*["'][^"']+["']/g)) {
      const seg = segment(src, m[0]);
      if (seg && seg.includes('logActivity')) getsWithLog++;
    }
  }
  check('no GET route logs', getsWithLog === 0, `${getsWithLog} found`);

  // -------------------------------------------------------------------------
  section('wiring, through real handlers');
  // A generic fake for the few queries these handlers make; activity_logs
  // inserts are captured, everything else answers with the row given.
  const logged = [];
  const answers = {};
  supabase.from = (table) => {
    const op = { table, kind: 'select' };
    const b = {
      select() { return b; }, eq() { return b; }, maybeSingle() { return b; }, single() { return b; },
      update() { op.kind = 'update'; return b; },
      insert(rows) { op.kind = 'insert'; if (table === 'activity_logs') logged.push(rows); return b; },
      then(res, rej) { return Promise.resolve({ data: answers[table] ?? null, error: null }).then(res, rej); },
    };
    return b;
  };
  const handlerFor = (router, method, routePath) => {
    const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const invoke = (handler, req) => new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
  const secretary = { user_id: 4242, username: 'probe_secretary', role: 'secretary' };

  const disputes = require(path.join(ROUTES, 'disputes.js'));
  answers.dispute_records = { dispute_id: 9, barangay_case_no: 'X-1', is_settled: true, dispute_parties: [] };
  const settled = await invoke(handlerFor(disputes, 'patch', '/:id/settle'), { user: secretary, params: { id: '9' }, body: { is_settled: true } });
  const reopened = await invoke(handlerFor(disputes, 'patch', '/:id/settle'), { user: secretary, params: { id: '9' }, body: { is_settled: false } });
  check('disputes settle → one SETTLE row by the session user, on dispute_records #9',
    settled.status === 200 && logged[0]?.action === 'SETTLE' && logged[0]?.user_id === 4242
      && logged[0]?.table_name === 'dispute_records' && logged[0]?.record_id === 9, JSON.stringify(logged[0]));
  check('disputes reopen → REOPEN, with is_settled false', reopened.status === 200 && logged[1]?.action === 'REOPEN'
    && logged[1]?.new_value?.is_settled === false, JSON.stringify(logged[1]));

  const types = require(path.join(ROUTES, 'documentTypes.js'));
  answers.document_types = { document_type_id: 3, name: 'Clearance', is_active: false };
  await invoke(handlerFor(types, 'post', '/:id/deactivate'), { user: secretary, params: { id: '3' }, body: {} });
  check('document type deactivate → DEACTIVATE on document_types #3', logged[2]?.action === 'DEACTIVATE'
    && logged[2]?.table_name === 'document_types' && logged[2]?.record_id === 3, JSON.stringify(logged[2]));

  answers.dispute_records = null; // the case does not exist
  const missing = await invoke(handlerFor(disputes, 'patch', '/:id/settle'), { user: secretary, params: { id: '77' }, body: { is_settled: true } });
  check('a 404 path logs nothing', missing.status === 404 && logged.length === 3, `${logged.length} row(s)`);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { loudConsole(); console.error(e.stack || e.message); process.exit(1); });
