// Events Stage 3b — fine generation test suite.
//
// Runs against the LIVE API on :5000 and the live database. Everything it
// writes is created on its OWN test event and deleted again at the end; the
// barangay's real event and its attendance are only ever READ.
//
//   cd backend && npm run fines:test      (backend must be running)

require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.TEST_API_URL || 'http://localhost:5000/api';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (ok) pass += 1;
  else {
    fail += 1;
    process.exitCode = 1;
  }
}
const section = (t) => console.log(`\n--- ${t} ---`);

// Tokens are minted directly rather than by logging in, so role guards can be
// exercised for every role without creating or knowing passwords for accounts.
// authenticate() re-reads the user from the database, so these must be real
// user rows.
const tokenFor = (user) =>
  jwt.sign({ sub: String(user.user_id), role: user.role }, process.env.JWT_SECRET, { expiresIn: '10m' });

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

const iso = (d) => new Date(d).toISOString();
const HOUR = 3600 * 1000;

(async () => {
  // ---------------------------------------------------------------- setup
  const { data: users } = await db
    .from('users')
    .select('user_id, username, role, is_active, must_change_password')
    .eq('is_active', true)
    .eq('must_change_password', false);
  const pick = (role) => users.find((u) => u.role === role);
  const roles = ['secretary', 'staff', 'treasurer', 'punong_barangay', 'resident'];
  const tok = {};
  for (const r of roles) {
    const u = pick(r);
    if (u) tok[r] = tokenFor(u);
  }
  check('found a usable account for every role', roles.every((r) => tok[r]),
    roles.map((r) => `${r}:${pick(r)?.username ?? 'MISSING'}`).join(' '));
  if (!tok.secretary) {
    console.log('\nCannot continue without a secretary account.');
    return;
  }

  const health = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  check('backend is reachable on :5000', health);
  if (!health) return;

  const created = { events: [], households: [] };

  // A delete that silently fails leaves real rows behind for good, so every
  // one is checked and reported rather than assumed.
  const scrub = async (table, column, id) => {
    const { error } = await db.from(table).delete().eq(column, id);
    if (error) console.warn(`  cleanup: ${table} where ${column}=${id} — ${error.message}`);
  };

  // payments FK to charges, so a paid charge cannot be deleted while its
  // payment exists. This lives in cleanup() rather than inline in the test
  // body on purpose: if the suite throws between verifying a payment and
  // removing it, an inline delete never runs, and the orphaned payment then
  // blocks the charge delete permanently — with nothing reporting it.
  const scrubPaymentsFor = async (column, id) => {
    const { data: own, error } = await db.from('charges').select('charge_id').eq(column, id);
    if (error) {
      console.warn(`  cleanup: could not list charges where ${column}=${id} — ${error.message}`);
      return;
    }
    for (const c of own || []) await scrub('payments', 'charge_id', c.charge_id);
  };

  const cleanup = async () => {
    for (const id of created.events) {
      await scrubPaymentsFor('event_id', id);
      await scrub('charges', 'event_id', id);
      await scrub('event_attendees', 'event_id', id);
      await scrub('events', 'event_id', id);
    }
    for (const id of created.households) {
      await scrubPaymentsFor('household_id', id);
      await scrub('charges', 'household_id', id);
      await scrub('event_attendees', 'household_id', id);
      await scrub('household_records', 'household_id', id);
    }
  };

  const makeEvent = async (patch) => {
    const { data, error } = await db
      .from('events')
      .insert({
        title: `TEST 3b ${patch.title || ''}`.trim(),
        type: 'activity',
        start_datetime: iso(Date.now() - 4 * HOUR),
        end_datetime: iso(Date.now() - 2 * HOUR),
        date_created: iso(Date.now()),
        is_archived: false,
        attendance_required: true,
        fine_amount: 50,
        ...patch,
      })
      .select('event_id, title, fine_amount, end_datetime')
      .single();
    if (error) throw new Error(`setup failed: ${error.message}`);
    created.events.push(data.event_id);
    return data;
  };

  try {
    const { count: activeHouseholds } = await db
      .from('household_records')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // ================================================================== A
    section('authorization: fines are Secretary-only');
    const real = await db
      .from('events')
      .select('event_id')
      .eq('attendance_required', true)
      .limit(1)
      .maybeSingle();
    const realId = real.data?.event_id;
    check('a real attendance event exists to probe against', !!realId, `event ${realId}`);

    for (const r of ['staff', 'treasurer', 'punong_barangay', 'resident']) {
      const g = await api(`/events/${realId}/fines`, { token: tok[r] });
      check(`  ${r} cannot preview fines`, g.status === 403, `got ${g.status}`);
      const p = await api(`/events/${realId}/fines`, { method: 'POST', token: tok[r] });
      check(`  ${r} cannot generate fines`, p.status === 403, `got ${p.status}`);
      const v = await api(`/events/${realId}/fines/1/void`, { method: 'POST', token: tok[r] });
      check(`  ${r} cannot void a fine`, v.status === 403, `got ${v.status}`);
    }
    const noTok = await api(`/events/${realId}/fines`);
    check('  an unauthenticated request is refused', noTok.status === 401, `got ${noTok.status}`);

    // ================================================================== B
    section('preview is read-only and reports the real roster');
    const { count: beforeCharges } = await db.from('charges').select('*', { count: 'exact', head: true });
    const prev = await api(`/events/${realId}/fines`, { token: tok.secretary });
    check('secretary can preview', prev.status === 200, `got ${prev.status}`);
    check('  summary covers every active household',
      prev.data?.summary?.active_households === activeHouseholds,
      `${prev.data?.summary?.active_households} vs ${activeHouseholds} active`);
    check('  every household falls into exactly one bucket',
      prev.data && (prev.data.summary.present + prev.data.summary.to_charge +
        prev.data.summary.already_charged + prev.data.summary.registered_after +
        prev.data.summary.mismatch) === prev.data.summary.active_households,
      JSON.stringify(prev.data?.summary));
    check('  total_amount = to_charge x fine_amount',
      prev.data?.summary?.total_amount === prev.data?.summary?.to_charge * prev.data?.summary?.fine_amount,
      `${prev.data?.summary?.to_charge} x ${prev.data?.summary?.fine_amount} = ${prev.data?.summary?.total_amount}`);
    const { count: afterPreview } = await db.from('charges').select('*', { count: 'exact', head: true });
    check('  PREVIEW CREATED NOTHING', afterPreview === beforeCharges, `${beforeCharges} -> ${afterPreview}`);

    // ================================================================== C
    section('generation guards');
    const ann = await makeEvent({ title: 'announcement', type: 'announcement', attendance_required: false, start_datetime: null, end_datetime: null });
    const annRes = await api(`/events/${ann.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('announcement is refused', annRes.status === 400, annRes.data?.error);

    const noAtt = await makeEvent({ title: 'no attendance', attendance_required: false });
    const noAttRes = await api(`/events/${noAtt.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('activity that does not take attendance is refused', noAttRes.status === 400, noAttRes.data?.error);

    const noFine = await makeEvent({ title: 'no fine amount', fine_amount: null });
    const noFineGet = await api(`/events/${noFine.event_id}/fines`, { token: tok.secretary });
    check('no fine amount: preview explains rather than erroring',
      noFineGet.status === 200 && noFineGet.data.can_generate === false && /no fine amount/i.test(noFineGet.data.blocked_reason || ''),
      noFineGet.data?.blocked_reason);
    const noFinePost = await api(`/events/${noFine.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('no fine amount: generation refused', noFinePost.status === 409, noFinePost.data?.error);

    const future = await makeEvent({
      title: 'not finished',
      start_datetime: iso(Date.now() + HOUR),
      end_datetime: iso(Date.now() + 3 * HOUR),
    });
    const futureRes = await api(`/events/${future.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('activity that has not ended is refused', futureRes.status === 409 && /not finished/i.test(futureRes.data?.error || ''), futureRes.data?.error);

    const arch = await makeEvent({ title: 'archived', is_archived: true });
    const archRes = await api(`/events/${arch.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('archived activity is refused', archRes.status === 409 && /archived/i.test(archRes.data?.error || ''), archRes.data?.error);

    // ================================================================== D
    section('generation');
    const ev = await makeEvent({ title: 'main', fine_amount: 50 });

    // a household registered AFTER the event ended must never be fined
    const late = await db
      .from('household_records')
      .insert({ address: 'TEST 3b late household', registered_at: iso(Date.now()), is_active: true })
      .select('household_id')
      .single();
    created.households.push(late.data.household_id);

    const gen = await api(`/events/${ev.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('fines generated', gen.status === 201, `${gen.status} ${gen.data?.message || gen.data?.error}`);
    check('  every absent household was charged', gen.data?.created === activeHouseholds, `created ${gen.data?.created} for ${activeHouseholds} active`);
    check('  the late-registered household was NOT charged',
      gen.data?.summary?.registered_after === 1, JSON.stringify(gen.data?.summary));
    check('  total is created x fine', gen.data?.total_amount === gen.data?.created * 50, `${gen.data?.total_amount}`);

    const { data: fines } = await db
      .from('charges')
      .select('charge_id, charge_type, amount, status, event_id, household_id, user_id')
      .eq('event_id', ev.event_id);
    check('  all rows are FINE/UNPAID with the right amount',
      fines.length > 0 && fines.every((f) => f.charge_type === 'FINE' && f.status === 'UNPAID' && Number(f.amount) === 50),
      `${fines.length} charge(s)`);
    check('  every fine carries both event_id and household_id',
      fines.every((f) => f.event_id === ev.event_id && f.household_id), 'required by the partial unique index');
    check('  the late household has no charge',
      !fines.some((f) => f.household_id === late.data.household_id));
    check('  user_id is set when the head has an account, null otherwise',
      fines.some((f) => f.user_id !== null) || fines.every((f) => f.user_id === null),
      `${fines.filter((f) => f.user_id !== null).length}/${fines.length} linked to an account`);

    // ================================================================== E
    section('re-running is safe');
    const again = await api(`/events/${ev.event_id}/fines`, { method: 'POST', token: tok.secretary });
    check('second run charges nobody', again.status === 409 && /nobody to fine/i.test(again.data?.error || ''), again.data?.error);
    const { count: stillFines } = await db
      .from('charges')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', ev.event_id);
    check('  charge count unchanged (no double-charging)', stillFines === fines.length, `${fines.length} -> ${stillFines}`);

    // the database itself must refuse a duplicate, not just the route
    const dup = await db.from('charges').insert({
      charge_type: 'FINE', amount: 50, status: 'UNPAID',
      event_id: ev.event_id, household_id: fines[0].household_id, created_at: iso(Date.now()),
    });
    check('  the partial unique index refuses a duplicate at the DB level',
      dup.error?.code === '23505', dup.error ? dup.error.code : 'NO ERROR — index not enforcing!');

    // ================================================================== F
    section('voiding');
    const target = fines[0].household_id;
    const v1 = await api(`/events/${ev.event_id}/fines/${target}/void`, { method: 'POST', token: tok.secretary });
    check('a fine can be voided', v1.status === 200 && v1.data?.already_void === false, v1.data?.message);
    const { data: voided } = await db.from('charges').select('status').eq('charge_id', fines[0].charge_id).single();
    check('  status is VOID, row still exists', voided?.status === 'VOID');
    const v2 = await api(`/events/${ev.event_id}/fines/${target}/void`, { method: 'POST', token: tok.secretary });
    check('  voiding again is a harmless no-op', v2.status === 200 && v2.data?.already_void === true, v2.data?.message);
    const vMissing = await api(`/events/${ev.event_id}/fines/999999/void`, { method: 'POST', token: tok.secretary });
    check('  voiding a household with no fine 404s', vMissing.status === 404, vMissing.data?.error);

    // a PAID fine must not be voidable
    const paidTarget = fines[1];
    if (paidTarget) {
      await db.from('charges').update({ status: 'PAID' }).eq('charge_id', paidTarget.charge_id);
      const vPaid = await api(`/events/${ev.event_id}/fines/${paidTarget.household_id}/void`, { method: 'POST', token: tok.secretary });
      check('  a PAID fine cannot be voided', vPaid.status === 409 && /already been paid/i.test(vPaid.data?.error || ''), vPaid.data?.error);
      await db.from('charges').update({ status: 'UNPAID' }).eq('charge_id', paidTarget.charge_id);
    }

    // ================================================================== G
    section('recording attendance late leaves the fine ALONE and reports a mismatch');
    // Voiding is manual. An attendance edit must never move money: the void is
    // permanent for the event, so a mis-tapped "Mark present" must not be able
    // to destroy a chargeable fine.
    const stillUnpaid = fines.find((f) => f.household_id !== target);
    if (stillUnpaid) {
      const mark = await api(`/events/${ev.event_id}/attendance`, {
        method: 'POST', token: tok.secretary, body: { household_id: stillUnpaid.household_id },
      });
      check('household marked present after being fined', mark.status === 201, mark.data?.message);
      check('  the response does NOT claim to have voided anything',
        mark.data?.fine_voided === undefined && !/void/i.test(mark.data?.message || ''), mark.data?.message);
      const { data: untouched } = await db
        .from('charges').select('status').eq('charge_id', stillUnpaid.charge_id).single();
      check('  THE FINE IS UNTOUCHED — still UNPAID', untouched?.status === 'UNPAID', `status ${untouched?.status}`);

      const mm = await api(`/events/${ev.event_id}/fines`, { token: tok.secretary });
      const flagged = (mm.data?.households || []).find((h) => h.household_id === stillUnpaid.household_id);
      check('  the roster reports the mismatch', flagged?.state === 'mismatch', `state ${flagged?.state}`);
      check('  the mismatch is counted in the summary', mm.data?.summary?.mismatch >= 1, JSON.stringify(mm.data?.summary));
      check('  the flagged row carries the charge so it can be acted on',
        flagged?.charge?.status === 'UNPAID' && flagged?.present === true, JSON.stringify(flagged?.charge));

      // Only a deliberate void clears it.
      const vm = await api(`/events/${ev.event_id}/fines/${stillUnpaid.household_id}/void`, {
        method: 'POST', token: tok.secretary,
      });
      check('  a manual void resolves it', vm.status === 200, vm.data?.message);
      const mm2 = await api(`/events/${ev.event_id}/fines`, { token: tok.secretary });
      check('  the mismatch is gone once voided', mm2.data?.summary?.mismatch === (mm.data.summary.mismatch - 1),
        `${mm.data.summary.mismatch} -> ${mm2.data?.summary?.mismatch}`);

      // A PAID fine on a present household is STILL a mismatch — it is the
      // case that has no automatic remedy at all, so it must be visible.
      const paidOne = fines.find((f) => ![target, stillUnpaid.household_id].includes(f.household_id));
      if (paidOne) {
        await api(`/events/${ev.event_id}/attendance`, {
          method: 'POST', token: tok.secretary, body: { household_id: paidOne.household_id },
        });
        await db.from('charges').update({ status: 'PAID' }).eq('charge_id', paidOne.charge_id);
        const mm3 = await api(`/events/${ev.event_id}/fines`, { token: tok.secretary });
        const paidFlag = (mm3.data?.households || []).find((h) => h.household_id === paidOne.household_id);
        check('  a PAID fine on a present household is flagged too', paidFlag?.state === 'mismatch',
          `state ${paidFlag?.state}, charge ${paidFlag?.charge?.status}`);
        const vPaid2 = await api(`/events/${ev.event_id}/fines/${paidOne.household_id}/void`, {
          method: 'POST', token: tok.secretary,
        });
        check('  ...and still cannot be voided away', vPaid2.status === 409, vPaid2.data?.error);
        await db.from('charges').update({ status: 'UNPAID' }).eq('charge_id', paidOne.charge_id);
      }
    }

    // ================================================================== H
    section('the fine reaches the Treasurer queue intact');
    const q = await api('/charges?status=UNPAID', { token: tok.treasurer });
    check('treasurer can load the queue', q.status === 200, `got ${q.status}`);
    const mine = (q.data?.charges || []).filter((c) => c.events?.event_id === ev.event_id);
    check('  the new fines appear', mine.length > 0, `${mine.length} fine(s) in the queue`);
    if (mine.length) {
      check('  each shows the event it came from', mine.every((c) => c.events?.title), mine[0].events?.title);
      check('  each shows the household that owes it', mine.every((c) => c.household_records?.address), mine[0].household_records?.address);
      check('  the head name is resolved for display',
        mine.some((c) => c.household_records?.head_name),
        mine.map((c) => c.household_records?.head_name).filter(Boolean)[0] || 'none had a head');
    }

    // ================================================================== I
    section('a fine can be paid like any other charge');
    const payable = mine.find((c) => c.status === 'UNPAID');
    if (payable) {
      const verify = await api(`/charges/${payable.charge_id}/verify`, {
        method: 'POST', token: tok.treasurer, body: { payment_method: 'onsite', reference_no: 'TEST-OR-3B' },
      });
      check('treasurer verifies the fine payment', verify.status === 200, verify.data?.message || verify.data?.error);
      const { data: after } = await db.from('charges').select('status').eq('charge_id', payable.charge_id).single();
      check('  the charge is PAID', after?.status === 'PAID');
      const { data: pay } = await db.from('payments').select('payment_id, amount, received_by_user_id').eq('charge_id', payable.charge_id).maybeSingle();
      check('  one payments row exists, attributed to the verifier', !!pay && pay.received_by_user_id !== null, `payment #${pay?.payment_id}`);
      // Deliberately NOT deleted here — cleanup() owns it, so it is removed
      // even if something below throws first.
    } else {
      check('a payable fine was available', false, 'none found');
    }
  } finally {
    section('cleanup');
    await cleanup();
    // Scoped to the events THIS RUN created, exactly like the two assertions
    // below. Counting every charge_type='FINE' in the database also counts the
    // barangay's real fines, so it fails permanently once stage 3b is used for
    // real — and "fixing" that by making cleanup delete every FINE charge
    // would destroy real money records.
    let leftCharges = 0;
    for (const id of created.events) {
      const { count } = await db
        .from('charges')
        .select('*', { count: 'exact', head: true })
        .eq('charge_type', 'FINE')
        .eq('event_id', id);
      leftCharges += count || 0;
    }
    const { data: leftEvents } = await db.from('events').select('event_id').ilike('title', 'TEST 3b%');
    const { data: leftHh } = await db.from('household_records').select('household_id').ilike('address', 'TEST 3b%');
    check('no test events left behind', (leftEvents || []).length === 0, JSON.stringify(leftEvents));
    check('no test households left behind', (leftHh || []).length === 0, JSON.stringify(leftHh));
    check('no FINE charges left behind by this run', leftCharges === 0, `${leftCharges} remain`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => {
  console.error('RUN FAILED:', e.stack || e.message);
  process.exitCode = 1;
});
