// ===========================================================================
// NOTIFICATIONS — service, failure isolation, and message encoding.
//
//   cd backend && npm run notif:test
//
// No server is started, no port is opened, and NOTHING IS SENT ANYWHERE:
// SMS_MODE is forced to SIMULATED for the run. Route handlers are invoked
// directly with a mock req/res, so the real code paths execute against the
// live database.
//
// The centrepiece is section C: the notification layer is forced to fail
// outright, and the approval it hangs off must still return 200 with its
// charge intact. That is the whole safety claim of this module, and it is
// worth nothing unless it is actually exercised.
// ===========================================================================
const path = require('path');
const fs = require('fs');

process.env.SMS_MODE = 'SIMULATED'; // belt and braces — never send from a test

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const supabase = require('../src/config/supabase');
const { notify, notifyMany, isGsmSafe, smsSegments, currentMode } = require('../src/services/notifications');
const { NOTIFICATION_STATUS, RELATED_TYPE } = require('../src/constants/notifications');

const docRouter = require('../src/routes/documentRequests');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

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
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  const created = { requests: [], notifications: [] };

  const cleanup = async () => {
    for (const id of created.requests) {
      await supabase.from('notifications').delete().eq('related_type', RELATED_TYPE.DOCUMENT_REQUEST).eq('related_to', id);
      await supabase.from('charges').delete().eq('document_request_id', id);
      await supabase.from('document_requests').delete().eq('request_id', id);
    }
    if (created.notifications.length) {
      await supabase.from('notifications').delete().in('notification_id', created.notifications);
    }
  };

  try {
    check('the run is in SIMULATED mode', currentMode() === 'SIMULATED', currentMode());

    // ================================================================== A
    section('A. the service records what it composes');
    const before = await countNotifications();

    const res1 = await notify({
      userId: null,
      destination: '09171234567',
      message: 'BrgyServe: test-harness message, nothing was sent.',
      relatedType: RELATED_TYPE.CHARGE,
      relatedTo: 999999999,
    });
    check('notify() reports SIMULATED, not SENT', res1.status === NOTIFICATION_STATUS.SIMULATED, res1.status);
    check('  and does NOT claim success', res1.ok === false, `ok=${res1.ok}`);

    const { data: row } = await supabase
      .from('notifications').select('*')
      .eq('related_to', 999999999).eq('related_type', RELATED_TYPE.CHARGE)
      .order('notification_id', { ascending: false }).limit(1).maybeSingle();
    check('a row was written', !!row);
    if (row) created.notifications.push(row.notification_id);
    check('  destination recorded', row?.destination === '09171234567', row?.destination);
    check('  status is SIMULATED', row?.status === NOTIFICATION_STATUS.SIMULATED, row?.status);
    check('  sent_at is NULL — nothing was sent, so there is no send time',
      row?.sent_at === null, String(row?.sent_at));
    check('  provider_response says so plainly', /simulated/i.test(row?.provider_response || ''), row?.provider_response);
    check('  it points back at what caused it',
      row?.related_type === RELATED_TYPE.CHARGE && row?.related_to === 999999999);

    // ================================================================== B
    section('B. no contact number is recorded, not silently dropped');
    const res2 = await notify({
      destination: null,
      message: 'BrgyServe: unreachable-resident test.',
      relatedType: RELATED_TYPE.CHARGE,
      relatedTo: 999999998,
    });
    check('notify() reports SKIPPED', res2.status === NOTIFICATION_STATUS.SKIPPED, res2.status);
    const { data: skipped } = await supabase
      .from('notifications').select('*')
      .eq('related_to', 999999998).order('notification_id', { ascending: false }).limit(1).maybeSingle();
    check('  a row still exists for it', !!skipped);
    if (skipped) created.notifications.push(skipped.notification_id);
    check('  with an empty destination (the column is NOT NULL)', skipped?.destination === '', JSON.stringify(skipped?.destination));
    check('  and a reason on the row', /no contact number/i.test(skipped?.provider_response || ''), skipped?.provider_response);

    const afterAB = await countNotifications();
    check('exactly two rows were added', afterAB - before === 2, `${before} -> ${afterAB}`);

    // ================================================================== C
    section('C. FAILURE ISOLATION — the one that matters');

    // Find a resident with a linked account and a document type, then create
    // a pending request to approve.
    const { data: docType } = await supabase
      .from('document_types').select('document_type_id, name, fee').eq('is_active', true).limit(1).single();
    const { data: profile } = await supabase
      .from('profiles').select('user_id, resident_id').not('resident_id', 'is', null).limit(1).single();
    const { data: secretary } = await supabase
      .from('users').select('user_id, role').eq('role', 'secretary').eq('is_active', true).limit(1).single();
    check('found the fixtures needed to approve a request',
      !!docType && !!profile && !!secretary,
      `type ${docType?.name}, resident ${profile?.resident_id}, secretary ${secretary?.user_id}`);

    const { data: request, error: reqErr } = await supabase
      .from('document_requests')
      .insert({
        document_type_id: docType.document_type_id,
        resident_id: profile.resident_id,
        requested_by_user_id: profile.user_id,
        purpose: 'NOTIF TEST — failure isolation',
        status: 'pending',
        requested_at: new Date().toISOString(),
      })
      .select('request_id')
      .single();
    if (reqErr) throw new Error(`setup failed: ${reqErr.message}`);
    created.requests.push(request.request_id);

    // Break the notifications table for the duration of the approval. Every
    // other table keeps working, so only the notification layer is impaired.
    const realFrom = supabase.from.bind(supabase);
    let sabotaged = 0;
    supabase.from = (table) => {
      if (table === 'notifications') {
        sabotaged += 1;
        throw new Error('FORCED FAILURE — notifications table is unavailable');
      }
      return realFrom(table);
    };

    let approve;
    try {
      approve = await invoke(handlerFor(docRouter, 'post', '/:id/approve'), {
        user: secretary,
        params: { id: String(request.request_id) },
        body: {},
      });
    } finally {
      supabase.from = realFrom; // always restore, even if the call threw
    }

    check('the notification layer really was made to fail', sabotaged > 0, `${sabotaged} attempt(s) blocked`);
    check('THE APPROVAL STILL RETURNS 200', approve.status === 200, `got ${approve.status}`);
    check('  the response is the normal success payload',
      /approved/i.test(approve.body?.message || ''), approve.body?.message || approve.body?.error);

    const { data: afterApproval } = await supabase
      .from('document_requests').select('status').eq('request_id', request.request_id).single();
    check('  THE REQUEST IS STILL APPROVED', afterApproval?.status === 'approved', afterApproval?.status);

    const { data: charge } = await supabase
      .from('charges').select('charge_id, status, amount').eq('document_request_id', request.request_id).maybeSingle();
    check('  THE CHARGE STILL EXISTS', !!charge, charge ? `charge ${charge.charge_id}` : 'MISSING');
    check('  and was not rolled back', charge?.status === 'PAID' || charge?.status === 'UNPAID', charge?.status);

    const { count: noneWritten } = await supabase
      .from('notifications').select('*', { count: 'exact', head: true })
      .eq('related_type', RELATED_TYPE.DOCUMENT_REQUEST).eq('related_to', request.request_id);
    check('  and no notification row was written (the failure was real)', noneWritten === 0, `${noneWritten}`);

    // ================================================================== D
    section('D. the same approval path records normally when nothing is broken');
    const { data: request2 } = await supabase
      .from('document_requests')
      .insert({
        document_type_id: docType.document_type_id,
        resident_id: profile.resident_id,
        requested_by_user_id: profile.user_id,
        purpose: 'NOTIF TEST — happy path',
        status: 'pending',
        requested_at: new Date().toISOString(),
      })
      .select('request_id')
      .single();
    created.requests.push(request2.request_id);

    const ok = await invoke(handlerFor(docRouter, 'post', '/:id/approve'), {
      user: secretary, params: { id: String(request2.request_id) }, body: {},
    });
    check('the approval succeeds', ok.status === 200, `${ok.status}`);
    const { data: notifRow } = await supabase
      .from('notifications').select('*')
      .eq('related_type', RELATED_TYPE.DOCUMENT_REQUEST).eq('related_to', request2.request_id).maybeSingle();
    check('  a notification row was recorded this time', !!notifRow);
    check('  addressed to the requester', notifRow?.user_id === profile.user_id, String(notifRow?.user_id));
    check('  status SIMULATED or SKIPPED, never SENT',
      [NOTIFICATION_STATUS.SIMULATED, NOTIFICATION_STATUS.SKIPPED].includes(notifRow?.status), notifRow?.status);

    // ================================================================== E
    section('E. batch send is one insert, and never throws');
    const batch = await notifyMany([
      { destination: '09171234567', message: 'BrgyServe: batch one.', relatedType: RELATED_TYPE.EVENT, relatedTo: 999999997 },
      { destination: null, message: 'BrgyServe: batch two, unreachable.', relatedType: RELATED_TYPE.EVENT, relatedTo: 999999997 },
    ]);
    check('notifyMany reports both rows', batch.written === 2, JSON.stringify(batch));
    const { data: batchRows } = await supabase
      .from('notifications').select('notification_id, status').eq('related_to', 999999997);
    check('  both were written', batchRows?.length === 2, `${batchRows?.length}`);
    check('  one SIMULATED and one SKIPPED',
      new Set(batchRows?.map((r) => r.status)).size === 2,
      batchRows?.map((r) => r.status).join(','));
    (batchRows || []).forEach((r) => created.notifications.push(r.notification_id));

    const brokenAgain = supabase.from.bind(supabase);
    supabase.from = (t) => { if (t === 'notifications') throw new Error('forced'); return brokenAgain(t); };
    const batchFail = await notifyMany([{ destination: '09171234567', message: 'x', relatedType: RELATED_TYPE.EVENT, relatedTo: 1 }]);
    supabase.from = brokenAgain;
    check('a broken batch returns instead of throwing', batchFail.ok === false && !!batchFail.error, JSON.stringify(batchFail));

    // ================================================================== F
    section('F. message encoding — every template must fit one SMS segment');
    const ROUTES = ['documentRequests', 'charges', 'payments', 'rentalRequests', 'events'];
    const offenders = [];
    for (const name of ROUTES) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', `${name}.js`), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!line.includes('BrgyServe:')) return;
        for (const ch of ['₱', '—', '×']) {
          if (line.includes(ch)) offenders.push(`${name}.js:${i + 1} contains ${JSON.stringify(ch)}`);
        }
      });
    }
    check('no message template contains a peso sign, em dash or multiplication sign',
      offenders.length === 0, offenders.join(' | '));

    const samples = [
      'BrgyServe: your Barangay Clearance request has been APPROVED. Please settle the PHP 50.00 fee at the barangay hall (cash) or via GCash to proceed.',
      'BrgyServe: your payment of PHP 50.00 for the Barangay Clearance request has been received and verified. Please wait for the release notice.',
      'BrgyServe: your household was not recorded at "General Assembly". A fine of PHP 100.00 is now due. Please settle it at the Barangay Office.',
      'BrgyServe: your booking is CONFIRMED - 20x Monobloc Chair on 15 Aug 2026, 8:00 AM to 5:00 PM.',
    ];
    samples.forEach((s, i) => {
      check(`  sample ${i + 1} is GSM-encodable and one segment`,
        isGsmSafe(s) && smsSegments(s) === 1, `${s.length} chars, ${smsSegments(s)} segment(s)`);
    });
  } catch (err) {
    console.error('\nERROR:', err.stack || err.message);
    failures++;
  } finally {
    section('cleanup');
    await cleanup();
    const { count: leftovers } = await supabase
      .from('notifications').select('*', { count: 'exact', head: true })
      .in('related_to', [999999999, 999999998, 999999997]);
    check('every test notification was removed', leftovers === 0, `${leftovers} left`);
    const { count: leftReqs } = await supabase
      .from('document_requests').select('*', { count: 'exact', head: true }).ilike('purpose', 'NOTIF TEST%');
    check('every test document request was removed', leftReqs === 0, `${leftReqs} left`);
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})();

async function countNotifications() {
  const { count } = await supabase.from('notifications').select('*', { count: 'exact', head: true });
  return count || 0;
}
