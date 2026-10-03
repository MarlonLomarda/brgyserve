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
//
// SECTIONS F TO K ARE THE SET-PASSWORD LINKS that staff-type accounts get:
// creation by email, the staff accounts list, sending another link, spending
// one at /set-password, and the temporary-password fallback. The SIMULATED
// email adapter is WRAPPED there, never replaced by a sender: it records what
// it was given, which is the only place the raw token exists, so the test
// spends the very link the route emailed. It can also be told to report
// FAILED, which is how a refused send is exercised without any provider.
// ===========================================================================
const path = require('path');

process.env.EMAIL_MODE = 'SIMULATED'; // belt and braces — never send from a test
process.env.SMS_MODE = 'SIMULATED';

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const bcrypt = require('bcryptjs');
const supabase = require('../src/config/supabase');
const { notify, PROVIDERS, currentMode } = require('../src/services/notifications');
const { NOTIFICATION_TYPE, NOTIFICATION_STATUS, RELATED_TYPE } = require('../src/constants/notifications');
const {
  TOKEN_TTL_MINUTES,
  REQUEST_COOLDOWN_MINUTES,
  generateToken,
  hashToken,
  FORGOT_PASSWORD_RESPONSE,
  resetEmail,
  resetLogMessage,
  SET_PASSWORD_TTL_HOURS,
  SET_PASSWORD_COOLDOWN_MINUTES,
  SET_PASSWORD_INVALID_MESSAGE,
  SET_PASSWORD_EMAIL_SUBJECT,
  NEW_PASSWORD_EMAIL_SUBJECT,
} = require('../src/constants/passwordReset');
const { ACTIONS } = require('../src/constants/activityLog');
const { setPasswordLimiter } = require('../src/middleware/rateLimit');

const authRouter = require('../src/routes/auth');
// Only for the email-uniqueness section below. The router-level
// authenticate + requireRole('secretary') guard is a layer with no .route, so
// handlerFor skips it and reaches the handler directly — and POST /accounts
// reads nothing but req.body, so it runs without a session. That is fine here
// because the only path exercised is the one that REFUSES before any insert.
const secretaryRouter = require('../src/routes/secretary');

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

// `user` stands in for the session authenticate() would have loaded. Only the
// routes that log an action as the caller read it.
function invoke(handler, { params = {}, body = {}, query = {}, user } = {}) {
  return new Promise((resolve, reject) => {
    const req = { params, body, query, user };
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
const setPassword = handlerFor(authRouter, 'post', '/set-password');

// Undone in the finally block whatever happens, so a failed run cannot leave
// the email adapter or the Supabase client patched for anything after it.
const realFromForRestore = supabase.from;
const emailAdapters = PROVIDERS[NOTIFICATION_TYPE.EMAIL];
const realSimulatedEmail = emailAdapters.SIMULATED;

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

    // ================================================================= B2
    // EMAIL UNIQUENESS AT BOTH INSERT ROUTES.
    //
    // These live here rather than in a harness of their own because this is
    // the only script with throwaway accounts whose addresses are known, and
    // it already cleans them up. Both probes use a FREE username with a TAKEN
    // address, so the username check cannot fire first and mask the result —
    // and both exercise only the refusing path, which returns before any row
    // is written. Nothing here can create an account.
    section('B2. an email address cannot be claimed twice');

    const registerHandler = handlerFor(authRouter, 'post', '/register');
    const accountsHandler = handlerFor(secretaryRouter, 'post', '/accounts');

    const dupRegister = await invoke(registerHandler, {
      body: {
        username: `${STAMP}_dupmail`,      // free, and valid under usernamePolicy
        email: active.email,               // already held by the `active` fixture
        password: 'Ubay-Sunrise-42!',
        first_name: 'Dup', last_name: 'Email', address: 'Purok 1',
      },
    });
    check('POST /register refuses an address another account holds',
      dupRegister.status === 409, `${dupRegister.status} ${dupRegister.body?.error || ''}`);
    check('  and it names the EMAIL, not the username',
      /email address is already registered/i.test(dupRegister.body?.error || '')
      && !/username/i.test(dupRegister.body?.error || ''), dupRegister.body?.error);
    check('  with a code the frontend can branch on',
      dupRegister.body?.code === 'EMAIL_TAKEN', String(dupRegister.body?.code));

    const dupAccount = await invoke(accountsHandler, {
      body: {
        username: `${STAMP}_dupmail2`,
        email: active.email.toUpperCase(),  // ALSO proves the check is case-insensitive
        role: 'staff',
        first_name: 'Dup', last_name: 'Email',
      },
    });
    check('POST /secretary/accounts refuses it too, case-insensitively',
      dupAccount.status === 409, `${dupAccount.status} ${dupAccount.body?.error || ''}`);
    check('  and it names the EMAIL, not the username',
      /email address is already registered/i.test(dupAccount.body?.error || '')
      && !/username/i.test(dupAccount.body?.error || ''), dupAccount.body?.error);

    // The refusals must have cost nothing: still four fixtures, no fifth or
    // sixth account created by the probes above.
    const { data: probeRows } = await supabase
      .from('users').select('user_id, username')
      .or(`username.eq.${STAMP}_dupmail,username.eq.${STAMP}_dupmail2`);
    check('  NEITHER probe created an account', (probeRows?.length || 0) === 0,
      `${probeRows?.length || 0} row(s)`);
    // Register anything the probes DID create for cleanup, so the assertion
    // above can fail without leaving accounts behind. It fails only against a
    // route missing the guard — which is exactly when this runs, and exactly
    // when a leak is least welcome: verified against the pre-fix code, both
    // probes returned 201 and one of them was an ACTIVE staff account holding
    // a duplicate address.
    for (const row of probeRows || []) created.users.push(row.user_id);

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

    // ---- E1b. the new password must actually be NEW ---------------------
    //
    // THE ASSERTION ABOVE — "and the old one no longer does" — LOOKS like it
    // covers this and does not. It passes because this test sets a DIFFERENT
    // password; it would pass identically against a route that happily
    // accepted the current one back. This section submits the account's
    // CURRENT password and requires a refusal.
    //
    // NEW_PASSWORD is used rather than the fixture's original, because
    // 'OriginalPass123' has no symbol and would be stopped by the composition
    // rule before ever reaching the reuse check — a test that passed for the
    // wrong reason.
    section('E1b. the new password must differ from the current one');
    const reuseToken = await issue(active.user_id);
    const reuse = await invoke(reset, { body: { token: reuseToken.token, new_password: NEW_PASSWORD } });
    check('submitting the CURRENT password as the new one is refused',
      reuse.status === 400, `${reuse.status} ${reuse.body?.error || ''}`);
    check('  with wording that says nothing changed and why it matters',
      /different from your current/i.test(reuse.body?.error || '')
      && /exposed/i.test(reuse.body?.error || ''), reuse.body?.error);
    check('  and a code the frontend can branch on',
      reuse.body?.code === 'RESET_PASSWORD_REUSED', String(reuse.body?.code));

    const { data: unchangedUser } = await supabase
      .from('users').select('password_hash').eq('user_id', active.user_id).single();
    check('  the stored password is UNTOUCHED',
      await bcrypt.compare(NEW_PASSWORD, unchangedUser.password_hash));

    // The point of refusing BEFORE the status-guarded claim: a rejected
    // password must cost the resident a retry, not the whole link.
    const reuseRows = await rowsFor(active.user_id);
    const stillLive = reuseRows.find((r) => r.reset_id === reuseToken.reset_id);
    check('  THE TOKEN IS NOT BURNED — it is still unused',
      !!stillLive && stillLive.used_at === null, `used_at=${String(stillLive?.used_at)}`);

    const RETRY_PASSWORD = 'Retry-Pass-77!';
    const retry = await invoke(reset, { body: { token: reuseToken.token, new_password: RETRY_PASSWORD } });
    check('  and that same link then works with a different password',
      retry.status === 200, `${retry.status} ${retry.body?.error || ''}`);
    const { data: retriedUser } = await supabase
      .from('users').select('password_hash').eq('user_id', active.user_id).single();
    check('    the retry password is the one now stored',
      await bcrypt.compare(RETRY_PASSWORD, retriedUser.password_hash));

    section('E2. a token can only be used once');
    const replay = await invoke(reset, { body: { token: good.token, new_password: 'AnotherPass!99' } });
    check('replaying the same token is refused', replay.status === 400, `${replay.status}`);
    check('  with wording that says what to do next',
      /request a new one/i.test(replay.body?.error || ''), replay.body?.error);
    const { data: unchanged } = await supabase
      .from('users').select('password_hash').eq('user_id', active.user_id).single();
    // RETRY_PASSWORD, not NEW_PASSWORD: E1b above legitimately set the
    // password again when it proved the un-burned link still worked. The
    // claim here is unchanged — the replay must not move the password — only
    // the value it is measured against.
    check('  and the password is UNCHANGED by the replay',
      await bcrypt.compare(RETRY_PASSWORD, unchanged.password_hash));

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

    // ================================================================== F
    // SET-PASSWORD LINKS: creating a staff account by email.
    section('F. a staff account created by EMAIL gets a link, never a password');

    // These sections create accounts that email a link. The top of this file
    // forces SIMULATED; this refuses to go on if anything has undone that, so
    // a real provider can never be reached from here.
    if (currentMode(NOTIFICATION_TYPE.EMAIL) !== 'SIMULATED') {
      throw new Error(`EMAIL_MODE is ${currentMode(NOTIFICATION_TYPE.EMAIL)}, not SIMULATED: refusing to run sections F onwards`);
    }

    // The SIMULATED adapter, wrapped: it records each email it is handed and
    // can be told to answer FAILED. Restored in the finally block.
    const sentMail = [];
    let failSends = false;
    emailAdapters.SIMULATED = async (destination, message, opts = {}) => {
      sentMail.push({ destination, message, ...opts });
      if (failSends) {
        return { status: NOTIFICATION_STATUS.FAILED, providerResponse: 'reset:test forced a failed send' };
      }
      return realSimulatedEmail(destination, message, opts);
    };
    const tokenInMail = (m) => {
      const found = String(m?.message || '').match(/\/set-password\?token=(\S+)/);
      return found ? decodeURIComponent(found[1]) : '';
    };

    // The Secretary acting in this section is a throwaway too, so no real
    // account is the actor on any row these tests write.
    const secretary = await mkUser('sec', { role: 'secretary' });
    const asSecretary = { user_id: secretary.user_id, role: 'secretary' };
    const staffList = handlerFor(secretaryRouter, 'get', '/staff-accounts');
    const sendLink = handlerFor(secretaryRouter, 'post', '/staff-accounts/:userId/send-set-password-link');
    const newAccount = (suffix, over = {}) => ({
      username: `${STAMP}_${suffix}`,
      email: `${STAMP}.${suffix}@example.invalid`,
      role: 'treasurer',
      first_name: 'Setpw',
      last_name: 'Fixture',
      ...over,
    });

    // ---- refused before anything is written ------------------------------
    const malformed = ['not-an-email', 'lon@com', 'juan @gmail.com', 'juan@gmail..com', `${'a'.repeat(250)}@x.com`];
    for (const bad of malformed) {
      const r = await invoke(accountsHandler, { user: asSecretary, body: newAccount('bademail', { email: bad }) });
      check(`a malformed address is refused with a 400: ${bad.length > 24 ? `${bad.slice(0, 8)}… (${bad.length} chars)` : bad}`,
        r.status === 400 && /valid email address/i.test(r.body?.error || ''), `${r.status} ${r.body?.error || ''}`);
    }
    const badDelivery = await invoke(accountsHandler, {
      user: asSecretary, body: newAccount('baddelivery', { delivery: 'sms' }),
    });
    check('an unknown delivery is refused with a 400',
      badDelivery.status === 400 && /delivery must be one of/.test(badDelivery.body?.error || ''),
      `${badDelivery.status} ${badDelivery.body?.error || ''}`);
    const { data: refusedRows } = await supabase
      .from('users').select('user_id')
      .or(`username.eq.${STAMP}_bademail,username.eq.${STAMP}_baddelivery`);
    for (const r of refusedRows || []) created.users.push(r.user_id);
    check('  none of those refusals created an account', (refusedRows?.length || 0) === 0,
      `${refusedRows?.length || 0} row(s)`);
    check('  and none sent an email', sentMail.length === 0, `${sentMail.length}`);

    // ---- the real thing --------------------------------------------------
    // No delivery given: email is the default. The address arrives padded
    // with spaces and in mixed case, the way a form can send it.
    const made = await invoke(accountsHandler, {
      user: asSecretary,
      body: newAccount('emailed', { email: `  ${STAMP}.Emailed@example.invalid ` }),
    });
    const emailed = made.body?.user || {};
    if (emailed.user_id) created.users.push(emailed.user_id);
    check('an account created with no delivery given is created by EMAIL',
      made.status === 201 && made.body?.delivery === 'email', `${made.status} ${made.body?.error || made.body?.delivery}`);
    check('  THE RESPONSE CARRIES NO PASSWORD',
      !('temporary_password' in (made.body || {})) && !/Temp-/.test(JSON.stringify(made.body || {})),
      Object.keys(made.body || {}).join(', '));
    check('  it reports the email status instead ({ ok, status })',
      made.body?.set_password_email?.status === NOTIFICATION_STATUS.SIMULATED
        && made.body?.set_password_email?.ok === false,
      JSON.stringify(made.body?.set_password_email));
    check('  the address was stored trimmed', emailed.email === `${STAMP}.Emailed@example.invalid`,
      JSON.stringify(emailed.email));

    const { data: emailedUser } = await supabase
      .from('users').select('password_hash, must_change_password, email_verified, is_active')
      .eq('user_id', emailed.user_id).single();
    check('  must_change_password is set, email_verified is not, the account is active',
      emailedUser?.must_change_password === true && emailedUser?.email_verified === false
        && emailedUser?.is_active === true, JSON.stringify({ ...emailedUser, password_hash: undefined }));
    check('  the stored password is a real bcrypt hash (of random bytes nobody holds)',
      /^\$2[aby]\$10\$/.test(emailedUser?.password_hash || ''));

    const emailedRows = await rowsFor(emailed.user_id);
    check('  exactly ONE link row was written', emailedRows.length === 1, `${emailedRows.length}`);
    const linkHours = (new Date(emailedRows[0]?.expires_at) - new Date(emailedRows[0]?.created_at)) / 3_600_000;
    check(`  it expires in about ${SET_PASSWORD_TTL_HOURS} hours`,
      Math.abs(linkHours - SET_PASSWORD_TTL_HOURS) < 0.05, `${linkHours.toFixed(3)} h`);
    check('  and is unused', emailedRows[0]?.used_at === null);

    const firstMail = sentMail[0];
    check('ONE email was handed to the provider, addressed to the account',
      sentMail.length === 1 && firstMail?.destination === emailed.email, `${sentMail.length} email(s)`);
    check(`  subject "${SET_PASSWORD_EMAIL_SUBJECT}"`, firstMail?.subject === SET_PASSWORD_EMAIL_SUBJECT,
      firstMail?.subject);
    check('  it names the username, the 72 hours, single use, and that signing in will not work yet',
      String(firstMail?.message).includes(emailed.username) && /72 hours/.test(firstMail?.message)
        && /only be used once/.test(firstMail?.message) && /Signing in will not work/.test(firstMail?.message));
    check('  and has no "if you did not ask" line', !/did not ask/i.test(String(firstMail?.message)));
    const firstToken = tokenInMail(firstMail);
    check('  its /set-password link carries the token whose hash is stored',
      !!firstToken && hashToken(firstToken) === emailedRows[0]?.token_hash);
    check('  and the HTML body carries the same link',
      String(firstMail?.html).includes(`/set-password?token=${encodeURIComponent(firstToken)}`));

    const { data: setNotif } = await supabase
      .from('notifications').select('*')
      .eq('related_type', RELATED_TYPE.ACCOUNT).eq('related_to', emailed.user_id)
      .order('notification_id', { ascending: false }).limit(1).maybeSingle();
    check('a notification row was recorded', !!setNotif);
    check('  EMAIL, SIMULATED, addressed to the account',
      setNotif?.type === NOTIFICATION_TYPE.EMAIL && setNotif?.status === NOTIFICATION_STATUS.SIMULATED
        && setNotif?.destination === emailed.email, `${setNotif?.type} ${setNotif?.status}`);
    check('  THE LINK IS NOT IN notifications.message',
      !/[?&]token=/i.test(setNotif?.message || '') && !String(setNotif?.message).includes('/set-password')
        && !String(setNotif?.message).includes(firstToken), JSON.stringify(String(setNotif?.message).slice(0, 80)));
    check('  and the recorded text still says what happened',
      /set-password link/i.test(setNotif?.message || '') && /not recorded/i.test(setNotif?.message || ''));

    const { data: createLog } = await supabase
      .from('activity_logs').select('*')
      .eq('table_name', 'users').eq('record_id', emailed.user_id).eq('action', ACTIONS.CREATE)
      .maybeSingle();
    check('the CREATE log row records the delivery and the email status',
      createLog?.new_value?.delivery === 'email' && createLog?.new_value?.email_status === 'SIMULATED',
      JSON.stringify(createLog?.new_value));
    check('  with the Secretary as the actor', createLog?.user_id === secretary.user_id);
    check('  and no address, link or password in it',
      !JSON.stringify(createLog || {}).toLowerCase().includes(emailed.email.toLowerCase())
        && !JSON.stringify(createLog || {}).includes(firstToken)
        && !/password"\s*:/.test(JSON.stringify(createLog?.new_value || {})));

    // ================================================================= F2
    section('F2. a failure part-way through leaves no half-made account');
    const sabotage = (table, method, error) => {
      supabase.from = (t) => {
        const real = realFromForRestore.call(supabase, t);
        if (t !== table) return real;
        const failing = method === 'insert'
          // profiles.insert is awaited bare; password_resets.insert is
          // followed by .select().single(). This answers both.
          ? () => Object.assign(Promise.resolve({ data: null, error }), {
            select: () => ({ single: async () => ({ data: null, error }) }),
          })
          : null;
        return { insert: failing, delete: (...a) => real.delete(...a) };
      };
    };
    for (const [table, label] of [['profiles', 'the profile'], ['password_resets', 'the link row']]) {
      const before = sentMail.length;
      sabotage(table, 'insert', { message: `reset:test sabotaged ${table}` });
      let thrown = null;
      try {
        await invoke(accountsHandler, { user: asSecretary, body: newAccount(`unwound_${table === 'profiles' ? 'p' : 'r'}`) });
      } catch (err) {
        thrown = err;
      } finally {
        supabase.from = realFromForRestore;
      }
      const { data: left } = await supabase
        .from('users').select('user_id').eq('username', `${STAMP}_unwound_${table === 'profiles' ? 'p' : 'r'}`);
      for (const r of left || []) created.users.push(r.user_id);
      check(`when ${label} cannot be written, the request fails`, !!thrown && /sabotaged/.test(thrown.message),
        thrown?.message);
      check('  and NO account is left behind', (left?.length || 0) === 0, `${left?.length || 0} row(s)`);
      check('  and no email was sent', sentMail.length === before);
    }

    // ================================================================== G
    section('G. the staff accounts list, and sending another link');
    const listed = await invoke(staffList, { user: asSecretary });
    const listRows = listed.body?.accounts || [];
    const emailedRow = listRows.find((r) => r.user_id === emailed.user_id);
    check('GET /staff-accounts lists the new account', listed.status === 200 && !!emailedRow, `${listed.status}`);
    check('  with exactly the expected fields',
      JSON.stringify(Object.keys(emailedRow || {}).sort()) === JSON.stringify(
        ['email', 'is_active', 'last_link_sent_at', 'must_change_password', 'role', 'user_id', 'username']),
      Object.keys(emailedRow || {}).join(', '));
    check('  and no password hash anywhere in the response',
      !JSON.stringify(listed.body || {}).includes('password_hash')
        && !JSON.stringify(listed.body || {}).includes(emailedUser?.password_hash || '$2'));
    check('  last_link_sent_at is the link just issued',
      emailedRow?.last_link_sent_at === emailedRows[0]?.created_at, String(emailedRow?.last_link_sent_at));
    check('  only Punong Barangay, Treasurer and Staff accounts are on it',
      listRows.every((r) => ['punong_barangay', 'treasurer', 'staff'].includes(r.role))
        && !listRows.some((r) => r.user_id === secretary.user_id || r.user_id === active.user_id),
      [...new Set(listRows.map((r) => r.role))].join(', '));

    const sendTo = (userId) => invoke(sendLink, { user: asSecretary, params: { userId: String(userId) } });

    const tooSoon = await sendTo(emailed.user_id);
    check(`another link within ${SET_PASSWORD_COOLDOWN_MINUTES} minutes is refused with a 429`,
      tooSoon.status === 429 && tooSoon.body?.code === 'SET_PASSWORD_LINK_COOLDOWN',
      `${tooSoon.status} ${tooSoon.body?.code}`);
    check('  and says when another can go', /send another in \d+ minutes?/.test(tooSoon.body?.error || ''),
      tooSoon.body?.error);
    check('  no second row, no second email',
      (await rowsFor(emailed.user_id)).length === 1 && sentMail.length === 1);

    const mailBeforeTargets = sentMail.length;
    for (const [label, id] of [['a resident', active.user_id], ['a Secretary', secretary.user_id], ['an unknown id', 2147480000]]) {
      const r = await sendTo(id);
      check(`sending a link to ${label} is a 404`, r.status === 404, `${r.status} ${r.body?.error || ''}`);
    }
    const junkId = await invoke(sendLink, { user: asSecretary, params: { userId: 'abc' } });
    check('a non-numeric id is a 400', junkId.status === 400, `${junkId.status}`);
    const inactiveStaff = await mkUser('inactivestaff', { role: 'staff', is_active: false });
    const toInactive = await sendTo(inactiveStaff.user_id);
    check('an inactive staff account is refused with a 409', toInactive.status === 409, `${toInactive.status}`);
    check('  none of those sent anything', sentMail.length === mailBeforeTargets);

    // Time is moved rather than waited for: the fixture's own rows are
    // backdated past the cooldown.
    const backdate = (userId) => supabase
      .from('password_resets')
      .update({ created_at: new Date(Date.now() - (SET_PASSWORD_COOLDOWN_MINUTES + 1) * 60_000).toISOString() })
      .eq('user_id', userId);
    await backdate(emailed.user_id);

    // A send the provider refuses: the new row goes, the older link stays.
    failSends = true;
    const failedSend = await sendTo(emailed.user_id);
    failSends = false;
    check('a send the provider refuses answers 200 with status FAILED',
      failedSend.status === 200 && failedSend.body?.set_password_email?.status === NOTIFICATION_STATUS.FAILED,
      `${failedSend.status} ${JSON.stringify(failedSend.body?.set_password_email)}`);
    const afterFail = await rowsFor(emailed.user_id);
    check('  the unsent link\'s row was DELETED: still exactly one row', afterFail.length === 1, `${afterFail.length}`);
    check('  and the earlier link is untouched',
      afterFail[0]?.reset_id === emailedRows[0]?.reset_id && afterFail[0]?.used_at === null);

    const resent = await sendTo(emailed.user_id);
    check('so the cooldown did not start: a retry goes straight through',
      resent.status === 200 && resent.body?.set_password_email?.status === NOTIFICATION_STATUS.SIMULATED,
      `${resent.status} ${resent.body?.error || JSON.stringify(resent.body?.set_password_email)}`);
    const afterResend = await rowsFor(emailed.user_id);
    const liveRows = afterResend.filter((r) => r.used_at === null);
    check('  a second row exists, and only ONE link is live', afterResend.length === 2 && liveRows.length === 1,
      afterResend.map((r) => `${r.reset_id}:${r.used_at ? 'used' : 'LIVE'}`).join(' '));
    check('  the OLDER link was retired', !!afterResend.find((r) => r.reset_id === emailedRows[0]?.reset_id)?.used_at);
    const resentMail = sentMail.at(-1);
    const resentToken = tokenInMail(resentMail);
    check('  the new email carries the live link', hashToken(resentToken) === liveRows[0]?.token_hash);
    check('  still worded for a new account (must_change_password is still set)',
      resentMail?.subject === SET_PASSWORD_EMAIL_SUBJECT, resentMail?.subject);

    const { data: sendLogs } = await supabase
      .from('activity_logs').select('user_id, old_value, new_value')
      .eq('table_name', 'users').eq('record_id', emailed.user_id).eq('action', ACTIONS.SEND_SET_PASSWORD_LINK)
      .order('log_id');
    check('both sends were logged as SEND_SET_PASSWORD_LINK by the Secretary (not the 429)',
      sendLogs?.length === 2 && sendLogs.every((l) => l.user_id === secretary.user_id), `${sendLogs?.length}`);
    check('  each holding the email status and nothing else',
      JSON.stringify((sendLogs || []).map((l) => l.new_value)) === JSON.stringify([
        { email_status: NOTIFICATION_STATUS.FAILED }, { email_status: NOTIFICATION_STATUS.SIMULATED }])
        && (sendLogs || []).every((l) => l.old_value === null),
      JSON.stringify((sendLogs || []).map((l) => l.new_value)));

    // ================================================================== H
    section('H. spending the link at /set-password');
    const SET_PASSWORD = 'Treasurer-Set-2026!';
    const retiredUse = await invoke(setPassword, { body: { token: firstToken, new_password: SET_PASSWORD } });
    check('the retired first link is refused', retiredUse.status === 400
      && retiredUse.body?.code === 'SET_PASSWORD_TOKEN_INVALID', `${retiredUse.status} ${retiredUse.body?.code}`);
    check('  with the set-password answer: 72 hours, the Barangay Office, never "60 minutes"',
      retiredUse.body?.error === SET_PASSWORD_INVALID_MESSAGE && /72 hours/.test(SET_PASSWORD_INVALID_MESSAGE)
        && /Barangay Office/.test(SET_PASSWORD_INVALID_MESSAGE) && !/60 minutes/.test(SET_PASSWORD_INVALID_MESSAGE),
      retiredUse.body?.error);

    const weakSet = await invoke(setPassword, { body: { token: resentToken, new_password: 'short' } });
    check('a password under 8 characters is refused', weakSet.status === 400
      && /8 characters/.test(weakSet.body?.error || ''), weakSet.body?.error);
    check('  and the link is NOT burned',
      (await rowsFor(emailed.user_id)).find((r) => r.token_hash === hashToken(resentToken))?.used_at === null);

    const setOk = await invoke(setPassword, { body: { token: resentToken, new_password: SET_PASSWORD } });
    check('the live link sets the password', setOk.status === 200 && /sign in/i.test(setOk.body?.message || ''),
      `${setOk.status} ${setOk.body?.error || setOk.body?.message}`);
    const { data: setUser } = await supabase
      .from('users').select('password_hash, must_change_password, email_verified')
      .eq('user_id', emailed.user_id).single();
    check('  THE NEW PASSWORD WORKS', await bcrypt.compare(SET_PASSWORD, setUser.password_hash));
    check('  must_change_password is cleared', setUser.must_change_password === false);
    check('  email_verified is set', setUser.email_verified === true);
    check('  every link for the account is now used',
      (await rowsFor(emailed.user_id)).every((r) => r.used_at !== null));
    const { data: setLog } = await supabase
      .from('activity_logs').select('user_id, old_value, new_value')
      .eq('table_name', 'users').eq('record_id', emailed.user_id).eq('action', ACTIONS.PASSWORD_SET)
      .maybeSingle();
    check('PASSWORD_SET was logged, by the account itself, with no values',
      setLog?.user_id === emailed.user_id && setLog?.old_value === null && setLog?.new_value === null,
      JSON.stringify(setLog));

    const spentAgain = await invoke(setPassword, { body: { token: resentToken, new_password: 'Another-Set-2026!' } });
    check('replaying the spent link is refused with the same answer',
      spentAgain.status === 400 && spentAgain.body?.error === SET_PASSWORD_INVALID_MESSAGE, `${spentAgain.status}`);
    const { data: afterReplay } = await supabase
      .from('users').select('password_hash').eq('user_id', emailed.user_id).single();
    check('  and the password is unchanged by it', await bcrypt.compare(SET_PASSWORD, afterReplay.password_hash));

    // ================================================================= H2
    section('H2. the other ways a set-password link fails');
    const deadAnswer = (r) => r.status === 400 && r.body?.code === 'SET_PASSWORD_TOKEN_INVALID'
      && r.body?.error === SET_PASSWORD_INVALID_MESSAGE;

    const staleLink = await issue(emailed.user_id, { minutesFromNow: -1 });
    check('an expired staff link is refused',
      deadAnswer(await invoke(setPassword, { body: { token: staleLink.token, new_password: 'Whatever-Set-99!' } })));
    check('an unknown token gets the same answer',
      deadAnswer(await invoke(setPassword, { body: { token: generateToken(), new_password: 'Whatever-Set-99!' } })));
    check('a missing token gets the same answer',
      deadAnswer(await invoke(setPassword, { body: { new_password: 'Whatever-Set-99!' } })));

    const inactiveLink = await issue(inactiveStaff.user_id);
    check('a link for an INACTIVE staff account gets the same answer',
      deadAnswer(await invoke(setPassword, { body: { token: inactiveLink.token, new_password: 'Inactive-Set-99!' } })));

    // A resident's token is a reset token, and /set-password must not spend it.
    const residentLink = await issue(active.user_id);
    check('A RESIDENT\'S RESET TOKEN gets the same answer',
      deadAnswer(await invoke(setPassword, { body: { token: residentLink.token, new_password: 'Resident-Set-99!' } })));
    const { data: residentAfter } = await supabase
      .from('users').select('password_hash').eq('user_id', active.user_id).single();
    check('  the resident\'s password is untouched', await bcrypt.compare(RETRY_PASSWORD, residentAfter.password_hash));
    check('  and their reset link still works where it belongs: not burned',
      (await rowsFor(active.user_id)).find((r) => r.reset_id === residentLink.reset_id)?.used_at === null);

    // And the other half: /reset-password must not spend a staff link.
    const staffLink = await issue(emailed.user_id);
    const viaReset = await invoke(reset, { body: { token: staffLink.token, new_password: 'ViaReset-Set-99!' } });
    check('/reset-password REFUSES a staff account\'s token', viaReset.status === 400,
      `${viaReset.status} ${viaReset.body?.code}`);
    const { data: staffAfterReset } = await supabase
      .from('users').select('password_hash').eq('user_id', emailed.user_id).single();
    check('  and the staff password is untouched', await bcrypt.compare(SET_PASSWORD, staffAfterReset.password_hash));

    // ================================================================== I
    section('I. a link to an account already in use (an admin reset)');
    await backdate(emailed.user_id);
    const mailBeforeReset = sentMail.length;
    const adminReset = await sendTo(emailed.user_id);
    check('an active account can be sent a link',
      adminReset.status === 200 && adminReset.body?.set_password_email?.status === NOTIFICATION_STATUS.SIMULATED,
      `${adminReset.status} ${adminReset.body?.error || ''}`);
    const resetMail = sentMail[mailBeforeReset];
    check(`  subject "${NEW_PASSWORD_EMAIL_SUBJECT}"`, resetMail?.subject === NEW_PASSWORD_EMAIL_SUBJECT, resetMail?.subject);
    check('  it says the current password keeps working, NOT that signing in will fail',
      /current password keeps working/.test(resetMail?.message || '')
        && !/Signing in will not work/.test(resetMail?.message || ''));
    const { data: beforeUse } = await supabase
      .from('users').select('password_hash, must_change_password').eq('user_id', emailed.user_id).single();
    check('  nothing about the account changed: the current password still works',
      await bcrypt.compare(SET_PASSWORD, beforeUse.password_hash) && beforeUse.must_change_password === false);
    check('  the staff link issued in H2 was retired by the newer one',
      !!(await rowsFor(emailed.user_id)).find((r) => r.reset_id === staffLink.reset_id)?.used_at);

    const adminToken = tokenInMail(resetMail);
    const sameAgain = await invoke(setPassword, { body: { token: adminToken, new_password: SET_PASSWORD } });
    check('setting the CURRENT password again is refused', sameAgain.status === 400
      && sameAgain.body?.code === 'SET_PASSWORD_REUSED', `${sameAgain.status} ${sameAgain.body?.code}`);
    check('  and the link survives it',
      (await rowsFor(emailed.user_id)).find((r) => r.token_hash === hashToken(adminToken))?.used_at === null);
    const NEXT_PASSWORD = 'Treasurer-Next-2026!';
    const adminSet = await invoke(setPassword, { body: { token: adminToken, new_password: NEXT_PASSWORD } });
    check('a different password is accepted', adminSet.status === 200, `${adminSet.status} ${adminSet.body?.error || ''}`);
    const { data: afterAdmin } = await supabase
      .from('users').select('password_hash').eq('user_id', emailed.user_id).single();
    check('  and is now the one that works', await bcrypt.compare(NEXT_PASSWORD, afterAdmin.password_hash)
      && !(await bcrypt.compare(SET_PASSWORD, afterAdmin.password_hash)));

    // ================================================================== J
    section('J. the temporary-password fallback is unchanged');
    const mailBeforeFallback = sentMail.length;
    const fallback = await invoke(accountsHandler, {
      user: asSecretary, body: newAccount('fallback', { role: 'staff', delivery: 'temporary_password' }),
    });
    const fallbackId = fallback.body?.user?.user_id;
    if (fallbackId) created.users.push(fallbackId);
    check('delivery temporary_password creates the account and returns the password ONCE',
      fallback.status === 201 && fallback.body?.delivery === 'temporary_password'
        && /^Temp-/.test(fallback.body?.temporary_password || ''),
      `${fallback.status} ${fallback.body?.error || ''}`);
    check('  and no email status', !('set_password_email' in (fallback.body || {})));
    const { data: fallbackUser } = await supabase
      .from('users').select('password_hash, must_change_password').eq('user_id', fallbackId).single();
    check('  the returned password is the stored one',
      await bcrypt.compare(fallback.body?.temporary_password || '', fallbackUser?.password_hash || ''));
    check('  must_change_password is set', fallbackUser?.must_change_password === true);
    check('  NO link row was written', (await rowsFor(fallbackId)).length === 0);
    check('  NO email was sent', sentMail.length === mailBeforeFallback);
    const { count: fallbackNotifs } = await supabase
      .from('notifications').select('notification_id', { count: 'exact', head: true })
      .eq('related_type', RELATED_TYPE.ACCOUNT).eq('related_to', fallbackId);
    check('  and no notification was recorded', fallbackNotifs === 0, String(fallbackNotifs));
    const { data: fallbackLog } = await supabase
      .from('activity_logs').select('new_value')
      .eq('table_name', 'users').eq('record_id', fallbackId).eq('action', ACTIONS.CREATE).maybeSingle();
    check('  the CREATE log row records the fallback, with no email status',
      fallbackLog?.new_value?.delivery === 'temporary_password' && !('email_status' in (fallbackLog?.new_value || {})),
      JSON.stringify(fallbackLog?.new_value));
    check('  and never the password',
      !JSON.stringify(fallbackLog || {}).includes(fallback.body?.temporary_password || 'Temp-'));
    const relisted = await invoke(staffList, { user: asSecretary });
    const fallbackRow = (relisted.body?.accounts || []).find((r) => r.user_id === fallbackId);
    check('  the staff list shows it waiting, with no link ever sent',
      fallbackRow?.must_change_password === true && fallbackRow?.last_link_sent_at === null,
      JSON.stringify(fallbackRow));

    // ================================================================== K
    section('K. /set-password is rate limited');
    const setLayer = authRouter.stack.find((l) => l.route?.path === '/set-password');
    check('the route runs setPasswordLimiter before its handler',
      setLayer?.route.stack.length === 2 && setLayer.route.stack[0].handle === setPasswordLimiter);
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
    emailAdapters.SIMULATED = realSimulatedEmail;
    supabase.from = realFromForRestore;
    section('cleanup');
    for (const id of created.users) {
      await supabase.from('password_resets').delete().eq('user_id', id);
      await supabase.from('notifications').delete().eq('user_id', id);
      // The activity log rows the instrumented routes wrote about this account,
      // as the actor (the reset) or as the record. They must go BEFORE the
      // user: activity_logs.user_id references users, with no ON DELETE.
      await supabase.from('activity_logs').delete().eq('user_id', id);
      await supabase.from('activity_logs').delete().eq('table_name', 'users').eq('record_id', id);
      await supabase.from('profiles').delete().eq('user_id', id);
      await supabase.from('users').delete().eq('user_id', id);
    }
    if (created.users.length) {
      const { data: leftLogs, error: logErr } = await supabase
        .from('activity_logs').select('log_id').in('user_id', created.users);
      if (!logErr) check('every activity log row was removed', (leftLogs || []).length === 0, `${(leftLogs || []).length} left`);
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
