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
// Section I is the /set-password page's check of its link: what it shows
// while the check is out, for a usable link, a dead one, and a check that
// could not be made, and that the check sends the token in its body, with no
// session header, and leaves a signed-in session alone.
//
// Section J is the Secretary's Staff accounts page: its route, the account
// menu item that opens it, and that no other role gets either.
//
// Section K is Resident review without the staff section: no staff list, no
// request for one, and the residents' queue still all there.
//
// Section L is the Staff accounts page itself: one heading, two-line rows,
// the search box, and the create, send and confirmation behaviour the page
// must keep.
//
// Section M is the Payments page's charges list: a load that fails says so,
// with Try again, and never shows an empty list; every way of loading again
// starts from the loading state; and an older answer that arrives late cannot
// replace a newer one.
//
// Section N is the Payments page's Method column: how each paid charge was
// paid, read from its payment record; what an unpaid or void charge shows
// instead; and the paid charge's View panel, which shows the record itself.
//
// Section O is the Payments page's search, type tabs, totals and paging: the
// pure helpers case by case, then the real page against 64 stubbed charges.
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
// Each call also records the body it was sent. `fail` makes fetch reject, the
// way a browser does when the server cannot be reached. `hold` keeps every
// answer back until the test calls `net.held[i](status, reply)`, so a test can
// choose the order answers arrive in.
const net = { calls: [], status: 200, body: { ok: true }, reply: null, fail: false, hold: false, held: [] };
global.fetch = async (url, options = {}) => {
  const auth = options.headers?.Authorization || null;
  net.calls.push({
    url: String(url),
    method: options.method || 'GET',
    token: auth ? auth.replace('Bearer ', '') : null,
    body: options.body ?? null,
  });
  if (net.fail) throw new TypeError('Failed to fetch');
  const answer = (status, reply) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => reply ?? (status === 401 ? { error: 'Invalid or expired token' } : net.body),
  });
  if (net.hold) return new Promise((resolve) => net.held.push((status, reply) => resolve(answer(status, reply))));
  const reply = typeof net.reply === 'function' ? net.reply(String(url), options.method || 'GET') : net.reply;
  return answer(net.status, reply);
};
function resetNet(status = 200, reply = null) {
  net.calls = [];
  net.status = status;
  net.reply = reply;
  net.fail = false;
  net.hold = false;
  net.held = [];
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
  // which comes first in the markup. These mounts are the Secretary's, whose
  // menu has a third item, Staff accounts, between the two (section J).
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
  // its real shape for each page loader these mounts pass through, the four
  // role homes section J lands on included.
  const answer = (profileBody) => (url, method) => {
    if (url.endsWith('/auth/profile')) return profileBody;
    if (url.endsWith('/auth/change-password') && method === 'POST') return { message: 'Password changed successfully' };
    if (url.includes('/document-types/all')) return { document_types: [] };
    if (url.includes('/secretary/staff-accounts')) return { accounts: [] };
    if (url.includes('/secretary/pending-residents')) return { pending: [] };
    if (url.includes('/rental-requests?')) return { requests: [] };
    if (url.includes('/charges?status=')) return { charges: [] };
    if (url.includes('/document-requests/mine')) return { requests: [] };
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
  const focused = () => menuPage.active()?.textContent;
  await menuPage.click(menuBtn);
  check('a click opens it: Profile, Staff accounts and Log out as role="menuitem" in role="menu", under "@secretary1"',
    menuBtn.getAttribute('aria-expanded') === 'true' && items().map((i) => i.textContent).join('|') === 'Profile|Staff accounts|Log out'
      && /@secretary1/.test(menuPage.query('.account-menu-panel')?.textContent || ''),
    items().map((i) => i.textContent).join('|'));
  check('  focus moves to the first item', menuPage.active() === items()[0]);
  await menuPage.key('ArrowDown');
  check('ArrowDown moves to Staff accounts', focused() === 'Staff accounts', focused());
  await menuPage.key('ArrowDown');
  check('  then to Log out', focused() === 'Log out', focused());
  await menuPage.key('ArrowDown');
  check('  and wraps round to Profile', menuPage.active() === items()[0], focused());
  await menuPage.key('ArrowUp');
  check('ArrowUp on Profile wraps round to Log out', focused() === 'Log out', focused());
  await menuPage.key('Home');
  const homeKeyOn = focused();
  await menuPage.key('End');
  check('  Home goes to Profile and End to Log out', homeKeyOn === 'Profile' && focused() === 'Log out',
    `${homeKeyOn} / ${focused()}`);
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
    items().length === 3 && menuPage.active() === items()[0]);

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
  await menuPage.click(items().find((i) => i.textContent === 'Log out'));
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

  // =========================================================================
  // I. /set-password checks its link before it shows the form
  // =========================================================================
  // The page asks POST /auth/set-password/check as soon as it opens. Only the
  // server's dead-link code makes it call the link dead; a check that could
  // not be made (no network, a server still waking, a 429, a 500) gets "Try
  // again" and never a verdict. The page reads its token from
  // window.location, not from the router, so each mount sets jsdom's address
  // first. LINK stands in for a token; it is not one.
  console.log('\n--- /set-password: the link is checked before the form shows ---');
  const LINK = 'stand-in-for-a-set-password-link-token-01';
  const DEAD_LINK = {
    error: 'This set-password link is no longer valid. Links work only once and expire after 72 hours, so this happens most often when the link has already been used or an older email was opened. Please ask the Barangay Office to send you a new link.',
    code: 'SET_PASSWORD_TOKEN_INVALID',
  };
  const CHECK_FAILED =
    'We could not check this link just now. The system may still be starting up, which can take up to a minute. Checking does not use the link up.';
  const TOO_MANY = {
    error: 'Too many link checks from this connection. Please wait 15 minutes and try again. Checking a link does not use it up.',
  };
  const SET_OK = {
    message: 'Your password is set. You can now sign in with your username and this password. Your username is in the email that brought you here.',
  };
  const NEW_PASSWORD = 'Brand-New-Set-2026!';
  const openSetPassword = (search, options) => {
    dom.window.history.replaceState(null, '', `/set-password${search}`);
    return globalThis.mountInteractive(root(), `/set-password${search}`, options);
  };
  const sentBody = (call) => {
    try { return JSON.parse(call?.body || ''); } catch { return null; }
  };
  const isCheck = (call) => call?.method === 'POST' && call.url.endsWith('/auth/set-password/check');
  const passwordFields = (page) => page.queryAll('input[autocomplete="new-password"]');
  const tryAgainButton = (page) => page.queryAll('button').find((b) => b.textContent === 'Try again');
  const deadPanel = (page) => page.query('h1')?.textContent === 'This link no longer works';
  // Answers the i-th held request. A request that was never sent fails the
  // checks that need it instead of crashing the run before the rest.
  const release = (i, status, reply) => {
    if (typeof net.held[i] === 'function') net.held[i](status, reply);
  };

  seedSession(null);
  resetNet(200);
  const noToken = await openSetPassword('');
  await noToken.settle();
  check('no token in the address: the no-code panel, and no request at all',
    deadPanel(noToken) && /has no set-password code in it/.test(noToken.html()) && net.calls.length === 0,
    `${net.calls.length} call(s)`);
  await noToken.unmount();

  seedSession(null);
  resetNet(200);
  net.hold = true;
  const setPage = await openSetPassword(`?token=${LINK}`);
  const checkingSubtitle = setPage.query('.subtitle')?.textContent;
  check('while the check is out: "Checking your link…" under the usual heading, and no form',
    setPage.query('h1')?.textContent === 'Set your password' && !!checkingSubtitle
      && setPage.query('p.muted[role="status"]')?.textContent === 'Checking your link…'
      && passwordFields(setPage).length === 0 && !deadPanel(setPage));
  check('  one request: POST /auth/set-password/check, with the token in its BODY',
    net.calls.length === 1 && isCheck(net.calls[0]) && sentBody(net.calls[0])?.token === LINK,
    `${net.calls.length} call(s)`);
  check('  not in its URL, and with no session header',
    !net.calls[0]?.url.includes(LINK) && net.calls[0]?.token === null);
  check('  and the address bar was cleaned, as before',
    dom.window.location.pathname === '/set-password' && dom.window.location.search === '');
  release(0, 200, { usable: true });
  await setPage.settle();
  check("a usable answer shows today's form under the same heading, and the checking line is gone",
    passwordFields(setPage).length === 2 && setPage.query('form h1')?.textContent === 'Set your password'
      && setPage.query('.subtitle')?.textContent === checkingSubtitle && !setPage.query('[role="status"]'));
  await setPage.fill('input[autocomplete="new-password"]', NEW_PASSWORD, 0);
  await setPage.fill('input[autocomplete="new-password"]', NEW_PASSWORD, 1);
  await setPage.submit();
  check('submitting sends POST /auth/set-password with the same token and the password, no session header',
    net.calls.length === 2 && net.calls[1].method === 'POST' && net.calls[1].url.endsWith('/auth/set-password')
      && sentBody(net.calls[1])?.token === LINK && sentBody(net.calls[1])?.new_password === NEW_PASSWORD
      && net.calls[1].token === null, `${net.calls.length} call(s)`);
  release(1, 200, SET_OK);
  await setPage.settle();
  check("  and a success shows \"Password set\" with the server's message",
    setPage.query('h1')?.textContent === 'Password set' && setPage.query('.alert.success')?.textContent === SET_OK.message);
  await setPage.unmount();

  seedSession(null);
  resetNet(400, DEAD_LINK);
  const deadOnOpen = await openSetPassword(`?token=${LINK}`);
  await deadOnOpen.settle();
  check("a dead answer shows the dead-link panel with the server's message, and no form",
    deadPanel(deadOnOpen) && deadOnOpen.query('.alert.error')?.textContent === DEAD_LINK.error
      && !deadOnOpen.query('input') && !!deadOnOpen.query('a[href="/login"]'));
  await deadOnOpen.unmount();

  seedSession(null);
  resetNet(400, { error: 'Invalid JSON in request body' });
  const otherBadRequest = await openSetPassword(`?token=${LINK}`);
  await otherBadRequest.settle();
  check('a 400 WITHOUT the dead-link code is not a verdict: the could-not-check note',
    !deadPanel(otherBadRequest) && otherBadRequest.query('.alert.info')?.textContent === CHECK_FAILED
      && !otherBadRequest.query('input'));
  await otherBadRequest.unmount();

  seedSession(null);
  resetNet(200, { usable: true });
  net.fail = true;
  const offline = await openSetPassword(`?token=${LINK}`);
  await offline.settle();
  check('no network: the could-not-check note in blue, "Try again" and "Back to sign in"',
    offline.query('.alert.info')?.textContent === CHECK_FAILED && !!tryAgainButton(offline)
      && !!offline.query('a[href="/login"]') && offline.query('h1')?.textContent === 'Set your password');
  check('  and NOT the dead-link panel, and no form', !deadPanel(offline) && !offline.query('input'));
  net.fail = false;
  if (tryAgainButton(offline)) await offline.click(tryAgainButton(offline));
  check('"Try again" asks once more, and a usable answer then shows the form',
    net.calls.length === 2 && isCheck(net.calls[1]) && sentBody(net.calls[1])?.token === LINK
      && passwordFields(offline).length === 2, `${net.calls.length} call(s)`);
  await offline.unmount();

  seedSession(null);
  resetNet(429, TOO_MANY);
  const limited = await openSetPassword(`?token=${LINK}`);
  await limited.settle();
  check("a 429 shows the limiter's own message, with \"Try again\", and not the dead-link panel",
    limited.query('.alert.info')?.textContent === TOO_MANY.error && !!tryAgainButton(limited) && !deadPanel(limited),
    JSON.stringify(limited.query('.alert.info')?.textContent ?? null));
  await limited.unmount();

  seedSession(null);
  resetNet(500, { error: 'Internal server error' });
  const broken = await openSetPassword(`?token=${LINK}`);
  await broken.settle();
  check("a 500 shows the page's own sentence, never \"Internal server error\", and not the dead-link panel",
    broken.query('.alert.info')?.textContent === CHECK_FAILED && !/Internal server error/.test(broken.html())
      && !deadPanel(broken));
  await broken.unmount();

  seedSession(VALID);
  resetNet(200, { usable: true });
  const signedIn = await openSetPassword(`?token=${LINK}`);
  await signedIn.settle();
  check('signed in: the check still carries no session header, and the form shows',
    net.calls.length === 1 && isCheck(net.calls[0]) && net.calls[0].token === null
      && passwordFields(signedIn).length === 2, `${net.calls.length} call(s)`);
  check('  and the signed-in session is left alone',
    store.removes === 0 && store.data.has(STORAGE_KEY), `${store.removes} teardown(s)`);
  await signedIn.unmount();

  // The accepted trade-off: a link can die between the check and the submit.
  seedSession(null);
  resetNet(200);
  net.hold = true;
  const diesLater = await openSetPassword(`?token=${LINK}`);
  release(0, 200, { usable: true });
  await diesLater.settle();
  await diesLater.fill('input[autocomplete="new-password"]', NEW_PASSWORD, 0);
  await diesLater.fill('input[autocomplete="new-password"]', NEW_PASSWORD, 1);
  await diesLater.submit();
  release(1, 400, DEAD_LINK);
  await diesLater.settle();
  check('a link that dies between the check and the submit still lands on the dead-link panel',
    deadPanel(diesLater) && diesLater.query('.alert.error')?.textContent === DEAD_LINK.error
      && !diesLater.query('input'));
  await diesLater.unmount();

  // StrictMode runs the effect twice on mount, as the dev server does: the
  // first check is cleaned up, and its answer must be ignored however late
  // it arrives. Here it arrives last, and dead.
  seedSession(null);
  resetNet(200);
  net.hold = true;
  const strict = await openSetPassword(`?token=${LINK}`, { strict: true });
  check('under StrictMode two checks go out, and both carry the token',
    net.calls.length === 2 && net.calls.every((c) => isCheck(c) && sentBody(c)?.token === LINK),
    `${net.calls.length} call(s)`);
  release(1, 200, { usable: true });
  await strict.settle();
  release(0, 400, DEAD_LINK);
  await strict.settle();
  check('  the late answer to the cleaned-up first check is ignored: the form stays',
    passwordFields(strict).length === 2 && !deadPanel(strict));
  await strict.unmount();
  dom.window.history.replaceState(null, '', '/');

  // =========================================================================
  // J. Staff accounts: a Secretary-only page, opened from the account menu
  // =========================================================================
  // The page has its own route, /secretary/staff-accounts, and is reached
  // from the account menu, not the sidebar. Only the Secretary's menu offers
  // it. Every other role's menu is still exactly Profile and Log out, and its
  // arrow keys wrap with no gap where the Secretary's item would be.
  //
  // The MemoryRouter here exposes no address, so where a mount landed is read
  // from the page: its title, and the sidebar link marked aria-current="page".
  // NavLink sets that from the router's own location, and each role home is
  // the exact-match first link of that role's nav, so the link names the
  // address. No sidebar link is current on Staff accounts, which has none.
  console.log('\n--- Staff accounts: a Secretary-only page, opened from the account menu ---');
  const menuItems = (page) => page.queryAll('[role="menu"] [role="menuitem"]');
  const menuLabels = (page) => menuItems(page).map((i) => i.textContent).join(' | ');
  const itemNamed = (page, label) => menuItems(page).find((i) => i.textContent === label);
  const pageTitle = (page) => page.query('.page-title h1')?.textContent ?? null;
  const currentNav = (page) => page.query('.dash-side-nav a[aria-current="page"]')?.getAttribute('href') ?? null;
  const staffListCalls = () => net.calls.filter((c) => c.url.endsWith('/secretary/staff-accounts'));

  seedSession(VALID);
  resetNet(200, answer(STAFF_PROFILE));
  const staffDirect = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  await staffDirect.settle();
  check('the Secretary opening /secretary/staff-accounts gets the Staff accounts page, not Resident review',
    pageTitle(staffDirect) === 'Staff accounts' && currentNav(staffDirect) === null,
    `title ${JSON.stringify(pageTitle(staffDirect))}, current sidebar link ${currentNav(staffDirect)}`);
  await staffDirect.unmount();

  seedSession(VALID);
  resetNet(200, answer(STAFF_PROFILE));
  const staffViaMenu = await globalThis.mountInteractive(root(), '/secretary/document-types');
  await staffViaMenu.click('button[aria-label="Account menu"]');
  const staffItem = itemNamed(staffViaMenu, 'Staff accounts');
  check('the Secretary\'s account menu offers "Staff accounts"', !!staffItem, menuLabels(staffViaMenu));
  net.calls = [];
  if (staffItem) await staffViaMenu.click(staffItem);
  await staffViaMenu.settle();
  check('  choosing it opens the Staff accounts page, and the menu closes behind it',
    pageTitle(staffViaMenu) === 'Staff accounts' && currentNav(staffViaMenu) === null && menuItems(staffViaMenu).length === 0,
    `title ${JSON.stringify(pageTitle(staffViaMenu))}`);
  check('  which asks GET /secretary/staff-accounts with the session and shows "New staff account"',
    staffListCalls().length === 1 && staffListCalls()[0].method === 'GET' && staffListCalls()[0].token === VALID
      && staffViaMenu.queryAll('button').some((b) => b.textContent === 'New staff account'),
    `${staffListCalls().length} staff-accounts request(s)`);
  await staffViaMenu.unmount();

  const OTHER_ROLES = [
    { role: 'punong_barangay', home: '/punong-barangay' },
    { role: 'treasurer', home: '/treasurer' },
    { role: 'staff', home: '/staff' },
    { role: 'resident', home: '/resident' },
  ];
  for (const { role, home } of OTHER_ROLES) {
    seedSession(makeToken({ sub: '7', role, exp: VALID_EXP }), { user_id: 7, username: `${role}_one`, role, must_change_password: false });
    resetNet(200, answer(STAFF_PROFILE));
    const other = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
    await other.settle();
    check(`${role} opening /secretary/staff-accounts is sent to ${home}, with no staff-accounts request`,
      currentNav(other) === home && pageTitle(other) !== 'Staff accounts'
        && !net.calls.some((c) => c.url.includes('/secretary/staff-accounts')),
      `current sidebar link ${currentNav(other)}, title ${JSON.stringify(pageTitle(other))}, `
        + `${net.calls.filter((c) => c.url.includes('/secretary/staff-accounts')).length} staff-accounts request(s)`);
    await other.click('button[aria-label="Account menu"]');
    check(`  the ${role} menu is exactly Profile | Log out`, menuLabels(other) === 'Profile | Log out', menuLabels(other));
    const logOut = itemNamed(other, 'Log out');
    if (logOut) await other.key('ArrowDown', logOut);
    check(`  ${role}: ArrowDown on Log out wraps round to Profile`, other.active()?.textContent === 'Profile',
      `focus on ${JSON.stringify(other.active()?.textContent)}`);
    const profile = itemNamed(other, 'Profile');
    if (profile) await other.key('ArrowUp', profile);
    check(`  ${role}: ArrowUp on Profile wraps round to Log out`, other.active()?.textContent === 'Log out',
      `focus on ${JSON.stringify(other.active()?.textContent)}`);
    await other.unmount();
  }

  seedSession(VALID, FORCED_USER);
  resetNet(200, answer(STAFF_PROFILE));
  const forcedStaff = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  await forcedStaff.settle();
  check('a Secretary on a temporary password is still sent to /change-password, with no staff-accounts request',
    forcedStaff.query('h1')?.textContent === 'Change password'
      && !net.calls.some((c) => c.url.includes('/secretary/staff-accounts')),
    JSON.stringify(forcedStaff.query('h1')?.textContent ?? null));
  await forcedStaff.unmount();

  // =========================================================================
  // K. Resident review is the residents' queue only
  // =========================================================================
  // The staff section has its own page (section J), so Resident review neither
  // shows it nor asks for the staff list. The queue must still be all there:
  // the page gets two pending accounts, one unlinked and one linked, in the
  // real shape of GET /secretary/pending-residents, so a removal that took the
  // queue with it fails here instead of passing as "no staff section".
  console.log('\n--- Resident review: the residents\' queue only ---');
  const queueRow = (over) => ({
    user_id: 0, username: '', email: '', is_rejected: false, rejection_reason: null, rejection_note: null,
    rejected_at: null, rejected_by_user_id: null, rejected_by_username: null, linked_record: null, ...over,
  });
  const queueProfile = (over) => ({
    resident_id: null, first_name: '', middle_name: null, last_name: '', suffix: null, birthdate: null,
    address: null, phone_number: null, resident_records: null, ...over,
  });
  const QUEUE = { status: 'pending', pending: [
    queueRow({ user_id: 31, username: 'queue_unlinked', email: 'queue.unlinked@example.invalid',
      profiles: queueProfile({ first_name: 'Una', last_name: 'Queue', birthdate: '1990-01-02', address: 'Purok 1' }) }),
    queueRow({ user_id: 32, username: 'queue_linked', email: 'queue.linked@example.invalid',
      profiles: queueProfile({ resident_id: 77, first_name: 'Lino', last_name: 'Queue',
        resident_records: { resident_id: 77, masterlist_registered_on: null } }),
      linked_record: { resident_id: 77, masterlist_registered_on: null, residency: null } }),
  ] };
  // The queue and the unlinked account's suggestions; everything else as in
  // section H. Suggestions first: their URL also contains pending-residents.
  const queueAnswer = (url, method) => {
    if (url.endsWith('/secretary/pending-residents/31/match-suggestions')) {
      return { claimed: QUEUE.pending[0].profiles, suggestions: [] };
    }
    if (url.includes('/secretary/pending-residents?status=pending')) return QUEUE;
    return answer(STAFF_PROFILE)(url, method);
  };
  const buttonsIn = (card) => (card ? [...card.querySelectorAll('button')].map((b) => b.textContent) : []);

  seedSession(VALID);
  resetNet(200, queueAnswer);
  const review = await globalThis.mountInteractive(root(), '/secretary');
  await review.settle();
  const subtitles = [review.query('.page-title span')?.textContent, review.query('.dash-header-section p')?.textContent];
  check('Resident review keeps its title, and its subtitle is "Review pending resident registrations" in both headers',
    pageTitle(review) === 'Resident review' && subtitles.every((s) => s === 'Review pending resident registrations'),
    JSON.stringify(subtitles));
  check('  no "New staff account" button',
    !review.queryAll('button').some((b) => b.textContent === 'New staff account'));
  const staffHeadings = review.queryAll('h1, h2, h3, h4, h5, h6').map((h) => h.textContent).filter((t) => /Staff accounts/.test(t));
  check('  no "Staff accounts" heading', staffHeadings.length === 0, staffHeadings.join(' / '));
  check('  and no request for the staff list',
    !net.calls.some((c) => c.url.includes('/secretary/staff-accounts')),
    net.calls.map((c) => c.url.replace(/^https?:\/\/[^/]+\/api/, '')).join(', '));

  const queueCards = review.queryAll('.pending-list > .pending-card');
  const cardNames = queueCards.map((c) => c.querySelector('h3')?.textContent).join(' | ');
  check("the residents' queue still renders: both stubbed accounts, under \"2 accounts awaiting review\"",
    review.query('.list-head h2')?.textContent === '2 accounts awaiting review' && cardNames === 'Una Queue | Lino Queue',
    `${JSON.stringify(review.query('.list-head h2')?.textContent ?? null)}: ${cardNames}`);
  const statusFilter = review.query('.list-head select');
  check('  with the status filter and Refresh',
    statusFilter?.value === 'pending'
      && [...(statusFilter?.options || [])].map((o) => o.textContent).join(' | ') === 'Awaiting review | Rejected | All'
      && review.queryAll('.list-head button').some((b) => b.textContent === 'Refresh'));
  check('  and each card\'s actions: Create & link, Link by ID and Reject when unlinked; Activate and Reject when linked',
    ['Create new resident record & link', 'Link by ID', 'Reject registration'].every((t) => buttonsIn(queueCards[0]).includes(t))
      && ['Activate account', 'Reject registration'].every((t) => buttonsIn(queueCards[1]).includes(t)),
    `${buttonsIn(queueCards[0]).join(', ')} / ${buttonsIn(queueCards[1]).join(', ')}`);
  check('  and the unlinked account\'s match suggestions were asked for',
    net.calls.some((c) => c.url.endsWith('/secretary/pending-residents/31/match-suggestions')));
  await review.unmount();

  // =========================================================================
  // L. The Staff accounts page: one heading, two-line rows, a search box
  // =========================================================================
  // The card no longer repeats the page title, each account is two lines, and
  // a search box filters the list already loaded, without a request. The
  // search HIDES rows rather than removing them, so a row's open "send a
  // link?" question, and the focus, survive typing. A search with no match
  // says so in its own words and never claims there are no accounts.
  //
  // The behaviour around the list is pinned here too: the in-row question,
  // sending, the 15-minute cooldown, and creating an account by email or with
  // a temporary password. There were no frontend checks for any of it; these
  // pass on the page as it was and must still pass on the page as it is.
  console.log('\n--- Staff accounts page: one heading, two-line rows, search, same actions ---');
  // The real GET /secretary/staff-accounts row: newest first, every status.
  const STAFF_LIST = [
    { user_id: 64, username: 'staff_old', role: 'staff', email: 'old.staff@example.invalid', is_active: false, must_change_password: false, last_link_sent_at: null },
    { user_id: 63, username: 'staff_mabini', role: 'staff', email: 'Mabini.Office@Example.invalid', is_active: true, must_change_password: false, last_link_sent_at: '2026-10-05T01:30:00Z' },
    { user_id: 62, username: 'treasurer_dela_cruz', role: 'treasurer', email: 'tdc@example.invalid', is_active: true, must_change_password: true, last_link_sent_at: '2026-10-08T03:00:00Z' },
    { user_id: 61, username: 'kap_reyes', role: 'punong_barangay', email: 'kap.reyes@example.invalid', is_active: true, must_change_password: false, last_link_sent_at: null },
  ];
  const ROLE_TEXT = { punong_barangay: 'Punong Barangay', treasurer: 'Barangay Treasurer', staff: 'Barangay Staff' };
  const SEARCH = '.staff-accounts input[type="search"]';
  // The staff list for GETs, `extra` for anything a check posts, section H's
  // answers for the rest.
  const staffAnswer = (list, extra = () => undefined) => (url, method) => extra(url, method)
    ?? (method === 'GET' && url.endsWith('/secretary/staff-accounts') ? { accounts: list } : answer(STAFF_PROFILE)(url, method));
  const listRows = (page) => page.queryAll('.staff-accounts li.suggestion');
  const shownRows = (page) => listRows(page).filter((li) => !li.hidden && !li.parentElement?.hidden);
  const userOf = (li) => (li.querySelector('strong')?.textContent || '').trim().split(/\s/)[0];
  const shownUsers = (page) => shownRows(page).map(userOf).join(' ');
  const rowOf = (page, username) => listRows(page).find((li) => userOf(li) === `@${username}`);
  const sendButtonOf = (page, username) => [...(rowOf(page, username)?.children || [])].find((c) => c.tagName === 'BUTTON');
  const buttonNamed = (scope, label) => [...scope.querySelectorAll('button')].find((b) => b.textContent === label);
  const questionIn = (page, username) => rowOf(page, username)?.querySelector('.alert.info') ?? null;
  const searchStatus = (page) => page.query('.staff-accounts [role="status"]')?.textContent ?? null;
  const typeSearch = async (page, text) => { if (page.query(SEARCH)) await page.fill(SEARCH, text); };
  const yetShown = (page) => page.queryAll('.staff-accounts p').some((p) => p.textContent === 'No staff accounts yet.');
  const clickIf = async (page, el) => { if (el) await page.click(el); };

  seedSession(VALID);
  resetNet(200, staffAnswer(STAFF_LIST));
  const staffPage = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  await staffPage.settle();
  const titled = staffPage.queryAll('main.dash-main h1, main.dash-main h2, main.dash-main h3, main.dash-main h4, main.dash-main h5, main.dash-main h6')
    .filter((h) => h.textContent.trim() === 'Staff accounts');
  check('"Staff accounts" is a heading once on the page, the page title, not again in the card',
    titled.length === 1 && !!titled[0].closest('.page-title'), titled.map((h) => h.tagName.toLowerCase()).join(', '));
  check('  the card\'s explanation reads word for word, "Residents register themselves" is nowhere on the page, '
      + 'and "New staff account" and the list label stay',
    staffPage.query('.pending-head p')?.textContent
      === 'Create accounts for barangay officials, who set their own password from an emailed link.'
      && !/Residents register themselves/i.test(staffPage.html())
      && staffPage.query('.pending-head button')?.textContent === 'New staff account'
      && staffPage.query('.staff-accounts h4')?.textContent === 'Punong Barangay, Treasurer and Staff accounts',
    JSON.stringify(staffPage.query('.pending-head p')?.textContent ?? null));
  const twoLines = STAFF_LIST.map((a) => {
    const lines = [...(rowOf(staffPage, a.username)?.querySelector('.suggestion-info')?.children || [])];
    return lines.length === 2 && !!lines[0].querySelector('.badge') && lines[0].textContent.startsWith(`@${a.username} · ${ROLE_TEXT[a.role]}`)
      && lines[1].textContent.includes(a.email)
      && lines[1].textContent.includes(a.last_link_sent_at ? 'Last link sent' : 'No set-password link sent');
  });
  check('each account is two lines: "@username · Role" with its status chip, then the email and the link status',
    twoLines.every(Boolean), STAFF_LIST.map((a, i) => `${a.username} ${twoLines[i] ? 'ok' : 'not two lines'}`).join(', '));

  const box = staffPage.query(SEARCH);
  const boxName = box ? (box.labels?.[0]?.textContent || box.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() : '';
  const listEl = staffPage.query('.staff-accounts ul');
  check('a search box with a label sits above the list',
    !!box && /search/i.test(boxName) && !!listEl && (box.compareDocumentPosition(listEl) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    JSON.stringify(boxName));
  const callsBeforeTyping = net.calls.length;
  await typeSearch(staffPage, 'dela_cruz');
  check('"dela_cruz" finds the account by username, and says "Showing 1 of 4 accounts"',
    shownUsers(staffPage) === '@treasurer_dela_cruz' && searchStatus(staffPage) === 'Showing 1 of 4 accounts',
    `${shownUsers(staffPage)} | ${JSON.stringify(searchStatus(staffPage))}`);
  await typeSearch(staffPage, 'punong');
  check('  "punong" finds the Punong Barangay by role label', shownUsers(staffPage) === '@kap_reyes', shownUsers(staffPage));
  await typeSearch(staffPage, 'tdc@');
  check('  "tdc@" finds the Treasurer by email', shownUsers(staffPage) === '@treasurer_dela_cruz', shownUsers(staffPage));
  await typeSearch(staffPage, 'MABINI.OFFICE');
  const upperEmail = shownUsers(staffPage);
  await typeSearch(staffPage, 'KAP_REYES');
  check('  and case does not matter: "MABINI.OFFICE" and "KAP_REYES"',
    upperEmail === '@staff_mabini' && shownUsers(staffPage) === '@kap_reyes', `${upperEmail} / ${shownUsers(staffPage)}`);
  await typeSearch(staffPage, 'zzz');
  const noMatch = staffPage.queryAll('.staff-accounts p').find((p) => p.textContent.startsWith('No staff accounts match'));
  const clearButton = buttonNamed(root(), 'Clear search');
  check('a search with no match says so in its own words, with "Clear search"',
    shownRows(staffPage).length === 0 && noMatch?.textContent === 'No staff accounts match "zzz".' && !!clearButton
      && searchStatus(staffPage) === 'Showing 0 of 4 accounts', JSON.stringify(noMatch?.textContent ?? null));
  check('  and never as "No staff accounts yet."', !yetShown(staffPage));
  await clickIf(staffPage, clearButton);
  check('"Clear search" brings every account back, empties the box and puts the focus in it',
    shownRows(staffPage).length === 4 && staffPage.query(SEARCH)?.value === '' && staffPage.active() === staffPage.query(SEARCH)
      && !searchStatus(staffPage), `${shownRows(staffPage).length} shown`);
  check('no request went out while searching', net.calls.length === callsBeforeTyping,
    `${net.calls.length - callsBeforeTyping} request(s) while typing`);

  await clickIf(staffPage, sendButtonOf(staffPage, 'kap_reyes'));
  const openedFirst = !!questionIn(staffPage, 'kap_reyes');
  const searchBox = staffPage.query(SEARCH);
  searchBox?.focus();
  await typeSearch(staffPage, 'kap');
  const keptWhileShown = !!questionIn(staffPage, 'kap_reyes') && shownUsers(staffPage) === '@kap_reyes';
  await typeSearch(staffPage, 'zzz');
  await typeSearch(staffPage, '');
  check('an open "send a link?" question survives typing, even after its row is filtered out and back',
    openedFirst && keptWhileShown && !!questionIn(staffPage, 'kap_reyes') && !!searchBox && staffPage.active() === searchBox,
    `opened ${openedFirst}, kept ${keptWhileShown}, back ${!!questionIn(staffPage, 'kap_reyes')}, `
      + `focus on ${JSON.stringify(staffPage.active()?.textContent || staffPage.active()?.tagName || null)}`);
  await staffPage.unmount();

  seedSession(VALID);
  resetNet(200, staffAnswer([]));
  const noStaff = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  await noStaff.settle();
  check('with no staff accounts at all: "No staff accounts yet." and no search box',
    yetShown(noStaff) && !noStaff.query(SEARCH) && !noStaff.query('.staff-accounts [role="status"]'));
  await noStaff.unmount();

  // The behaviour the layout change must not touch.
  const sentReply = (url, method) => {
    const sent = method === 'POST' && url.match(/\/secretary\/staff-accounts\/(\d+)\/send-set-password-link$/);
    return sent ? { message: 'A set-password link was emailed.', user_id: Number(sent[1]), set_password_email: { ok: true, status: 'SENT' } } : undefined;
  };
  seedSession(VALID);
  resetNet(200, staffAnswer(STAFF_LIST, sentReply));
  const actions = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  await actions.settle();
  let callsSoFar = net.calls.length;
  await clickIf(actions, sendButtonOf(actions, 'kap_reyes'));
  check('an active account is asked about first, in its row, and nothing is sent yet',
    /Send @kap_reyes a link to set a new password\? Their current password keeps working until they use the link\./
      .test(questionIn(actions, 'kap_reyes')?.textContent || '') && net.calls.length === callsSoFar,
    `${net.calls.length - callsSoFar} request(s)`);
  check('  with the focus on Cancel', actions.active()?.textContent === 'Cancel');
  await clickIf(actions, questionIn(actions, 'kap_reyes') && buttonNamed(questionIn(actions, 'kap_reyes'), 'Cancel'));
  check('  Cancel closes it and hands the focus back to that row\'s button',
    !questionIn(actions, 'kap_reyes') && !!sendButtonOf(actions, 'kap_reyes') && actions.active() === sendButtonOf(actions, 'kap_reyes'));
  await clickIf(actions, sendButtonOf(actions, 'kap_reyes'));
  callsSoFar = net.calls.length;
  await clickIf(actions, questionIn(actions, 'kap_reyes') && buttonNamed(questionIn(actions, 'kap_reyes'), 'Send link'));
  await actions.settle();
  const sendCalls = net.calls.slice(callsSoFar);
  check('  "Send link" posts once, shows the email result in the row, and reloads the list',
    sendCalls.length === 2 && sendCalls[0].method === 'POST' && sendCalls[0].url.endsWith('/secretary/staff-accounts/61/send-set-password-link')
      && sendCalls[1].method === 'GET' && sendCalls[1].url.endsWith('/secretary/staff-accounts')
      && rowOf(actions, 'kap_reyes')?.querySelector('.alert.success')?.textContent
        === 'Set-password link emailed to kap.reyes@example.invalid. It works once and lasts 72 hours.',
    sendCalls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+\/api/, '')}`).join(', '));
  callsSoFar = net.calls.length;
  await clickIf(actions, sendButtonOf(actions, 'treasurer_dela_cruz'));
  await actions.settle();
  check('an account still waiting for its password is sent the link straight away, with no question',
    !questionIn(actions, 'treasurer_dela_cruz') && net.calls[callsSoFar]?.method === 'POST'
      && !!net.calls[callsSoFar]?.url.endsWith('/secretary/staff-accounts/62/send-set-password-link'));
  check('an inactive account\'s button is disabled', sendButtonOf(actions, 'staff_old')?.disabled === true);
  await actions.unmount();

  const COOLDOWN = {
    error: 'A set-password link was sent to @kap_reyes less than 15 minutes ago. Ask them to check their inbox and spam folder, or send another in 12 minutes.',
    code: 'SET_PASSWORD_LINK_COOLDOWN',
    retry_after_minutes: 12,
  };
  seedSession(VALID);
  resetNet(200);
  net.hold = true;
  const cooldown = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  release(0, 200, { accounts: STAFF_LIST });
  await cooldown.settle();
  await clickIf(cooldown, sendButtonOf(cooldown, 'kap_reyes'));
  await clickIf(cooldown, questionIn(cooldown, 'kap_reyes') && buttonNamed(questionIn(cooldown, 'kap_reyes'), 'Send link'));
  release(1, 429, COOLDOWN);
  await cooldown.settle();
  check('the 15-minute cooldown shows the server\'s own sentence in the row, as information, not an error',
    rowOf(cooldown, 'kap_reyes')?.querySelector('.alert.info')?.textContent === COOLDOWN.error
      && !rowOf(cooldown, 'kap_reyes')?.querySelector('.alert.error'));
  await cooldown.unmount();

  const CREATED_BY_EMAIL = {
    message: 'Account created. A set-password link was emailed to the address you entered. It works once and expires in 72 hours.',
    user: { user_id: 71, username: 'new_official', email: 'new.official@example.invalid', role: 'staff' },
    set_password_email: { ok: true, status: 'SENT' },
  };
  const CREATED_WITH_TEMP = {
    message: 'Account created. Hand over the temporary password below; it must be changed at first sign-in.',
    user: { user_id: 72, username: 'temp_official', email: 'temp.official@example.invalid', role: 'treasurer' },
    temporary_password: 'Fixture-Temp-Pass-0',
  };
  let createdReply = CREATED_BY_EMAIL;
  const fillAccount = async (page, username, email) => {
    for (const [name, value] of [['first_name', 'New'], ['last_name', 'Official'], ['email', email], ['username', username]]) {
      if (page.query(`input[name="${name}"]`)) await page.fill(`input[name="${name}"]`, value);
    }
  };
  seedSession(VALID);
  resetNet(200, staffAnswer(STAFF_LIST, (url, method) => (method === 'POST' && url.endsWith('/secretary/accounts') ? createdReply : undefined)));
  const create = await globalThis.mountInteractive(root(), '/secretary/staff-accounts');
  await create.settle();
  await clickIf(create, buttonNamed(root(), 'New staff account'));
  await fillAccount(create, 'new_official', 'new.official@example.invalid');
  callsSoFar = net.calls.length;
  if (create.query('form')) await create.submit();
  await create.settle();
  const createCall = net.calls[callsSoFar];
  check('creating an account by email posts the form once with delivery "email", and shows the email result',
    createCall?.method === 'POST' && createCall.url.endsWith('/secretary/accounts') && sentBody(createCall)?.delivery === 'email'
      && sentBody(createCall)?.username === 'new_official'
      && !!create.query('.created-panel .alert.success')?.textContent
        .startsWith('Account created. A set-password link was emailed to new.official@example.invalid.'),
    JSON.stringify(create.query('.created-panel .alert')?.textContent ?? null));
  check('  and the list reloads', net.calls.slice(callsSoFar + 1).some((c) => c.method === 'GET' && c.url.endsWith('/secretary/staff-accounts')));
  createdReply = CREATED_WITH_TEMP;
  await clickIf(create, buttonNamed(root(), 'Create another'));
  await fillAccount(create, 'temp_official', 'temp.official@example.invalid');
  const delivery = create.query('select[name="delivery"]');
  if (delivery) {
    delivery.value = 'temporary_password';
    delivery.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  }
  await create.settle();
  check('  choosing the temporary-password fallback shows its warning first',
    /Use this only if email is not working\./.test(create.query('.account-form .alert.info')?.textContent || ''));
  callsSoFar = net.calls.length;
  if (create.query('form')) await create.submit();
  await create.settle();
  check('a temporary password is shown once, in its own panel, when the server sends one',
    sentBody(net.calls[callsSoFar])?.delivery === 'temporary_password'
      && create.queryAll('.created-panel dt').some((d) => d.textContent === 'Temporary password (shown only once)')
      && create.query('.created-panel code.temp-pass')?.textContent === CREATED_WITH_TEMP.temporary_password);
  await create.unmount();

  // =========================================================================
  // M. Payments: a failed load is an error, never an empty list
  // =========================================================================
  // A charges request that failed (a server asleep, a dropped connection, a
  // 500) used to leave "0 charges" and "No charges awaiting verification" on
  // the screen, which reads as nobody owing anything. A failed load must say
  // so, with Try again, and show no rows, no count and no empty text. Every
  // request below is answered by the fetch stub, the Record and Re-check
  // POSTs included, so nothing reaches a server.
  console.log('\n--- Payments: a failed load is an error, never an empty list ---');
  {
    const LIST = '/charges?status=';
    const isList = (call) => call?.method === 'GET' && call.url.includes(LIST);
    // A charge in the list's real shape: a document fee, named by its resident.
    const payCharge = (id, first, last, documentType, extra = {}) => ({
      charge_id: id, charge_type: 'DOCUMENT', amount: 100, status: 'UNPAID', created_at: '2026-10-05T01:00:00+00:00',
      declared_method: null, declared_reference: null, declared_at: null,
      paymongo_session_id: null, paymongo_payment_id: null, household_id: null,
      payer: { user_id: 900 + id, username: `res_${id}`, profiles: { first_name: first, middle_name: null, last_name: last, suffix: null } },
      document_requests: { request_id: 700 + id, purpose: 'Employment', status: 'approved', document_types: { name: documentType },
        resident_records: { resident_id: 800 + id, first_name: first, middle_name: null, last_name: last, suffix: null } },
      rental_requests: null, events: null, household_records: null, payments: [],
      ...extra,
    });
    const UNPAID_TWO = [
      payCharge(41, 'Ana', 'Cruz', 'Barangay Clearance', { paymongo_session_id: 'cs_test_41' }),
      payCharge(42, 'Ben', 'Reyes', 'Certificate of Residency'),
    ];
    const PAID_TWO = [
      payCharge(43, 'Carla', 'Santos', 'Barangay Clearance', { status: 'PAID' }),
      payCharge(44, 'Dino', 'Tan', 'Certificate of Residency', { status: 'PAID' }),
    ];
    const VOID_ONE = [payCharge(45, 'Elsa', 'Uy', 'Barangay Clearance', { status: 'VOID' })];
    const listBody = (charges) => ({ charges, total: charges.length });
    const listOf = (charges) => (url) => (url.includes(LIST) ? listBody(charges) : undefined);
    const openPayments = async () => {
      const page = await globalThis.mountInteractive(root(), '/secretary/payments');
      await page.settle();
      return page;
    };
    const viewButton = (page, name) =>
      page.queryAll('button').find((b) => (b.getAttribute('aria-label') || '').startsWith(`View charge for ${name}:`));
    // The status dropdown, changed the way the Staff accounts form's is.
    const choose = async (page, value) => {
      const select = page.query('.list-head select');
      if (select) {
        select.value = value;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await page.settle();
    };
    // What the list area says, read the way a person would. The heading is
    // the one h2 outside the View panel: the totals line since section O, the
    // "{n} charges" heading before it.
    const listView = (page) => {
      const text = root().textContent;
      return {
        heading: page.queryAll('h2').find((h) => !h.closest('.pay-panel'))?.textContent ?? null,
        error: page.queryAll('[role="alert"]').map((el) => el.textContent)
          .find((t) => t.startsWith('Could not load the charges')) ?? null,
        tryAgain: !!tryAgainButton(page),
        rows: page.queryAll('table.payments-table tbody tr').map((tr) => tr.querySelector('strong')?.textContent),
        zero: text.includes('0 charges'),
        empty: /No charges (awaiting verification|here)/.test(text),
        loading: text.includes('Loading charges…'),
      };
    };
    // The error with Try again, and nothing that could read as "nothing to
    // verify": no rows, no count, no empty text.
    const errorOnly = (v) => !!v.error && v.tryAgain && v.heading === 'Charges' && v.rows.length === 0
      && !v.zero && !v.empty && !v.loading;
    const loadingOnly = (v) => v.loading && !v.error && !v.tryAgain && v.heading === 'Charges' && v.rows.length === 0
      && !v.zero && !v.empty;
    const said = (v) => JSON.stringify(v);
    const callsSaid = () => net.calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api/, '')}`).join(', ');
    let paySoFar;

    // a. A failure with the server's own message.
    seedSession(VALID);
    resetNet(500, (url) => (url.includes(LIST) ? { error: 'Network down' } : undefined));
    const down = await openPayments();
    const downView = listView(down);
    check('a failed load shows "Could not load the charges: Network down", with a Try again button',
      downView.error === 'Could not load the charges: Network down' && downView.tryAgain, said(downView));
    check('  and no rows, no "0 charges", no "No charges awaiting verification": it cannot read as nothing to verify',
      errorOnly(downView), said(downView));
    await down.unmount();

    // b. No message from the server: unreachable, or an answer without one.
    seedSession(VALID);
    resetNet(200);
    net.fail = true;
    const unreachable = await openPayments();
    const unreachableView = listView(unreachable);
    check('a server that cannot be reached gets the plain fallback, "Could not load the charges: the server did not respond"',
      unreachableView.error === 'Could not load the charges: the server did not respond' && errorOnly(unreachableView)
        && !/Cannot reach the server|Failed to fetch/.test(root().textContent), said(unreachableView));
    await unreachable.unmount();

    seedSession(VALID);
    resetNet(502);
    const bare = await openPayments();
    const bareView = listView(bare);
    check('  so does an error answer with no message in it, never "Request failed (502)"',
      bareView.error === 'Could not load the charges: the server did not respond' && errorOnly(bareView)
        && !/Request failed/.test(root().textContent), said(bareView));
    await bare.unmount();

    // c. Try again repeats the SAME load: here the Paid list, which failed.
    seedSession(VALID);
    resetNet(200, listOf(UNPAID_TWO));
    const again = await openPayments();
    net.fail = true;
    await choose(again, 'PAID');
    const failedPaid = listView(again);
    net.fail = false;
    net.hold = true;
    paySoFar = net.calls.length;
    await clickIf(again, tryAgainButton(again));
    const retrying = listView(again);
    const retryCall = net.calls[paySoFar];
    release(0, 200, listBody(PAID_TWO));
    await again.settle();
    const retried = listView(again);
    check('Try again repeats the same load (status=PAID), showing the loading state, not the error, while it is out',
      errorOnly(failedPaid) && net.calls.length === paySoFar + 1 && isList(retryCall)
        && retryCall.url.endsWith('status=PAID') && loadingOnly(retrying),
      `${said(failedPaid)} then ${retryCall?.url ?? 'no request'} ${said(retrying)}`);
    check('  and when it answers with 2 charges the error is gone: "2 charges · ₱200.00 paid" and both rows',
      !retried.error && !retried.tryAgain && retried.heading === '2 charges · ₱200.00 paid'
        && retried.rows.join('|') === 'Carla Santos|Dino Tan', said(retried));
    await again.unmount();

    // d. Zero charges, loaded successfully, is a real empty state.
    seedSession(VALID);
    resetNet(200, listOf([]));
    const none = await openPayments();
    const noneView = listView(none);
    check('a successful load of no charges still shows "0 charges" and "No charges awaiting verification.", and no error',
      noneView.heading === '0 charges' && /No charges awaiting verification\./.test(root().textContent)
        && !noneView.error && !noneView.tryAgain && noneView.rows.length === 0, said(noneView));
    await none.unmount();

    // e. Changing the status after a failure, and Refresh after one.
    seedSession(VALID);
    resetNet(200);
    net.fail = true;
    const switched = await openPayments();
    const beforeSwitch = listView(switched);
    net.fail = false;
    net.hold = true;
    paySoFar = net.calls.length;
    await choose(switched, 'PAID');
    const switching = listView(switched);
    const switchCall = net.calls[paySoFar];
    release(0, 200, listBody(PAID_TWO));
    await switched.settle();
    const switchedView = listView(switched);
    check('changing the status after a failure loads that status and clears the error: the loading state shows',
      errorOnly(beforeSwitch) && isList(switchCall) && switchCall.url.endsWith('status=PAID') && loadingOnly(switching),
      `${switchCall?.url ?? 'no request'} ${said(switching)}`);
    check('  and its answer replaces it', switchedView.heading === '2 charges · ₱200.00 paid' && !switchedView.error
      && switchedView.rows.join('|') === 'Carla Santos|Dino Tan', said(switchedView));
    await switched.unmount();

    seedSession(VALID);
    resetNet(200);
    net.fail = true;
    const refreshed = await openPayments();
    net.fail = false;
    net.hold = true;
    paySoFar = net.calls.length;
    await clickIf(refreshed, buttonNamed(root(), 'Refresh'));
    const refreshing = listView(refreshed);
    const refreshCall = net.calls[paySoFar];
    release(0, 200, listBody(UNPAID_TWO));
    await refreshed.settle();
    const refreshedView = listView(refreshed);
    check('Refresh after a failure clears the error, shows the loading state, then the list',
      isList(refreshCall) && refreshCall.url.endsWith('status=UNPAID') && loadingOnly(refreshing)
        && refreshedView.heading === '2 charges · ₱200.00 unpaid' && !refreshedView.error, `${said(refreshing)} then ${said(refreshedView)}`);
    await refreshed.unmount();

    // f. A reload that fails after Record payment, then after Re-check. The
    // stub answers the POST and makes the reload after it fail.
    seedSession(VALID);
    resetNet(200, (url, method) => {
      if (method === 'GET' && url.includes(LIST)) return listBody(UNPAID_TWO);
      if (method === 'POST' && url.endsWith('/charges/41/verify')) {
        net.fail = true;
        return { message: 'Payment recorded — charge marked PAID', payment: { payment_id: 77 } };
      }
      return undefined;
    });
    const recorded = await openPayments();
    await clickIf(recorded, viewButton(recorded, 'Ana Cruz'));
    if (recorded.query('form')?.closest('.pay-panel')) await recorded.submit();
    await recorded.settle();
    const recordedView = listView(recorded);
    check('a reload that fails after Record payment shows the load error: not the old list, not "0 charges"',
      errorOnly(recordedView) && !recorded.query('.pay-panel'), said(recordedView));
    check('  the Record message above it is unchanged, and the stub answered every request',
      recorded.query('.alert.success')?.textContent === 'Payment recorded — charge marked PAID (payment #77)'
        && callsSaid() === 'GET /charges?status=UNPAID, POST /charges/41/verify, GET /charges?status=UNPAID',
      `${JSON.stringify(recorded.query('.alert.success')?.textContent ?? null)}; ${callsSaid()}`);
    await recorded.unmount();

    seedSession(VALID);
    resetNet(200, (url, method) => {
      if (method === 'GET' && url.includes(LIST)) return listBody(UNPAID_TWO);
      if (method === 'POST' && url.endsWith('/payments/gcash/reconcile/41')) {
        net.fail = true;
        return { settled: true, outcome: 'recorded', message: 'PayMongo confirmed the payment. The charge is now paid.' };
      }
      return undefined;
    });
    const rechecked = await openPayments();
    await clickIf(rechecked, viewButton(rechecked, 'Ana Cruz'));
    await clickIf(rechecked, buttonNamed(root(), 'Re-check with PayMongo'));
    await rechecked.settle();
    const recheckedView = listView(rechecked);
    check('a reload that fails after Re-check shows the load error, and the panel closes as before',
      errorOnly(recheckedView) && !rechecked.query('.pay-panel'), said(recheckedView));
    check('  the Re-check message above it is unchanged, and the stub answered every request',
      rechecked.query('.alert.success')?.textContent === 'PayMongo confirmed the payment. The charge is now paid.'
        && callsSaid() === 'GET /charges?status=UNPAID, POST /payments/gcash/reconcile/41, GET /charges?status=UNPAID',
      `${JSON.stringify(rechecked.query('.alert.success')?.textContent ?? null)}; ${callsSaid()}`);
    await rechecked.unmount();

    // g. An older answer that arrives last must not replace a newer one.
    seedSession(VALID);
    resetNet(200);
    net.hold = true;
    const raced = await openPayments();
    release(0, 200, listBody(UNPAID_TWO));
    await raced.settle();
    await choose(raced, 'PAID');
    await choose(raced, 'VOID');
    release(2, 200, listBody(VOID_ONE));
    await raced.settle();
    release(1, 200, listBody(PAID_TWO));
    await raced.settle();
    const racedView = listView(raced);
    check('an older answer that arrives last cannot replace the newer list: Void keeps its one charge',
      raced.query('.list-head select')?.value === 'VOID' && racedView.heading === '1 charge · ₱100.00 void'
        && racedView.rows.join('|') === 'Elsa Uy', said(racedView));
    await choose(raced, 'all');
    await choose(raced, 'UNPAID');
    release(4, 200, listBody(UNPAID_TWO));
    await raced.settle();
    release(3, 500, { error: 'boom' });
    await raced.settle();
    const racedLater = listView(raced);
    check('  nor can an older load that fails last put its error over the newer list',
      racedLater.heading === '2 charges · ₱200.00 unpaid' && racedLater.rows.join('|') === 'Ana Cruz|Ben Reyes' && !racedLater.error,
      said(racedLater));
    await raced.unmount();
  }

  // =========================================================================
  // N. Payments: the Method column says how each paid charge was paid
  // =========================================================================
  // The column used to show what a RESIDENT declared ("Onsite", "GCash ref")
  // or that a checkout had started, which says nothing about how a paid charge
  // was actually paid. It now reads the charge's payment record: "Paid online"
  // for a payment nobody received, which only PayMongo makes; "Cash" or
  // "GCash" for one a staff member recorded. A paid charge with no payment row
  // is "No fee" when its amount is 0, because approval marks a PHP 0 charge
  // paid without one, and "No record" otherwise. The amount may arrive as a
  // number or a numeric string, and a missing, null or blank one is never 0.
  // An unpaid or void charge shows "Online pending" while a PayMongo checkout
  // is open, otherwise a dash. methodOf is checked on its own, case by case,
  // then through the real page, whose View panel shows the record itself. The
  // clock is UTC for this section, so "Paid on" must be Manila time by the
  // page's own doing, not because this machine is in Manila. Every request is
  // answered by the fetch stub.
  console.log('\n--- Payments: the Method column says how each paid charge was paid ---');
  {
    const previousTZ = process.env.TZ;
    process.env.TZ = 'UTC';
    const LIST = '/charges?status=';
    // Recorders in the payload's real shape: username, role and profile name.
    const TREASURER = { username: 'treasurer_one', role: 'treasurer',
      profiles: { first_name: 'Teresa', middle_name: 'Lim', last_name: 'Ocampo', suffix: null } };
    const NO_PROFILE = { username: 'secretary_one', role: 'secretary', profiles: null };
    const payment = (id, method, recorderId, recorder, createdAt, reference = null) => ({
      payment_id: id, payment_method: method, reference_no: reference, created_at: createdAt,
      received_by_user_id: recorderId, recorder,
    });
    const PAY_ID = 'pay_tEsT51aBcDeFgHiJkLmNoPqR'; // 28 characters, as a real PayMongo id is
    // A document fee in the list's real shape, as in section M, paid unless
    // `extra` says otherwise.
    const charge = (id, first, last, extra = {}) => ({
      charge_id: id, charge_type: 'DOCUMENT', amount: 100, status: 'PAID', created_at: '2026-10-05T01:00:00+00:00',
      declared_method: null, declared_reference: null, declared_at: null,
      paymongo_session_id: null, paymongo_payment_id: null, household_id: null,
      payer: { user_id: 900 + id, username: `res_${id}`, profiles: { first_name: first, middle_name: null, last_name: last, suffix: null } },
      document_requests: { request_id: 700 + id, purpose: 'Employment', status: 'approved', document_types: { name: 'Barangay Clearance' },
        resident_records: { resident_id: 800 + id, first_name: first, middle_name: null, last_name: last, suffix: null } },
      rental_requests: null, events: null, household_records: null, payments: [],
      ...extra,
    });
    // The same charge with no amount key at all.
    const withoutAmount = (c) => {
      delete c.amount;
      return c;
    };
    // Every case, with the label it must get, written by hand.
    const CASES = [
      { name: 'a PayMongo payment (no recorder)', want: 'Paid online', c: charge(51, 'Lorna', 'Abad', {
        paymongo_session_id: 'cs_test_51', paymongo_payment_id: PAY_ID,
        payments: [payment(501, 'gcash', null, null, '2026-10-06T02:15:00+00:00', PAY_ID)] }) },
      { name: 'cash recorded by a staff member', want: 'Cash', c: charge(52, 'Mario', 'Bautista', {
        declared_method: 'onsite', declared_at: '2026-10-05T03:00:00+00:00',
        payments: [payment(502, 'onsite', 12, TREASURER, '2026-10-06T06:40:00+00:00')] }) },
      { name: 'GCash recorded by a staff member', want: 'GCash', c: charge(53, 'Nena', 'Cortez', {
        declared_method: 'gcash', declared_reference: '1029384756', declared_at: '2026-10-05T04:00:00+00:00',
        payments: [payment(503, 'gcash', 3, NO_PROFILE, '2026-10-07T01:05:00+00:00', '1029384756')] }) },
      { name: 'PAID with no payment row, amount 100', want: 'No record', c: charge(54, 'Oscar', 'Dizon') },
      { name: 'UNPAID with an open PayMongo session', want: 'Online pending', c: charge(55, 'Pilar', 'Estrada', {
        status: 'UNPAID', paymongo_session_id: 'cs_test_55' }) },
      { name: 'UNPAID with no session', want: '—', c: charge(56, 'Quintin', 'Fajardo', { status: 'UNPAID' }) },
      { name: 'UNPAID declared onsite (a dash, not "Cash")', want: '—', c: charge(57, 'Rosa', 'Gomez', {
        status: 'UNPAID', declared_method: 'onsite', declared_at: '2026-10-08T00:30:00+00:00' }) },
      { name: 'VOID with an open PayMongo session', want: 'Online pending', c: charge(58, 'Santi', 'Hizon', {
        status: 'VOID', paymongo_session_id: 'cs_test_58' }) },
      { name: 'VOID with no session', want: '—', c: charge(59, 'Tess', 'Ilagan', { status: 'VOID' }) },
      { name: 'two payment rows, the latest second', want: 'Cash', c: charge(60, 'Ugo', 'Jacinto', {
        paymongo_session_id: 'cs_test_60', paymongo_payment_id: 'pay_test_60',
        payments: [payment(600, 'gcash', null, null, '2026-10-02T01:00:00+00:00', 'pay_test_60'),
          payment(601, 'onsite', 12, TREASURER, '2026-10-03T01:00:00+00:00')] }) },
      { name: 'two payment rows, the latest first', want: 'GCash', c: charge(61, 'Vilma', 'Katigbak', {
        payments: [payment(611, 'gcash', 12, TREASURER, '2026-10-04T01:00:00+00:00', '5647382910'),
          payment(610, 'onsite', 12, TREASURER, '2026-10-01T01:00:00+00:00')] }) },
      { name: 'an unknown method, shown as it is', want: 'cheque', c: charge(62, 'Wena', 'Lacson', {
        payments: [payment(620, 'cheque', 12, TREASURER, '2026-10-06T01:00:00+00:00', 'CHK-0042')] }) },
      { name: 'an empty method, never blank', want: '—', c: charge(63, 'Xavier', 'Manalo', {
        payments: [payment(630, '', 12, TREASURER, '2026-10-06T01:30:00+00:00')] }) },
      // Approval creates a PHP 0 charge PAID with no payment row, so it had no
      // fee to pay. Only a paid charge with an amount above 0 and no row is
      // missing its record, and an amount that is not a number is never 0.
      { name: 'PAID, no payment row, amount 0', want: 'No fee', c: charge(64, 'Yolanda', 'Navarro', { amount: 0 }) },
      { name: 'PAID, no payment row, amount "0.00" (a string)', want: 'No fee', c: charge(65, 'Zaldy', 'Ortega', { amount: '0.00' }) },
      { name: 'PAID, no payment row, amount "0" (a string)', want: 'No fee', c: charge(66, 'Alma', 'Pascual', { amount: '0' }) },
      { name: 'PAID, no payment row, amount 0.01', want: 'No record', c: charge(67, 'Bernie', 'Quiambao', { amount: 0.01 }) },
      { name: 'PAID, no payment row, amount null', want: 'No record', c: charge(68, 'Carmen', 'Ramos', { amount: null }) },
      { name: 'PAID, no payment row, no amount at all', want: 'No record', c: withoutAmount(charge(69, 'Danilo', 'Salcedo')) },
      { name: 'PAID, no payment row, amount "" (blank, which Number() reads as 0)', want: 'No record',
        c: charge(70, 'Edna', 'Tolentino', { amount: '' }) },
      { name: 'PAID, amount 0, a PayMongo payment row', want: 'Paid online', c: charge(71, 'Fely', 'Umali', {
        amount: 0, paymongo_session_id: 'cs_test_71', paymongo_payment_id: 'pay_test_71',
        payments: [payment(710, 'gcash', null, null, '2026-10-06T03:00:00+00:00', 'pay_test_71')] }) },
      { name: 'PAID, amount 0, cash a staff member recorded', want: 'Cash', c: charge(72, 'Gardo', 'Villanueva', {
        amount: 0, payments: [payment(720, 'onsite', 12, TREASURER, '2026-10-06T04:00:00+00:00')] }) },
      { name: 'PAID, amount 0, GCash a staff member recorded', want: 'GCash', c: charge(73, 'Hilda', 'Yap', {
        amount: 0, payments: [payment(730, 'gcash', 12, TREASURER, '2026-10-06T05:00:00+00:00', '3141592653')] }) },
      { name: 'UNPAID, amount 0, no session (a dash, not "No fee")', want: '—', c: charge(74, 'Isko', 'Zamora', {
        status: 'UNPAID', amount: 0 }) },
      { name: 'VOID, amount 0, no session (a dash, not "No fee")', want: '—', c: charge(75, 'Jun', 'Aquino', {
        status: 'VOID', amount: 0 }) },
    ];
    const caseOf = (id) => CASES.find((k) => k.c.charge_id === id);

    // a. methodOf on its own.
    const methodOf = globalThis.methodOf;
    for (const { name, want, c } of CASES) {
      let got;
      try { got = typeof methodOf === 'function' ? methodOf(c) : 'methodOf is not exported'; } catch (e) { got = `threw: ${e.message}`; }
      check(`methodOf: ${name} = "${want}"`, got === want, String(JSON.stringify(got)));
    }

    // b. The real page. The list answer holds the cases of the status asked
    // for, as the server's does.
    const listAnswer = (url) => {
      if (!url.includes(LIST)) return undefined;
      const status = url.split(LIST)[1].toUpperCase();
      const charges = CASES.map((k) => k.c).filter((c) => status === 'ALL' || c.status === status);
      return { charges, total: charges.length };
    };
    const nameOf = (c) => `${c.document_requests.resident_records.first_name} ${c.document_requests.resident_records.last_name}`;
    const viewButton = (page, c) =>
      page.queryAll('button').find((b) => (b.getAttribute('aria-label') || '').startsWith(`View charge for ${nameOf(c)}:`));
    const choose = async (page, value) => {
      const select = page.query('.list-head select');
      if (select) {
        select.value = value;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await page.settle();
    };
    // Each case's row, found by its resident, must show `want` in the cell the
    // phone card labels "Method", and the list must hold exactly those rows.
    const labelsMatch = (page, cases) => {
      const rows = page.queryAll('table.payments-table tbody tr').map((tr) => ({
        name: tr.querySelector('strong')?.textContent ?? null,
        method: tr.querySelector('td[data-label="Method"]')?.textContent ?? null,
        fourth: tr.children[3]?.textContent ?? null,
      }));
      const wrong = cases.flatMap(({ want, c }) => {
        const row = rows.find((r) => r.name === nameOf(c));
        if (row?.method === want) return [];
        const got = !row ? 'no row' : row.method === null ? `no Method cell, fourth column "${row.fourth}"` : `"${row.method}"`;
        return [`${nameOf(c)}: ${got}, want "${want}"`];
      });
      return {
        ok: rows.length === cases.length && wrong.length === 0,
        detail: `${rows.length} row(s) for ${cases.length} case(s)${wrong.length ? `; ${wrong.join('; ')}` : ''}`,
      };
    };
    // The View panel's rows as label → value, any run of whitespace as one
    // space (the time has a narrow no-break space before AM and PM).
    const panelRows = (page) => {
      const out = {};
      let label = null;
      for (const el of page.query('.pay-panel dl.pay-panel-list')?.children || []) {
        if (el.tagName === 'DT') label = el.textContent;
        else if (label !== null) {
          out[label] = el.textContent.replace(/\s+/g, ' ').trim();
          label = null;
        }
      }
      return out;
    };
    const RECORD = ['Paid on', 'Method', 'Reference', 'Recorded by'];
    const noRecordRows = (rows) => RECORD.every((label) => !(label in rows));
    const panelText = (page) => page.query('.pay-panel')?.textContent ?? '';
    const readOnly = (page) => page.query('.pay-panel .pay-panel-note')?.textContent === 'Read-only' && !page.query('.pay-panel form');
    const said = (rows) => JSON.stringify(rows);

    seedSession(VALID);
    resetNet(200, listAnswer);
    const page = await globalThis.mountInteractive(root(), '/secretary/payments');
    await page.settle();
    const headers = page.queryAll('table.payments-table thead th').map((th) => th.textContent);
    check('the column header reads "Method", and no header reads "Declared"',
      headers.includes('Method') && !headers.includes('Declared'), headers.join(' | '));
    const needs = labelsMatch(page, CASES.filter((k) => k.c.status === 'UNPAID'));
    check('Needs verification: each unpaid row shows "Online pending" or "—" under Method', needs.ok, needs.detail);
    await choose(page, 'all');
    const everyRow = labelsMatch(page, CASES);
    check('All charges: each row shows its own label under Method', everyRow.ok, everyRow.detail);
    const cardLabels = page.queryAll('table.payments-table tbody td[data-label]').map((td) => td.getAttribute('data-label'));
    check('  and the phone card labels that line "Method", never "Declared"',
      cardLabels.filter((l) => l === 'Method').length === CASES.length && !cardLabels.includes('Declared'),
      `${cardLabels.filter((l) => l === 'Method').length} "Method", ${cardLabels.filter((l) => l === 'Declared').length} "Declared"`);
    // One row's Method cell, found by its resident.
    const methodCell = (c) => page.queryAll('table.payments-table tbody tr')
      .find((tr) => tr.querySelector('strong')?.textContent === nameOf(c))
      ?.querySelector('td[data-label="Method"]')?.textContent ?? null;
    check('All charges: a paid PHP 0 charge with no payment row reads "No fee" under Method, a paid PHP 100 one "No record"',
      methodCell(caseOf(64).c) === 'No fee' && methodCell(caseOf(54).c) === 'No record',
      `${JSON.stringify(methodCell(caseOf(64).c))}, ${JSON.stringify(methodCell(caseOf(54).c))}`);

    // c. The View panel of each kind of charge.
    const openFor = async (id) => {
      await clickIf(page, viewButton(page, caseOf(id).c));
      return panelRows(page);
    };
    const closeIt = () => clickIf(page, page.query('.pay-panel button[aria-label="Close"]'));

    let rows = await openFor(51);
    check('a PayMongo payment\'s panel: Paid on in Manila time (02:15 UTC is 10:15 AM), Method "Paid online", '
        + 'its pay_ id as the reference, recorded by "PayMongo (automatic)"',
      rows['Paid on'] === 'Oct 6, 2026, 10:15 AM' && rows.Method === 'Paid online' && rows.Reference === PAY_ID
        && rows['Recorded by'] === 'PayMongo (automatic)', said(rows));
    check('  the old "Payment: Paid." and "Online payment" rows are gone, and the panel stays read-only',
      !('Payment' in rows) && !('Online payment' in rows) && readOnly(page), said(rows));
    await closeIt();

    rows = await openFor(52);
    check('cash a staff member recorded: Method "Cash", Reference "—", recorded by the staff member\'s full name',
      rows['Paid on'] === 'Oct 6, 2026, 2:40 PM' && rows.Method === 'Cash' && rows.Reference === '—'
        && rows['Recorded by'] === 'Teresa Lim Ocampo' && readOnly(page), said(rows));
    check('  and what the resident declared still shows beside it', rows['Declared payment'] === 'Cash (on-site)'
      && 'Declared on' in rows, said(rows));
    await closeIt();

    rows = await openFor(53);
    check('GCash a staff member recorded: Method "GCash", the typed reference, and @username when there is no profile name',
      rows['Paid on'] === 'Oct 7, 2026, 9:05 AM' && rows.Method === 'GCash' && rows.Reference === '1029384756'
        && rows['Recorded by'] === '@secretary_one', said(rows));
    await closeIt();

    rows = await openFor(60);
    check('two payment rows: the panel shows the latest, as the column does',
      rows['Paid on'] === 'Oct 3, 2026, 9:00 AM' && rows.Method === 'Cash' && rows.Reference === '—'
        && rows['Recorded by'] === 'Teresa Lim Ocampo', said(rows));
    await closeIt();

    rows = await openFor(54);
    check('a paid PHP 100 charge with no payment row: "Payment: No payment record on file." in place of the record, still read-only',
      rows.Payment === 'No payment record on file.' && noRecordRows(rows) && !('Online payment' in rows) && readOnly(page),
      said(rows));
    await closeIt();

    rows = await openFor(64);
    check('a paid PHP 0 charge with no payment row: "Payment: No payment needed (no fee).", no record rows, still read-only',
      rows.Payment === 'No payment needed (no fee).' && !panelText(page).includes('No payment record on file.')
        && noRecordRows(rows) && readOnly(page), said(rows));
    await closeIt();

    rows = await openFor(65);
    check('  the same when the amount arrives as the string "0.00"',
      rows.Payment === 'No payment needed (no fee).' && noRecordRows(rows), said(rows));
    await closeIt();

    rows = await openFor(72);
    check('a paid PHP 0 charge WITH a payment row shows that record (Method "Cash") and no "Payment" line',
      rows.Method === 'Cash' && rows['Recorded by'] === 'Teresa Lim Ocampo' && !('Payment' in rows), said(rows));
    await closeIt();

    rows = await openFor(57);
    check('an unpaid charge\'s panel is unchanged: "Declared payment: Cash (on-site)", "Declared on" and the Record form',
      rows['Declared payment'] === 'Cash (on-site)' && 'Declared on' in rows && !!page.query('.pay-panel form')
        && noRecordRows(rows) && !page.query('.pay-panel .pay-panel-note'), said(rows));
    await closeIt();

    rows = await openFor(55);
    check('  one with an open checkout still says "GCash online — started, not yet confirmed" and offers Re-check',
      rows['Online payment'] === 'GCash online — started, not yet confirmed' && noRecordRows(rows)
        && !!buttonNamed(root(), 'Re-check with PayMongo'), said(rows));
    await closeIt();

    rows = await openFor(59);
    check('a void charge\'s panel still says "Void.", with no payment record',
      rows.Payment === 'Void.' && noRecordRows(rows) && readOnly(page), said(rows));
    await closeIt();
    await page.unmount();

    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }

  // =========================================================================
  // O. Payments: search, type tabs, totals and paging
  // =========================================================================
  // The page listed every charge of a status in one long table. It now has a
  // search box that filters as you type (case and accents ignored, every word
  // required, in any order) over the payer name as shown, the @username, the
  // charge number, the references the View panel can show and the "For" text,
  // but never the purpose; type tabs whose counts follow the search; a totals
  // line over EVERY matching charge, summed in whole centavos, not just the
  // page shown; and pages of 25. Filters start fresh on every visit and live
  // through Refresh, Record payment and Re-check. The pure helpers
  // (utils/chargeSearch.js, chargeTotals.js, paging.js) are checked case by
  // case, then the real page against 64 stubbed charges: 30 waiting, 26 paid
  // and 8 void. Every request is answered by the fetch stub.
  console.log('\n--- Payments: search, type tabs, totals and paging ---');
  {
    const S = globalThis.chargeSearch || {};
    const T = globalThis.chargeTotals || {};
    const P = globalThis.paging || {};
    // A missing export or a throw becomes a value the check prints.
    const attempt = (f) => { try { return f(); } catch (e) { return `threw: ${e.message}`; } };
    const said = (v) => JSON.stringify(v);
    const LIST = '/charges?status=';
    const PAY_ID = 'pay_tEsT51aBcDeFgHiJkLmNoPqR';

    // Charges in the list's real shape (sections M and N). NAME holds each
    // one's payer name as the page shows it, written by hand.
    const NAME = new Map();
    const who = (first, middle, last) => ({ first_name: first, middle_name: middle, last_name: last, suffix: null });
    const STAFF = { username: 'treasurer_one', role: 'treasurer', profiles: who('Teresa', 'Lim', 'Ocampo') };
    const paidRow = (id, method, reference, auto = false) => [{
      payment_id: 5000 + id, payment_method: method, reference_no: reference, created_at: '2026-10-06T01:00:00+00:00',
      received_by_user_id: auto ? null : 12, recorder: auto ? null : STAFF,
    }];
    const charge = (id, type, status, amount, extra) => ({
      charge_id: id, charge_type: type, amount, status, created_at: '2026-10-05T01:00:00+00:00',
      declared_method: null, declared_reference: null, declared_at: null,
      paymongo_session_id: null, paymongo_payment_id: null, household_id: null,
      payer: null, document_requests: null, rental_requests: null, events: null, household_records: null, payments: [],
      ...extra,
    });
    const docOf = (id, status, amount, [first, middle, last], documentType, { purpose = 'Employment', ...extra } = {}) => {
      NAME.set(id, [first, middle, last].filter(Boolean).join(' '));
      return charge(id, 'DOCUMENT', status, amount, {
        payer: { user_id: 900 + id, username: `res_${id}`, profiles: who(first, middle, last) },
        document_requests: { request_id: 700 + id, purpose, status: 'approved', document_types: { name: documentType },
          resident_records: { resident_id: 800 + id, ...who(first, middle, last) } },
        ...extra,
      });
    };
    // `person` is [first, last] for a resident, or { guest } for a borrower
    // from another barangay, who has no account and no resident record.
    const rentalOf = (id, status, amount, person, item, quantity, extra = {}) => {
      const guest = Array.isArray(person) ? null : person.guest;
      NAME.set(id, guest || person.join(' '));
      return charge(id, 'RENTAL', status, amount, {
        payer: guest ? null : { user_id: 900 + id, username: `res_${id}`, profiles: who(person[0], null, person[1]) },
        rental_requests: { request_id: 600 + id, quantity_requested: quantity, start_datetime: '2026-10-20T00:00:00+00:00',
          end_datetime: '2026-10-20T08:00:00+00:00', status: 'confirmed', resident_id: guest ? null : 800 + id,
          outside_borrower_name: guest, rental_items: { name: item },
          resident_records: guest ? null : { resident_id: 800 + id, ...who(person[0], null, person[1]) } },
        ...extra,
      });
    };
    // A household's fine, with no account behind it, named by its head.
    const fineOf = (id, status, amount, head, title, extra = {}) => {
      NAME.set(id, head);
      return charge(id, 'FINE', status, amount, {
        household_id: id,
        events: { event_id: 400 + id, title, start_datetime: '2026-10-01T00:00:00+00:00', end_datetime: '2026-10-01T08:00:00+00:00' },
        household_records: { household_id: id, address: 'Purok 2, Ubujan', head_name: head },
        ...extra,
      });
    };

    // a. Search, on its own. `shown` is what the page shows for the charge,
    // its payer name and its "For" text, written here by hand.
    const textOf = (c, name, forText) => attempt(() => S.chargeSearchText(c, { name, forText }));
    const finds = (text, query) => attempt(() => S.matchesTerms(text, S.searchTerms(query)));
    const sJuan = docOf(148, 'UNPAID', 50, ['Juan', 'Torralba', 'Dela Cruz'], 'Barangay Clearance', { purpose: 'Scholarship' });
    // Two keys the list never sends, a contact number and an email: the
    // search must read only the fields it is meant to, never the whole charge.
    sJuan.document_requests.resident_records.contact_number = '09171234567';
    sJuan.payer.email = 'juan@example.com';
    const tJuan = textOf(sJuan, 'Juan Torralba Dela Cruz', 'Barangay Clearance');
    const tNino = textOf(docOf(52, 'PAID', 100, ['Niño', null, 'Peñaflor'], 'Certificate of Residency',
      { payments: paidRow(52, 'onsite', 'OR-2026-0042') }), 'Niño Peñaflor', 'Certificate of Residency');
    const tOnline = textOf(docOf(53, 'PAID', 100, ['Maria', null, 'Santos'], 'Barangay Clearance', {
      paymongo_session_id: 'cs_test_53', paymongo_payment_id: PAY_ID, payments: paidRow(53, 'gcash', PAY_ID, true) }),
    'Maria Santos', 'Barangay Clearance');
    const tDeclared = textOf(docOf(54, 'UNPAID', 50, ['Ana', null, 'Cruz'], 'Barangay Clearance',
      { declared_method: 'gcash', declared_reference: '5550001234' }), 'Ana Cruz', 'Barangay Clearance');
    const sGuest = rentalOf(55, 'UNPAID', 300, { guest: 'Lito Guest' }, 'Monobloc Chairs', 20);
    const tGuest = textOf(sGuest, 'Lito Guest', 'Monobloc Chairs × 20');
    const sFine = fineOf(56, 'UNPAID', 100, 'Rosa Lim', 'General Assembly');
    const tFine = textOf(sFine, 'Rosa Lim', 'Missed General Assembly');
    const sPlain = docOf(57, 'UNPAID', 50, ['Nino', null, 'Salazar'], 'Barangay Clearance');
    const tPlain = textOf(sPlain, 'Nino Salazar', 'Barangay Clearance');
    const TEXTS = [tJuan, tNino, tOnline, tDeclared, tGuest, tFine, tPlain];

    check('search: accents are folded in the charge: "nino penaflor" finds Niño Peñaflor',
      finds(tNino, 'nino penaflor') === true, said(tNino));
    check('  and in the search: "Niño" and "NIÑO" find Nino Salazar',
      finds(tPlain, 'Niño') === true && finds(tPlain, 'NIÑO') === true, said(tPlain));
    check('search: every word is required, in any order: "cruz juan" and "dela JUAN" find Juan Torralba Dela Cruz, "juan reyes" does not',
      finds(tJuan, 'cruz juan') === true && finds(tJuan, 'dela JUAN') === true && finds(tJuan, 'juan reyes') === false, said(tJuan));
    check('search: every name part as shown: "torralba" (the middle name) finds him', finds(tJuan, 'torralba') === true);
    check('search: the charge number with or without #: "148" and "#148" find charge #148, "#149" does not',
      finds(tJuan, '148') === true && finds(tJuan, '#148') === true && finds(tJuan, '#149') === false);
    check('search: the @username: "@res_148" and "res_148" find it',
      finds(tJuan, '@res_148') === true && finds(tJuan, 'res_148') === true);
    check('search: a payment reference, here an OR number: "OR-2026-0042", "or-2026" and "0042" find it',
      finds(tNino, 'OR-2026-0042') === true && finds(tNino, 'or-2026') === true && finds(tNino, '0042') === true);
    check('search: the pay_ id, in any case: "pay_tEsT51" and "PAY_TEST51ABC" find it',
      finds(tOnline, 'pay_tEsT51') === true && finds(tOnline, 'PAY_TEST51ABC') === true, said(tOnline));
    check('search: a declared GCash reference: "5550001234" finds it', finds(tDeclared, '5550001234') === true);
    check('search: the For text: "clearance" (a document type), "monobloc" (a rental item), "general assembly" (an event title)',
      finds(tJuan, 'clearance') === true && finds(tGuest, 'monobloc') === true && finds(tFine, 'general assembly') === true);
    check('search: the name as shown for a guest borrower and a household head: "lito guest", "rosa lim"',
      finds(tGuest, 'lito guest') === true && finds(tFine, 'rosa lim') === true);
    check('search: the purpose is NOT searched: "scholarship" (his purpose) finds nothing', finds(tJuan, 'scholarship') === false);
    check('search: a phone-like or email-like string finds nothing, not even one hidden in the charge: "09171234567", "juan@example.com"',
      TEXTS.every((t) => finds(t, '09171234567') === false && finds(t, 'juan@example.com') === false));
    check('search: an empty or blank search has no words and matches every charge',
      said(attempt(() => S.searchTerms(''))) === '[]' && said(attempt(() => S.searchTerms('   '))) === '[]'
        && TEXTS.every((t) => finds(t, '') === true && finds(t, '  ') === true));

    // Tabs, on their own.
    const tabList = attempt(() => S.TYPE_TABS.map((t) => `${t.key}:${t.label}`).join(' | '));
    check('tabs: All, Documents, Rentals, Fines, in that order',
      tabList === 'all:All | DOCUMENT:Documents | RENTAL:Rentals | FINE:Fines', said(tabList));
    const counted = attempt(() => S.tabCounts([sJuan, sGuest, sFine, sPlain]));
    check('tab counts: All plus one per type, over whatever list they are given',
      counted?.all === 4 && counted.DOCUMENT === 2 && counted.RENTAL === 1 && counted.FINE === 1, said(counted));
    const none = attempt(() => S.tabCounts([]));
    check('  an empty list counts 0 for every tab, never a missing count',
      none?.all === 0 && none.DOCUMENT === 0 && none.RENTAL === 0 && none.FINE === 0, said(none));
    check('inTab: All takes every charge, a type tab only its own type',
      attempt(() => S.inTab(sGuest, 'all') && S.inTab(sGuest, 'RENTAL') && !S.inTab(sGuest, 'DOCUMENT') && !S.inTab(sFine, 'RENTAL')) === true);

    // b. Totals, on their own.
    const cents = (a) => attempt(() => T.toCentavos(a));
    check('toCentavos: 0.1 is 10, 0.2 is 20, "100.50" is 10050, 1500 is 150000',
      cents(0.1) === 10 && cents(0.2) === 20 && cents('100.50') === 10050 && cents(1500) === 150000,
      said([cents(0.1), cents(0.2), cents('100.50'), cents(1500)]));
    check('  a missing, null, blank or non-numeric amount adds 0',
      cents(undefined) === 0 && cents(null) === 0 && cents('') === 0 && cents('abc') === 0);
    const sum = attempt(() => T.sumCentavos([{ amount: 0.1 }, { amount: 0.2 }]));
    check('sums are whole centavos: 0.1 + 0.2 is exactly 30, not 30.000000000000004',
      sum === 30 && Number.isInteger(sum), String(sum));
    const peso = (c) => attempt(() => T.formatPeso(c));
    check('formatPeso: thousands separators and two decimals: ₱1,500.00, ₱10,549.00, ₱1,234,567.89, ₱0.30, ₱0.05, ₱0.00',
      peso(150000) === '₱1,500.00' && peso(1054900) === '₱10,549.00' && peso(123456789) === '₱1,234,567.89'
        && peso(30) === '₱0.30' && peso(5) === '₱0.05' && peso(0) === '₱0.00',
      said([peso(150000), peso(1054900), peso(123456789), peso(30), peso(5), peso(0)]));

    const line = (args) => attempt(() => T.totalsLine(args));
    const owing = (status, list) => list.map((amount, i) => charge(9000 + i, 'DOCUMENT', status, amount, {}));
    // A paid charge: cash or GCash a staff member recorded, a PayMongo
    // payment, or no payment row at all.
    const paidWith = (id, amount, how) => charge(id, 'DOCUMENT', 'PAID', amount, {
      payments: how === 'none' ? [] : paidRow(id, how === 'online' ? 'gcash' : how, null, how === 'online') });
    const UNPAID14 = owing('UNPAID', [...Array(13).fill(100), 1050]);
    let got = line({ status: 'UNPAID', shown: UNPAID14, received: 14, total: 14, filtered: false });
    check('totals, Needs verification: "14 charges · ₱2,350.00 unpaid", and no second line',
      got?.heading === '14 charges · ₱2,350.00 unpaid' && got.detail === null, said(got));
    got = line({ status: 'UNPAID', shown: owing('UNPAID', [100]), received: 1, total: 1, filtered: false });
    check('  one charge: "1 charge · ₱100.00 unpaid"', got?.heading === '1 charge · ₱100.00 unpaid', said(got));
    const PAID6 = [paidWith(1, 100, 'onsite'), paidWith(2, 50.5, 'onsite'), paidWith(3, 250, 'gcash'),
      paidWith(4, 0.1, 'online'), paidWith(5, 0.2, 'online'), paidWith(6, 0, 'none')];
    got = line({ status: 'PAID', shown: PAID6, received: 6, total: 6, filtered: false });
    check('totals, Paid: "6 charges · ₱400.80 paid", then "Cash ₱150.50 · GCash ₱250.00 · Paid online ₱0.30" (0.1 + 0.2 online)',
      got?.heading === '6 charges · ₱400.80 paid' && got.detail === 'Cash ₱150.50 · GCash ₱250.00 · Paid online ₱0.30', said(got));
    check('  a No fee charge is never listed, and "No payment record" only appears when there is one',
      typeof got?.detail === 'string' && !got.detail.includes('No fee') && !got.detail.includes('No payment record'), said(got));
    got = line({ status: 'PAID', shown: [...PAID6, paidWith(7, 1500, 'none')], received: 7, total: 7, filtered: false });
    check('  with a paid PHP 1,500 charge that has no payment record: "· No payment record ₱1,500.00" at the end',
      got?.heading === '7 charges · ₱1,900.80 paid'
        && got.detail === 'Cash ₱150.50 · GCash ₱250.00 · Paid online ₱0.30 · No payment record ₱1,500.00', said(got));
    got = line({ status: 'VOID', shown: owing('VOID', [500, 500, 500, 500, 537, 100]), received: 6, total: 6, filtered: false });
    check('totals, Void: "6 charges · ₱2,637.00 void", and no second line',
      got?.heading === '6 charges · ₱2,637.00 void' && got.detail === null, said(got));
    const MIXED = [paidWith(1, 100, 'onsite'), ...owing('UNPAID', [50, 0.3]), ...owing('VOID', [25.5])];
    got = line({ status: 'all', shown: MIXED, received: 4, total: 4, filtered: false });
    check('totals, All charges: "4 charges", then "₱100.00 paid · ₱50.30 unpaid · ₱25.50 void"',
      got?.heading === '4 charges' && got.detail === '₱100.00 paid · ₱50.30 unpaid · ₱25.50 void', said(got));
    got = line({ status: 'UNPAID', shown: owing('UNPAID', [1000, 200, 50]), received: 14, total: 14, filtered: true });
    check('totals with a search or tab: "3 of 14 charges match · ₱1,250.00 unpaid"',
      got?.heading === '3 of 14 charges match · ₱1,250.00 unpaid' && got.detail === null, said(got));
    got = line({ status: 'UNPAID', shown: owing('UNPAID', [100]), received: 14, total: 14, filtered: true });
    check('  one match: "1 of 14 charges matches · ₱100.00 unpaid"', got?.heading === '1 of 14 charges matches · ₱100.00 unpaid', said(got));
    got = line({ status: 'all', shown: [paidWith(1, 100, 'onsite'), ...owing('UNPAID', [50])], received: 64, total: 64, filtered: true });
    check('  on All charges: "2 of 64 charges match", then the amounts of those two',
      got?.heading === '2 of 64 charges match' && got.detail === '₱100.00 paid · ₱50.00 unpaid · ₱0.00 void', said(got));
    got = line({ status: 'UNPAID', shown: [], received: 14, total: 14, filtered: true });
    const nothing = line({ status: 'PAID', shown: [], received: 0, total: 0, filtered: false });
    const nothingFiltered = line({ status: 'all', shown: [], received: 0, total: 0, filtered: true });
    check('totals with nothing to show: "0 of 14 charges match" with no amount; an empty status view "0 charges", searched or not',
      got?.heading === '0 of 14 charges match' && got.detail === null && nothing?.heading === '0 charges' && nothing.detail === null
        && nothingFiltered?.heading === '0 charges' && nothingFiltered.detail === null, said([got, nothing, nothingFiltered]));
    const THIRTY = owing('UNPAID', Array(30).fill(100));
    got = line({ status: 'UNPAID', shown: THIRTY, received: 30, total: 1234, filtered: false });
    const cappedSearch = line({ status: 'UNPAID', shown: THIRTY.slice(0, 2), received: 30, total: 1234, filtered: true });
    check('totals over a capped list never claim to cover everything: "Newest 30 of 1,234 charges · ₱3,000.00 unpaid", '
        + '"2 of the newest 30 charges match · ₱200.00 unpaid"',
      got?.heading === 'Newest 30 of 1,234 charges · ₱3,000.00 unpaid'
        && cappedSearch?.heading === '2 of the newest 30 charges match · ₱200.00 unpaid', said([got, cappedSearch]));
    got = line({ status: 'UNPAID', shown: owing('UNPAID', Array(1000).fill(1)), received: 1000, total: 1000, filtered: false });
    check('  counts get thousands separators too: "1,000 charges · ₱1,000.00 unpaid"',
      got?.heading === '1,000 charges · ₱1,000.00 unpaid', said(got));

    // c. Paging, on its own.
    const pg = (count, pageNo) => attempt(() => P.pageOf(count, pageNo));
    const words = (p) => attempt(() => P.pagerText(p));
    check('paging: 25 a page', P.PAGE_SIZE === 25, String(P.PAGE_SIZE));
    let p = pg(88, 1);
    check('paging: 88 charges, page 1: rows 1-25 of 4 pages, "Page 1 of 4", "Showing 1–25 of 88", pager shown',
      p?.page === 1 && p.pages === 4 && p.start === 0 && p.end === 25 && p.show === true
        && words(p)?.page === 'Page 1 of 4' && words(p)?.range === 'Showing 1–25 of 88', said([p, words(p)]));
    p = pg(88, 2);
    check('  page 2: rows 26-50, "Showing 26–50 of 88"', p?.start === 25 && p.end === 50 && words(p)?.range === 'Showing 26–50 of 88', said(p));
    p = pg(88, 4);
    check('  the last page holds what is left: rows 76-88, "Page 4 of 4", "Showing 76–88 of 88"',
      p?.page === 4 && p.start === 75 && p.end === 88 && words(p)?.page === 'Page 4 of 4' && words(p)?.range === 'Showing 76–88 of 88', said(p));
    check('paging clamps: page 9 of 88 is page 4; page 4 of a list shrunk to 60 is page 3 ("Showing 51–60 of 60"); 0, -2 and NaN are page 1',
      pg(88, 9)?.page === 4 && pg(60, 4)?.page === 3 && words(pg(60, 4))?.range === 'Showing 51–60 of 60'
        && pg(10, 0)?.page === 1 && pg(10, -2)?.page === 1 && pg(10, NaN)?.page === 1,
      said([pg(88, 9)?.page, pg(60, 4)?.page, pg(10, 0)?.page, pg(10, -2)?.page, pg(10, NaN)?.page]));
    check('paging hides the pager when everything fits: 25 is one page, 26 is two, none is one',
      pg(25, 1)?.show === false && pg(25, 1).pages === 1 && pg(26, 1)?.show === true && pg(26, 1).pages === 2
        && pg(0, 3)?.page === 1 && pg(0, 3).pages === 1 && pg(0, 3).show === false, said([pg(25, 1), pg(26, 1), pg(0, 3)]));
    p = pg(1000, 40);
    check('  with thousands separators: "Page 40 of 40", "Showing 976–1,000 of 1,000"',
      words(p)?.page === 'Page 40 of 40' && words(p)?.range === 'Showing 976–1,000 of 1,000', said(words(p)));

    // d. The real page, against 64 charges. 30 waiting: 18 documents at PHP
    // 50, 8 rentals at 300, 4 fines at 100 (PHP 3,700). 26 paid: 14
    // documents (one of them PHP 0) and 2 fines, cash, GCash and PayMongo, 10
    // rentals by PayMongo (PHP 4,500). 8 void: 6 rentals at 500, a fine at
    // 100, a document at 50 (PHP 3,150).
    const UNPAID = [
      docOf(148, 'UNPAID', 50, ['Juan', null, 'Dela Cruz'], 'Barangay Clearance', { purpose: 'Scholarship' }),
      docOf(331, 'UNPAID', 50, ['Niño', null, 'Peñaflor'], 'Certificate of Residency'),
      rentalOf(330, 'UNPAID', 300, ['Juan', 'Ramos'], 'Tent', 1, { paymongo_session_id: 'cs_test_330' }),
      rentalOf(329, 'UNPAID', 300, { guest: 'Lito Guest' }, 'Monobloc Chairs', 20),
      fineOf(328, 'UNPAID', 100, 'Rosa Lim', 'General Assembly'),
      docOf(327, 'UNPAID', 50, ['Ana', null, 'Cruz'], 'Barangay Clearance',
        { declared_method: 'gcash', declared_reference: '5550001234', declared_at: '2026-10-05T02:00:00+00:00' }),
      ...['Alma', 'Berto', 'Celia', 'Dante', 'Elena', 'Fidel', 'Gina', 'Hector', 'Ines', 'Jaime', 'Karla', 'Leon', 'Mila',
        'Nestor', 'Olga'].map((first, i) => docOf(300 + i, 'UNPAID', 50, [first, null, 'Abad'], 'Barangay Clearance')),
      ...['Pablo', 'Quina', 'Rico', 'Sara', 'Tomas', 'Ursula'].map((first, i) =>
        rentalOf(315 + i, 'UNPAID', 300, [first, 'Bello'], 'Tent', 1)),
      ...['Victor Cano', 'Wilma Cano', 'Xenia Cano'].map((head, i) => fineOf(321 + i, 'UNPAID', 100, head, 'Clean-up Drive')),
    ];
    const PAID = [
      docOf(340, 'PAID', 100, ['Carla', null, 'Santos'], 'Barangay Clearance', { payments: paidRow(340, 'onsite', 'OR-2026-0042') }),
      docOf(341, 'PAID', 100, ['Dino', null, 'Tan'], 'Barangay Clearance', { payments: paidRow(341, 'gcash', '9876543210') }),
      docOf(342, 'PAID', 100, ['Elsa', null, 'Uy'], 'Barangay Clearance', {
        paymongo_session_id: 'cs_test_342', paymongo_payment_id: PAY_ID, payments: paidRow(342, 'gcash', PAY_ID, true) }),
      docOf(343, 'PAID', 0, ['Fe', null, 'Vera'], 'Certificate of Indigency'),
      ...['Gabo', 'Hilda', 'Igme', 'Jojo', 'Kiko', 'Lorna', 'Mario', 'Nena', 'Oscar', 'Pilar'].map((first, i) =>
        docOf(344 + i, 'PAID', 100, [first, null, 'Cortez'], 'Barangay Clearance', { payments: paidRow(344 + i, 'onsite', null) })),
      ...['Quintin', 'Rosario', 'Santi', 'Tess', 'Ugo', 'Vilma', 'Wena', 'Xavier', 'Yolanda', 'Zaldy'].map((first, i) =>
        rentalOf(354 + i, 'PAID', 300, [first, 'Diaz'], 'Tent', 1, { paymongo_session_id: `cs_test_${354 + i}`,
          paymongo_payment_id: `pay_test_${354 + i}`, payments: paidRow(354 + i, 'gcash', `pay_test_${354 + i}`, true) })),
      ...['Alfredo Ely', 'Bea Ely'].map((head, i) =>
        fineOf(364 + i, 'PAID', 100, head, 'General Assembly', { payments: paidRow(364 + i, 'onsite', null) })),
    ];
    const VOID = [
      ...['Celso', 'Divina', 'Efren', 'Flor', 'Goyo', 'Herminia'].map((first, i) =>
        rentalOf(370 + i, 'VOID', 500, [first, 'Ebro'], 'Tent', 1)),
      fineOf(376, 'VOID', 100, 'Isabel Fuentes', 'Clean-up Drive'),
      docOf(377, 'VOID', 50, ['Jun', null, 'Galang'], 'Barangay Clearance'),
    ];
    const fresh = () => ({ UNPAID: [...UNPAID], PAID: [...PAID], VOID: [...VOID] });
    // The list answer for the status asked for, from `state`, which a check
    // may change between loads; `total` stands in for a server cap.
    const answerFrom = (state, total = null) => (url, method) => {
      if (method !== 'GET' || !url.includes(LIST)) return undefined;
      const status = url.split(LIST)[1].toUpperCase();
      const charges = status === 'ALL' ? [...state.UNPAID, ...state.PAID, ...state.VOID] : state[status] || [];
      return { charges, total: total ?? charges.length };
    };
    const SEARCH = 'input[aria-label="Search charges"]';
    const mountPayments = async () => {
      const page = await globalThis.mountInteractive(root(), '/secretary/payments');
      await page.settle();
      return page;
    };
    const openWith = async (state, total) => {
      seedSession(VALID);
      resetNet(200, answerFrom(state, total));
      return mountPayments();
    };
    const listHeading = (page) => page.queryAll('h2').find((h) => !h.closest('.pay-panel')) ?? null;
    // What the page says, read the way a person would.
    const look = (page) => ({
      heading: listHeading(page)?.textContent ?? null,
      detail: page.query('.pay-totals-detail')?.textContent ?? null,
      tabs: page.queryAll('.pay-tabs button').map((b) => b.textContent).join(' · '),
      pressed: page.queryAll('.pay-tabs button[aria-pressed="true"]').map((b) => b.textContent),
      rows: page.queryAll('table.payments-table tbody tr').map((tr) => tr.querySelector('strong')?.textContent ?? null),
      pager: page.query('.pay-pager')?.textContent ?? null,
      cap: page.query('.pay-cap')?.textContent ?? null,
      search: page.query(SEARCH)?.value ?? null,
      noMatch: root().textContent.includes('No charges match your search or filters.'),
    });
    const pagerSays = (v, pageText, range) => typeof v.pager === 'string' && v.pager.includes(pageText) && v.pager.includes(range);
    const type = async (page, text) => { if (page.query(SEARCH)) await page.fill(SEARCH, text); };
    const tabNamed = (page, label) => page.queryAll('.pay-tabs button').find((b) => b.textContent.startsWith(`${label} `));
    const viewFor = (page, name) =>
      page.queryAll('button').find((b) => (b.getAttribute('aria-label') || '').startsWith(`View charge for ${name}:`));
    const choose = async (page, value) => {
      const select = page.query('.list-head select');
      if (select) {
        select.value = value;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await page.settle();
    };
    const namesOf = (list) => list.map((c) => NAME.get(c.charge_id));
    // jsdom has no scrollIntoView; this one records what asked to be shown.
    const scrolled = [];
    const proto = dom.window.HTMLElement.prototype;
    const previousScroll = proto.scrollIntoView;
    proto.scrollIntoView = function scrollIntoView(options) { scrolled.push({ el: this, options }); };

    let page = await openWith(fresh());
    let v = look(page);
    check('Payments opens on Needs verification: "30 charges · ₱3,700.00 unpaid", tabs All 30 · Documents 18 · Rentals 8 · Fines 4, All pressed',
      page.query('.list-head select')?.value === 'UNPAID' && v.heading === '30 charges · ₱3,700.00 unpaid' && v.detail === null
        && v.tabs === 'All 30 · Documents 18 · Rentals 8 · Fines 4' && said(v.pressed) === said(['All 30']), said(v));
    check('  the first 25 rows in the order sent, and the pager reads "Page 1 of 2" and "Showing 1–25 of 30"',
      said(v.rows) === said(namesOf(UNPAID.slice(0, 25))) && pagerSays(v, 'Page 1 of 2', 'Showing 1–25 of 30'),
      said({ rows: v.rows.length, first: v.rows[0], pager: v.pager }));
    const box = page.query(SEARCH);
    check('  the search box is labelled "Search charges", reads "Search name, charge no. or reference" and starts empty; no Clear button, no cap notice',
      !!box && box.getAttribute('placeholder') === 'Search name, charge no. or reference' && box.value === ''
        && !page.query('button[aria-label="Clear search"]') && v.cap === null,
      said({ placeholder: box?.getAttribute('placeholder') ?? null, cap: v.cap }));

    await type(page, 'juan');
    v = look(page);
    check('typing "juan" narrows the rows to Juan Dela Cruz and Juan Ramos as you type, with no button pressed',
      said(v.rows) === said(['Juan Dela Cruz', 'Juan Ramos']), said(v.rows));
    check('  the tab counts follow the search: All 2 · Documents 1 · Rentals 1 · Fines 0, Fines dimmed but still a button you can press',
      v.tabs === 'All 2 · Documents 1 · Rentals 1 · Fines 0' && tabNamed(page, 'Fines')?.classList.contains('pay-tab-empty') === true
        && tabNamed(page, 'Fines')?.disabled === false && tabNamed(page, 'Rentals')?.classList.contains('pay-tab-empty') === false,
      said(v.tabs));
    check('  the totals follow it: "2 of 30 charges match · ₱350.00 unpaid", and the pager is hidden',
      v.heading === '2 of 30 charges match · ₱350.00 unpaid' && v.pager === null, said(v));

    const rowsFor = async (text) => { await type(page, text); return look(page).rows; };
    const found = {
      nino: await rowsFor('nino'), cruzJuan: await rowsFor('cruz juan'), hash: await rowsFor('#148'), bare: await rowsFor('148'),
    };
    check('accents, word order and the charge number: "nino" finds Niño Peñaflor; "cruz juan" only Juan Dela Cruz; "#148" and "148" charge #148',
      said(found.nino) === said(['Niño Peñaflor']) && said(found.cruzJuan) === said(['Juan Dela Cruz'])
        && said(found.hash) === said(['Juan Dela Cruz']) && said(found.bare) === said(['Juan Dela Cruz']), said(found));
    const more = {
      reference: await rowsFor('5550001234'), item: await rowsFor('monobloc'), event: await rowsFor('general assembly'),
    };
    check('a declared reference, a rental item, an event title: "5550001234" finds Ana Cruz, "monobloc" Lito Guest, "general assembly" Rosa Lim',
      said(more.reference) === said(['Ana Cruz']) && said(more.item) === said(['Lito Guest']) && said(more.event) === said(['Rosa Lim']),
      said(more));
    await type(page, 'scholarship');
    v = look(page);
    check('the purpose is not searched: "scholarship" (Juan Dela Cruz\'s purpose) matches nothing: "No charges match your search or filters."',
      v.rows.length === 0 && v.noMatch && !!buttonNamed(root(), 'Clear search and filters') && v.heading === '0 of 30 charges match',
      said(v));

    await type(page, 'juan');
    const clearX = page.query('button[aria-label="Clear search"]');
    await clickIf(page, clearX);
    v = look(page);
    check('the Clear (x) button shows while the box has text; pressing it empties the box, brings all 30 back and leaves focus in the box',
      !!clearX && v.search === '' && v.heading === '30 charges · ₱3,700.00 unpaid' && v.rows.length === 25
        && page.active() === page.query(SEARCH) && !page.query('button[aria-label="Clear search"]'), said(v));
    await type(page, 'juan');
    if (page.query(SEARCH)) await page.key('Escape', SEARCH);
    v = look(page);
    check('Escape in the box clears it too', v.search === '' && v.rows.length === 25, said({ search: v.search, rows: v.rows.length }));

    await clickIf(page, tabNamed(page, 'Rentals'));
    v = look(page);
    check('the Rentals tab: only the 8 rentals, Rentals pressed, "8 of 30 charges match · ₱2,400.00 unpaid"',
      said(v.rows) === said(namesOf(UNPAID.filter((c) => c.charge_type === 'RENTAL'))) && said(v.pressed) === said(['Rentals 8'])
        && v.heading === '8 of 30 charges match · ₱2,400.00 unpaid', said(v));
    await type(page, 'juan');
    await clickIf(page, tabNamed(page, 'Fines'));
    v = look(page);
    const clearAll = buttonNamed(root(), 'Clear search and filters');
    check('a tab with nothing in it: "juan", then Fines (0), says "No charges match your search or filters." with a "Clear search and filters" button',
      v.rows.length === 0 && v.noMatch && !!clearAll && said(v.pressed) === said(['Fines 0']) && v.heading === '0 of 30 charges match',
      said(v));
    await clickIf(page, clearAll);
    v = look(page);
    check('  pressing it clears the search, goes back to All and puts focus in the search box',
      v.search === '' && said(v.pressed) === said(['All 30']) && v.rows.length === 25 && page.active() === page.query(SEARCH), said(v));

    scrolled.length = 0;
    const focusBefore = page.active();
    await clickIf(page, buttonNamed(root(), 'Next'));
    v = look(page);
    const nextButton = buttonNamed(root(), 'Next');
    check('Next: page 2 holds the last 5 rows, "Page 2 of 2", "Showing 26–30 of 30", and Next is no longer available',
      said(v.rows) === said(namesOf(UNPAID.slice(25))) && pagerSays(v, 'Page 2 of 2', 'Showing 26–30 of 30')
        && nextButton?.getAttribute('aria-disabled') === 'true', said(v));
    check('  it scrolls the list heading into view and moves nothing else: focus stays where it was',
      scrolled.length === 1 && scrolled[0].el === listHeading(page) && page.active() === focusBefore,
      `${scrolled.length} scroll(s), onto ${scrolled[0]?.el?.tagName ?? 'nothing'}`);
    await clickIf(page, nextButton);
    check('  pressing the unavailable Next does nothing', pagerSays(look(page), 'Page 2 of 2', 'Showing 26–30 of 30') && scrolled.length === 1);
    await clickIf(page, buttonNamed(root(), 'Previous'));
    v = look(page);
    check('  Previous goes back to page 1, where Previous is the one not available',
      pagerSays(v, 'Page 1 of 2', 'Showing 1–25 of 30') && buttonNamed(root(), 'Previous')?.getAttribute('aria-disabled') === 'true'
        && buttonNamed(root(), 'Next')?.getAttribute('aria-disabled') !== 'true', said(v.pager));

    await clickIf(page, buttonNamed(root(), 'Next'));
    await choose(page, 'all');
    v = look(page);
    check('a status change returns to page 1: page 2 of Needs verification, then All charges, reads "Page 1 of 3"',
      pagerSays(v, 'Page 1 of 3', 'Showing 1–25 of 64'), said(v.pager));
    check('All charges: "64 charges", then "₱4,500.00 paid · ₱3,700.00 unpaid · ₱3,150.00 void"; tabs All 64 · Documents 33 · Rentals 24 · Fines 7',
      v.heading === '64 charges' && v.detail === '₱4,500.00 paid · ₱3,700.00 unpaid · ₱3,150.00 void'
        && v.tabs === 'All 64 · Documents 33 · Rentals 24 · Fines 7', said(v));
    await clickIf(page, buttonNamed(root(), 'Next'));
    await clickIf(page, tabNamed(page, 'Documents'));
    v = look(page);
    check('a tab change returns to page 1: page 2 of All charges, then Documents, reads "Page 1 of 2" and "33 of 64 charges match"',
      pagerSays(v, 'Page 1 of 2', 'Showing 1–25 of 33') && v.heading === '33 of 64 charges match', said(v));
    await clickIf(page, tabNamed(page, 'All'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    const onThird = look(page);
    await type(page, 'clearance');
    v = look(page);
    check('a search change returns to page 1: page 3 of All charges, then "clearance", reads "Page 1 of 2" of 31',
      pagerSays(onThird, 'Page 3 of 3', 'Showing 51–64 of 64') && pagerSays(v, 'Page 1 of 2', 'Showing 1–25 of 31'),
      said([onThird.pager, v.pager]));

    await clickIf(page, tabNamed(page, 'Documents'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    const beforeRefresh = look(page);
    const callsBefore = net.calls.length;
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    v = look(page);
    check('Refresh keeps the search, the tab and the page: "clearance", Documents and page 2 of All charges, before and after the reload',
      pagerSays(beforeRefresh, 'Page 2 of 2', 'Showing 26–31 of 31') && net.calls.length === callsBefore + 1
        && v.search === 'clearance' && said(v.pressed) === said(['Documents 31']) && pagerSays(v, 'Page 2 of 2', 'Showing 26–31 of 31'),
      said({ before: beforeRefresh.pager, after: v }));

    await type(page, '');
    await clickIf(page, tabNamed(page, 'All'));
    await choose(page, 'PAID');
    v = look(page);
    check('Paid: "26 charges · ₱4,500.00 paid", split "Cash ₱1,300.00 · GCash ₱100.00 · Paid online ₱3,100.00"; the No fee charge is not listed',
      v.heading === '26 charges · ₱4,500.00 paid' && v.detail === 'Cash ₱1,300.00 · GCash ₱100.00 · Paid online ₱3,100.00', said(v));
    await choose(page, 'VOID');
    v = look(page);
    check('Void: "8 charges · ₱3,150.00 void", no second line, and one page, so no pager',
      v.heading === '8 charges · ₱3,150.00 void' && v.detail === null && v.pager === null, said(v));

    await choose(page, 'UNPAID');
    await type(page, 'juan');
    await clickIf(page, tabNamed(page, 'Rentals'));
    await choose(page, 'all');
    v = look(page);
    check('a status change keeps the search and the tab: "juan" and Rentals on Needs verification, then All charges: both kept, "1 of 64 charges matches"',
      v.search === 'juan' && said(v.pressed) === said(['Rentals 1']) && v.heading === '1 of 64 charges matches'
        && said(v.rows) === said(['Juan Ramos']) && v.detail === '₱0.00 paid · ₱300.00 unpaid · ₱0.00 void', said(v));
    await page.unmount();

    // A reload that brings back fewer charges: page 3 of 3 becomes the last
    // page there is, and stays where it landed when the list grows again.
    const shrinking = fresh();
    page = await openWith(shrinking);
    await choose(page, 'all');
    await clickIf(page, buttonNamed(root(), 'Next'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    const third = look(page);
    shrinking.PAID = PAID.filter((c) => c.charge_type !== 'RENTAL');
    shrinking.VOID = VOID.filter((c) => c.charge_type !== 'RENTAL');
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    const shrunk = look(page);
    Object.assign(shrinking, fresh());
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    const regrown = look(page);
    check('a reload that shrinks the list moves to its last page: page 3 of 3, then 48 charges, reads "Page 2 of 2", "Showing 26–48 of 48"',
      pagerSays(third, 'Page 3 of 3', 'Showing 51–64 of 64') && pagerSays(shrunk, 'Page 2 of 2', 'Showing 26–48 of 48')
        && shrunk.rows.length === 23, said([third.pager, shrunk.pager]));
    check('  and stays there when the list grows back: "Page 2 of 3"', pagerSays(regrown, 'Page 2 of 3', 'Showing 26–50 of 64'), said(regrown.pager));
    await page.unmount();

    // Filters reset on every visit and are never kept in the browser. The
    // second mount does NOT reseed the session, which would clear storage.
    page = await openWith(fresh());
    const writesAtOpen = store.sets;
    await type(page, 'juan');
    await clickIf(page, tabNamed(page, 'Rentals'));
    await choose(page, 'PAID');
    const writesAfter = store.sets;
    await page.unmount();
    resetNet(200, answerFrom(fresh()));
    page = await mountPayments();
    v = look(page);
    check('filters start fresh each time the page opens: after "juan", Rentals and Paid, a new visit shows Needs verification, an empty box and All',
      v.search === '' && said(v.pressed) === said(['All 30']) && page.query('.list-head select')?.value === 'UNPAID'
        && pagerSays(v, 'Page 1 of 2', 'Showing 1–25 of 30'), said(v));
    check('  and nothing about them was stored in the browser: no localStorage write, sessionStorage empty',
      writesAfter === writesAtOpen && dom.window.sessionStorage.length === 0,
      `${writesAfter - writesAtOpen} localStorage write(s), sessionStorage ${dom.window.sessionStorage.length}`);
    await page.unmount();

    // Record payment: the reload after it keeps the search.
    const recordState = fresh();
    seedSession(VALID);
    resetNet(200, (url, method) => {
      if (method === 'POST' && url.endsWith('/charges/148/verify')) {
        recordState.UNPAID = recordState.UNPAID.filter((c) => c.charge_id !== 148);
        return { message: 'Payment recorded — charge marked PAID', payment: { payment_id: 88 } };
      }
      return answerFrom(recordState)(url, method);
    });
    page = await mountPayments();
    await type(page, 'juan');
    await clickIf(page, viewFor(page, 'Juan Dela Cruz'));
    if (page.query('form')?.closest('.pay-panel')) await page.submit();
    await page.settle();
    v = look(page);
    check('Record payment keeps the filters: "juan", Record on Juan Dela Cruz, and the reload still reads "juan": "1 of 29 charges matches · ₱300.00 unpaid"',
      v.search === 'juan' && v.heading === '1 of 29 charges matches · ₱300.00 unpaid' && said(v.rows) === said(['Juan Ramos'])
        && page.query('.alert.success')?.textContent === 'Payment recorded — charge marked PAID (payment #88)' && !page.query('.pay-panel'),
      said(v));
    await page.unmount();

    // A charge that a search hides while its panel is open: the panel works
    // from the whole list, never the filtered one.
    const recheckState = fresh();
    seedSession(VALID);
    resetNet(200, (url, method) => {
      if (method === 'POST' && url.endsWith('/payments/gcash/reconcile/330')) {
        recheckState.UNPAID = recheckState.UNPAID.filter((c) => c.charge_id !== 330);
        return { settled: true, outcome: 'recorded', message: 'PayMongo confirmed the payment. The charge is now paid.' };
      }
      return answerFrom(recheckState)(url, method);
    });
    page = await mountPayments();
    await clickIf(page, viewFor(page, 'Juan Ramos'));
    const opened = page.query('.pay-panel #pay-panel-title')?.textContent ?? null;
    await type(page, 'nino');
    v = look(page);
    check('a charge filtered out of view keeps its panel: View Juan Ramos, then "nino": the panel stays open on Juan Ramos, the list shows Niño Peñaflor',
      opened === 'Juan Ramos' && page.query('.pay-panel #pay-panel-title')?.textContent === 'Juan Ramos'
        && said(v.rows) === said(['Niño Peñaflor']), said({ opened, rows: v.rows }));
    await clickIf(page, buttonNamed(root(), 'Re-check with PayMongo'));
    await page.settle();
    v = look(page);
    check('  and Re-check still closes it when the reload shows the charge paid: focus on the message, "nino" kept',
      !page.query('.pay-panel') && page.active() === page.query('.alert.success') && v.search === 'nino'
        && said(v.rows) === said(['Niño Peñaflor']), said({ panel: !!page.query('.pay-panel'), focus: page.active()?.className, v }));
    await page.unmount();

    // The 1,000-row cap: a total larger than the list received.
    page = await openWith(fresh(), 1234);
    v = look(page);
    const capEl = page.query('.pay-cap');
    const capFirst = !!capEl && !!listHeading(page)
      && (capEl.compareDocumentPosition(listHeading(page)) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    check('the 1,000-row cap: a total of 1,234 with 30 received says "Showing the newest 30 of 1,234 charges." above the totals, '
        + 'which say "Newest 30 of 1,234 charges · ₱3,700.00 unpaid"',
      typeof v.cap === 'string' && v.cap.startsWith('Showing the newest 30 of 1,234 charges.') && capFirst
        && v.heading === 'Newest 30 of 1,234 charges · ₱3,700.00 unpaid', said(v));
    await type(page, 'juan');
    v = look(page);
    check('  with a search: "2 of the newest 30 charges match · ₱350.00 unpaid", and the notice stays',
      v.heading === '2 of the newest 30 charges match · ₱350.00 unpaid' && typeof v.cap === 'string', said(v));
    await page.unmount();

    // The batch 4 load error: still no rows, counts, tabs, totals or pager.
    seedSession(VALID);
    resetNet(500, (url) => (url.includes(LIST) ? { error: 'Network down' } : undefined));
    page = await mountPayments();
    v = look(page);
    const statusSelect = page.query('.list-head select');
    check('a load error shows no tabs, no totals, no pager and no rows, the heading just "Charges"; the search box and status dropdown still work',
      root().textContent.includes('Could not load the charges: Network down') && v.heading === 'Charges' && !page.query('.pay-tabs')
        && v.detail === null && v.pager === null && v.rows.length === 0 && v.cap === null
        && !!page.query(SEARCH) && !page.query(SEARCH).disabled && !!statusSelect && !statusSelect.disabled, said(v));
    await type(page, 'juan');
    v = look(page);
    check('  typing during the error changes none of that, and says nothing about matches',
      v.search === 'juan' && v.heading === 'Charges' && !page.query('.pay-tabs') && v.rows.length === 0 && !v.noMatch, said(v));
    await page.unmount();

    // A status view with no charges at all keeps its own empty text.
    page = await openWith({ ...fresh(), VOID: [] });
    await type(page, 'juan');
    await choose(page, 'VOID');
    v = look(page);
    check('a status view with no charges at all keeps its own text: Void with none says "No charges here.", not the no-match text, search or not',
      root().textContent.includes('No charges here.') && !v.noMatch && v.heading === '0 charges' && v.rows.length === 0, said(v));
    await page.unmount();

    if (previousScroll === undefined) delete proto.scrollIntoView;
    else proto.scrollIntoView = previousScroll;
  }

  console.error = origError;
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => {
  // console.error is silenced while the checks run, so a crash is written to
  // stderr directly; through console.error it vanished without a word.
  process.stderr.write(`FAILED: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
