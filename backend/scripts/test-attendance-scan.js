// ===========================================================================
// EVENTS STAGE 3d — QR scan -> attendance.
//
//   cd backend && npm run scan:test
//
// Runs the REAL POST /api/events/:id/attendance handler by invoking it with a
// mock req/res. No server is started and no port is opened; the handler runs
// its real queries against the live database.
//
// It creates its own test event and its own throwaway households, and deletes
// everything it wrote. Real households are only ever READ — their QR tokens
// are used to scan against the TEST event, so no real attendance is touched.
// ===========================================================================
const { createRequire } = require('module');
const beRequire = createRequire(require('path').join(__dirname, '..', 'package.json'));
beRequire('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { createClient } = beRequire('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const routerPath = path.join(__dirname, '..', 'src', 'routes', 'events.js');
const router = require(routerPath);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);
const iso = (ms) => new Date(ms).toISOString();

// Pull a route handler off the router, skipping the authenticate/requireRole
// layers (their placement is asserted separately, below).
function handlerFor(method, routePath) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`${method.toUpperCase()} ${routePath} not found on the router`);
}
const postAttendance = handlerFor('post', '/:id/attendance');

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

(async () => {
  const created = { events: [], households: [] };
  const cleanup = async () => {
    for (const id of created.events) {
      await db.from('event_attendees').delete().eq('event_id', id);
      await db.from('events').delete().eq('event_id', id);
    }
    for (const id of created.households) {
      await db.from('household_qr').delete().eq('household_id', id);
      await db.from('event_attendees').delete().eq('household_id', id);
      await db.from('household_records').delete().eq('household_id', id);
    }
  };

  const makeHousehold = async (address, { active = true, qrActive = true } = {}) => {
    const { data, error } = await db
      .from('household_records')
      .insert({ address, registered_at: iso(Date.now()), is_active: active })
      .select('household_id')
      .single();
    if (error) throw new Error(`setup failed (household): ${error.message}`);
    created.households.push(data.household_id);
    const token = crypto.randomUUID();
    const { error: qrErr } = await db
      .from('household_qr')
      .insert({ household_id: data.household_id, qr_token: token, is_active: qrActive });
    if (qrErr) throw new Error(`setup failed (qr): ${qrErr.message}`);
    return { household_id: data.household_id, token };
  };

  try {
    // ------------------------------------------------------------- setup
    const { data: staff } = await db
      .from('users')
      .select('user_id, username, role')
      .in('role', ['secretary', 'staff'])
      .eq('is_active', true)
      .limit(1)
      .single();
    check('found a staff-side account to record as', !!staff, staff && `@${staff.username} (${staff.role})`);
    if (!staff) return;

    const { data: event, error: evErr } = await db
      .from('events')
      .insert({
        title: 'TEST 3d scan',
        type: 'activity',
        start_datetime: iso(Date.now() - 4 * 3600e3),
        end_datetime: iso(Date.now() - 2 * 3600e3),
        date_created: iso(Date.now()),
        is_archived: false,
        attendance_required: true,
        fine_amount: null,
      })
      .select('event_id')
      .single();
    if (evErr) throw new Error(`setup failed (event): ${evErr.message}`);
    created.events.push(event.event_id);
    const params = { id: String(event.event_id) };
    const scan = (body) => invoke(postAttendance, { user: staff, params, body });

    // A REAL household, read only — its token is what a resident's phone shows.
    const { data: realQr } = await db
      .from('household_qr')
      .select('household_id, qr_token, household_records!inner ( is_active )')
      .eq('is_active', true)
      .eq('household_records.is_active', true)
      .limit(1)
      .single();
    check('found a real active household with an active QR to scan', !!realQr,
      realQr && `household ${realQr.household_id}`);
    if (!realQr) return;

    // =================================================================== A
    section('the route sits behind the management gate');
    // The scan path adds no new route, so it inherits 3a's guard — but only
    // while it stays declared after it. Asserted structurally so moving it
    // above the gate breaks a test rather than silently exposing attendance.
    const src = fs.readFileSync(routerPath, 'utf8');
    const gateAt = src.indexOf("router.use(requireRole(");
    const routeAt = src.indexOf("router.post('/:id/attendance'");
    check('requireRole gate is declared before the attendance route',
      gateAt > -1 && routeAt > -1 && gateAt < routeAt, `gate@${gateAt} route@${routeAt}`);

    // =================================================================== B
    section('a valid token records the household that owns it');
    const first = await scan({ qr_token: realQr.qr_token });
    check('scanning an active token records attendance', first.status === 201, first.body?.message);
    check('  it resolves to the token owner, not anything the client sent',
      first.body?.household_id === realQr.household_id,
      `${first.body?.household_id} vs ${realQr.household_id}`);
    check('  the reply names the household so the operator can eyeball it',
      !!first.body?.household && 'head_name' in first.body.household && 'address' in first.body.household,
      JSON.stringify(first.body?.household));

    const { data: written } = await db
      .from('event_attendees')
      .select('household_id, recorded_by_user_id')
      .eq('event_id', event.event_id);
    check('  exactly one row was written', written?.length === 1, `${written?.length} row(s)`);
    check('  it records WHO scanned it', written?.[0]?.recorded_by_user_id === staff.user_id);

    // =================================================================== C
    section('re-scanning is harmless — the code lingers in front of the lens');
    const repeat = await scan({ qr_token: realQr.qr_token });
    check('a second scan is 200, not an error', repeat.status === 200, repeat.body?.message);
    check('  it reports already_recorded', repeat.body?.already_recorded === true);
    check('  it says when it was first recorded', !!repeat.body?.attendance?.recorded_at);
    const { count: afterRepeat } = await db
      .from('event_attendees')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', event.event_id);
    check('  STILL exactly one row', afterRepeat === 1, `${afterRepeat} row(s)`);

    // =================================================================== D
    section('typed-fallback tolerance');
    const messy = `  ${realQr.qr_token.toUpperCase()}  `;
    const tolerant = await scan({ qr_token: messy });
    check('padded, upper-cased token still resolves', tolerant.body?.household_id === realQr.household_id,
      `${tolerant.status} ${tolerant.body?.error || ''}`);

    // =================================================================== E
    section('tokens that must not record anything');
    const unknown = await scan({ qr_token: crypto.randomUUID() });
    check('an unknown token is refused', unknown.status === 404, unknown.body?.error);
    check('  flagged as unknown so the UI can say so', unknown.body?.qr_unknown === true);

    const deadQr = await makeHousehold('TEST 3d deactivated-code', { qrActive: false });
    const dead = await scan({ qr_token: deadQr.token });
    check('a DEACTIVATED code is refused', dead.status === 409, dead.body?.error);
    check('  told apart from an unknown one', dead.body?.qr_inactive === true);

    const goneHousehold = await makeHousehold('TEST 3d inactive-household', { active: false });
    const gone = await scan({ qr_token: goneHousehold.token });
    check('an active code on an INACTIVE household is refused', gone.status === 409, gone.body?.error);

    const tooLong = await scan({ qr_token: 'x'.repeat(200) });
    check('an absurdly long token is rejected before the query', tooLong.status === 400, tooLong.body?.error);

    for (const [label, value] of [['empty', ''], ['blank', '   '], ['non-string', 12345]]) {
      const bad = await scan({ qr_token: value });
      check(`  a ${label} token is a 400`, bad.status === 400, bad.body?.error);
    }

    const { count: afterRefusals } = await db
      .from('event_attendees')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', event.event_id);
    check('NONE of the refusals wrote a row', afterRefusals === 1, `${afterRefusals} row(s)`);

    // =================================================================== F
    section('exactly one way of naming the household per request');
    const both = await scan({ qr_token: realQr.qr_token, household_id: realQr.household_id });
    check('sending both a token and an id is refused', both.status === 400, both.body?.error);
    const neither = await scan({});
    check('sending neither is refused', neither.status === 400, neither.body?.error);

    // =================================================================== G
    section('the tap path is unchanged (3a regression)');
    const tapTarget = await makeHousehold('TEST 3d tap-path');
    const tap = await scan({ household_id: tapTarget.household_id });
    check('Mark present by household_id still records', tap.status === 201, tap.body?.message);
    check('  and still reports that household', tap.body?.household_id === tapTarget.household_id);
    const tapRepeat = await scan({ household_id: tapTarget.household_id });
    check('  repeat tap is still a no-op', tapRepeat.status === 200 && tapRepeat.body?.already_recorded === true);
    const missing = await scan({ household_id: 99999999 });
    check('  an unknown household_id is still a 404', missing.status === 404, missing.body?.error);

    // =================================================================== H
    section('scan and tap converge on the same row shape');
    const { data: rows } = await db
      .from('event_attendees')
      .select('event_id, household_id, recorded_by_user_id, recorded_at')
      .eq('event_id', event.event_id)
      .order('household_id');
    check('two households recorded in total', rows?.length === 2, `${rows?.length}`);
    check('  every row carries the same fields whichever path wrote it',
      (rows || []).every((r) => r.event_id === event.event_id && r.recorded_by_user_id === staff.user_id && !!r.recorded_at));
  } catch (err) {
    console.error('\nERROR:', err.stack || err.message);
    failures++;
  } finally {
    section('cleanup');
    await cleanup();
    const { count: leftoverEvents } = await db
      .from('events')
      .select('*', { count: 'exact', head: true })
      .ilike('title', 'TEST 3d%');
    const { count: leftoverHouseholds } = await db
      .from('household_records')
      .select('*', { count: 'exact', head: true })
      .ilike('address', 'TEST 3d%');
    check('every test event was removed', leftoverEvents === 0, `${leftoverEvents} left`);
    check('every test household was removed', leftoverHouseholds === 0, `${leftoverHouseholds} left`);
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exitCode = failures ? 1 : 0;
})();
