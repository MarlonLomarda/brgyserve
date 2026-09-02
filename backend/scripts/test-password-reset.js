// ===========================================================================
// PASSWORD RESET — the redaction split, the neutral response, and the token.
//
//   cd backend && npm run reset:test
//
// No server is started, no port is opened, and NOTHING IS SENT ANYWHERE:
// EMAIL_MODE is forced to SIMULATED for the run, so the Resend adapter is
// never reached. Route handlers are invoked directly with a mock req/res, so
// the real code paths execute against the live database.
//
// THE CENTREPIECE IS SECTION A. It is the only section that needs no database
// and no migration: the notifications insert is stubbed and the composed row
// captured in memory. It asserts two things together, and BOTH are needed —
//
//   * no reset URL, and no `token=`, reaches notifications.message; and
//   * a row was nonetheless recorded successfully.
//
// The second assertion is what gives the first one teeth. Drop the logMessage
// argument in routes/auth.js and the service's backstop refuses the write, so
// "no URL in the column" would still hold while the notification silently
// stopped being recorded at all. Verified against a copy of the service with
// that backstop disabled — the pre-split behaviour — where the raw link lands
// in the column in full.
//
// Why it matters: /secretary/notifications renders notifications.message on
// screen. A reset link stored there is a working password-reset URL for
// another person's account, readable by every Secretary.
//
// SECTIONS B ONWARDS NEED MIGRATION 020. They are skipped with a clear
// message if password_resets does not exist, rather than failing as if the
// code were broken.
// ===========================================================================
const path = require('path');

process.env.EMAIL_MODE = 'SIMULATED'; // belt and braces — never send from a test
process.env.SMS_MODE = 'SIMULATED';

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const bcrypt = require('bcryptjs');
const supabase = require('../src/config/supabase');
const { notify } = require('../src/services/notifications');
const { NOTIFICATION_TYPE, NOTIFICATION_STATUS, RELATED_TYPE } = require('../src/constants/notifications');
const {
  TOKEN_TTL_MINUTES,
  REQUEST_COOLDOWN_MINUTES,
  generateToken,
  hashToken,
  FORGOT_PASSWORD_RESPONSE,
  resetEmail,
  resetLogMessage,
} = require('../src/constants/passwordReset');

const authRouter = require('../src/routes/auth');

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

function invoke(handler, { params = {}, body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { params, body, query };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const forgot = handlerFor(authRouter, 'post', '/forgot-password');
const reset = handlerFor(authRouter, 'post', '/reset-password');

// Unique enough that a crashed run cannot collide with the next one.
const STAMP = `rst${Date.now().toString(36)}`;
const created = { users: [], resets: [] };

// Thrown to abandon sections B onwards when migration 020 is not applied. It
// unwinds through the same catch/finally/exit the normal run uses, rather than
// calling process.exit() mid-flight — doing that immediately after a Supabase
// request aborts the Node process on Windows with a libuv handle assertion,
// which turned a clean section-A pass into exit code 127.
const SKIP_REST = Symbol('migration 020 not applied');
let skipReason = '';

(async () => {
  try {
    // ================================================================== A
    // OFFLINE. No database, no migration, no writes.
    section('A. THE REDACTION SPLIT — the one that matters');

    const captured = [];
    const realFrom = supabase.from.bind(supabase);
    supabase.from = (table) =>
      (table === 'notifications'
        ? { insert: async (rows) => { captured.push(...rows); return { error: null }; } }
        : realFrom(table));

    const probeToken = generateToken();
    const probeUrl = `http://localhost:5173/reset-password?token=${probeToken}`;
    const mail = resetEmail({ name: 'Test', url: probeUrl });

    check('the SENT message really does carry the link',
      mail.text.includes(probeToken) && mail.text.includes('/reset-password'),
      'otherwise every assertion below is vacuous');

    const split = await notify({
      type: NOTIFICATION_TYPE.EMAIL,
      userId: null,
      destination: 'reset-test@example.invalid',
      subject: mail.subject,
      message: mail.text,
      logMessage: resetLogMessage(),
      relatedType: RELATED_TYPE.ACCOUNT,
      relatedTo: 0,
    });
    supabase.from = realFrom;

    const row = captured[0];
    // BOTH of these, together. See the header: the safety assertion alone
    // would still pass if the notification stopped being written entirely.
    check('A ROW WAS RECORDED', captured.length === 1 && !!row, `${captured.length} row(s)`);
    check('  and it was recorded successfully, not FAILED',
      split.status === NOTIFICATION_STATUS.SIMULATED, `${split.status}${split.error ? ` (${split.error})` : ''}`);
    check('  THE RAW TOKEN IS NOT IN notifications.message',
      !String(row?.message).includes(probeToken));
    check('  the reset PATH is not in it either',
      !String(row?.message).includes('/reset-password'));
    check('  and nothing in it looks like a token query parameter',
      !/[?&]token=/i.test(String(row?.message || '')));
    check('  the subject was stored (varchar(255))',
      row?.subject === mail.subject, JSON.stringify(row?.subject));
    check('  the type is EMAIL', row?.type === NOTIFICATION_TYPE.EMAIL, row?.type);
    check('  it points back at the account', row?.related_type === RELATED_TYPE.ACCOUNT, row?.related_type);
    check('  and the recorded text still explains what happened',
      /link/i.test(String(row?.message)) && /not recorded/i.test(String(row?.message)),
      JSON.stringify(row?.message));

    // The backstop that catches a FUTURE link-bearing message written without
    // the split. It must refuse the write rather than record a live token.
    const captured2 = [];
    supabase.from = (table) =>
      (table === 'notifications'
        ? { insert: async (rows) => { captured2.push(...rows); return { error: null }; } }
        : realFrom(table));
    const unsplit = await notify({
      type: NOTIFICATION_TYPE.EMAIL,
      destination: 'reset-test@example.invalid',
      subject: mail.subject,
      message: mail.text, // no logMessage — the mistake this guards
      relatedType: RELATED_TYPE.ACCOUNT,
      relatedTo: 0,
    });
    supabase.from = realFrom;
    check('a link-bearing message with NO logMessage is refused, not recorded',
      captured2.length === 0 && unsplit.status === NOTIFICATION_STATUS.FAILED,
      `${captured2.length} row(s), status ${unsplit.status}`);
    check('  and notify() still did not throw', typeof unsplit.ok === 'boolean');

    // ================================================================== B
    section('B. does migration 020 exist?');
    // Deliberately NOT a head/count probe: with head: true a missing table
    // comes back as a bodyless 404 that supabase-js reports as error null and
    // count null, so the probe passed and the run then failed four sections
    // later on the first insert. A real (bounded) select surfaces the error.
    const { error: tableError } = await supabase
      .from('password_resets').select('reset_id').limit(1);
    if (tableError) {
      skipReason = tableError.message;
      throw SKIP_REST;
    }
    check('password_resets exists', true);

    // ---- fixtures: throwaway accounts, deleted at the end ----------------
    const { data: anySecretary } = await supabase
      .from('users').select('user_id').eq('role', 'secretary').limit(1).single();

    const mkUser = async (suffix, over = {}) => {
      const { data, error } = await supabase
        .from('users')
        .insert({
          username: `${STAMP}_${suffix}`,
          password_hash: await bcrypt.hash('OriginalPass123', 10),
          email: `${STAMP}.${suffix}@example.invalid`,
          email_verified: false,
          role: 'resident',
          must_change_password: false,
          is_active: true,
          ...over,
        })
        .select('user_id, username, email, password_hash')
        .single();
      if (error) throw new Error(`fixture ${suffix} failed: ${error.message}`);
      created.users.push(data.user_id);
      await supabase.from('profiles').insert({
        user_id: data.user_id, first_name: 'Reset', last_name: 'Fixture', address: 'Test',
      });
      return data;
    };

    const active = await mkUser('active');
    const pending = await mkUser('pending', { is_active: false });
    const rejected = await mkUser('rejected', {
      is_active: false,
      is_rejected: true,
      rejection_reason: 'NOT_IN_MASTERLIST',
      rejected_at: new Date().toISOString(),
      rejected_by_user_id: anySecretary.user_id,
    });
    const staff = await mkUser('staff', { role: 'staff' });
    check('four throwaway fixtures created', created.users.length === 4, created.users.join(', '));

    // ================================================================== C
    section('C. the response is byte-identical on every path');
    const pinned = JSON.stringify(FORGOT_PASSWORD_RESPONSE);
    const branches = [
      ['an ACTIVE resident', active.email],
      ['an unknown address', `${STAMP}.nobody@example.invalid`],
      ['a PENDING account', pending.email],
      ['a REJECTED account', rejected.email],
      ['a STAFF account', staff.email],
      ['a wildcard probe', '%@example.invalid'],
      ['the same address in a different case', active.email.toUpperCase()],
    ];
    for (const [label, email] of branches) {
      const r = await invoke(forgot, { body: { email } });
      check(`${label}: 200 and the pinned body`,
        r.status === 200 && JSON.stringify(r.body) === pinned,
        `${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
    }
    const missing = await invoke(forgot, { body: {} });
    check('a missing email field is a 400 about the request shape, not the address',
      missing.status === 400 && /required/i.test(missing.body?.error || ''), missing.body?.error);

    section('C2. only the eligible account actually got a token');
    const rowsFor = async (userId) => {
      const { data } = await supabase
        .from('password_resets').select('reset_id, token_hash, expires_at, used_at, created_at')
        .eq('user_id', userId).order('reset_id');
      (data || []).forEach((r) => created.resets.push(r.reset_id));
      return data || [];
    };
    const activeRows = await rowsFor(active.user_id);
    check('the active resident has exactly ONE reset row', activeRows.length === 1, `${activeRows.length}`);
    for (const [label, u] of [['pending', pending], ['rejected', rejected], ['staff', staff]]) {
      check(`  the ${label} account has none`, (await rowsFor(u.user_id)).length === 0);
    }
    check('  the stored value is a 64-char hex digest, not the raw token',
      /^[0-9a-f]{64}$/.test(activeRows[0]?.token_hash || ''), activeRows[0]?.token_hash?.slice(0, 12) + '...');
    const ttlMin = Math.round(
      (new Date(activeRows[0].expires_at) - new Date(activeRows[0].created_at)) / 60000);
    check(`  it expires in about ${TOKEN_TTL_MINUTES} minutes`,
      Math.abs(ttlMin - TOKEN_TTL_MINUTES) <= 1, `${ttlMin} min`);

    section('C3. nothing was sent, and the recorded row is redacted');
    const { data: notif } = await supabase
      .from('notifications').select('*')
      .eq('related_type', RELATED_TYPE.ACCOUNT).eq('related_to', active.user_id)
      .order('notification_id', { ascending: false }).limit(1).maybeSingle();
    check('a notification row exists for the request', !!notif);
    check('  status SIMULATED, never SENT (EMAIL_MODE is SIMULATED here)',
      notif?.status === NOTIFICATION_STATUS.SIMULATED, notif?.status);
    check('  sent_at is null', notif?.sent_at === null, String(notif?.sent_at));
    check('  addressed to the account email', notif?.destination === active.email, notif?.destination);
    check('  A RESET URL IS NOT IN THE MESSAGE COLUMN',
      !/[?&]token=/i.test(notif?.message || '') && !String(notif?.message).includes('/reset-password'),
      JSON.stringify(String(notif?.message).slice(0, 80)));

    // ================================================================== D
    section('D. the per-user cooldown');
    const second = await invoke(forgot, { body: { email: active.email } });
    check('a second request answers identically', JSON.stringify(second.body) === pinned);
    check(`  and creates NO second row within ${REQUEST_COOLDOWN_MINUTES} minutes`,
      (await rowsFor(active.user_id)).length === 1);

    // ================================================================== E
    section('E. using the token');
    // The raw token never left the route, so the test mints its own and
    // installs the hash — exactly what the route would have stored.
    const issue = async (userId, { minutesFromNow = TOKEN_TTL_MINUTES, used = null } = {}) => {
      const token = generateToken();
      const { data, error } = await supabase
        .from('password_resets')
        .insert({
          user_id: userId,
          token_hash: hashToken(token),
          expires_at: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
          used_at: used,
        })
        .select('reset_id')
        .single();
      if (error) throw new Error(`issue failed: ${error.message}`);
      created.resets.push(data.reset_id);
      return { token, reset_id: data.reset_id };
    };

    const good = await issue(active.user_id);
    const spare = await issue(active.user_id); // must be swept when `good` is used

    const tooShort = await invoke(reset, { body: { token: good.token, new_password: 'short' } });
    check('a password under 8 characters is refused',
      tooShort.status === 400 && /8 characters/.test(tooShort.body?.error || ''), tooShort.body?.error);

    const NEW_PASSWORD = 'ResetTest!2026';
    const okReset = await invoke(reset, { body: { token: good.token, new_password: NEW_PASSWORD } });
    check('a valid token is accepted', okReset.status === 200, `${okReset.status} ${okReset.body?.error || ''}`);
    check('  and the message says they can now sign in',
      /sign in/i.test(okReset.body?.message || ''), okReset.body?.message);

    const { data: afterUser } = await supabase
      .from('users').select('password_hash').eq('user_id', active.user_id).single();
    check('  THE NEW PASSWORD ACTUALLY WORKS',
      await bcrypt.compare(NEW_PASSWORD, afterUser.password_hash));
    check('  and the old one no longer does',
      !(await bcrypt.compare('OriginalPass123', afterUser.password_hash)));

    const afterRows = await rowsFor(active.user_id);
    const usedRow = afterRows.find((r) => r.reset_id === good.reset_id);
    check('  the token is marked used, not deleted', !!usedRow && !!usedRow.used_at, String(usedRow?.used_at));
    check('  EVERY other outstanding token for that user was swept too',
      afterRows.every((r) => r.used_at !== null),
      afterRows.map((r) => `${r.reset_id}:${r.used_at ? 'used' : 'LIVE'}`).join(' '));
    check('    (there really was another one to sweep)',
      afterRows.some((r) => r.reset_id === spare.reset_id), `spare ${spare.reset_id}`);

    section('E2. a token can only be used once');
    const replay = await invoke(reset, { body: { token: good.token, new_password: 'AnotherPass!99' } });
    check('replaying the same token is refused', replay.status === 400, `${replay.status}`);
    check('  with wording that says what to do next',
      /request a new one/i.test(replay.body?.error || ''), replay.body?.error);
    const { data: unchanged } = await supabase
      .from('users').select('password_hash').eq('user_id', active.user_id).single();
    check('  and the password is UNCHANGED by the replay',
      await bcrypt.compare(NEW_PASSWORD, unchanged.password_hash));

    section('E3. the other ways a token fails');
    const expired = await issue(active.user_id, { minutesFromNow: -1 });
    const r1 = await invoke(reset, { body: { token: expired.token, new_password: 'Whatever!123' } });
    check('an expired token is refused', r1.status === 400, `${r1.status}`);

    const unknown = await invoke(reset, { body: { token: generateToken(), new_password: 'Whatever!123' } });
    check('an unknown token is refused', unknown.status === 400, `${unknown.status}`);
    check('  with the SAME wording as an expired one (no oracle)',
      unknown.body?.error === r1.body?.error);

    const blank = await invoke(reset, { body: { new_password: 'Whatever!123' } });
    check('a missing token is refused', blank.status === 400, `${blank.status}`);

    // The status-guarded claim: `used_at IS NULL` is the only thing standing
    // between two simultaneous submissions of one link.
    const raced = await issue(active.user_id);
    await supabase.from('password_resets')
      .update({ used_at: new Date().toISOString() }).eq('reset_id', raced.reset_id);
    const lost = await invoke(reset, { body: { token: raced.token, new_password: 'Whatever!123' } });
    check('a token consumed underneath the request loses the race cleanly',
      lost.status === 400, `${lost.status}`);

    section('E4. eligibility is re-checked at USE time, not just at request time');
    const laterPending = await issue(pending.user_id);
    const refused = await invoke(reset, { body: { token: laterPending.token, new_password: 'Whatever!123' } });
    check('a token for an account that is no longer active is refused',
      refused.status === 400 && refused.body?.code === 'RESET_ACCOUNT_INACTIVE',
      `${refused.status} ${refused.body?.code}`);
    check('  and it points at the Barangay Office rather than a new link',
      /Barangay Office/i.test(refused.body?.error || ''), refused.body?.error);
    const { data: stillOld } = await supabase
      .from('users').select('password_hash').eq('user_id', pending.user_id).single();
    check('  the pending account\'s password is untouched',
      await bcrypt.compare('OriginalPass123', stillOld.password_hash));
  } catch (err) {
    if (err === SKIP_REST) {
      console.log(`\nSKIPPED from section B: password_resets is not there (${skipReason}).`);
      console.log('Apply backend/migrations/020_password_resets.sql, then re-run.');
      console.log('Section A above needs neither the table nor a server, and is the one that matters.');
    } else {
      console.error('\nERROR:', err.stack || err.message);
      failures++;
    }
  } finally {
    section('cleanup');
    for (const id of created.users) {
      await supabase.from('password_resets').delete().eq('user_id', id);
      await supabase.from('notifications').delete().eq('user_id', id);
      await supabase.from('profiles').delete().eq('user_id', id);
      await supabase.from('users').delete().eq('user_id', id);
    }
    const { count: leftUsers } = await supabase
      .from('users').select('*', { count: 'exact', head: true }).ilike('username', `${STAMP}%`);
    check('every throwaway account was removed', leftUsers === 0, `${leftUsers} left`);
    if (created.users.length) {
      const { data: leftResets, error: sweepErr } = await supabase
        .from('password_resets').select('reset_id').in('user_id', created.users);
      // A missing table here means the run stopped before section B, so there
      // is nothing to have left behind — not a cleanup failure.
      if (!sweepErr) {
        check('every reset row was removed', (leftResets || []).length === 0, `${(leftResets || []).length} left`);
      }
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
})();
