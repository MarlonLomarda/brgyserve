// Tests for the two auth session defects.
//
//   1. An expired token rendered a fully logged-in view. Nothing failed until
//      the first request came back 401, so the session looked alive right up
//      to the point a screen broke on use.
//   2. A 401 called logout(), which changed authFetch's identity, which every
//      loader effect in the app depends on. Concurrent 401s each tore the
//      session down again, and re-fired requests with no token.
//
// Both live between the stored session and the first request, which is
// invisible to an API-level test — so this bundles the REAL AuthProvider,
// ProtectedRoute and App, mounts them in jsdom, and stubs fetch and
// localStorage to count what actually happens.
//
// Section G adds a third: a wrong current password on the change-password
// screen must leave the session alone and show the server's message.
//
// No backend required.
//   cd frontend && npm run test:auth

const path = require('path');
const { rolldown } = require('rolldown');
const { JSDOM } = require('jsdom');

const HERE = __dirname;
const STORAGE_KEY = 'brgyserve.auth';

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

// --- fake session tokens ----------------------------------------------------
// Real JWT shape, unsigned. The client only ever DECODES the token, so a real
// signature is irrelevant here — which is itself the point: this check is a UX
// guard, not a security control.
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.notarealsignature`;
const nowSec = () => Math.floor(Date.now() / 1000);

// Pinned, not recomputed at assert time — the clock moves between the two.
const VALID_EXP = nowSec() + 3600;
const EXPIRED = makeToken({ sub: '1', role: 'secretary', exp: nowSec() - 3600 });
const VALID = makeToken({ sub: '1', role: 'secretary', exp: VALID_EXP });
const USER = { user_id: 1, username: 'secretary1', role: 'secretary', must_change_password: false };

// --- jsdom + stubs ----------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;

// localStorage that counts writes, so "how many times was the session torn
// down" is directly observable.
const store = { data: new Map(), removes: 0, sets: 0 };
const localStorageStub = {
  getItem: (k) => (store.data.has(k) ? store.data.get(k) : null),
  setItem: (k, v) => { store.sets += 1; store.data.set(k, String(v)); },
  removeItem: (k) => { store.removes += 1; store.data.delete(k); },
  clear: () => store.data.clear(),
};
global.localStorage = localStorageStub;
dom.window.localStorage = localStorageStub;

// fetch stub: counts calls, records whether each carried a token, and answers
// with whatever status the current test wants. `reply`, when a test sets one,
// is the body sent with that status; otherwise a 401 carries the token error.
// A `reply` that is a function is asked per request, (url, method), so one
// mount can answer two endpoints differently; returning undefined falls back.
const net = { calls: [], status: 200, body: { ok: true }, reply: null };
global.fetch = async (url, options = {}) => {
  const auth = options.headers?.Authorization || null;
  net.calls.push({ url: String(url), method: options.method || 'GET', token: auth ? auth.replace('Bearer ', '') : null });
  const reply = typeof net.reply === 'function' ? net.reply(String(url), options.method || 'GET') : net.reply;
  return {
    ok: net.status >= 200 && net.status < 300,
    status: net.status,
    json: async () => reply ?? (net.status === 401 ? { error: 'Invalid or expired token' } : net.body),
  };
};
function resetNet(status = 200, reply = null) {
  net.calls = [];
  net.status = status;
  net.reply = reply;
}
function seedSession(token, user = USER) {
  store.data.clear();
  store.removes = 0;
  store.sets = 0;
  if (token) store.data.set(STORAGE_KEY, JSON.stringify({ token, user }));
}

const root = () => dom.window.document.getElementById('root');

(async () => {
  // 1) bundle the real components so Node can execute them
  const out = path.join(HERE, '.auth-session-bundle.cjs');
  const EXTERNAL = ['react', 'react-dom', 'react-dom/server', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom'];
  const bundle = await rolldown({
    input: path.join(HERE, 'auth-session-entry.jsx'),
    platform: 'node',
    external: EXTERNAL,
    // api/client.js reads import.meta.env, which does not exist in a CJS
    // bundle. Vite substitutes it at build time; this does the same job.
    plugins: [{
      name: 'define-import-meta-env',
      transform(code) {
        if (!code.includes('import.meta.env')) return null;
        return {
          code: code.replace(/import\.meta\.env/g, JSON.stringify({ VITE_API_URL: 'http://localhost:5000/api' })),
          map: null,
        };
      },
    }, {
      // LoginPage and LandingPage import images, which Vite turns into URLs.
      // Left alone, rolldown reads the bytes as source and the build dies with
      // UNLOADABLE_DEPENDENCY before a single check runs. Each image becomes
      // its file name instead: nothing here asserts on an image, and no image
      // file is emitted next to the bundle.
      name: 'image-as-filename',
      load(id) {
        if (!/\.(jpe?g|png|gif|webp|svg)$/i.test(id)) return null;
        return { code: `export default ${JSON.stringify(path.basename(id))};`, moduleType: 'js' };
      },
    }],
    onwarn: () => {},
  });
  await bundle.write({ file: out, format: 'cjs' });
  await bundle.close();
  require(out);
  check('real App + AuthProvider bundled and loaded', typeof globalThis.mountApp === 'function');

  const origError = console.error;
  console.error = () => {}; // React act/router noise; keep output readable

  // =========================================================================
  // A. the expiry helper itself
  // =========================================================================
  console.log('\n--- expiry detection ---');
  check('an expired token reads as expired', globalThis.isTokenExpired(EXPIRED) === true);
  check('a valid token reads as not expired', globalThis.isTokenExpired(VALID) === false);
  check('a token with no exp fails OPEN (unchanged behaviour)',
    globalThis.isTokenExpired(makeToken({ sub: '1' })) === false);
  check('garbage fails OPEN rather than logging someone out',
    globalThis.isTokenExpired('not.a.jwt') === false && globalThis.isTokenExpired('') === false
    && globalThis.isTokenExpired(null) === false && globalThis.isTokenExpired(undefined) === false);
  check('the exp claim is read correctly', globalThis.decodeJwtPayload(VALID).exp === VALID_EXP);
  // clock skew: a token that expired 5s ago must NOT be dropped, one an hour
  // ago must be.
  check('a token 5s past exp is kept (clock-skew leeway)',
    globalThis.isTokenExpired(makeToken({ exp: nowSec() - 5 })) === false);
  check('a token 5 minutes past exp is dropped',
    globalThis.isTokenExpired(makeToken({ exp: nowSec() - 300 })) === true);

  // =========================================================================
  // B. DEFECT 1 — an expired token must not render a logged-in view
  // =========================================================================
  console.log('\n--- defect 1: expired session does not render a dashboard ---');
  seedSession(EXPIRED);
  resetNet(200);
  const expiredHtml = await globalThis.mountApp(root(), '/secretary');
  check('lands on the login screen, not the dashboard',
    /sign in|log ?in|password/i.test(expiredHtml) && !/Pending resident/i.test(expiredHtml),
    `${expiredHtml.length} chars`);
  check('NO request was fired at all', net.calls.length === 0, `${net.calls.length} call(s)`);
  check('the dead session was purged from localStorage', store.data.has(STORAGE_KEY) === false);

  // the control: the same mount with a live token DOES render the dashboard
  seedSession(VALID);
  resetNet(200);
  const validHtml = await globalThis.mountApp(root(), '/secretary');
  // The account menu button is in the dashboard header and nowhere on the
  // login screen. This used to look for the text "Log out", which moved INTO
  // the closed account menu and so is no longer in the markup at all; before
  // that it asserted the ABSENCE of "Sign in to BrgyServe", a string the app
  // has never rendered, so it passed whatever this mount showed.
  check('CONTROL: a valid token still renders the logged-in view',
    /aria-label="Account menu"/.test(validHtml) && !/aria-label="Account menu"/.test(expiredHtml),
    `${validHtml.length} chars`);
  check('CONTROL: the valid session was left in localStorage', store.data.has(STORAGE_KEY) === true);
  check('CONTROL: a valid session sends its request with the token',
    net.calls.length > 0 && net.calls.every((c) => c.token === VALID),
    `${net.calls.length} call(s), all bearing the token`);

  // =========================================================================
  // C. DEFECT 2 — one 401 means exactly one logout
  // =========================================================================
  console.log('\n--- defect 2: a 401 burst produces exactly one logout ---');
  seedSession(VALID);
  resetNet(401);
  const BURST = 6; // the Secretary review screen's real worst case
  const statuses = await globalThis.mountBurst(root(), BURST);
  check(`all ${BURST} concurrent requests rejected with 401`,
    Array.isArray(statuses) && statuses.length === BURST && statuses.every((s) => s === 401),
    JSON.stringify(statuses));
  check('EXACTLY ONE logout, not one per failed request',
    store.removes === 1, `${store.removes} teardown(s) for ${BURST} failures`);
  check('no token-less request was fired',
    net.calls.every((c) => c.token === VALID), `${net.calls.filter((c) => !c.token).length} token-less`);
  check('no request was retried after the session ended',
    net.calls.length <= BURST, `${net.calls.length} call(s) for ${BURST} requests`);

  // =========================================================================
  // D. after the session ends, nothing else leaves the browser
  // =========================================================================
  console.log('\n--- after teardown: no further requests, no further logouts ---');
  seedSession(VALID);
  resetNet(401);
  const probe = await globalThis.mountProbe(root());
  const first = await probe.call('/first');
  check('the first request goes out and 401s', net.calls.length === 1 && first.status === 401);
  check('it ended the session once', store.removes === 1, `${store.removes}`);
  const after = await probe.call('/second');
  check('a later call is short-circuited, never sent', net.calls.length === 1, `${net.calls.length} call(s) total`);
  check('it still reports 401 to the caller', after.status === 401, after.message);
  check('and did NOT tear the session down again', store.removes === 1, `${store.removes}`);
  await probe.unmount();

  // a manual logout followed by a straggler behaves the same way
  seedSession(VALID);
  resetNet(200);
  const probe2 = await globalThis.mountProbe(root());
  await probe2.logout();
  check('manual logout tears down once', store.removes === 1, `${store.removes}`);
  await probe2.call('/straggler');
  check('a straggler after manual logout is not sent', net.calls.length === 0, `${net.calls.length} call(s)`);
  check('and does not log out again', store.removes === 1, `${store.removes}`);
  await probe2.unmount();

  // =========================================================================
  // E. authFetch identity — the actual cascade mechanism
  // =========================================================================
  console.log('\n--- authFetch identity is stable (what re-fired the loaders) ---');
  seedSession(VALID);
  resetNet(401);
  const probe3 = await globalThis.mountProbe(root());
  const before = probe3.authFetchRef();
  await probe3.call('/trigger-logout');
  const afterRef = probe3.authFetchRef();
  check('authFetch keeps the same identity across a session teardown',
    before === afterRef,
    before === afterRef ? 'stable — dependent effects do not re-run' : 'CHANGED — every loader effect would re-fire');
  check('the session did end (the teardown really happened)', probe3.user() === null);
  await probe3.unmount();

  // =========================================================================
  // F. an expired token mid-session is caught before the request goes out
  // =========================================================================
  console.log('\n--- expired mid-session: caught before hitting the network ---');
  seedSession(EXPIRED);
  store.data.set(STORAGE_KEY, JSON.stringify({ token: EXPIRED, user: USER }));
  resetNet(200);
  const probe4 = await globalThis.mountProbe(root());
  const dead = await probe4.call('/anything');
  check('the request is never sent', net.calls.length === 0, `${net.calls.length} call(s)`);
  check('the caller gets a 401 it can handle', dead.status === 401, dead.message);
  await probe4.unmount();

  // =========================================================================
  // G. a wrong current password keeps the session
  // =========================================================================
  // POST /auth/change-password answers a mistyped current password with 400
  // and this message (asserted on the server side by backend reset:test,
  // section L). authFetch ends the session on ANY 401, so this answer must
  // never be one: when it was, the person landed on /login without seeing why.
  console.log('\n--- wrong current password: the session stays, the message shows ---');
  const WRONG_CURRENT = { error: 'Current password is incorrect' };
  const submitChange = async () => {
    const page = await globalThis.mountInteractive(root(), '/change-password');
    await page.fill('input[autocomplete="current-password"]', 'NotTheCurrent-99!');
    await page.fill('input[autocomplete="new-password"]', 'Changed-Pass-2026!', 0);
    await page.fill('input[autocomplete="new-password"]', 'Changed-Pass-2026!', 1);
    await page.submit();
    return page;
  };

  seedSession(VALID);
  resetNet(400, WRONG_CURRENT);
  const kept = await submitChange();
  const keptAlert = root().querySelector('.alert.error');
  check('the change request went out once, with the session token',
    net.calls.length === 1 && net.calls[0].url.endsWith('/auth/change-password') && net.calls[0].token === VALID,
    `${net.calls.length} call(s)`);
  check("the server's message is shown on the form",
    keptAlert?.textContent === WRONG_CURRENT.error, JSON.stringify(keptAlert?.textContent ?? null));
  check('still on the change-password screen, not sent to /login',
    root().querySelector('h1')?.textContent === 'Change password' && !/Forgot your password\?/.test(kept.html()));
  check('the session was NOT ended', store.removes === 0 && store.data.has(STORAGE_KEY),
    `${store.removes} teardown(s)`);
  await kept.unmount();

  // CONTROL: the same answer with the 401 the server used to send. It must end
  // the session, or the checks above could not tell the two apart.
  seedSession(VALID);
  resetNet(401, WRONG_CURRENT);
  const lost = await submitChange();
  check('CONTROL: answered with 401, the session IS ended',
    store.removes === 1 && !store.data.has(STORAGE_KEY), `${store.removes} teardown(s)`);
  check('CONTROL: and the person is on the login screen, without the message',
    /Forgot your password\?/.test(lost.html()) && !lost.html().includes(WRONG_CURRENT.error));
  await lost.unmount();

  // =========================================================================
  // H. the account menu, the Profile page, and the voluntary password change
  // =========================================================================
  // The menu replaced the Log out button in BOTH top bars. jsdom applies no
  // stylesheet, so both headers are in the DOM here, as they are in the
  // browser before CSS hides one; interactions use the narrow header's menu,
  // which comes first in the markup.
  console.log('\n--- account menu, Profile page, voluntary change ---');
  const RES_USER = { user_id: 2, username: 'res_one', role: 'resident', must_change_password: false };
  const RES_TOKEN = makeToken({ sub: '2', role: 'resident', exp: VALID_EXP });
  const FORCED_USER = { ...USER, must_change_password: true };
  const STAFF_PROFILE = {
    user: { username: 'secretary1', email: 'sec@example.invalid', role: 'secretary', email_verified: true },
    profile: { first_name: 'Ana', middle_name: null, last_name: 'Secretario', suffix: null, birthdate: null, address: null, phone_number: null },
  };
  const RESIDENT_PROFILE = {
    user: { username: 'res_one', email: 'res@example.invalid', role: 'resident', email_verified: false },
    profile: { first_name: 'Rita', middle_name: 'Cruz', last_name: 'Residente', suffix: null, birthdate: '1990-02-03', address: 'Purok 1, Ubujan', phone_number: '09170000001' },
    linked: true,
  };
  // The profile endpoint, a successful password change, and an empty list in
  // its real shape for each page loader these mounts pass through.
  const answer = (profileBody) => (url, method) => {
    if (url.endsWith('/auth/profile')) return profileBody;
    if (url.endsWith('/auth/change-password') && method === 'POST') return { message: 'Password changed successfully' };
    if (url.includes('/document-types/all')) return { document_types: [] };
    if (url.includes('/secretary/staff-accounts')) return { accounts: [] };
    if (url.includes('/secretary/pending-residents')) return { pending: [] };
    return undefined;
  };
  const labels = (page) => page.queryAll('dt').map((d) => d.textContent);

  seedSession(VALID);
  resetNet(200, answer(STAFF_PROFILE));
  const menuPage = await globalThis.mountInteractive(root(), '/secretary/document-types');
  const menuButtons = menuPage.queryAll('button[aria-label="Account menu"]');
  check('the account menu is in BOTH top bars (CSS shows one at any width)',
    menuButtons.length === 2 && !!menuPage.query('.dash-user .account-menu-btn')
      && !!menuPage.query('.page-header-wrapper .account-menu-btn'), `${menuButtons.length} button(s)`);
  check('  each with aria-haspopup="menu", aria-expanded="false" and a title',
    menuButtons.every((b) => b.getAttribute('aria-haspopup') === 'menu'
      && b.getAttribute('aria-expanded') === 'false' && !!b.getAttribute('title')));
  check('no Log out button is left in either top bar, and "Log out" is nowhere until the menu opens',
    !menuPage.queryAll('.dash-user button, .page-header-wrapper button').some((b) => /Log out/.test(b.textContent))
      && !/Log out/.test(menuPage.html()));

  const menuBtn = menuButtons[0];
  const items = () => menuPage.queryAll('[role="menu"] [role="menuitem"]');
  await menuPage.click(menuBtn);
  check('a click opens it: Profile and Log out as role="menuitem" in role="menu", under "@secretary1"',
    menuBtn.getAttribute('aria-expanded') === 'true' && items().map((i) => i.textContent).join('|') === 'Profile|Log out'
      && /@secretary1/.test(menuPage.query('.account-menu-panel')?.textContent || ''),
    items().map((i) => i.textContent).join('|'));
  check('  focus moves to the first item', menuPage.active() === items()[0]);
  await menuPage.key('ArrowDown');
  check('ArrowDown moves to Log out', menuPage.active() === items()[1]);
  await menuPage.key('ArrowDown');
  check('  and wraps round to Profile', menuPage.active() === items()[0]);
  await menuPage.click(menuBtn);
  check('a second click on the button closes it',
    items().length === 0 && menuBtn.getAttribute('aria-expanded') === 'false');
  await menuPage.click(menuBtn);
  await menuPage.pressOutside();
  check('a press outside closes it', items().length === 0);
  await menuPage.click(menuBtn);
  await menuPage.key('Escape');
  check('Escape closes it and puts focus back on the button', items().length === 0 && menuPage.active() === menuBtn);
  await menuPage.key('ArrowDown', menuBtn);
  check('ArrowDown on the button opens it with focus on the first item',
    items().length === 2 && menuPage.active() === items()[0]);

  net.calls = [];
  await menuPage.click(items()[0]);
  await menuPage.settle();
  check('"Profile" goes to /profile, which fetches /auth/profile and shows the account',
    menuPage.query('.page-title h1')?.textContent === 'My profile'
      && net.calls.some((c) => c.url.endsWith('/auth/profile'))
      && /@secretary1/.test(menuPage.query('.pending-card')?.textContent || ''));
  check('  and the menu closed behind it', items().length === 0);
  const staffLabels = labels(menuPage);
  check('a staff-type profile has name and contact rows and NO birthdate or address row',
    ['Username', 'Email', 'Role', 'First name', 'Last name', 'Contact number'].every((l) => staffLabels.includes(l))
      && !staffLabels.includes('Birthdate') && !staffLabels.includes('Address'), staffLabels.join(', '));
  check('  blanks read "Not provided", and there is no Barangay Office line',
    /Not provided/.test(menuPage.html()) && !/contact the Barangay Office/.test(menuPage.html()));
  check('  "Change password" links to /change-password',
    menuPage.query('a[href="/change-password"]')?.textContent === 'Change password');

  await menuPage.click('button[aria-label="Account menu"]');
  await menuPage.click(items()[1]);
  check('"Log out" in the menu ends the session once and lands on the login screen',
    store.removes === 1 && !store.data.has(STORAGE_KEY) && /Forgot your password\?/.test(menuPage.html()),
    `${store.removes} teardown(s)`);
  await menuPage.unmount();

  seedSession(RES_TOKEN, RES_USER);
  resetNet(200, answer(RESIDENT_PROFILE));
  const residentPage = await globalThis.mountInteractive(root(), '/profile');
  await residentPage.settle();
  const residentLabels = labels(residentPage);
  check('a resident profile shows birthdate, address and contact number',
    ['Birthdate', 'Address', 'Contact number'].every((l) => residentLabels.includes(l))
      && /1990-02-03/.test(residentPage.html()) && /Purok 1, Ubujan/.test(residentPage.html()), residentLabels.join(', '));
  check('  and the line about correcting details at the Barangay Office',
    /To correct your name, birthdate or address, contact the Barangay Office\./.test(residentPage.html()));
  await residentPage.unmount();

  seedSession(VALID, FORCED_USER);
  resetNet(200, answer(STAFF_PROFILE));
  const forcedPage = await globalThis.mountInteractive(root(), '/profile');
  await forcedPage.settle();
  check('/profile sends a user on a temporary password to /change-password, without fetching the profile',
    forcedPage.query('h1')?.textContent === 'Change password' && !net.calls.some((c) => c.url.endsWith('/auth/profile')));
  check('  where there is no "Back to profile", and "Sign out instead" stays',
    !/Back to profile/.test(forcedPage.html()) && /Sign out instead/.test(forcedPage.html()));
  await forcedPage.fill('input[autocomplete="current-password"]', 'Temporary-Pass-1!');
  await forcedPage.fill('input[autocomplete="new-password"]', 'Brand-New-Pass-2026!', 0);
  await forcedPage.fill('input[autocomplete="new-password"]', 'Brand-New-Pass-2026!', 1);
  await forcedPage.submit();
  await forcedPage.settle();
  check('a forced change still goes to the role home, with no notice',
    forcedPage.query('.page-title h1')?.textContent === 'Resident review' && !/Password changed\./.test(forcedPage.html()),
    forcedPage.query('.page-title h1')?.textContent);
  await forcedPage.unmount();

  seedSession(VALID);
  resetNet(200, answer(STAFF_PROFILE));
  const voluntaryPage = await globalThis.mountInteractive(root(), '/change-password');
  check('a voluntary change shows "Back to profile" (to /profile) and still offers "Sign out instead"',
    voluntaryPage.query('a[href="/profile"]')?.textContent === 'Back to profile' && /Sign out instead/.test(voluntaryPage.html()));
  await voluntaryPage.fill('input[autocomplete="current-password"]', 'Old-Pass-2026!');
  await voluntaryPage.fill('input[autocomplete="new-password"]', 'Brand-New-Pass-2026!', 0);
  await voluntaryPage.fill('input[autocomplete="new-password"]', 'Brand-New-Pass-2026!', 1);
  await voluntaryPage.submit();
  await voluntaryPage.settle();
  check('after a voluntary change it returns to /profile with "Password changed."',
    voluntaryPage.query('.page-title h1')?.textContent === 'My profile'
      && voluntaryPage.query('.alert.success')?.textContent === 'Password changed.',
    voluntaryPage.query('.page-title h1')?.textContent);
  check('  and the session is kept', store.removes === 0 && store.data.has(STORAGE_KEY), `${store.removes} teardown(s)`);
  await voluntaryPage.unmount();

  console.error = origError;
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
});
