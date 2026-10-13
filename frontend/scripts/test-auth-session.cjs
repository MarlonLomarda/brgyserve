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
// Section P is the Payments pager itself: the count line, Rows per page, the
// numbered page buttons and Previous and Next, against 89 stubbed charges. It
// sits inside section O's block, to use the same charges and helpers.
//
// Section Q is the Payments page's Method and date filters: the pure helpers
// (utils/chargeFilters.js, and the totals line's date phrase) case by case,
// then the real page against 23 stubbed charges, with "today" fixed at 12 Oct
// 2026 by the helpers' one clock. It sits inside section O's block too.
//
// Section R is the Payments toolbar on a phone: the "Filters" button and the
// panel it opens in place, holding the one set of Method and date controls,
// and Refresh, which keeps its name. Against section Q's 23 charges, inside
// section O's block.
//
// Section T is "No fee" on My requests, My rentals and the request detail: a
// PAID PHP 0 charge says "No fee" instead of "₱0.00 — Paid", and a billed
// request shows the fee it was charged, not its type's fee today.
//
// Section U is the Collections report: the "No-fee charges" tile beside
// "Payments recorded", and the monthly series named "Collected (by billed
// month)" in the chart's legend and the Monthly table.
//
// Section V is the Document requests list, for the Secretary, Staff and the
// Punong Barangay: what section M checks on Payments. A load that fails says
// so, with Try again, and never shows an empty list; every way of loading
// again starts from the loading state; an older answer that arrives late
// cannot replace a newer one; and the status tabs are labelled.
//
// Section W is the Document requests list's status tabs, for the same three
// roles: seven tabs with counts in place of the status select, the list
// loaded once with ?status=all and filtered in the browser, the page opening
// on Pending, and the chosen tab kept through every reload; then the tab
// strip on a narrow phone, as section S checks Payments'.
//
// Section X is the Document requests list's search box, for the same three
// roles: the Payments box (components/ListToolbar.jsx) over the list already
// loaded, matching only what a row shows of who and what, with the tab counts
// and the heading following it, no request per keystroke, and the search kept
// through Refresh, Try again and Back from a request.
//
// Section Y is the Document requests list's pager, for the same three roles:
// the Payments pager (components/ListPager.jsx) under the rows, from 11
// matches, paging the list already loaded with no request; the heading and
// the tab counts still counting every match; page 1 again on a tab, search
// or Rows per page change; and the page kept, or clamped to the last one,
// through Refresh, Try again and Back from a request.
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
  // page shown; and pages, 25 a page unless Rows per page says otherwise (the
  // pager itself is section P, below). Filters start fresh on every visit and
  // live through Refresh, Record payment and Re-check. The pure helpers
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

    // c. Paging, on its own: 25 a page unless Rows per page says otherwise,
    // the count line ("Showing 1 to 25 of 88 results"), the phone's "Page 1
    // of 4", and which page numbers the pager draws.
    const pg = (count, pageNo, size) => attempt(() => P.pageOf(count, pageNo, size));
    const words = (p) => attempt(() => P.pagerText(p));
    // The count line as the page writes it, from pagerText's three numbers.
    const showing = (p) => {
      const w = words(p);
      return w && typeof w === 'object' ? `Showing ${w.from} to ${w.to} of ${w.of} results` : String(w);
    };
    check('paging: 25 a page unless chosen otherwise, and the choices are 10, 25, 50 and 100',
      P.PAGE_SIZE === 25 && said(P.PAGE_SIZES) === '[10,25,50,100]', said([P.PAGE_SIZE, P.PAGE_SIZES]));
    let p = pg(88, 1);
    check('paging: 88 charges, page 1: rows 1-25 of 4 pages, "Showing 1 to 25 of 88 results", "Page 1 of 4", pager shown',
      p?.page === 1 && p.pages === 4 && p.start === 0 && p.end === 25 && p.show === true
        && showing(p) === 'Showing 1 to 25 of 88 results' && words(p)?.page === 'Page 1 of 4', said([p, words(p)]));
    p = pg(88, 2);
    check('  page 2: rows 26-50, "Showing 26 to 50 of 88 results"',
      p?.start === 25 && p.end === 50 && showing(p) === 'Showing 26 to 50 of 88 results', said([p, words(p)]));
    p = pg(88, 4);
    check('  the last page holds what is left: rows 76-88, "Page 4 of 4", "Showing 76 to 88 of 88 results"',
      p?.page === 4 && p.start === 75 && p.end === 88 && words(p)?.page === 'Page 4 of 4'
        && showing(p) === 'Showing 76 to 88 of 88 results', said([p, words(p)]));
    check('paging clamps: page 9 of 88 is page 4; page 4 of a list shrunk to 60 is page 3 ("Showing 51 to 60 of 60 results"); 0, -2 and NaN are page 1',
      pg(88, 9)?.page === 4 && pg(60, 4)?.page === 3 && showing(pg(60, 4)) === 'Showing 51 to 60 of 60 results'
        && pg(10, 0)?.page === 1 && pg(10, -2)?.page === 1 && pg(10, NaN)?.page === 1,
      said([pg(88, 9)?.page, pg(60, 4)?.page, pg(10, 0)?.page, pg(10, -2)?.page, pg(10, NaN)?.page]));
    check('the pager shows from 11 matches, even when they fit on one page: 10 hides it, 11 and 25 show it with one page, '
        + '26 makes two, none hides it',
      pg(10, 1)?.show === false && pg(11, 1)?.show === true && pg(11, 1).pages === 1 && pg(25, 1)?.show === true
        && pg(25, 1).pages === 1 && pg(26, 1)?.show === true && pg(26, 1).pages === 2
        && pg(0, 3)?.page === 1 && pg(0, 3).pages === 1 && pg(0, 3).show === false,
      said([pg(10, 1), pg(11, 1), pg(25, 1), pg(26, 1), pg(0, 3)]));
    p = pg(1000, 40);
    check('  with thousands separators: "Page 40 of 40", "Showing 976 to 1,000 of 1,000 results"',
      words(p)?.page === 'Page 40 of 40' && showing(p) === 'Showing 976 to 1,000 of 1,000 results', said(words(p)));
    p = pg(89, 9, 10);
    const firstOfTen = pg(89, 1, 10);
    check('paging at 10 a page: 89 charges make 9 pages; page 1 is rows 1-10, page 9 rows 81-89, "Showing 81 to 89 of 89 results"',
      firstOfTen?.pages === 9 && firstOfTen.start === 0 && firstOfTen.end === 10 && p?.page === 9 && p.start === 80 && p.end === 89
        && showing(p) === 'Showing 81 to 89 of 89 results' && words(p)?.page === 'Page 9 of 9', said([firstOfTen, p, words(p)]));
    check('  at 50 a page 89 charges make 2 pages, at 100 one page ("Showing 1 to 89 of 89 results")',
      pg(89, 2, 50)?.pages === 2 && pg(89, 2, 50).start === 50 && pg(89, 1, 100)?.pages === 1
        && showing(pg(89, 1, 100)) === 'Showing 1 to 89 of 89 results', said([pg(89, 2, 50), pg(89, 1, 100)]));
    check('  a size that is not a whole number above 0 is 25: 0, -10, 2.5 and NaN all make 89 charges 4 pages',
      [0, -10, 2.5, NaN].every((size) => pg(89, 1, size)?.pages === 4), said([0, -10, 2.5, NaN].map((size) => pg(89, 1, size)?.pages)));

    // Which page numbers the pager draws: up to 7 pages, every number; above
    // 7, exactly 7 slots, "…" standing for the pages left out.
    const drawn = (current, pages) => {
      const items = attempt(() => P.pageItems(current, pages));
      return Array.isArray(items) ? items.map((it) => (it === P.GAP ? '…' : String(it))).join(' ') : String(items);
    };
    check('page numbers, 1 page: "1"', drawn(1, 1) === '1', drawn(1, 1));
    check('page numbers, 7 pages: every number whatever the page; 1, 4 and 7 all draw "1 2 3 4 5 6 7"',
      [1, 4, 7].every((c) => drawn(c, 7) === '1 2 3 4 5 6 7'), said([1, 4, 7].map((c) => drawn(c, 7))));
    check('page numbers, 8 pages: 1 and 4 draw "1 2 3 4 5 … 8", 5 and 8 draw "1 … 4 5 6 7 8"',
      drawn(1, 8) === '1 2 3 4 5 … 8' && drawn(4, 8) === '1 2 3 4 5 … 8' && drawn(5, 8) === '1 … 4 5 6 7 8'
        && drawn(8, 8) === '1 … 4 5 6 7 8', said([1, 4, 5, 8].map((c) => drawn(c, 8))));
    const TWENTY_ONE = {
      1: '1 2 3 4 5 … 21', 2: '1 2 3 4 5 … 21', 4: '1 2 3 4 5 … 21', 5: '1 … 4 5 6 … 21', 11: '1 … 10 11 12 … 21',
      17: '1 … 16 17 18 … 21', 18: '1 … 17 18 19 20 21', 21: '1 … 17 18 19 20 21',
    };
    const wrong21 = Object.entries(TWENTY_ONE).filter(([c, want]) => drawn(Number(c), 21) !== want)
      .map(([c, want]) => `page ${c}: "${drawn(Number(c), 21)}", want "${want}"`);
    check('page numbers, 21 pages: 1, 2 and 4 draw "1 2 3 4 5 … 21"; 5 "1 … 4 5 6 … 21"; 11, the middle, "1 … 10 11 12 … 21"; '
        + '17 "1 … 16 17 18 … 21"; 18, the last but 3, and 21, the last, "1 … 17 18 19 20 21"',
      wrong21.length === 0, said(wrong21));
    // Every page of every list from 1 to 40 pages, against the rules the
    // numbers keep whatever the window looks like.
    const broken = [];
    for (let pages = 1; pages <= 40; pages += 1) {
      for (let current = 1; current <= pages; current += 1) {
        const items = attempt(() => P.pageItems(current, pages));
        const why = [];
        if (!Array.isArray(items)) why.push(String(items));
        else {
          const nums = items.filter((it) => it !== P.GAP);
          if (items.length > 7) why.push(`${items.length} slots`);
          if (pages > 7 && items.length !== 7) why.push('not exactly 7 slots');
          if (pages <= 7 && items.length !== pages) why.push('not every number');
          if (items.some((it, i) => it === P.GAP && items[i + 1] === P.GAP)) why.push('two … in a row');
          if (items[0] !== 1 || items[items.length - 1] !== pages) why.push('first or last page missing');
          if (!items.includes(current)) why.push('current page missing');
          if (nums.some((n) => !Number.isInteger(n))) why.push('a slot that is neither a page number nor …');
          if (nums.some((n, i) => i > 0 && n <= nums[i - 1])) why.push('out of order');
          if (items.some((it, i) => it === P.GAP && items[i + 1] - items[i - 1] < 3)) why.push('… for a single page');
        }
        if (why.length) broken.push(`page ${current} of ${pages}: ${why.join(', ')}`);
      }
    }
    check('page numbers, every page of lists of 1 to 40 pages: at most 7 slots, exactly 7 above 7 pages, never two "…" in a row, '
        + 'always the first, the last and the current page, in order, and every "…" stands for at least two pages',
      broken.length === 0, `${broken.length} broken${broken.length ? `: ${said(broken.slice(0, 4))}` : ''}`);

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
    // What the page says, read the way a person would. The pager's parts are
    // read one by one: the count line, the page number marked current, the
    // numbers drawn ("…" for a gap), the phone's "Page 2 of 4" and the Rows
    // per page choice.
    const look = (page) => ({
      heading: listHeading(page)?.textContent ?? null,
      detail: page.query('.pay-totals-detail')?.textContent ?? null,
      tabs: page.queryAll('.pay-tabs button').map((b) => b.textContent).join(' · '),
      pressed: page.queryAll('.pay-tabs button[aria-pressed="true"]').map((b) => b.textContent),
      rows: page.queryAll('table.payments-table tbody tr').map((tr) => tr.querySelector('strong')?.textContent ?? null),
      pager: page.query('.pay-pager')?.textContent ?? null,
      showing: page.query('.pay-pager-count')?.textContent ?? null,
      current: page.queryAll('.pay-pager [aria-current="page"]').map((b) => b.textContent),
      numbers: page.queryAll('.pay-pager-numbers li').map((li) => li.textContent).join(' '),
      short: page.query('.pay-pager-short')?.textContent ?? null,
      size: page.query('#pay-page-size')?.value ?? null,
      cap: page.query('.pay-cap')?.textContent ?? null,
      search: page.query(SEARCH)?.value ?? null,
      noMatch: root().textContent.includes('No charges match your search or filters.'),
    });
    // The pager is on page n of m, which three parts must agree on: the count
    // line, the one number marked aria-current="page", and "Page n of m".
    const pagerSays = (v, short, showingText) => {
      const n = /^Page (\d+) of /.exec(short)?.[1];
      return v.short === short && v.showing === showingText && said(v.current) === said([n]);
    };
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
    check('  the first 25 rows in the order sent, and the pager reads "Showing 1 to 25 of 30 results", page 1 of 2',
      said(v.rows) === said(namesOf(UNPAID.slice(0, 25))) && pagerSays(v, 'Page 1 of 2', 'Showing 1 to 25 of 30 results'),
      said({ rows: v.rows.length, first: v.rows[0], showing: v.showing, current: v.current, short: v.short }));
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
    check('Next: page 2 holds the last 5 rows, "Showing 26 to 30 of 30 results", page 2 of 2, and Next is no longer available',
      said(v.rows) === said(namesOf(UNPAID.slice(25))) && pagerSays(v, 'Page 2 of 2', 'Showing 26 to 30 of 30 results')
        && nextButton?.getAttribute('aria-disabled') === 'true', said(v));
    check('  it scrolls the list heading into view and moves nothing else: focus stays where it was',
      scrolled.length === 1 && scrolled[0].el === listHeading(page) && page.active() === focusBefore,
      `${scrolled.length} scroll(s), onto ${scrolled[0]?.el?.tagName ?? 'nothing'}`);
    await clickIf(page, nextButton);
    check('  pressing the unavailable Next does nothing',
      pagerSays(look(page), 'Page 2 of 2', 'Showing 26 to 30 of 30 results') && scrolled.length === 1);
    await clickIf(page, buttonNamed(root(), 'Previous'));
    v = look(page);
    check('  Previous goes back to page 1, where Previous is the one not available',
      pagerSays(v, 'Page 1 of 2', 'Showing 1 to 25 of 30 results') && buttonNamed(root(), 'Previous')?.getAttribute('aria-disabled') === 'true'
        && buttonNamed(root(), 'Next')?.getAttribute('aria-disabled') !== 'true', said([v.showing, v.current]));

    await clickIf(page, buttonNamed(root(), 'Next'));
    await choose(page, 'all');
    v = look(page);
    check('a status change returns to page 1: page 2 of Needs verification, then All charges, reads page 1 of 3',
      pagerSays(v, 'Page 1 of 3', 'Showing 1 to 25 of 64 results'), said([v.showing, v.current, v.short]));
    check('All charges: "64 charges", then "₱4,500.00 paid · ₱3,700.00 unpaid · ₱3,150.00 void"; tabs All 64 · Documents 33 · Rentals 24 · Fines 7',
      v.heading === '64 charges' && v.detail === '₱4,500.00 paid · ₱3,700.00 unpaid · ₱3,150.00 void'
        && v.tabs === 'All 64 · Documents 33 · Rentals 24 · Fines 7', said(v));
    await clickIf(page, buttonNamed(root(), 'Next'));
    await clickIf(page, tabNamed(page, 'Documents'));
    v = look(page);
    check('a tab change returns to page 1: page 2 of All charges, then Documents, reads page 1 of 2 and "33 of 64 charges match"',
      pagerSays(v, 'Page 1 of 2', 'Showing 1 to 25 of 33 results') && v.heading === '33 of 64 charges match', said(v));
    await clickIf(page, tabNamed(page, 'All'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    const onThird = look(page);
    await type(page, 'clearance');
    v = look(page);
    check('a search change returns to page 1: page 3 of All charges, then "clearance", reads page 1 of 2 of 31',
      pagerSays(onThird, 'Page 3 of 3', 'Showing 51 to 64 of 64 results') && pagerSays(v, 'Page 1 of 2', 'Showing 1 to 25 of 31 results'),
      said([onThird.showing, v.showing]));

    await clickIf(page, tabNamed(page, 'Documents'));
    await clickIf(page, buttonNamed(root(), 'Next'));
    const beforeRefresh = look(page);
    const callsBefore = net.calls.length;
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    v = look(page);
    check('Refresh keeps the search, the tab and the page: "clearance", Documents and page 2 of All charges, before and after the reload',
      pagerSays(beforeRefresh, 'Page 2 of 2', 'Showing 26 to 31 of 31 results') && net.calls.length === callsBefore + 1
        && v.search === 'clearance' && said(v.pressed) === said(['Documents 31'])
        && pagerSays(v, 'Page 2 of 2', 'Showing 26 to 31 of 31 results'),
      said({ before: beforeRefresh.showing, after: v }));

    await type(page, '');
    await clickIf(page, tabNamed(page, 'All'));
    await choose(page, 'PAID');
    v = look(page);
    check('Paid: "26 charges · ₱4,500.00 paid", split "Cash ₱1,300.00 · GCash ₱100.00 · Paid online ₱3,100.00"; the No fee charge is not listed',
      v.heading === '26 charges · ₱4,500.00 paid' && v.detail === 'Cash ₱1,300.00 · GCash ₱100.00 · Paid online ₱3,100.00', said(v));
    await choose(page, 'VOID');
    v = look(page);
    check('Void: "8 charges · ₱3,150.00 void", no second line, and 10 or fewer, so no pager',
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
    check('a reload that shrinks the list moves to its last page: page 3 of 3, then 48 charges, reads page 2 of 2, "Showing 26 to 48 of 48 results"',
      pagerSays(third, 'Page 3 of 3', 'Showing 51 to 64 of 64 results') && pagerSays(shrunk, 'Page 2 of 2', 'Showing 26 to 48 of 48 results')
        && shrunk.rows.length === 23, said([third.showing, shrunk.showing]));
    check('  and stays there when the list grows back: page 2 of 3',
      pagerSays(regrown, 'Page 2 of 3', 'Showing 26 to 50 of 64 results'), said([regrown.showing, regrown.current]));
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
        && pagerSays(v, 'Page 1 of 2', 'Showing 1 to 25 of 30 results'), said(v));
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

    // =======================================================================
    // P. Payments: the pager, its page numbers and rows per page
    // =======================================================================
    // The pager was Previous, "Page 2 of 4" over "Showing 26–50 of 88", and
    // Next, always 25 a page. It is one bar now: "Showing 26 to 50 of 89
    // results", a Rows per page select (10, 25, 50 or 100, 25 to start), then
    // Previous, the page numbers and Next. The current page is a filled
    // button marked aria-current="page"; above 7 pages there are exactly 7
    // slots, "…" standing for the pages left out, and a "…" is text, never a
    // button. The bar shows from 11 matches, even when they fit on one page,
    // so Rows per page stays within reach; at 10 or fewer it is not drawn. A
    // new rows per page goes back to page 1 and brings the list heading into
    // view, as a page change does. Refresh, Record payment and Re-check keep
    // the rows per page and the page; a tab, status or search change keeps the
    // rows per page and goes back to page 1; nothing is kept in the browser.
    // A phone draws "Page 2 of 4" in place of the numbers (index.css decides
    // which shows), so both are in the markup, and checked, at every width.
    console.log('\n--- Payments: the pager, its page numbers and rows per page ---');
    const SIZE = '#pay-page-size';
    const numberButton = (page, n) => page.query(`.pay-pager button[aria-label="Page ${n}"]`);
    const setRows = async (page, value) => {
      const select = page.query(SIZE);
      if (select) {
        select.value = String(value);
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await page.settle();
    };
    // Focus first, as a press does in a browser: a dispatched click in jsdom
    // moves no focus, and these checks are about where focus ends up.
    const press = async (page, el) => {
      if (!el) return;
      el.focus();
      await page.click(el);
    };
    // n document charges named "Res 001" onwards, from position `first` of
    // All charges, so a row's name says where it sits in the list.
    const bulk = (first, n, status) => Array.from({ length: n }, (_, i) => {
      const k = first + i;
      return docOf(2000 + k, status, 50, ['Res', null, String(k).padStart(3, '0')], 'Barangay Clearance');
    });
    const names = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `Res ${String(from + i).padStart(3, '0')}`);
    // 89 charges, as the live list held on 12 Oct 2026: 14 waiting, 60 paid
    // and 15 void, "Res 001" to "Res 089" in All charges' order.
    const EIGHTY_NINE = () => ({ UNPAID: bulk(1, 14, 'UNPAID'), PAID: bulk(15, 60, 'PAID'), VOID: bulk(75, 15, 'VOID') });

    page = await openWith(EIGHTY_NINE());
    const writesAtOpen89 = store.sets;
    await choose(page, 'all');
    v = look(page);
    const sizeSelect = page.query(SIZE);
    const sizeLabel = sizeSelect ? page.query(`label[for="${sizeSelect.id}"]`)?.textContent ?? null : null;
    const sizeOptions = sizeSelect ? [...sizeSelect.options].map((o) => o.textContent) : null;
    check('Rows per page: a select labelled "Rows per page" offering 10, 25, 50 and 100, with 25 chosen',
      sizeLabel === 'Rows per page' && said(sizeOptions) === said(['10', '25', '50', '100']) && v.size === '25',
      said({ label: sizeLabel, options: sizeOptions, size: v.size }));
    const nav = page.query('nav.pay-pager');
    check('All charges with 89: a nav named "Pagination" reads "Showing 1 to 25 of 89 results", with pages 1 2 3 4 and 1 the current page',
      nav?.getAttribute('aria-label') === 'Pagination' && v.showing === 'Showing 1 to 25 of 89 results' && v.numbers === '1 2 3 4'
        && said(v.current) === said(['1']) && v.short === 'Page 1 of 4' && said(v.rows) === said(names(1, 25)),
      said({ label: nav?.getAttribute('aria-label') ?? null, showing: v.showing, numbers: v.numbers, current: v.current, short: v.short }));
    const numberButtons = page.queryAll('.pay-pager-numbers button')
      .map((b) => `${b.getAttribute('type')}:${b.getAttribute('aria-label')}:${b.getAttribute('aria-current')}`);
    check('  each number is a button named "Page N", and only the current one carries aria-current="page"',
      said(numberButtons) === said(['button:Page 1:page', 'button:Page 2:null', 'button:Page 3:null', 'button:Page 4:null']),
      said(numberButtons));

    scrolled.length = 0;
    const three = numberButton(page, 3);
    await press(page, three);
    v = look(page);
    check('clicking 3: rows 51 to 75 ("Res 051" to "Res 075"), "Showing 51 to 75 of 89 results", 3 the current page; '
        + 'the list heading is brought into view, and focus stays on 3',
      said(v.rows) === said(names(51, 75)) && v.showing === 'Showing 51 to 75 of 89 results' && said(v.current) === said(['3'])
        && v.short === 'Page 3 of 4' && scrolled.length === 1 && scrolled[0].el === listHeading(page)
        && !!three && page.active() === three && three.getAttribute('aria-current') === 'page',
      said({ showing: v.showing, current: v.current, rows: [v.rows[0], v.rows.at(-1)], scrolls: scrolled.length,
        focus: page.active()?.getAttribute('aria-label') ?? page.active()?.tagName }));
    scrolled.length = 0;
    await press(page, numberButton(page, 3));
    check('  pressing the current page again does nothing: no scroll, still 51 to 75',
      look(page).showing === 'Showing 51 to 75 of 89 results' && scrolled.length === 0, `${scrolled.length} scroll(s)`);

    scrolled.length = 0;
    await setRows(page, 10);
    v = look(page);
    check('Rows per page 10, from page 3: back to page 1 with 10 rows ("Res 001" to "Res 010"), "Showing 1 to 10 of 89 results", '
        + 'pages 1 2 3 4 5 … 9, and the list heading brought into view as for a page change',
      v.size === '10' && said(v.rows) === said(names(1, 10)) && v.showing === 'Showing 1 to 10 of 89 results'
        && v.numbers === '1 2 3 4 5 … 9' && said(v.current) === said(['1']) && v.short === 'Page 1 of 9'
        && scrolled.length === 1 && scrolled[0].el === listHeading(page),
      said({ size: v.size, showing: v.showing, numbers: v.numbers, current: v.current, rows: v.rows.length, scrolls: scrolled.length }));
    const gaps = page.queryAll('.pay-pager-numbers li').filter((li) => li.textContent === '…');
    check('  the "…" is plain text: not a button, and nothing in it can take focus',
      gaps.length === 1 && gaps.every((li) => !li.matches('[tabindex]') && !li.querySelector('button, a, input, select, [tabindex]')),
      gaps.map((li) => li.outerHTML).join(' ') || 'no "…" drawn');

    await press(page, numberButton(page, 5));
    v = look(page);
    check('clicking 5 of 9: "1 … 4 5 6 … 9", "Showing 41 to 50 of 89 results", and focus stays on the button for page 5',
      v.numbers === '1 … 4 5 6 … 9' && v.showing === 'Showing 41 to 50 of 89 results' && said(v.current) === said(['5'])
        && page.active()?.getAttribute('aria-label') === 'Page 5',
      said({ numbers: v.numbers, showing: v.showing, focus: page.active()?.getAttribute('aria-label') ?? page.active()?.tagName }));
    await press(page, numberButton(page, 9));
    v = look(page);
    const nextAtEnd = buttonNamed(root(), 'Next');
    check('clicking 9: the last page, its 9 rows ("Res 081" to "Res 089"), "Showing 81 to 89 of 89 results", "1 … 5 6 7 8 9", and Next unavailable',
      v.showing === 'Showing 81 to 89 of 89 results' && said(v.rows) === said(names(81, 89)) && v.numbers === '1 … 5 6 7 8 9'
        && said(v.current) === said(['9']) && v.short === 'Page 9 of 9' && nextAtEnd?.getAttribute('aria-disabled') === 'true'
        && page.active()?.getAttribute('aria-label') === 'Page 9',
      said({ showing: v.showing, numbers: v.numbers, next: nextAtEnd?.getAttribute('aria-disabled') ?? null }));
    scrolled.length = 0;
    await press(page, nextAtEnd);
    v = look(page);
    check('  pressing the unavailable Next does nothing and focus stays on it: aria-disabled, never disabled',
      v.showing === 'Showing 81 to 89 of 89 results' && scrolled.length === 0 && !!nextAtEnd && page.active() === nextAtEnd
        && nextAtEnd.disabled === false && nextAtEnd.getAttribute('aria-disabled') === 'true',
      said({ showing: v.showing, scrolls: scrolled.length, focusOnNext: !!nextAtEnd && page.active() === nextAtEnd,
        disabled: nextAtEnd?.disabled ?? null }));
    await press(page, numberButton(page, 1));
    const prevAtStart = buttonNamed(root(), 'Previous');
    scrolled.length = 0;
    await press(page, prevAtStart);
    v = look(page);
    check('on page 1, Previous is unavailable the same way: pressing it does nothing and focus stays on it; Next is available',
      v.showing === 'Showing 1 to 10 of 89 results' && scrolled.length === 0 && !!prevAtStart && page.active() === prevAtStart
        && prevAtStart.disabled === false && prevAtStart.getAttribute('aria-disabled') === 'true'
        && buttonNamed(root(), 'Next')?.getAttribute('aria-disabled') !== 'true',
      said({ showing: v.showing, scrolls: scrolled.length, focusOnPrevious: !!prevAtStart && page.active() === prevAtStart }));

    await press(page, numberButton(page, 5));
    const callsBeforeRefresh = net.calls.length;
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    v = look(page);
    check('Refresh keeps the rows per page and the page: 10 a page on page 5, and after the reload still "Showing 41 to 50 of 89 results"',
      net.calls.length === callsBeforeRefresh + 1 && v.size === '10' && v.showing === 'Showing 41 to 50 of 89 results'
        && said(v.current) === said(['5']), said({ size: v.size, showing: v.showing, current: v.current }));

    await clickIf(page, tabNamed(page, 'Documents'));
    const afterTab = look(page);
    await press(page, numberButton(page, 3));
    await choose(page, 'PAID');
    const afterStatus = look(page);
    await press(page, numberButton(page, 2));
    await type(page, 'res');
    const afterSearch = look(page);
    check('a tab, a status or a search change keeps 10 a page and goes back to page 1: page 5, then Documents, "Showing 1 to 10 of 89 results"; '
        + 'page 3, then Paid, "Showing 1 to 10 of 60 results"; page 2, then "res", "Showing 1 to 10 of 60 results"',
      [afterTab, afterStatus, afterSearch].every((x) => x.size === '10' && said(x.current) === said(['1']))
        && afterTab.showing === 'Showing 1 to 10 of 89 results' && afterStatus.showing === 'Showing 1 to 10 of 60 results'
        && afterSearch.showing === 'Showing 1 to 10 of 60 results',
      said([afterTab, afterStatus, afterSearch].map((x) => `${x.size} a page: ${x.showing} (${x.current})`)));
    check('nothing about the pager is kept in the browser: no localStorage write, sessionStorage empty, no cookie',
      store.sets === writesAtOpen89 && dom.window.sessionStorage.length === 0 && dom.window.document.cookie === '',
      `${store.sets - writesAtOpen89} localStorage write(s), sessionStorage ${dom.window.sessionStorage.length}, `
        + `cookie ${JSON.stringify(dom.window.document.cookie)}`);
    await page.unmount();
    // A new visit, without reseeding the session (which would clear storage).
    resetNet(200, answerFrom(EIGHTY_NINE()));
    page = await mountPayments();
    await choose(page, 'all');
    v = look(page);
    check('  and a new visit starts again at 25 a page, page 1: "Showing 1 to 25 of 89 results"',
      v.size === '25' && v.showing === 'Showing 1 to 25 of 89 results' && said(v.current) === said(['1']),
      said({ size: v.size, showing: v.showing, current: v.current }));
    await page.unmount();

    // Needs verification holds 14: the bar with one page, then Record payment
    // and Re-check at 10 a page, on page 2.
    const settling = EIGHTY_NINE();
    settling.UNPAID.find((c) => c.charge_id === 2013).paymongo_session_id = 'cs_test_2013';
    seedSession(VALID);
    resetNet(200, (url, method) => {
      if (method === 'POST' && url.endsWith('/charges/2012/verify')) {
        settling.UNPAID = settling.UNPAID.filter((c) => c.charge_id !== 2012);
        return { message: 'Payment recorded — charge marked PAID', payment: { payment_id: 89 } };
      }
      if (method === 'POST' && url.endsWith('/payments/gcash/reconcile/2013')) {
        settling.UNPAID = settling.UNPAID.filter((c) => c.charge_id !== 2013);
        return { settled: true, outcome: 'recorded', message: 'PayMongo confirmed the payment. The charge is now paid.' };
      }
      return answerFrom(settling)(url, method);
    });
    page = await mountPayments();
    v = look(page);
    const prev14 = buttonNamed(root(), 'Previous');
    const next14 = buttonNamed(root(), 'Next');
    check('14 charges at 25 a page (Needs verification): the bar still shows, "Showing 1 to 14 of 14 results", Rows per page 25, '
        + 'a single "1" as the current page, and Previous and Next both unavailable',
      v.showing === 'Showing 1 to 14 of 14 results' && v.size === '25' && v.numbers === '1' && said(v.current) === said(['1'])
        && v.short === 'Page 1 of 1' && v.rows.length === 14
        && prev14?.getAttribute('aria-disabled') === 'true' && next14?.getAttribute('aria-disabled') === 'true',
      said({ showing: v.showing, size: v.size, numbers: v.numbers, previous: prev14?.getAttribute('aria-disabled') ?? null,
        next: next14?.getAttribute('aria-disabled') ?? null }));
    await setRows(page, 10);
    await press(page, numberButton(page, 2));
    const pageTwo = look(page);
    await clickIf(page, viewFor(page, 'Res 012'));
    if (page.query('form')?.closest('.pay-panel')) await page.submit();
    await page.settle();
    v = look(page);
    check('Record payment keeps the rows per page and the page: 10 a page, page 2 ("Res 011" to "Res 014"), Record on Res 012, '
        + 'and the reload still shows page 2, "Showing 11 to 13 of 13 results"',
      pageTwo.showing === 'Showing 11 to 14 of 14 results' && said(pageTwo.rows) === said(names(11, 14))
        && v.size === '10' && v.showing === 'Showing 11 to 13 of 13 results' && said(v.current) === said(['2'])
        && said(v.rows) === said(['Res 011', 'Res 013', 'Res 014']) && !page.query('.pay-panel')
        && page.query('.alert.success')?.textContent === 'Payment recorded — charge marked PAID (payment #89)',
      said({ before: pageTwo.showing, after: v.showing, rows: v.rows, size: v.size }));
    await clickIf(page, viewFor(page, 'Res 013'));
    await clickIf(page, buttonNamed(root(), 'Re-check with PayMongo'));
    await page.settle();
    v = look(page);
    check('  and so does Re-check: it settles Res 013, and the reload shows page 2, "Showing 11 to 12 of 12 results", still 10 a page',
      v.size === '10' && v.showing === 'Showing 11 to 12 of 12 results' && said(v.current) === said(['2'])
        && said(v.rows) === said(['Res 011', 'Res 014']) && !page.query('.pay-panel'),
      said({ showing: v.showing, rows: v.rows, size: v.size, panel: !!page.query('.pay-panel') }));
    await page.unmount();

    // A reload that shrinks the list under the page, at 10 a page.
    const shrinkingTen = EIGHTY_NINE();
    page = await openWith(shrinkingTen);
    await choose(page, 'all');
    await setRows(page, 10);
    await press(page, numberButton(page, 9));
    const ninth = look(page);
    shrinkingTen.PAID = shrinkingTen.PAID.slice(0, 31);
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    v = look(page);
    check('a reload that shrinks the list under the page lands on its last page at any rows per page: page 9 of 89 at 10 a page, '
        + 'then 60 charges, page 6, "Showing 51 to 60 of 60 results", pages 1 2 3 4 5 6',
      ninth.showing === 'Showing 81 to 89 of 89 results' && v.size === '10' && v.showing === 'Showing 51 to 60 of 60 results'
        && said(v.current) === said(['6']) && v.numbers === '1 2 3 4 5 6',
      said({ before: ninth.showing, after: v.showing, numbers: v.numbers }));
    await page.unmount();

    // 10 matches or fewer: no bar at all. 11: the bar, one page.
    page = await openWith({ UNPAID: bulk(1, 10, 'UNPAID'), PAID: [], VOID: [] });
    const ten = look(page);
    await page.unmount();
    page = await openWith({ UNPAID: bulk(1, 11, 'UNPAID'), PAID: [], VOID: [] });
    const eleven = look(page);
    await page.unmount();
    check('10 charges: no pager at all, not even Rows per page; 11: the bar, "Showing 1 to 11 of 11 results", one page',
      ten.rows.length === 10 && ten.pager === null && ten.size === null
        && eleven.rows.length === 11 && eleven.showing === 'Showing 1 to 11 of 11 results' && eleven.numbers === '1' && eleven.size === '25',
      said({ ten: { rows: ten.rows.length, pager: ten.pager }, eleven: { rows: eleven.rows.length, showing: eleven.showing } }));
    page = await openWith(EIGHTY_NINE());
    await choose(page, 'all');
    await type(page, 'zzzz');
    v = look(page);
    check('no matches: no pager, only "No charges match your search or filters."',
      v.noMatch && v.pager === null && v.rows.length === 0, said({ noMatch: v.noMatch, pager: v.pager }));
    await page.unmount();

    // =======================================================================
    // Q. Payments: the Method and date filters
    // =======================================================================
    // A second toolbar row under the search: a Method select that mirrors
    // the Method column (methodOf, never the raw payment_method, so "GCash"
    // is a GCash payment a staff member recorded and never a PayMongo one), a
    // date select, "Billed date" or, under Paid, "Paid date" (the latest
    // payment row's, or the billed date for a paid charge with no row), From
    // and To under "Choose dates", and a quiet "Clear filters" while either
    // is on. Days are Manila days, both ends included. "Today" comes from the
    // helpers' one clock, fixed here at 12 Oct 2026, 12:00 in Manila, and this
    // machine is put on Los Angeles time, where that moment is still Oct 11,
    // so every Manila day has to be the code's own doing. Everything
    // composes with the status, the search and the tabs: the tab counts
    // follow the method and date, the totals cover every match and name the
    // date, and every change goes back to page 1. The helpers are checked
    // case by case, then the real page against 23 stubbed charges. Every
    // request is answered by the fetch stub.
    console.log('\n--- Payments: the Method and date filters ---');
    const previousTZQ = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    const F = globalThis.chargeFilters || {};
    const realNow = F.clock?.now;
    const setNow = (iso) => { if (F.clock) F.clock.now = () => new Date(iso); };
    const FIXED_NOW = '2026-10-12T04:00:00Z'; // 12:00 on Oct 12 in Manila, 21:00 on Oct 11 in Los Angeles

    // a. Method, on its own.
    const optionLabels = (status) => attempt(() => F.methodOptions(status).map((o) => o.label).join(' | '));
    check('method options per status view: Needs verification offers Any method and Online pending',
      optionLabels('UNPAID') === 'Any method | Online pending', said(optionLabels('UNPAID')));
    check('  Paid offers Any method, Cash, GCash, Paid online and No fee',
      optionLabels('PAID') === 'Any method | Cash | GCash | Paid online | No fee', said(optionLabels('PAID')));
    check('  Void offers Any method only', optionLabels('VOID') === 'Any method', said(optionLabels('VOID')));
    check('  All charges offers all six: Any method, Cash, GCash, Paid online, No fee and Online pending',
      optionLabels('all') === 'Any method | Cash | GCash | Paid online | No fee | Online pending', said(optionLabels('all')));

    // Payment rows in the list's real shape: one a staff member recorded, and
    // one PayMongo made (nobody received it; its payment_method is "gcash").
    const STAFF_ROW = (id, method, at, reference = null) => ({ payment_id: 8000 + id, payment_method: method,
      reference_no: reference, created_at: at, received_by_user_id: 12, recorder: STAFF });
    const AUTO_ROW = (id, at) => ({ payment_id: 8000 + id, payment_method: 'gcash', reference_no: `pay_q_${id}`,
      created_at: at, received_by_user_id: null, recorder: null });
    const AT = '2026-10-06T01:00:00+00:00';
    // Every case, with the one method it must match (or none), written by hand.
    const M_CASES = [
      { name: 'cash a staff member recorded', want: 'Cash',
        c: charge(8101, 'DOCUMENT', 'PAID', 100, { payments: [STAFF_ROW(8101, 'onsite', AT)] }) },
      { name: 'GCash a staff member recorded', want: 'GCash',
        c: charge(8102, 'DOCUMENT', 'PAID', 100, { payments: [STAFF_ROW(8102, 'gcash', AT, '1029384756')] }) },
      { name: 'a PayMongo payment (payment_method "gcash", nobody received it)', want: 'Paid online',
        c: charge(8103, 'DOCUMENT', 'PAID', 100, { paymongo_session_id: 'cs_q_8103', paymongo_payment_id: 'pay_q_8103',
          payments: [AUTO_ROW(8103, AT)] }) },
      { name: 'unpaid, with an open checkout', want: 'Online pending',
        c: charge(8104, 'DOCUMENT', 'UNPAID', 100, { paymongo_session_id: 'cs_q_8104' }) },
      { name: 'unpaid, no checkout', want: '', c: charge(8105, 'DOCUMENT', 'UNPAID', 100, {}) },
      { name: 'paid, PHP 0, no payment row', want: 'No fee', c: charge(8106, 'DOCUMENT', 'PAID', 0, {}) },
      { name: 'paid, PHP 100, no payment row ("No record", which is not a choice)', want: '',
        c: charge(8107, 'DOCUMENT', 'PAID', 100, {}) },
      { name: 'paid, PHP 0, WITH a cash row', want: 'Cash',
        c: charge(8108, 'DOCUMENT', 'PAID', 0, { payments: [STAFF_ROW(8108, 'onsite', AT)] }) },
      { name: 'unpaid, PHP 0, no checkout', want: '', c: charge(8109, 'DOCUMENT', 'UNPAID', 0, {}) },
      { name: 'paid in cash after a checkout was opened', want: 'Cash',
        c: charge(8110, 'DOCUMENT', 'PAID', 100, { paymongo_session_id: 'cs_q_8110', payments: [STAFF_ROW(8110, 'onsite', AT)] }) },
      { name: 'void, with an open checkout (its Method column reads "Online pending")', want: 'Online pending',
        c: charge(8111, 'DOCUMENT', 'VOID', 100, { paymongo_session_id: 'cs_q_8111' }) },
      { name: 'void, no checkout', want: '', c: charge(8112, 'DOCUMENT', 'VOID', 100, {}) },
    ];
    const FIVE = ['Cash', 'GCash', 'Paid online', 'No fee', 'Online pending'];
    const matched = (c) => attempt(() => FIVE.filter((m) => F.matchesMethod(c, m) === true).join(','));
    const wrongM = M_CASES.filter(({ want, c }) => matched(c) !== want)
      .map(({ name, want, c }) => `${name}: ${said(matched(c))}, want ${said(want)}`);
    check('matchesMethod mirrors the Method column: each charge matches the one method its column shows, or none',
      wrongM.length === 0, wrongM.length ? said(wrongM) : `${M_CASES.length} cases`);
    const mm = (i, method) => attempt(() => F.matchesMethod(M_CASES[i].c, method));
    check('  GCash never takes a PayMongo payment, though both carry payment_method "gcash"; Paid online takes only the PayMongo one',
      mm(2, 'GCash') === false && mm(2, 'Paid online') === true && mm(1, 'GCash') === true && mm(1, 'Paid online') === false,
      said([mm(2, 'GCash'), mm(2, 'Paid online'), mm(1, 'GCash'), mm(1, 'Paid online')]));
    check('  Online pending takes an unpaid charge with an open checkout, never a paid one, not even one whose checkout was opened',
      mm(3, 'Online pending') === true && mm(9, 'Online pending') === false && mm(2, 'Online pending') === false
        && mm(4, 'Online pending') === false, said([mm(3, 'Online pending'), mm(9, 'Online pending'), mm(2, 'Online pending')]));
    check('  No fee takes only a paid PHP 0 charge with no payment row: not one someone recorded, not an unpaid PHP 0 one, not a paid one with no record',
      mm(5, 'No fee') === true && mm(7, 'No fee') === false && mm(8, 'No fee') === false && mm(6, 'No fee') === false,
      said([mm(5, 'No fee'), mm(7, 'No fee'), mm(8, 'No fee'), mm(6, 'No fee')]));
    check('  "Any method" takes every charge', M_CASES.every(({ c }) => attempt(() => F.matchesMethod(c, F.ANY)) === true),
      said(M_CASES.map(({ c }) => attempt(() => F.matchesMethod(c, F.ANY)))));

    // b. Days, on their own: Manila days, whatever this machine's clock says.
    const day = (value) => attempt(() => F.manilaDay(value));
    check('the Manila day of a UTC timestamp: 2026-10-11T17:00:00Z is Oct 12 in Manila, 2026-10-11T15:59:59Z is still Oct 11',
      day('2026-10-11T17:00:00Z') === '2026-10-12' && day('2026-10-11T15:59:59Z') === '2026-10-11',
      said([day('2026-10-11T17:00:00Z'), day('2026-10-11T15:59:59Z')]));
    check('  midnight in Manila is 16:00 UTC: 16:00:00Z on Oct 11 is Oct 12; so is the live #161 shape, 2026-10-11T23:47:20.859+00:00; 07:30+08:00 on Oct 12 is Oct 12',
      day('2026-10-11T16:00:00Z') === '2026-10-12' && day('2026-10-11T23:47:20.859+00:00') === '2026-10-12'
        && day('2026-10-12T07:30:00+08:00') === '2026-10-12',
      said([day('2026-10-11T16:00:00Z'), day('2026-10-11T23:47:20.859+00:00'), day('2026-10-12T07:30:00+08:00')]));
    check('  no timestamp, a blank one or one that does not parse has no day (null), never a guess',
      day(null) === null && day(undefined) === null && day('') === null && day('not a date') === null,
      said([day(null), day(undefined), day(''), day('not a date')]));
    const todayAt = (iso) => { setNow(iso); return attempt(() => F.manilaToday()); };
    const todays = [todayAt('2026-10-12T04:00:00Z'), todayAt('2026-10-11T16:30:00Z'), todayAt('2026-10-12T15:59:59Z'),
      todayAt('2026-10-12T16:00:00Z')];
    check('"today" is the Manila day of the clock: 04:00Z on Oct 12 is Oct 12 (Los Angeles says Oct 11); 16:30Z on Oct 11 is already Oct 12 '
        + '(UTC says Oct 11); 15:59:59Z on Oct 12 is still Oct 12; 16:00Z is Oct 13',
      said(todays) === said(['2026-10-12', '2026-10-12', '2026-10-12', '2026-10-13']), said(todays));

    // c. The presets, for a fixed "today".
    const rng = (choice, today, from = '', to = '') => attempt(() => F.dateRange(choice, from, to, today));
    const span = (r) => (r && typeof r === 'object' ? `${r.from} to ${r.to}` : String(r));
    check('presets on 12 Oct 2026: Today is Oct 12 to Oct 12; Last 7 days Oct 6 to Oct 12 (today and the 6 days before it); This month Oct 1 to Oct 12',
      span(rng('today', '2026-10-12')) === '2026-10-12 to 2026-10-12' && span(rng('week', '2026-10-12')) === '2026-10-06 to 2026-10-12'
        && span(rng('month', '2026-10-12')) === '2026-10-01 to 2026-10-12',
      said([span(rng('today', '2026-10-12')), span(rng('week', '2026-10-12')), span(rng('month', '2026-10-12'))]));
    check('  This month on the 1st is the 1st alone (Nov 1 to Nov 1); on the 31st it is the whole month (Oct 1 to Oct 31)',
      span(rng('month', '2026-11-01')) === '2026-11-01 to 2026-11-01' && span(rng('month', '2026-10-31')) === '2026-10-01 to 2026-10-31',
      said([span(rng('month', '2026-11-01')), span(rng('month', '2026-10-31'))]));
    check('  Last 7 days across a 28-day February (3 Mar 2027: Feb 25 to Mar 3), a 29-day one (3 Mar 2028: Feb 26 to Mar 3) and a new year (2 Jan 2027: Dec 27 to Jan 2)',
      span(rng('week', '2027-03-03')) === '2027-02-25 to 2027-03-03' && span(rng('week', '2028-03-03')) === '2028-02-26 to 2028-03-03'
        && span(rng('week', '2027-01-02')) === '2026-12-27 to 2027-01-02',
      said([span(rng('week', '2027-03-03')), span(rng('week', '2028-03-03')), span(rng('week', '2027-01-02'))]));
    setNow('2026-10-31T16:30:00Z');
    const monthAtMidnight = attempt(() => F.dateRange('month', '', '', F.manilaToday()));
    check('  at 00:30 on Nov 1 in Manila (16:30Z on Oct 31), This month is already Nov 1 to Nov 1, not October',
      span(monthAtMidnight) === '2026-11-01 to 2026-11-01', span(monthAtMidnight));
    check('Any date restricts nothing (no range), nor does Choose dates with neither date; only From is "from that day on", only To "up to that day"',
      rng('any', '2026-10-12') === null && rng('custom', '2026-10-12') === null
        && said(rng('custom', '2026-10-12', '2026-10-05', '')) === said({ from: '2026-10-05', to: null })
        && said(rng('custom', '2026-10-12', '', '2026-10-05')) === said({ from: null, to: '2026-10-05' })
        && said(rng('custom', '2026-10-12', '2026-10-01', '2026-10-05')) === said({ from: '2026-10-01', to: '2026-10-05' }),
      said([rng('any', '2026-10-12'), rng('custom', '2026-10-12'), rng('custom', '2026-10-12', '2026-10-05', ''),
        rng('custom', '2026-10-12', '', '2026-10-05')]));

    // d. A range against a charge's date: both ends in.
    const billedAt = (iso, status = 'UNPAID') => charge(8200, 'DOCUMENT', status, 100, { created_at: iso });
    const inR = (iso, from, to) => attempt(() => F.matchesDate(billedAt(iso), 'billed', { from, to }));
    check('From and To are both included, in Manila days: Oct 1 to Oct 12 takes 23:59 on Oct 12 (15:59Z) and 00:00 on Oct 1 (16:00Z on Sep 30), '
        + 'not 00:00 on Oct 13 nor 23:59 on Sep 30',
      inR('2026-10-12T15:59:00Z', '2026-10-01', '2026-10-12') === true && inR('2026-09-30T16:00:00Z', '2026-10-01', '2026-10-12') === true
        && inR('2026-10-12T16:00:00Z', '2026-10-01', '2026-10-12') === false && inR('2026-09-30T15:59:00Z', '2026-10-01', '2026-10-12') === false,
      said([inR('2026-10-12T15:59:00Z', '2026-10-01', '2026-10-12'), inR('2026-09-30T16:00:00Z', '2026-10-01', '2026-10-12'),
        inR('2026-10-12T16:00:00Z', '2026-10-01', '2026-10-12'), inR('2026-09-30T15:59:00Z', '2026-10-01', '2026-10-12')]));
    check('  only From (Oct 5): 00:00 on Oct 5 and a day next year are in, 23:59:59 on Oct 4 is not',
      inR('2026-10-04T16:00:00Z', '2026-10-05', null) === true && inR('2027-06-01T04:00:00Z', '2026-10-05', null) === true
        && inR('2026-10-04T15:59:59Z', '2026-10-05', null) === false);
    check('  only To (Oct 5): 23:59:59 on Oct 5 and a day years before are in, 00:00 on Oct 6 is not',
      inR('2026-10-05T15:59:59Z', null, '2026-10-05') === true && inR('2020-01-01T04:00:00Z', null, '2026-10-05') === true
        && inR('2026-10-05T16:00:00Z', null, '2026-10-05') === false);
    const BACK = { from: '2026-10-12', to: '2026-10-01' };
    check('From after To (Oct 12 to Oct 1) matches nothing, not Oct 1, Oct 5 or Oct 12, and is never swapped: backwards() says so, and only for that',
      ['2026-09-30T16:00:00Z', '2026-10-05T04:00:00Z', '2026-10-12T04:00:00Z'].every((iso) => attempt(() => F.matchesDate(billedAt(iso), 'billed', BACK)) === false)
        && attempt(() => F.backwards(BACK)) === true && attempt(() => F.backwards({ from: '2026-10-01', to: '2026-10-12' })) === false
        && attempt(() => F.backwards({ from: '2026-10-05', to: '2026-10-05' })) === false && attempt(() => F.backwards({ from: '2026-10-12', to: null })) === false
        && attempt(() => F.backwards(null)) === false);
    check('  no range (Any date) takes every charge, even one with no date',
      attempt(() => F.matchesDate(billedAt('2026-10-05T04:00:00Z'), 'billed', null)) === true
        && attempt(() => F.matchesDate(billedAt(null), 'billed', null)) === true
        && attempt(() => F.matchesDate(billedAt(null), 'billed', { from: '2026-10-01', to: null })) === false);

    // e. Which date: billed, or paid under Paid.
    const twoRows = (rows) => charge(8300, 'DOCUMENT', 'PAID', 100, { created_at: '2026-09-01T04:00:00Z', payments: rows });
    const dOf = (c, kind) => attempt(() => F.chargeDate(c, kind));
    const EARLY = STAFF_ROW(8301, 'gcash', '2026-09-20T04:00:00Z', '1');
    const LATE = STAFF_ROW(8302, 'onsite', '2026-10-07T02:00:00Z');
    check('the paid date is the latest payment row\'s created_at, whichever order the rows come in',
      dOf(twoRows([EARLY, LATE]), 'paid') === '2026-10-07T02:00:00Z' && dOf(twoRows([LATE, EARLY]), 'paid') === '2026-10-07T02:00:00Z',
      said([dOf(twoRows([EARLY, LATE]), 'paid'), dOf(twoRows([LATE, EARLY]), 'paid')]));
    check('  a paid charge with no payment row (approval creates a PHP 0 one already paid) is paid on its billed date',
      dOf(charge(8303, 'DOCUMENT', 'PAID', 0, { created_at: '2026-10-11T23:47:20.859+00:00' }), 'paid') === '2026-10-11T23:47:20.859+00:00');
    check('  unpaid and void charges use their billed date, and a paid one does too when the view filters on the billed date',
      dOf(charge(8304, 'DOCUMENT', 'UNPAID', 100, { created_at: '2026-10-03T04:00:00Z' }), 'paid') === '2026-10-03T04:00:00Z'
        && dOf(charge(8305, 'DOCUMENT', 'VOID', 100, { created_at: '2026-10-04T04:00:00Z' }), 'paid') === '2026-10-04T04:00:00Z'
        && dOf(twoRows([EARLY, LATE]), 'billed') === '2026-09-01T04:00:00Z' && dOf(billedAt('2026-10-03T04:00:00Z'), 'billed') === '2026-10-03T04:00:00Z');
    check('the date a view filters on: "paid" under Paid; "billed" under Needs verification, Void and All charges',
      attempt(() => ['PAID', 'UNPAID', 'VOID', 'all'].map((s) => F.dateKind(s)).join(' ')) === 'paid billed billed billed',
      said(attempt(() => ['PAID', 'UNPAID', 'VOID', 'all'].map((s) => F.dateKind(s)).join(' '))));
    const billedOct1PaidToday = charge(8306, 'DOCUMENT', 'PAID', 100, { created_at: '2026-10-01T02:00:00Z',
      payments: [STAFF_ROW(8306, 'onsite', '2026-10-11T16:10:00Z')] });
    const TODAY = { from: '2026-10-12', to: '2026-10-12' };
    check('  so a charge billed Oct 1 and paid at 00:10 on Oct 12 in Manila is "today" by its paid date and not by its billed date',
      attempt(() => F.matchesDate(billedOct1PaidToday, 'paid', TODAY)) === true && attempt(() => F.matchesDate(billedOct1PaidToday, 'billed', TODAY)) === false);

    // f. The date phrase the totals line ends with.
    const dt = (kind, choice, range, today = '2026-10-12') => attempt(() => F.dateText(kind, choice, range, today));
    check('the date phrase names the date and the range: "billed today", "paid in the last 7 days", "paid this month"',
      dt('billed', 'today', TODAY) === 'billed today' && dt('paid', 'week', { from: '2026-10-06', to: '2026-10-12' }) === 'paid in the last 7 days'
        && dt('paid', 'month', { from: '2026-10-01', to: '2026-10-12' }) === 'paid this month',
      said([dt('billed', 'today', TODAY), dt('paid', 'week', { from: '2026-10-06', to: '2026-10-12' }), dt('paid', 'month', { from: '2026-10-01', to: '2026-10-12' })]));
    check('  chosen dates: "paid Oct 1 to Oct 12"; one day, "billed on Oct 5"; only From, "billed from Oct 1"; only To, "billed up to Oct 12"',
      dt('paid', 'custom', { from: '2026-10-01', to: '2026-10-12' }) === 'paid Oct 1 to Oct 12'
        && dt('billed', 'custom', { from: '2026-10-05', to: '2026-10-05' }) === 'billed on Oct 5'
        && dt('billed', 'custom', { from: '2026-10-01', to: null }) === 'billed from Oct 1'
        && dt('billed', 'custom', { from: null, to: '2026-10-12' }) === 'billed up to Oct 12',
      said([dt('paid', 'custom', { from: '2026-10-01', to: '2026-10-12' }), dt('billed', 'custom', { from: '2026-10-05', to: '2026-10-05' }),
        dt('billed', 'custom', { from: '2026-10-01', to: null }), dt('billed', 'custom', { from: null, to: '2026-10-12' })]));
    check('  a date outside this year carries its year, on both ends: "paid Dec 20, 2025 to Jan 5, 2026"',
      dt('paid', 'custom', { from: '2025-12-20', to: '2026-01-05' }) === 'paid Dec 20, 2025 to Jan 5, 2026',
      said(dt('paid', 'custom', { from: '2025-12-20', to: '2026-01-05' })));
    check('  and there is no phrase when no date filter is on', dt('billed', 'any', null) === null && dt('paid', 'custom', null) === null,
      said([dt('billed', 'any', null), dt('paid', 'custom', null)]));
    got = line({ status: 'UNPAID', shown: owing('UNPAID', [1000, 200, 50]), received: 14, total: 14, filtered: true, dated: 'billed in the last 7 days' });
    check('the totals line ends with the date phrase when a date filter is on: "3 of 14 charges match · ₱1,250.00 unpaid · billed in the last 7 days"',
      got?.heading === '3 of 14 charges match · ₱1,250.00 unpaid · billed in the last 7 days' && got.detail === null, said(got));
    got = line({ status: 'PAID', shown: PAID6, received: 69, total: 69, filtered: true, dated: 'paid Oct 1 to Oct 12' });
    check('  on Paid: "6 of 69 charges match · ₱400.80 paid · paid Oct 1 to Oct 12", and the split still covers those 6',
      got?.heading === '6 of 69 charges match · ₱400.80 paid · paid Oct 1 to Oct 12'
        && got.detail === 'Cash ₱150.50 · GCash ₱250.00 · Paid online ₱0.30', said(got));
    got = line({ status: 'all', shown: MIXED, received: 89, total: 89, filtered: true, dated: 'billed this month' });
    check('  on All charges: "4 of 89 charges match · billed this month", with the amounts on the line under it',
      got?.heading === '4 of 89 charges match · billed this month' && got.detail === '₱100.00 paid · ₱50.30 unpaid · ₱25.50 void', said(got));
    got = line({ status: 'UNPAID', shown: [], received: 14, total: 14, filtered: true, dated: 'billed today' });
    check('  with nothing matching: "0 of 14 charges match · billed today"', got?.heading === '0 of 14 charges match · billed today'
      && got.detail === null, said(got));
    got = line({ status: 'UNPAID', shown: owing('UNPAID', [1000, 200, 50]), received: 14, total: 14, filtered: true, dated: null });
    check('  and nothing extra when no date filter is on: "3 of 14 charges match · ₱1,250.00 unpaid"',
      got?.heading === '3 of 14 charges match · ₱1,250.00 unpaid', said(got));

    // g. The real page, against 23 charges, on 12 Oct 2026 at 12:00 in
    // Manila. 8 waiting (PHP 950), billed from 00:30 that morning back to
    // Sep 20, three with an open checkout; 12 paid: cash, GCash a staff member
    // recorded, PayMongo and No fee, paid from 00:10 that morning back to
    // July; 3 void. Several sit a minute either side of a Manila midnight.
    const Q_UNPAID = [
      docOf(4001, 'UNPAID', 50, ['Aida', null, 'Flores'], 'Barangay Clearance', { created_at: '2026-10-11T16:30:00Z' }),
      rentalOf(4002, 'UNPAID', 300, ['Bert', 'Flores'], 'Tent', 1, { created_at: '2026-10-12T02:00:00Z', paymongo_session_id: 'cs_q_4002' }),
      docOf(4003, 'UNPAID', 50, ['Cora', null, 'Flores'], 'Certificate of Residency',
        { created_at: '2026-10-08T15:59:00Z', paymongo_session_id: 'cs_q_4003' }),
      fineOf(4004, 'UNPAID', 100, 'Dodong Flores', 'General Assembly', { created_at: '2026-10-05T16:00:00Z' }),
      docOf(4005, 'UNPAID', 50, ['Edna', null, 'Flores'], 'Barangay Clearance', { created_at: '2026-10-05T15:59:00Z' }),
      docOf(4006, 'UNPAID', 50, ['Fermin', null, 'Flores'], 'Barangay Clearance',
        { created_at: '2026-10-01T00:00:00Z', paymongo_session_id: 'cs_q_4006' }),
      rentalOf(4007, 'UNPAID', 300, ['Gloria', 'Flores'], 'Tent', 1, { created_at: '2026-09-30T15:59:00Z' }),
      docOf(4008, 'UNPAID', 50, ['Hugo', null, 'Flores'], 'Barangay Clearance', { created_at: '2026-09-20T04:00:00Z' }),
    ];
    const online = (id, at) => ({ paymongo_session_id: `cs_q_${id}`, paymongo_payment_id: `pay_q_${id}`, payments: [AUTO_ROW(id, at)] });
    const Q_PAID = [
      docOf(4011, 'PAID', 100, ['Ines', null, 'Garcia'], 'Barangay Clearance',
        { created_at: '2026-10-01T02:00:00Z', payments: [STAFF_ROW(4011, 'onsite', '2026-10-11T16:10:00Z')] }),
      docOf(4012, 'PAID', 150, ['Jose', null, 'Garcia'], 'Barangay Clearance',
        { created_at: '2026-09-28T03:00:00Z', payments: [STAFF_ROW(4012, 'gcash', '2026-10-12T01:00:00Z', '1112223334')] }),
      rentalOf(4013, 'PAID', 300, ['Karen', 'Garcia'], 'Tent', 1, { created_at: '2026-10-09T04:00:00Z', ...online(4013, '2026-10-09T05:00:00Z') }),
      docOf(4014, 'PAID', 100, ['Luis', null, 'Garcia'], 'Barangay Clearance',
        { created_at: '2026-09-15T04:00:00Z', ...online(4014, '2026-10-05T16:30:00Z') }),
      docOf(4015, 'PAID', 100, ['Marta', null, 'Garcia'], 'Barangay Clearance',
        { created_at: '2026-09-10T04:00:00Z', payments: [STAFF_ROW(4015, 'onsite', '2026-10-02T03:00:00Z')] }),
      fineOf(4016, 'PAID', 100, 'Nonoy Garcia', 'Clean-up Drive',
        { created_at: '2026-09-05T04:00:00Z', payments: [STAFF_ROW(4016, 'onsite', '2026-09-29T04:00:00Z')] }),
      docOf(4017, 'PAID', 0, ['Olive', null, 'Garcia'], 'Certificate of Indigency', { created_at: '2026-10-11T23:47:20.859+00:00' }),
      docOf(4018, 'PAID', 0, ['Pedro', null, 'Garcia'], 'Certificate of Indigency', { created_at: '2026-07-07T11:59:10.124+00:00' }),
      docOf(4019, 'PAID', 120, ['Queenie', null, 'Garcia'], 'Barangay Clearance',
        { created_at: '2026-08-01T04:00:00Z', payments: [STAFF_ROW(4019, 'gcash', '2026-08-02T04:00:00Z', '5556667778')] }),
      rentalOf(4020, 'PAID', 300, ['Ramon', 'Garcia'], 'Tent', 1, { created_at: '2026-10-05T03:00:00Z', ...online(4020, '2026-10-05T03:30:00Z') }),
      docOf(4021, 'PAID', 50, ['Sonia', null, 'Garcia'], 'Barangay Clearance',
        { created_at: '2026-10-12T01:00:00Z', payments: [STAFF_ROW(4021, 'onsite', '2026-10-12T02:00:00Z')] }),
      // Two rows: a PayMongo one on Sep 20, then cash on Oct 7, the latest.
      docOf(4022, 'PAID', 100, ['Tonyo', null, 'Garcia'], 'Barangay Clearance', { created_at: '2026-09-19T04:00:00Z',
        paymongo_session_id: 'cs_q_4022', paymongo_payment_id: 'pay_q_4022',
        payments: [AUTO_ROW(4022, '2026-09-20T04:00:00Z'), STAFF_ROW(4122, 'onsite', '2026-10-07T02:00:00Z')] }),
    ];
    const Q_VOID = [
      docOf(4031, 'VOID', 50, ['Ursula', null, 'Reyes'], 'Barangay Clearance', { created_at: '2026-10-10T02:00:00Z' }),
      rentalOf(4032, 'VOID', 500, ['Vic', 'Reyes'], 'Tent', 1, { created_at: '2026-09-25T04:00:00Z' }),
      fineOf(4033, 'VOID', 100, 'Wally Reyes', 'Clean-up Drive', { created_at: '2026-10-12T03:00:00Z' }),
    ];
    const qFresh = () => ({ UNPAID: [...Q_UNPAID], PAID: [...Q_PAID], VOID: [...Q_VOID] });
    // A control found by its visible label, as a person finds it.
    const labelled = (pg_, text) => {
      const label = pg_.queryAll('label').find((l) => l.textContent === text);
      return label ? label.control || (label.htmlFor ? dom.window.document.getElementById(label.htmlFor) : null) : null;
    };
    const methodSelect = (pg_) => labelled(pg_, 'Method');
    const dateSelect = (pg_) => labelled(pg_, 'Billed date') || labelled(pg_, 'Paid date');
    const chosen = (select) => (select ? select.options[select.selectedIndex]?.textContent ?? null : null);
    const HINT = 'The start date is after the end date.';
    const hintEl = (pg_) => pg_.queryAll('[role="status"], [aria-live="polite"]').find((el) => el.textContent === HINT) ?? null;
    const lookQ = (pg_) => {
      const m = methodSelect(pg_);
      const d = dateSelect(pg_);
      return {
        ...look(pg_),
        method: chosen(m),
        methods: m ? [...m.options].map((o) => o.textContent).join(' | ') : null,
        methodOff: m ? m.disabled : null,
        dateLabel: labelled(pg_, 'Paid date') ? 'Paid date' : labelled(pg_, 'Billed date') ? 'Billed date' : null,
        date: chosen(d),
        from: labelled(pg_, 'From')?.value ?? null,
        to: labelled(pg_, 'To')?.value ?? null,
        clear: !!buttonNamed(root(), 'Clear filters'),
        hint: !!hintEl(pg_) || root().textContent.includes(HINT),
      };
    };
    // Choose the option a select shows as `label`, the way a person does.
    const pick = async (pg_, select, label) => {
      const option = select ? [...select.options].find((o) => o.textContent === label) : null;
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await pg_.settle();
    };
    const pickMethod = (pg_, label) => pick(pg_, methodSelect(pg_), label);
    const pickDate = (pg_, label) => pick(pg_, dateSelect(pg_), label);
    const typeDate = async (pg_, label, value) => {
      const input = labelled(pg_, label);
      if (input?.id) await pg_.fill(`#${input.id}`, value);
      await pg_.settle();
    };
    const openQ = (state = qFresh()) => { setNow(FIXED_NOW); return openWith(state); };

    page = await openQ();
    const writesAtOpenQ = store.sets;
    v = lookQ(page);
    const toolbarQ = page.query('.list-head.pay-toolbar');
    const secondRow = toolbarQ?.nextElementSibling ?? null;
    const m0 = methodSelect(page);
    const d0 = dateSelect(page);
    const tabsQ = page.query('.pay-tabs');
    check('a second toolbar row sits under the search row and above the tabs, holding a native select labelled "Method" and one labelled "Billed date"',
      !!secondRow && !!m0 && !!d0 && m0.tagName === 'SELECT' && d0.tagName === 'SELECT' && secondRow.contains(m0) && secondRow.contains(d0)
        && !toolbarQ.contains(m0) && !!tabsQ && (secondRow.compareDocumentPosition(tabsQ) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      said({ secondRow: secondRow?.className ?? null, method: m0?.tagName ?? null, date: d0?.tagName ?? null }));
    check('  the search row is as it was: the search box, the status (still the first select in .list-head, on Needs verification) and Refresh',
      !!toolbarQ && toolbarQ.contains(page.query(SEARCH)) && page.query('.list-head select')?.value === 'UNPAID' && !!buttonNamed(toolbarQ, 'Refresh'));
    check('  Method reads "Any method"; the date reads "Any date", choosing from Any date, Today, Last 7 days, This month and Choose dates; '
        + 'no From or To yet, no Clear filters, no hint, and the totals as before',
      v.method === 'Any method' && v.date === 'Any date'
        && (d0 ? [...d0.options].map((o) => o.textContent).join(' | ') : null) === 'Any date | Today | Last 7 days | This month | Choose dates'
        && v.from === null && v.to === null && !v.clear && !v.hint && v.heading === '8 charges · ₱950.00 unpaid', said(v));
    check('Needs verification: Method offers Any method and Online pending, and the date is the "Billed date"',
      v.methods === 'Any method | Online pending' && v.methodOff === false && v.dateLabel === 'Billed date', said(v));
    await choose(page, 'PAID');
    v = lookQ(page);
    check('Paid: Method offers Any method, Cash, GCash, Paid online and No fee, and the date label reads "Paid date"',
      v.methods === 'Any method | Cash | GCash | Paid online | No fee' && v.methodOff === false && v.dateLabel === 'Paid date', said(v));
    await choose(page, 'VOID');
    v = lookQ(page);
    check('Void: Method offers only Any method and is disabled; the date is the "Billed date" again',
      v.methods === 'Any method' && v.methodOff === true && v.dateLabel === 'Billed date', said(v));
    await choose(page, 'all');
    v = lookQ(page);
    check('All charges: Method offers all six, and the date is the "Billed date"',
      v.methods === 'Any method | Cash | GCash | Paid online | No fee | Online pending' && v.methodOff === false
        && v.dateLabel === 'Billed date', said(v));

    await pickMethod(page, 'GCash');
    v = lookQ(page);
    check('All charges, Method GCash: the 2 GCash payments a staff member recorded (Jose, Queenie Garcia), never a PayMongo one; '
        + 'tabs "All 2 · Documents 2 · Rentals 0 · Fines 0", totals "2 of 23 charges match", then "₱270.00 paid · ₱0.00 unpaid · ₱0.00 void"',
      said(v.rows) === said(['Jose Garcia', 'Queenie Garcia']) && v.tabs === 'All 2 · Documents 2 · Rentals 0 · Fines 0'
        && v.heading === '2 of 23 charges match' && v.detail === '₱270.00 paid · ₱0.00 unpaid · ₱0.00 void' && v.clear, said(v));
    const perMethod = {};
    for (const label of ['Cash', 'Paid online', 'No fee', 'Online pending']) {
      await pickMethod(page, label);
      const x = lookQ(page);
      perMethod[label] = { rows: x.rows, tabs: x.tabs };
    }
    check('  Cash: Ines, Marta, Nonoy, Sonia and Tonyo Garcia (his latest row is cash); Paid online: Karen, Luis, Ramon; No fee: Olive, Pedro; '
        + 'Online pending: Bert, Cora, Fermin Flores; and the tab counts follow each',
      said(perMethod.Cash?.rows) === said(['Ines Garcia', 'Marta Garcia', 'Nonoy Garcia', 'Sonia Garcia', 'Tonyo Garcia'])
        && perMethod.Cash.tabs === 'All 5 · Documents 4 · Rentals 0 · Fines 1'
        && said(perMethod['Paid online']?.rows) === said(['Karen Garcia', 'Luis Garcia', 'Ramon Garcia'])
        && perMethod['Paid online'].tabs === 'All 3 · Documents 1 · Rentals 2 · Fines 0'
        && said(perMethod['No fee']?.rows) === said(['Olive Garcia', 'Pedro Garcia'])
        && said(perMethod['Online pending']?.rows) === said(['Bert Flores', 'Cora Flores', 'Fermin Flores'])
        && perMethod['Online pending'].tabs === 'All 3 · Documents 2 · Rentals 1 · Fines 0', said(perMethod));

    await choose(page, 'UNPAID');
    v = lookQ(page);
    const keptPending = v.method === 'Online pending' && said(v.rows) === said(['Bert Flores', 'Cora Flores', 'Fermin Flores']);
    await choose(page, 'all');
    await pickMethod(page, 'Cash');
    await choose(page, 'PAID');
    v = lookQ(page);
    const keptCash = v.method === 'Cash' && v.rows.length === 5;
    await choose(page, 'UNPAID');
    v = lookQ(page);
    check('a status change resets the method when the new view does not offer it: Cash on Paid, then Needs verification, reads Any method, all 8 rows',
      v.method === 'Any method' && v.rows.length === 8 && v.heading === '8 charges · ₱950.00 unpaid', said(v));
    check('  and keeps it when it does: Online pending from All charges to Needs verification, Cash from All charges to Paid',
      keptPending && keptCash, said({ keptPending, keptCash }));

    const presetRows = {};
    for (const label of ['Today', 'Last 7 days', 'This month']) {
      await pickDate(page, label);
      const x = lookQ(page);
      presetRows[label] = { rows: x.rows, heading: x.heading };
    }
    check('Needs verification by billed date: Today takes Aida (00:30 that morning, still Oct 11 in UTC) and Bert; Last 7 days adds Cora and Dodong '
        + '(00:00 on Oct 6), not Edna (23:59 on Oct 5); This month adds Edna and Fermin, not Gloria (23:59 on Sep 30)',
      said(presetRows.Today?.rows) === said(['Aida Flores', 'Bert Flores'])
        && said(presetRows['Last 7 days']?.rows) === said(['Aida Flores', 'Bert Flores', 'Cora Flores', 'Dodong Flores'])
        && said(presetRows['This month']?.rows) === said(['Aida Flores', 'Bert Flores', 'Cora Flores', 'Dodong Flores', 'Edna Flores', 'Fermin Flores']),
      said(presetRows));
    check('  the totals name the date and range: "2 of 8 charges match · ₱350.00 unpaid · billed today", "4 of 8 … ₱500.00 … billed in the last 7 days", '
        + '"6 of 8 … ₱600.00 … billed this month"',
      presetRows.Today?.heading === '2 of 8 charges match · ₱350.00 unpaid · billed today'
        && presetRows['Last 7 days']?.heading === '4 of 8 charges match · ₱500.00 unpaid · billed in the last 7 days'
        && presetRows['This month']?.heading === '6 of 8 charges match · ₱600.00 unpaid · billed this month', said(presetRows));

    await choose(page, 'PAID');
    const paidMonth = lookQ(page);
    await pickDate(page, 'Today');
    const paidToday = lookQ(page);
    await pickDate(page, 'Last 7 days');
    const paidWeek = lookQ(page);
    check('a status change keeps the date: This month on Needs verification is still This month on Paid, by the paid date: '
        + '"9 of 12 charges match · ₱1,200.00 paid · paid this month", split "Cash ₱350.00 · GCash ₱150.00 · Paid online ₱700.00"',
      paidMonth.date === 'This month' && paidMonth.dateLabel === 'Paid date' && paidMonth.rows.length === 9
        && paidMonth.heading === '9 of 12 charges match · ₱1,200.00 paid · paid this month'
        && paidMonth.detail === 'Cash ₱350.00 · GCash ₱150.00 · Paid online ₱700.00', said(paidMonth));
    check('Paid, Today: Ines (paid 00:10 that morning, billed Oct 1), Jose, Olive (no payment row, so billed and paid at 07:47) and Sonia',
      said(paidToday.rows) === said(['Ines Garcia', 'Jose Garcia', 'Olive Garcia', 'Sonia Garcia']), said(paidToday));
    check('  "4 of 12 charges match · ₱300.00 paid · paid today", and the split covers just those: "Cash ₱150.00 · GCash ₱150.00 · Paid online ₱0.00"',
      paidToday.heading === '4 of 12 charges match · ₱300.00 paid · paid today'
        && paidToday.detail === 'Cash ₱150.00 · GCash ₱150.00 · Paid online ₱0.00', said(paidToday));
    check('  Last 7 days adds Karen, Luis (paid 00:30 on Oct 6) and Tonyo (by his latest row, Oct 7, not his first, Sep 20): '
        + '"7 of 12 charges match · ₱800.00 paid · paid in the last 7 days"',
      said(paidWeek.rows) === said(['Ines Garcia', 'Jose Garcia', 'Karen Garcia', 'Luis Garcia', 'Olive Garcia', 'Sonia Garcia', 'Tonyo Garcia'])
        && paidWeek.heading === '7 of 12 charges match · ₱800.00 paid · paid in the last 7 days'
        && paidWeek.detail === 'Cash ₱250.00 · GCash ₱150.00 · Paid online ₱400.00', said(paidWeek));
    await pickDate(page, 'Today');
    await pickMethod(page, 'No fee');
    v = lookQ(page);
    check('  Paid, No fee, Today: Olive Garcia alone, by her billed date; Pedro Garcia, billed in July, is not in it',
      said(v.rows) === said(['Olive Garcia']) && v.heading === '1 of 12 charges matches · ₱0.00 paid · paid today', said(v));

    await pickMethod(page, 'Any method');
    await choose(page, 'all');
    v = lookQ(page);
    check('All charges goes by the billed date, paid charges too: Today takes Aida, Bert, Olive, Sonia and Wally Reyes, not Ines (paid today, billed Oct 1); '
        + '"5 of 23 charges match · billed today", then "₱50.00 paid · ₱350.00 unpaid · ₱100.00 void"',
      v.dateLabel === 'Billed date' && said(v.rows) === said(['Aida Flores', 'Bert Flores', 'Olive Garcia', 'Sonia Garcia', 'Wally Reyes'])
        && v.tabs === 'All 5 · Documents 3 · Rentals 1 · Fines 1' && v.heading === '5 of 23 charges match · billed today'
        && v.detail === '₱50.00 paid · ₱350.00 unpaid · ₱100.00 void', said(v));
    await pickDate(page, 'This month');
    await pickMethod(page, 'Cash');
    v = lookQ(page);
    check('  method and date together: Cash and This month on All charges take Ines and Sonia Garcia only, "2 of 23 charges match · billed this month"',
      said(v.rows) === said(['Ines Garcia', 'Sonia Garcia']) && v.tabs === 'All 2 · Documents 2 · Rentals 0 · Fines 0'
        && v.heading === '2 of 23 charges match · billed this month' && v.detail === '₱150.00 paid · ₱0.00 unpaid · ₱0.00 void', said(v));

    await type(page, 'sonia');
    await clickIf(page, tabNamed(page, 'Documents'));
    const beforeClear = lookQ(page);
    const clearButton = buttonNamed(root(), 'Clear filters');
    await press(page, clearButton);
    v = lookQ(page);
    check('"Clear filters" shows while a method or date filter is on, and clears just those: Cash and This month go, "sonia" and the Documents tab stay',
      beforeClear.clear && !!clearButton && v.method === 'Any method' && v.date === 'Any date' && v.search === 'sonia'
        && said(v.pressed) === said(['Documents 1']) && said(v.rows) === said(['Sonia Garcia']) && v.heading === '1 of 23 charges matches' && !v.clear,
      said({ before: beforeClear.clear, after: v }));
    check('  the button goes once nothing is on, and focus moves to the Method select instead of being dropped',
      !buttonNamed(root(), 'Clear filters') && !!methodSelect(page) && page.active() === methodSelect(page),
      `focus on ${page.active()?.tagName ?? 'nothing'} ${page.active()?.id ?? ''}`);
    await type(page, '');
    await clickIf(page, tabNamed(page, 'All'));

    await choose(page, 'UNPAID');
    await pickDate(page, 'Choose dates');
    v = lookQ(page);
    const fromInput = labelled(page, 'From');
    const toInput = labelled(page, 'To');
    check('Choose dates shows two native date inputs labelled "From" and "To", both empty; with neither filled nothing is narrowed, and Clear filters is offered',
      fromInput?.type === 'date' && toInput?.type === 'date' && v.from === '' && v.to === '' && v.rows.length === 8
        && v.heading === '8 charges · ₱950.00 unpaid' && v.clear && !v.hint, said(v));
    await typeDate(page, 'From', '2026-10-05');
    await typeDate(page, 'To', '2026-10-08');
    v = lookQ(page);
    check('  From Oct 5 to Oct 8, both days in: Cora (23:59 on Oct 8), Dodong and Edna (23:59 on Oct 5): "3 of 8 charges match · ₱200.00 unpaid · billed Oct 5 to Oct 8"',
      said(v.rows) === said(['Cora Flores', 'Dodong Flores', 'Edna Flores'])
        && v.heading === '3 of 8 charges match · ₱200.00 unpaid · billed Oct 5 to Oct 8', said(v));
    await typeDate(page, 'To', '');
    await typeDate(page, 'From', '2026-10-08');
    const onlyFrom = lookQ(page);
    await typeDate(page, 'From', '');
    await typeDate(page, 'To', '2026-10-05');
    const onlyTo = lookQ(page);
    check('  only From (Oct 8): that day on, "billed from Oct 8"; only To (Oct 5): up to that day, "billed up to Oct 5"',
      said(onlyFrom.rows) === said(['Aida Flores', 'Bert Flores', 'Cora Flores'])
        && onlyFrom.heading === '3 of 8 charges match · ₱400.00 unpaid · billed from Oct 8'
        && said(onlyTo.rows) === said(['Edna Flores', 'Fermin Flores', 'Gloria Flores', 'Hugo Flores'])
        && onlyTo.heading === '4 of 8 charges match · ₱450.00 unpaid · billed up to Oct 5', said({ onlyFrom, onlyTo }));
    await typeDate(page, 'From', '2026-10-08');
    v = lookQ(page);
    const hintNow = hintEl(page);
    check('From after To (Oct 8 to Oct 5): "The start date is after the end date." in a polite status region; the range matches nothing and is not swapped',
      !!hintNow && v.from === '2026-10-08' && v.to === '2026-10-05' && v.rows.length === 0 && v.noMatch
        && v.tabs === 'All 0 · Documents 0 · Rentals 0 · Fines 0' && v.heading === '0 of 8 charges match · billed Oct 8 to Oct 5', said(v));
    await typeDate(page, 'To', '2026-10-08');
    v = lookQ(page);
    check('  To set to Oct 8 as well: the hint goes, and the one day holds Cora Flores, "1 of 8 charges matches · ₱50.00 unpaid · billed on Oct 8"',
      !v.hint && said(v.rows) === said(['Cora Flores']) && v.heading === '1 of 8 charges matches · ₱50.00 unpaid · billed on Oct 8', said(v));

    await type(page, 'bert');
    await pickMethod(page, 'Online pending');
    await clickIf(page, tabNamed(page, 'Rentals'));
    v = lookQ(page);
    const emptyButton = buttonNamed(root(), 'Clear search and filters');
    await clickIf(page, emptyButton);
    const cleared = lookQ(page);
    check('no match ("bert", Online pending, Rentals, Oct 8 to Oct 8): "Clear search and filters" clears the search, the tab, the method and the date, and leaves the status',
      v.noMatch && !!emptyButton && cleared.search === '' && said(cleared.pressed) === said(['All 8']) && cleared.method === 'Any method'
        && cleared.date === 'Any date' && cleared.from === null && cleared.to === null && page.query('.list-head select')?.value === 'UNPAID'
        && cleared.rows.length === 8 && cleared.heading === '8 charges · ₱950.00 unpaid' && page.active() === page.query(SEARCH),
      said({ v, cleared }));
    await pickDate(page, 'Choose dates');
    v = lookQ(page);
    check('  and Choose dates opens empty afterwards: the From and To it held were cleared too', v.from === '' && v.to === '', said(v));

    await pickMethod(page, 'Online pending');
    await pickDate(page, 'Today');
    const callsBeforeQ = net.calls.length;
    await clickIf(page, buttonNamed(root(), 'Refresh'));
    v = lookQ(page);
    check('Refresh keeps the method and the date: Online pending and Today before and after the reload, "1 of 8 charges matches · ₱300.00 unpaid · billed today"',
      net.calls.length === callsBeforeQ + 1 && v.method === 'Online pending' && v.date === 'Today' && said(v.rows) === said(['Bert Flores'])
        && v.heading === '1 of 8 charges matches · ₱300.00 unpaid · billed today', said(v));
    check('nothing about the filters is kept in the browser: no localStorage write, sessionStorage empty',
      store.sets === writesAtOpenQ && dom.window.sessionStorage.length === 0,
      `${store.sets - writesAtOpenQ} localStorage write(s), sessionStorage ${dom.window.sessionStorage.length}`);
    await page.unmount();
    // A new visit, without reseeding the session (which would clear storage).
    resetNet(200, answerFrom(qFresh()));
    page = await mountPayments();
    v = lookQ(page);
    check('  and they start fresh each time the page opens: after Online pending and Today, a new visit reads Any method and Any date, no From or To, no Clear filters',
      v.method === 'Any method' && v.date === 'Any date' && v.from === null && v.to === null && !v.clear && v.rows.length === 8, said(v));
    await page.unmount();

    // Record payment: the reload after it keeps the method and the date.
    const qRecord = qFresh();
    seedSession(VALID);
    setNow(FIXED_NOW);
    resetNet(200, (url, method) => {
      if (method === 'POST' && url.endsWith('/charges/4003/verify')) {
        qRecord.UNPAID = qRecord.UNPAID.filter((c) => c.charge_id !== 4003);
        return { message: 'Payment recorded — charge marked PAID', payment: { payment_id: 90 } };
      }
      return answerFrom(qRecord)(url, method);
    });
    page = await mountPayments();
    await pickMethod(page, 'Online pending');
    await pickDate(page, 'Last 7 days');
    const beforeRecord = lookQ(page);
    await clickIf(page, viewFor(page, 'Cora Flores'));
    if (page.query('form')?.closest('.pay-panel')) await page.submit();
    await page.settle();
    v = lookQ(page);
    check('Record payment keeps the method and the date: Online pending and Last 7 days, Record on Cora Flores, and the reload reads '
        + '"1 of 7 charges matches · ₱300.00 unpaid · billed in the last 7 days"',
      said(beforeRecord.rows) === said(['Bert Flores', 'Cora Flores']) && v.method === 'Online pending' && v.date === 'Last 7 days'
        && said(v.rows) === said(['Bert Flores']) && v.heading === '1 of 7 charges matches · ₱300.00 unpaid · billed in the last 7 days'
        && page.query('.alert.success')?.textContent === 'Payment recorded — charge marked PAID (payment #90)' && !page.query('.pay-panel'),
      said({ before: beforeRecord.rows, v }));
    await page.unmount();

    // A charge the filters hide while its panel is open: the panel works from
    // the whole list, never the filtered one, and Re-check keeps the filters.
    const qRecheck = qFresh();
    seedSession(VALID);
    setNow(FIXED_NOW);
    resetNet(200, (url, method) => {
      if (method === 'POST' && url.endsWith('/payments/gcash/reconcile/4002')) {
        qRecheck.UNPAID = qRecheck.UNPAID.filter((c) => c.charge_id !== 4002);
        return { settled: true, outcome: 'recorded', message: 'PayMongo confirmed the payment. The charge is now paid.' };
      }
      return answerFrom(qRecheck)(url, method);
    });
    page = await mountPayments();
    await clickIf(page, viewFor(page, 'Bert Flores'));
    const openedQ = page.query('.pay-panel #pay-panel-title')?.textContent ?? null;
    await pickDate(page, 'Choose dates');
    await typeDate(page, 'From', '2026-10-01');
    await typeDate(page, 'To', '2026-10-05');
    v = lookQ(page);
    check('a charge the filters hide keeps its panel: View Bert Flores (billed today), then Oct 1 to Oct 5: the panel stays on Bert Flores, the list shows Edna and Fermin',
      openedQ === 'Bert Flores' && page.query('.pay-panel #pay-panel-title')?.textContent === 'Bert Flores'
        && said(v.rows) === said(['Edna Flores', 'Fermin Flores']), said({ openedQ, rows: v.rows }));
    await clickIf(page, buttonNamed(root(), 'Re-check with PayMongo'));
    await page.settle();
    v = lookQ(page);
    check('  and Re-check still closes it once the reload shows it paid: focus on the message, Oct 1 to Oct 5 kept',
      !page.query('.pay-panel') && page.active() === page.query('.alert.success') && v.date === 'Choose dates' && v.from === '2026-10-01'
        && v.to === '2026-10-05' && said(v.rows) === said(['Edna Flores', 'Fermin Flores']),
      said({ panel: !!page.query('.pay-panel'), focus: page.active()?.className ?? null, v }));
    await page.unmount();

    // Pages: 30 waiting, 15 with an open checkout, 20 billed today.
    const PAGING_Q = () => ({
      UNPAID: Array.from({ length: 30 }, (_, i) => docOf(4100 + i, 'UNPAID', 50, ['Pay', null, String(i + 1).padStart(2, '0')],
        'Barangay Clearance', { created_at: i < 20 ? '2026-10-12T01:00:00Z' : '2026-10-03T01:00:00Z',
          paymongo_session_id: i % 2 === 0 ? `cs_q_${4100 + i}` : null })),
      PAID: [], VOID: [],
    });
    page = await openQ(PAGING_Q());
    const writesQ = store.sets;
    await setRows(page, 10);
    const toSecond = () => press(page, numberButton(page, 2));
    await toSecond();
    const onTwo = lookQ(page);
    await pickMethod(page, 'Online pending');
    const afterMethod = lookQ(page);
    await pickMethod(page, 'Any method');
    await toSecond();
    await pickDate(page, 'Today');
    const afterPreset = lookQ(page);
    await toSecond();
    await pickDate(page, 'Choose dates');
    const afterChoose = lookQ(page);
    await toSecond();
    await typeDate(page, 'From', '2026-10-01');
    const afterFrom = lookQ(page);
    await toSecond();
    await typeDate(page, 'To', '2026-10-12');
    const afterTo = lookQ(page);
    check('every filter change goes back to page 1 and keeps 10 a page: from page 2, Online pending reads "Showing 1 to 10 of 15 results"; '
        + 'Today, "of 20"; Choose dates, "of 30"; a From date, "of 30"; a To date, "of 30"',
      pagerSays(onTwo, 'Page 2 of 3', 'Showing 11 to 20 of 30 results')
        && [afterMethod, afterPreset, afterChoose, afterFrom, afterTo].every((x) => x.size === '10' && said(x.current) === said(['1']))
        && afterMethod.showing === 'Showing 1 to 10 of 15 results' && afterPreset.showing === 'Showing 1 to 10 of 20 results'
        && afterChoose.showing === 'Showing 1 to 10 of 30 results' && afterFrom.showing === 'Showing 1 to 10 of 30 results'
        && afterTo.showing === 'Showing 1 to 10 of 30 results',
      said([onTwo, afterMethod, afterPreset, afterChoose, afterFrom, afterTo].map((x) => `${x.size}: ${x.showing} (${x.current})`)));
    check('  and still nothing in the browser: no localStorage write, sessionStorage empty',
      store.sets === writesQ && dom.window.sessionStorage.length === 0, `${store.sets - writesQ} localStorage write(s)`);
    await page.unmount();

    // A status change keeps the search, the tab and the date.
    page = await openQ();
    await type(page, 'tent');
    await clickIf(page, tabNamed(page, 'Rentals'));
    await pickDate(page, 'Last 7 days');
    const onUnpaid = lookQ(page);
    await choose(page, 'all');
    const onAll = lookQ(page);
    await choose(page, 'PAID');
    const onPaid = lookQ(page);
    check('a status change keeps the search, the tab and the date: "tent", Rentals and Last 7 days on Needs verification (Bert), then All charges '
        + '(Bert, Karen), then Paid, where the label turns to "Paid date" (Karen, paid Oct 9; not Ramon, paid Oct 5)',
      said(onUnpaid.rows) === said(['Bert Flores']) && onAll.search === 'tent' && said(onAll.pressed) === said(['Rentals 2'])
        && onAll.date === 'Last 7 days' && onAll.dateLabel === 'Billed date' && said(onAll.rows) === said(['Bert Flores', 'Karen Garcia'])
        && onPaid.search === 'tent' && onPaid.date === 'Last 7 days' && onPaid.dateLabel === 'Paid date' && said(onPaid.rows) === said(['Karen Garcia']),
      said({ onUnpaid: onUnpaid.rows, onAll, onPaid }));
    await page.unmount();

    // The batch 4 load error: the second row stays, and changes nothing.
    seedSession(VALID);
    setNow(FIXED_NOW);
    resetNet(500, (url) => (url.includes(LIST) ? { error: 'Network down' } : undefined));
    page = await mountPayments();
    const errMethod = methodSelect(page);
    const errDate = dateSelect(page);
    await pickMethod(page, 'Online pending');
    await pickDate(page, 'Today');
    v = lookQ(page);
    check('a load error is unchanged: the second row stays usable, and with Online pending and Today chosen there are still no tabs, totals, pager or rows',
      root().textContent.includes('Could not load the charges: Network down') && !!errMethod && !errMethod.disabled && !!errDate
        && v.method === 'Online pending' && v.date === 'Today' && v.heading === 'Charges' && !page.query('.pay-tabs') && v.detail === null
        && v.pager === null && v.rows.length === 0 && !v.noMatch, said(v));
    await page.unmount();

    // =======================================================================
    // R. Payments: the Filters button and panel on a phone
    // =======================================================================
    // On a phone the toolbar is the search, then one row of the status, a
    // "Filters" button and Refresh; Method, the date, From and To and Clear
    // filters sit in a panel under that row, which the button opens and
    // closes in place. "Filters (n)" counts the Method and date filters that
    // are on, never the search or the tab; aria-expanded says whether the
    // panel is open, and aria-controls names it. The panel holds the one set
    // of those controls, not a copy; Escape inside it closes it and gives
    // focus back to the button; it starts closed on every visit, stays as it
    // was left through Refresh and Record payment, and nothing about it is
    // kept in the browser. Refresh is an icon on a phone and keeps "Refresh"
    // as its name. Which of these shows at which width is index.css's to
    // decide (above 640px the button is hidden and the row always shown), and
    // the layout harness's to measure: here the markup and the behaviour are
    // checked, which are the same at every width.
    console.log('\n--- Payments: the Filters button and panel on a phone ---');
    const TOOLBAR = '.list-head.pay-toolbar';
    // The toolbar's button whose text starts "Filters". "Clear filters" is a
    // different button, in the panel.
    const filtersButton = (pg_) => pg_.queryAll(`${TOOLBAR} button`).find((b) => b.textContent.startsWith('Filters')) ?? null;
    // Refresh, found by where it is rather than by its name, so a check can
    // see the name go missing: the last button in the status row.
    const refreshButton = (pg_) => pg_.queryAll(`${TOOLBAR} .head-actions button`).at(-1) ?? null;
    const panelOf = (pg_) => {
      const id = filtersButton(pg_)?.getAttribute('aria-controls');
      return id ? dom.window.document.getElementById(id) : null;
    };
    // The name a screen reader gives an element: its aria-label, else its
    // aria-labelledby, else the text inside it, leaving out anything
    // aria-hidden (an icon).
    const accName = (el) => {
      if (!el) return null;
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => dom.window.document.getElementById(id)?.textContent ?? '').join(' ').trim();
      const text = (node) => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
        return [...node.childNodes].map(text).join('');
      };
      return text(el).replace(/\s+/g, ' ').trim();
    };
    // Whether the panel is open, as the button says it and as the panel is
    // marked for index.css.
    const panelState = () => {
      const b = filtersButton(page);
      const p = panelOf(page);
      return { expanded: b?.getAttribute('aria-expanded') ?? null, open: p ? p.classList.contains('is-open') : null };
    };
    const OPEN = said({ expanded: 'true', open: true });
    const CLOSED = said({ expanded: 'false', open: false });
    const listGets = () => net.calls.filter((c) => c.method === 'GET' && c.url.includes(LIST)).length;
    const follows = (a, b) => !!a && !!b && (a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    page = await openQ();
    const writesAtOpenR = store.sets;
    const toolbarR = page.query(TOOLBAR);
    const panelR = panelOf(page);
    const buttonR = filtersButton(page);
    check('the toolbar has a "Filters" button between the status and Refresh, with aria-expanded="false" and aria-controls naming the panel, '
        + 'which sits under the row and holds the Method and date selects',
      !!buttonR && buttonR.type === 'button' && buttonR.getAttribute('aria-expanded') === 'false' && !!panelR && !toolbarR.contains(panelR)
        && follows(toolbarR, panelR) && follows(page.query('.list-head select'), buttonR) && follows(buttonR, refreshButton(page))
        && panelR.contains(methodSelect(page)) && panelR.contains(dateSelect(page)),
      said({ button: buttonR?.outerHTML.slice(0, 160) ?? null, controls: buttonR?.getAttribute('aria-controls') ?? null, panel: panelR?.id ?? null }));

    const filtersName = () => accName(filtersButton(page));
    const named = { none: filtersName() };
    await pickMethod(page, 'Online pending');
    named.method = filtersName();
    await pickDate(page, 'Today');
    named.both = filtersName();
    named.bothText = filtersButton(page)?.textContent ?? null;
    await pickMethod(page, 'Any method');
    named.date = filtersName();
    check('it reads "Filters" with nothing on, "Filters (1)" with a method, "Filters (2)" with a method and a date, and "Filters (1)" with the date alone',
      named.none === 'Filters' && named.method === 'Filters (1)' && named.both === 'Filters (2)' && named.bothText === 'Filters (2)'
        && named.date === 'Filters (1)', said(named));
    await type(page, 'flores');
    named.search = filtersName();
    await clickIf(page, tabNamed(page, 'Documents'));
    named.tab = filtersName();
    await press(page, buttonNamed(root(), 'Clear filters'));
    named.cleared = filtersName();
    v = lookQ(page);
    check('  a search and a tab are not filters: "flores" and the Documents tab leave it at "Filters (1)", '
        + 'and Clear filters takes it back to "Filters" with both still on',
      named.search === 'Filters (1)' && named.tab === 'Filters (1)' && named.cleared === 'Filters' && v.search === 'flores'
        && v.pressed.length === 1 && v.pressed[0].startsWith('Documents '), said({ named, search: v.search, pressed: v.pressed }));
    await type(page, '');
    await clickIf(page, tabNamed(page, 'All'));

    const toggled = [panelState()];
    await clickIf(page, filtersButton(page));
    toggled.push(panelState());
    await clickIf(page, filtersButton(page));
    toggled.push(panelState());
    check('pressing Filters opens the panel (aria-expanded="true", the panel marked open) and pressing it again closes it',
      said(toggled[0]) === CLOSED && said(toggled[1]) === OPEN && said(toggled[2]) === CLOSED, said(toggled));

    await clickIf(page, filtersButton(page));
    await pickDate(page, 'Choose dates');
    const inPanel = (el) => !!el && !!panelOf(page) && panelOf(page).contains(el);
    // Labels outside the View panel, whose own form has a "Payment method".
    const labelsReading = (text) => page.queryAll('label').filter((l) => l.textContent === text && !l.closest('.pay-panel')).length;
    const ids = page.queryAll('[id]').map((e) => e.id);
    const one = {
      method: labelsReading('Method'), date: labelsReading('Billed date') + labelsReading('Paid date'), from: labelsReading('From'),
      to: labelsReading('To'), clear: page.queryAll('button').filter((b) => b.textContent === 'Clear filters').length,
      doubledIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
    };
    check('the panel holds the one set of controls, not a copy: one Method select, one date select, From and To under Choose dates '
        + 'and one Clear filters, all inside it, and no id is used twice on the page',
      one.method === 1 && one.date === 1 && one.from === 1 && one.to === 1 && one.clear === 1 && one.doubledIds.length === 0
        && inPanel(methodSelect(page)) && inPanel(dateSelect(page)) && inPanel(labelled(page, 'From')) && inPanel(labelled(page, 'To'))
        && inPanel(buttonNamed(root(), 'Clear filters')), said(one));
    await typeDate(page, 'From', '2026-10-08');
    await typeDate(page, 'To', '2026-10-05');
    const hintR = hintEl(page);
    check('  "The start date is after the end date." is inside the panel, in its polite status region',
      !!hintR && inPanel(hintR) && hintR.getAttribute('role') === 'status', hintR?.outerHTML ?? 'no hint');

    const fromR = labelled(page, 'From');
    fromR?.focus();
    const beforeEscape = panelState();
    if (fromR) await page.key('Escape', fromR);
    check('Escape inside the open panel closes it and puts focus back on the Filters button',
      said(beforeEscape) === OPEN && said(panelState()) === CLOSED && !!filtersButton(page) && page.active() === filtersButton(page),
      said({ beforeEscape, after: panelState(), focus: page.active()?.textContent || page.active()?.tagName }));

    await clickIf(page, filtersButton(page));
    const refreshNames = { open: accName(refreshButton(page)) };
    const getsBeforeR = listGets();
    await clickIf(page, refreshButton(page));
    check('the panel stays open through Refresh, which reloads the list (one more request)',
      listGets() === getsBeforeR + 1 && said(panelState()) === OPEN, said({ requests: listGets() - getsBeforeR, state: panelState() }));
    await clickIf(page, filtersButton(page));
    refreshNames.closed = accName(refreshButton(page));
    await pickMethod(page, 'Online pending');
    refreshNames.two = `${filtersName()}: ${accName(refreshButton(page))}`;
    await clickIf(page, filtersButton(page));
    const openAtLeave = panelState();
    await page.unmount();
    // A new visit, without reseeding the session (which would clear storage).
    resetNet(200, answerFrom(qFresh()));
    page = await mountPayments();
    const openAtReturn = panelState();
    check('it starts closed on every visit, and nothing about it is kept in the browser: left open, a new visit shows it closed; '
        + 'no localStorage write, sessionStorage empty',
      said(openAtLeave) === OPEN && said(openAtReturn) === CLOSED && store.sets === writesAtOpenR && dom.window.sessionStorage.length === 0,
      said({ openAtLeave, openAtReturn, writes: store.sets - writesAtOpenR, session: dom.window.sessionStorage.length }));
    await page.unmount();

    // Record payment: the reload after it leaves the panel as it was.
    const rRecord = qFresh();
    seedSession(VALID);
    setNow(FIXED_NOW);
    resetNet(200, (url, method) => {
      if (method === 'POST' && url.endsWith('/charges/4003/verify')) {
        rRecord.UNPAID = rRecord.UNPAID.filter((c) => c.charge_id !== 4003);
        return { message: 'Payment recorded — charge marked PAID', payment: { payment_id: 91 } };
      }
      return answerFrom(rRecord)(url, method);
    });
    page = await mountPayments();
    await clickIf(page, filtersButton(page));
    const openBeforeRecord = panelState();
    await clickIf(page, viewFor(page, 'Cora Flores'));
    if (page.query('form')?.closest('.pay-panel')) await page.submit();
    await page.settle();
    check('  and through Record payment: opened, Record on Cora Flores, and after the reload it is still open',
      said(openBeforeRecord) === OPEN && said(panelState()) === OPEN && !page.query('.pay-panel') && lookQ(page).rows.length === 7
        && page.query('.alert.success')?.textContent === 'Payment recorded — charge marked PAID (payment #91)',
      said({ openBeforeRecord, now: panelState(), rows: lookQ(page).rows.length }));
    await page.unmount();

    // A load error: Refresh keeps its name, the panel still opens, and
    // pressing Refresh loads again.
    seedSession(VALID);
    setNow(FIXED_NOW);
    resetNet(500, (url) => (url.includes(LIST) ? { error: 'Network down' } : undefined));
    page = await mountPayments();
    refreshNames.error = accName(refreshButton(page));
    await clickIf(page, filtersButton(page));
    refreshNames.errorOpen = `${panelState().expanded}: ${accName(refreshButton(page))}`;
    const getsAtError = listGets();
    await clickIf(page, refreshButton(page));
    check('Refresh is named "Refresh" in every state: the panel open and closed, with "Filters (2)", and after a load error with the panel open, '
        + 'where pressing it loads again',
      said(refreshNames) === said({ open: 'Refresh', closed: 'Refresh', two: 'Filters (2): Refresh', error: 'Refresh', errorOpen: 'true: Refresh' })
        && listGets() === getsAtError + 1 && root().textContent.includes('Could not load the charges: Network down'),
      said({ refreshNames, requests: listGets() - getsAtError }));
    await page.unmount();

    // =======================================================================
    // S. Payments: the type tabs on a narrow phone
    // =======================================================================
    // Where the four tabs do not fit (below about 360px), the strip scrolls
    // inside itself, with no scrollbar drawn, and fades the edge that has
    // more tabs past it: data-fade on the strip names those edges, "start",
    // "end" or "start end", and is absent while the tabs fit. It is measured
    // after every render, on the strip's own scroll and on a resize. A tab
    // chosen while part of it is out of view is scrolled fully into view,
    // clear of the fade, by moving the strip and never the page. jsdom lays
    // nothing out, so the strip's widths, its scroll position and the tabs'
    // boxes are set by hand: a 300px strip holding 411px of tabs, 79, 135,
    // 108 and 89 wide. Drawing the fade and hiding the scrollbar are
    // index.css's, and the layout harness's to measure.
    console.log('\n--- Payments: the type tabs on a narrow phone ---');
    const FADE = 24; // the width of the faded edge in index.css
    const TAB_WIDTHS = [79, 135, 108, 89];
    // Lays the strip out by hand: its client and scroll widths, a scrollLeft
    // held within them as a browser holds it, and each tab's box from where
    // it sits in the strip.
    const layOutStrip = (pg_, clientWidth, widths = TAB_WIDTHS) => {
      const strip = pg_.query('.pay-tabs');
      if (!strip) return null;
      const lefts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
      const scrollWidth = Math.max(widths.reduce((a, b) => a + b, 0), clientWidth);
      let left = 0;
      const rect = (l, r) => ({ left: l, right: r, top: 0, bottom: 40, width: r - l, height: 40, x: l, y: 0 });
      Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => clientWidth });
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => scrollWidth });
      Object.defineProperty(strip, 'scrollLeft', {
        configurable: true, get: () => left, set: (x) => { left = Math.max(0, Math.min(Number(x) || 0, scrollWidth - clientWidth)); },
      });
      strip.getBoundingClientRect = () => rect(0, clientWidth);
      [...strip.querySelectorAll('.pay-tab')].forEach((b, i) => {
        b.getBoundingClientRect = () => rect(lefts[i] - left, lefts[i] + widths[i] - left);
      });
      return strip;
    };
    const strip = () => page.query('.pay-tabs');
    const fade = () => strip()?.getAttribute('data-fade') ?? null;
    // The strip moved by hand, and the scroll event a browser then sends.
    const scrollStripTo = async (x) => {
      if (!strip()) return;
      strip().scrollLeft = x;
      strip().dispatchEvent(new dom.window.Event('scroll'));
      await page.settle();
    };
    // Where a tab sits in the 300px strip, and whether all of it shows.
    const tabBox = (label) => {
      const b = tabNamed(page, label)?.getBoundingClientRect();
      return b ? { left: b.left, right: b.right } : null;
    };

    page = await openQ();
    const fitting = fade();
    layOutStrip(page, 300);
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await page.settle();
    check('the tabs mark no edge while they fit, and "end" once the strip is narrower than they are (here on a resize)',
      fitting === null && fade() === 'end', said({ fitting, narrow: fade() }));
    const marks = [];
    for (const x of [60, 111, 0]) {
      await scrollStripTo(x);
      marks.push(fade());
    }
    check('scrolling the strip moves the mark: "start end" partway, "start" at the end, "end" back at the start',
      said(marks) === said(['start end', 'start', 'end']), said(marks));

    const scrollsBefore = scrolled.length;
    await clickIf(page, tabNamed(page, 'Rentals'));
    const rentals = { at: strip()?.scrollLeft ?? null, box: tabBox('Rentals'), fade: fade() };
    check('choosing a tab partly out of view scrolls the strip until all of it shows, clear of the faded edges: Rentals, '
        + 'and the page itself does not scroll',
      rentals.at > 0 && !!rentals.box && rentals.box.left >= FADE && rentals.box.right <= 300 - FADE && rentals.fade === 'start end'
        && scrolled.length === scrollsBefore, said({ rentals, pageScrolls: scrolled.length - scrollsBefore }));
    await clickIf(page, tabNamed(page, 'Fines'));
    const fines = { at: strip()?.scrollLeft ?? null, box: tabBox('Fines'), fade: fade() };
    check('  Fines, the last, scrolls it to its end, where nothing is past it and that edge is not faded',
      fines.at === 111 && !!fines.box && fines.box.left >= 0 && fines.box.right <= 300 && fines.fade === 'start', said(fines));
    await clickIf(page, tabNamed(page, 'All'));
    const all = { at: strip()?.scrollLeft ?? null, box: tabBox('All'), fade: fade() };
    check('  and All scrolls it back to its start',
      all.at === 0 && !!all.box && all.box.left === 0 && all.fade === 'end' && scrolled.length === scrollsBefore, said(all));
    // A browser scrolls a focused element into view only when none of it
    // shows; a tab half under the faded end stays there unless the page
    // moves it (measured in Chrome 155).
    tabNamed(page, 'Rentals')?.focus();
    await page.settle();
    const focused = { at: strip()?.scrollLeft ?? null, box: tabBox('Rentals'), pressed: look(page).pressed };
    check('a tab that takes keyboard focus while partly out of view is brought fully into view too, without being chosen',
      page.active() === tabNamed(page, 'Rentals') && focused.at > 0 && !!focused.box && focused.box.left >= FADE
        && focused.box.right <= 300 - FADE && said(focused.pressed) === said(['All 8']), said(focused));
    await clickIf(page, tabNamed(page, 'All'));

    layOutStrip(page, 420);
    await type(page, 'flores');
    const widened = fade();
    layOutStrip(page, 300);
    await type(page, '');
    check('the mark follows the strip after any render, not only a scroll or a resize: widened to fit, a search drops it; '
        + 'narrowed again, clearing the search brings "end" back',
      widened === null && fade() === 'end', said({ widened, narrowed: fade() }));
    await page.unmount();

    if (F.clock && realNow) F.clock.now = realNow;
    if (previousTZQ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZQ;

    if (previousScroll === undefined) delete proto.scrollIntoView;
    else proto.scrollIntoView = previousScroll;
  }

  // =========================================================================
  // T. No fee: PHP 0 charges on the request and rental pages
  // =========================================================================
  // Approval creates a PHP 0 document charge already PAID, with no payment
  // row, and a booking does the same for a PHP 0 rental; the Payments page
  // calls that "No fee" (section N). My requests and My rentals said "Amount
  // due: ₱0.00 — Paid", and the request detail the Secretary, Staff and the
  // Punong Barangay open said "Charge ₱0.00 Paid", which reads as a payment
  // someone made. All three now say "No fee". An unpaid or void PHP 0 charge
  // keeps its old wording, and so does every charge above 0. The Fee of My
  // requests and of the detail showed the document type's fee as it is
  // today; once approval has billed a request they show the charge's amount,
  // the fee taken then (request 11's type costs PHP 20.00 now, but it was
  // charged PHP 0). isNoFeeCharge is checked on its own, case by case, then
  // through the three real pages and the Punong Barangay's read-only detail.
  // Every request is answered by the fetch stub, and only GETs are sent.
  console.log('\n--- No fee: PHP 0 charges on the request and rental pages ---');
  {
    const said = (v) => JSON.stringify(v);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

    // a. isNoFeeCharge on its own. The amount arrives as a number or as a
    // numeric string; a missing, null or blank one is never 0 (isZeroFee,
    // section N), and only a PAID charge is "No fee".
    const NO_FEE_CASES = [
      { name: 'PAID, amount 0', want: true, c: { status: 'PAID', amount: 0 } },
      { name: 'PAID, amount "0.00" (a string)', want: true, c: { status: 'PAID', amount: '0.00' } },
      { name: 'PAID, amount "0" (a string)', want: true, c: { status: 'PAID', amount: '0' } },
      { name: 'PAID, amount 20', want: false, c: { status: 'PAID', amount: 20 } },
      { name: 'PAID, amount "20.00"', want: false, c: { status: 'PAID', amount: '20.00' } },
      { name: 'PAID, amount 0.01', want: false, c: { status: 'PAID', amount: 0.01 } },
      { name: 'PAID, amount null', want: false, c: { status: 'PAID', amount: null } },
      { name: 'PAID, no amount at all', want: false, c: { status: 'PAID' } },
      { name: 'PAID, amount "" (blank, which Number() reads as 0)', want: false, c: { status: 'PAID', amount: '' } },
      { name: 'UNPAID, amount 0', want: false, c: { status: 'UNPAID', amount: 0 } },
      { name: 'VOID, amount "0.00"', want: false, c: { status: 'VOID', amount: '0.00' } },
      { name: 'no charge at all (null)', want: false, c: null },
    ];
    const isNoFee = globalThis.isNoFeeCharge;
    for (const { name, want, c } of NO_FEE_CASES) {
      let got;
      try { got = typeof isNoFee === 'function' ? isNoFee(c) : 'isNoFeeCharge is not exported'; } catch (e) { got = `threw: ${e.message}`; }
      check(`isNoFeeCharge: ${name} = ${want}`, got === want, said(got));
    }

    // The pages' data, in each list's real shape. Every request names its own
    // document type and every booking its own item, so a row is found by the
    // name in its first cell; each detail is opened by its resident's name.
    const docRequest = (id, status, name, typeFee, charge) => ({
      request_id: id, purpose: `Purpose ${id}`, status, requested_at: '2026-10-01T02:00:00+00:00',
      claimed_at: status === 'claimed' ? '2026-10-05T03:00:00+00:00' : null, rejection_reason: null,
      document_types: { document_type_id: 500 + id, name, fee: typeFee },
      charges: charge && { charge_id: 900 + id, declared_method: null, declared_reference: null, declared_at: null, ...charge },
    });
    const MINE = [
      // Request 91: a First-time Jobseeker certificate, a PHP 0 type, claimed.
      docRequest(91, 'claimed', 'First-time Jobseeker Certificate', '0.00', { amount: '0.00', status: 'PAID' }),
      // Request 11: its type costs PHP 20.00 now; it cost nothing when approved.
      docRequest(11, 'claimed', 'Certificate of Indigency', '20.00', { amount: 0, status: 'PAID' }),
      docRequest(120, 'ready_for_release', 'Barangay Clearance', '20.00', { amount: '20.00', status: 'PAID' }),
      // Billed at PHP 50.00; the type has cost PHP 75.00 since.
      docRequest(121, 'approved', 'Certificate of Residency', '75.00', { amount: '50.00', status: 'UNPAID' }),
      docRequest(122, 'pending', 'Barangay ID', '30.00', null),
      docRequest(123, 'approved', 'Certificate of Good Moral Character', '0.00', { amount: '0', status: 'PAID' }),
      docRequest(124, 'approved', 'Business Clearance', '0.00', { amount: 0, status: 'UNPAID' }),
      docRequest(125, 'claimed', 'Certificate of Low Income', '20.00', { amount: null, status: 'PAID' }),
      docRequest(126, 'claimed', 'Solo Parent Certificate', '20.00', { status: 'PAID' }),
    ];
    const booking = (id, name, itemFee, status, charge) => ({
      request_id: id, quantity_requested: 1, start_datetime: '2026-10-20T01:00:00+00:00', end_datetime: '2026-10-20T05:00:00+00:00',
      purpose: `Purpose ${id}`, status, return_note: null, returned_at: null,
      rental_items: { item_id: 600 + id, name, type: 'equipment', fee: itemFee },
      charges: charge && { charge_id: 950 + id, declared_method: null, declared_reference: null, declared_at: null, ...charge },
    });
    const RENTALS = [
      booking(301, 'Monobloc Chairs', '0.00', 'confirmed', { amount: '0.00', status: 'PAID' }),
      booking(302, 'Sound System', '25.00', 'confirmed', { amount: '25.00', status: 'PAID' }),
      booking(303, 'Covered Court', '300.00', 'confirmed', { amount: '300.00', status: 'UNPAID' }),
      booking(304, 'Folding Tables', '0.00', 'confirmed', { amount: 0, status: 'UNPAID' }),
      booking(305, 'Event Tent', '0.00', 'cancelled', { amount: '0.00', status: 'VOID' }),
    ];
    // The detail's shape: the list's, with the resident record, the requester,
    // who decided it, and the charge's billed date and payment rows.
    const detailRequest = (id, status, name, typeFee, charge, first, last) => ({
      ...docRequest(id, status, name, typeFee, charge && { created_at: '2026-10-02T02:00:00+00:00', payments: [], ...charge }),
      processed_at: status === 'pending' ? null : '2026-10-02T02:00:00+00:00',
      resident_records: { resident_id: 800 + id, first_name: first, middle_name: null, last_name: last, suffix: null,
        birthdate: '1990-01-01', birthplace: 'Tagbilaran City', address: 'Purok 2, Ubujan', sex: null, civil_status: null,
        contact_number: null, date_registered: '2026-07-01T00:00:00+00:00', account: { username: `res_${id}` } },
      requester: { user_id: 700 + id, username: `res_${id}`, email: null },
      processed_by: status === 'pending' ? null : { user_id: 1, username: 'secretary1' },
    });
    const DETAIL = [
      detailRequest(91, 'claimed', 'First-time Jobseeker Certificate', '0.00', { amount: '0.00', status: 'PAID' }, 'Liza', 'Bantilan'),
      detailRequest(11, 'claimed', 'Certificate of Indigency', '20.00', { amount: 0, status: 'PAID' }, 'Mario', 'Dagohoy'),
      detailRequest(130, 'approved', 'First-time Jobseeker Certificate', '0.00', { amount: '0.00', status: 'PAID' }, 'Nora', 'Escabas'),
      detailRequest(131, 'approved', 'Certificate of Residency', '75.00', { amount: '50.00', status: 'UNPAID' }, 'Oscar', 'Fuentes'),
      detailRequest(132, 'ready_for_release', 'Barangay Clearance', '20.00', { amount: '20.00', status: 'PAID' }, 'Pia', 'Gallego'),
      detailRequest(133, 'pending', 'Barangay ID', '30.00', null, 'Quino', 'Hontanosas'),
    ];
    const answer = (url) => {
      if (url.includes('/document-requests/mine')) return { requests: MINE };
      if (url.includes('/rental-requests/mine')) return { requests: RENTALS };
      const one = url.match(/\/document-requests\/(\d+)$/);
      if (one) {
        const found = DETAIL.find((r) => r.request_id === Number(one[1]));
        return found ? { request: found } : undefined;
      }
      if (url.includes('/document-requests?')) return { requests: DETAIL };
      return undefined;
    };
    const methodsSent = [];
    // A row's charge line is the one that says "No fee" or "Amount due …";
    // the status cell's other notes ("Claimed on …") are not it.
    const chargeLine = (cell) => [...(cell?.querySelectorAll('.reason-note') || [])].map(text)
      .find((l) => l === 'No fee' || l.startsWith('Amount due')) ?? null;
    const requestRow = (page, name) => {
      const tr = page.queryAll('table.my-requests-table tbody tr').find((row) => text(row.querySelector('strong')) === name);
      if (!tr) return null;
      const statusCell = tr.children[3];
      return {
        fee: text(tr.querySelector('td.num')),
        charge: chargeLine(statusCell),
        statusText: text(statusCell),
        pay: !!tr.querySelector('.pay-menu'),
        cancel: !!buttonNamed(tr, 'Cancel'),
      };
    };
    const rentalRow = (page, name) => {
      const tr = page.queryAll('table.my-rentals-table tbody tr').find((row) => text(row.querySelector('strong')) === name);
      if (!tr) return null;
      return { charge: chargeLine(tr), rowText: text(tr), pay: !!tr.querySelector('.pay-menu') };
    };

    // b. My requests, as the resident who made them.
    seedSession(RES_TOKEN, RES_USER);
    resetNet(200, answer);
    let page = await globalThis.mountInteractive(root(), '/resident');
    await page.settle();
    const r91 = requestRow(page, 'First-time Jobseeker Certificate');
    check('My requests, request 91 (PAID ₱0.00): the charge line says "No fee", not "Amount due: ₱0.00 — Paid", with no '
        + 'Pay menu; the Fee column shows the charge\'s ₱0.00',
      r91?.charge === 'No fee' && !r91.statusText.includes('₱0.00') && !r91.statusText.includes('Amount due') && !r91.pay
        && r91.fee === '₱0.00', said(r91));
    const r11 = requestRow(page, 'Certificate of Indigency');
    check('My requests, request 11 (its type costs ₱20.00 now, it was charged ₱0): Fee shows the charge\'s ₱0.00, not '
        + '₱20.00, and the charge line says "No fee"',
      r11?.fee === '₱0.00' && r11.charge === 'No fee' && !r11.pay, said(r11));
    const r120 = requestRow(page, 'Barangay Clearance');
    check('My requests, a PAID ₱20.00 charge still reads "Amount due: ₱20.00 — Paid", Fee ₱20.00',
      r120?.charge === 'Amount due: ₱20.00 — Paid' && r120.fee === '₱20.00' && !r120.pay, said(r120));
    const r121 = requestRow(page, 'Certificate of Residency');
    check('My requests, an UNPAID ₱50.00 charge still reads "Amount due: ₱50.00 — Unpaid", with the Pay menu',
      r121?.charge === 'Amount due: ₱50.00 — Unpaid' && r121.pay, said(r121));
    check('  and its Fee is the ₱50.00 it was billed, not the ₱75.00 its type costs today', r121?.fee === '₱50.00', said(r121));
    const r122 = requestRow(page, 'Barangay ID');
    check('My requests, a pending request with no charge yet shows its type\'s ₱30.00 and no charge line',
      r122?.fee === '₱30.00' && r122.charge === null && r122.cancel && !r122.pay, said(r122));
    const r123 = requestRow(page, 'Certificate of Good Moral Character');
    check('My requests, a PAID charge whose amount is the string "0" says "No fee" too',
      r123?.charge === 'No fee' && !r123.pay, said(r123));
    const r124 = requestRow(page, 'Business Clearance');
    check('My requests, an UNPAID ₱0.00 charge keeps "Amount due: ₱0.00 — Unpaid" and the Pay menu, never "No fee"',
      r124?.charge === 'Amount due: ₱0.00 — Unpaid' && r124.pay, said(r124));
    const r125 = requestRow(page, 'Certificate of Low Income');
    const r126 = requestRow(page, 'Solo Parent Certificate');
    check('My requests, a PAID charge with a null amount, or with no amount at all, is never "No fee"',
      !!r125 && !!r126 && r125.charge !== null && r125.charge !== 'No fee' && r126.charge !== null && r126.charge !== 'No fee',
      said({ r125, r126 }));
    methodsSent.push(...net.calls.map((c) => c.method));
    await page.unmount();

    // c. My rentals, as the same resident.
    seedSession(RES_TOKEN, RES_USER);
    resetNet(200, answer);
    page = await globalThis.mountInteractive(root(), '/resident/rentals');
    await page.settle();
    const chairs = rentalRow(page, 'Monobloc Chairs');
    check('My rentals, a PAID ₱0.00 booking: the charge line says "No fee", no "₱0.00" anywhere in the row, and no Pay menu',
      chairs?.charge === 'No fee' && !chairs.rowText.includes('₱0.00') && !chairs.rowText.includes('Amount due') && !chairs.pay,
      said(chairs));
    const sound = rentalRow(page, 'Sound System');
    check('My rentals, a PAID ₱25.00 booking still reads "Amount due: ₱25.00 — Paid"',
      sound?.charge === 'Amount due: ₱25.00 — Paid' && !sound.pay, said(sound));
    const court = rentalRow(page, 'Covered Court');
    check('My rentals, an UNPAID ₱300.00 booking still reads "Amount due: ₱300.00 — Unpaid", with the Pay menu',
      court?.charge === 'Amount due: ₱300.00 — Unpaid' && court.pay, said(court));
    const tables = rentalRow(page, 'Folding Tables');
    check('My rentals, an UNPAID ₱0.00 booking keeps "Amount due: ₱0.00 — Unpaid" and the Pay menu, never "No fee"',
      tables?.charge === 'Amount due: ₱0.00 — Unpaid' && tables.pay, said(tables));
    const tent = rentalRow(page, 'Event Tent');
    check('My rentals, a cancelled booking\'s VOID ₱0.00 charge keeps "Amount due: ₱0.00 — Void", never "No fee"',
      tent?.charge === 'Amount due: ₱0.00 — Void' && !tent.pay, said(tent));
    methodsSent.push(...net.calls.map((c) => c.method));
    await page.unmount();

    // d. The request detail, as the Secretary. Opened from the list's Review
    // (View for the Punong Barangay) and left by Back to list; the workflow
    // buttons are read, never pressed. The list opens on its Pending tab
    // (section W) and most of these requests are not pending, so the All tab
    // is chosen first; the tab is kept when Back to list returns to it.
    const showAll = async (pg) => {
      const all = pg.queryAll('.pay-tabs button').find((b) => b.textContent.startsWith('All '));
      if (all) await pg.click(all);
    };
    const detailOf = async (pg, first, last) => {
      const row = pg.queryAll('table.data-table tbody tr').find((tr) => text(tr.querySelector('strong')) === `${first} ${last}`);
      const opener = row && [...row.querySelectorAll('button')].find((b) => /^(Review|View)$/.test(b.textContent));
      if (!opener) return { fields: {}, missing: `${first} ${last}` };
      await pg.click(opener);
      await pg.settle();
      const grid = pg.query('.pending-card dl.info-grid');
      const out = {
        fields: Object.fromEntries([...(grid?.children || [])].map((div) => [text(div.querySelector('dt')), text(div.querySelector('dd'))])),
        release: !!buttonNamed(root(), 'Mark ready for release'),
        claim: !!buttonNamed(root(), 'Mark as claimed'),
        awaiting: root().textContent.includes('Awaiting payment'),
      };
      await clickIf(pg, buttonNamed(root(), '← Back to list'));
      return out;
    };
    seedSession(VALID);
    resetNet(200, answer);
    page = await globalThis.mountInteractive(root(), '/secretary/requests');
    await page.settle();
    await showAll(page);
    let d = await detailOf(page, 'Liza', 'Bantilan');
    check('Request detail, request 91 (PAID ₱0.00): Charge says "No fee", not "₱0.00 Paid"; Fee is the charge\'s ₱0.00',
      d.fields.Charge === 'No fee' && d.fields.Fee === '₱0.00', said(d.fields));
    d = await detailOf(page, 'Mario', 'Dagohoy');
    check('Request detail, request 11 (its type costs ₱20.00 now, it was charged ₱0): Fee shows the charge\'s ₱0.00, not '
        + '₱20.00, and Charge says "No fee"',
      d.fields.Fee === '₱0.00' && d.fields.Charge === 'No fee', said(d.fields));
    d = await detailOf(page, 'Nora', 'Escabas');
    check('Request detail, an approved request with a PAID ₱0.00 charge says "No fee" and still offers "Mark ready for '
        + 'release": the release rule is unchanged',
      d.fields.Charge === 'No fee' && d.release && !d.awaiting, said(d));
    d = await detailOf(page, 'Oscar', 'Fuentes');
    check('Request detail, an approved request with an UNPAID ₱50.00 charge: Charge "₱50.00 Unpaid", Fee the ₱50.00 it was '
        + 'billed (not the type\'s ₱75.00 today), and it still awaits payment',
      d.fields.Charge === '₱50.00 Unpaid' && d.fields.Fee === '₱50.00' && d.awaiting && !d.release, said(d));
    d = await detailOf(page, 'Pia', 'Gallego');
    check('Request detail, a PAID ₱20.00 charge still reads "₱20.00 Paid", Fee ₱20.00, and "Mark as claimed" is offered',
      d.fields.Charge === '₱20.00 Paid' && d.fields.Fee === '₱20.00' && d.claim, said(d));
    d = await detailOf(page, 'Quino', 'Hontanosas');
    check('Request detail, a pending request with no charge: Fee is its type\'s ₱30.00, Charge "No charge (billed on approval)"',
      d.fields.Fee === '₱30.00' && d.fields.Charge === 'No charge (billed on approval)', said(d.fields));
    methodsSent.push(...net.calls.map((c) => c.method));
    await page.unmount();

    // e. The same detail, read-only, as the Punong Barangay.
    seedSession(makeToken({ sub: '5', role: 'punong_barangay', exp: VALID_EXP }),
      { user_id: 5, username: 'pb_ubujan', role: 'punong_barangay', must_change_password: false });
    resetNet(200, answer);
    page = await globalThis.mountInteractive(root(), '/punong-barangay/requests');
    await page.settle();
    await showAll(page);
    d = await detailOf(page, 'Nora', 'Escabas');
    check('the Punong Barangay\'s read-only detail says "No fee" too, Fee ₱0.00, with no release button',
      d.fields.Charge === 'No fee' && d.fields.Fee === '₱0.00' && !d.release, said(d));
    methodsSent.push(...net.calls.map((c) => c.method));
    await page.unmount();
    check('section T sent nothing but GETs', methodsSent.length > 0 && methodsSent.every((m) => m === 'GET'),
      `${methodsSent.length} request(s): ${[...new Set(methodsSent)].join(', ')}`);
  }

  // =========================================================================
  // U. The Collections report: the No-fee charges tile, and "by billed month"
  // =========================================================================
  // Paid charges counted more than Payments recorded (69 against 67 on the
  // live data, 12 Oct 2026) with nothing on screen to say why: the PHP 0
  // charges approval marks paid have no payment row. The report's totals now
  // carry no_fee_charges, shown as a "No-fee charges" tile after "Payments
  // recorded". The monthly "Collected" series counts each paid charge in the
  // month it was billed, and is now named "Collected (by billed month)" in
  // the chart's legend and the Monthly table; the by-type chart and table
  // keep "Collected". The figure and the CSV are the server's
  // (routes/reports.js); this is the page. jsdom has no ResizeObserver and
  // lays nothing out, so for this section a stub one, and the chart box's
  // getBoundingClientRect, report 800 by 260, and recharts draws the charts
  // and their legends. Every request is answered by the fetch stub.
  console.log('\n--- Collections report: the No-fee charges tile, and "by billed month" ---');
  {
    const said = (v) => JSON.stringify(v);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const TREASURER_USER = { user_id: 16, username: 'treasurer1', role: 'treasurer', must_change_password: false };
    const TREASURER_TOKEN = makeToken({ sub: '16', role: 'treasurer', exp: VALID_EXP });
    // The live report's totals on 12 Oct 2026, before no_fee_charges.
    const TOTALS = { total_collected: 10549, total_outstanding: 2350, total_billed: 12899, voided_amount: 2637,
      paid_charges: 69, unpaid_charges: 14, payments_recorded: 67 };
    const report = (totals) => ({
      range: { from: '2025-11-01', to: '2026-10-12' }, generated_at: '2026-10-12T11:00:00.000Z', totals,
      by_type: [
        { charge_type: 'DOCUMENT', charges: 50, collected: 1000, outstanding: 100 },
        { charge_type: 'RENTAL', charges: 30, collected: 9000, outstanding: 2000 },
        { charge_type: 'FINE', charges: 3, collected: 549, outstanding: 250 },
      ],
      by_payment_method: [
        { payment_method: 'onsite', payments: 40, amount: 6000 },
        { payment_method: 'gcash', payments: 27, amount: 4549 },
      ],
      monthly: [
        { month: '2026-09', collected: 4000, billed: 5000 },
        { month: '2026-10', collected: 6549, billed: 7899 },
      ],
    });
    // recharts reads its box with getBoundingClientRect, then watches it with
    // a ResizeObserver; both are put back at the end of the section.
    const CHART_BOX = { width: 800, height: 260, top: 0, left: 0, right: 800, bottom: 260, x: 0, y: 0 };
    class BoxObserver {
      constructor(callback) { this.callback = callback; }
      observe(target) { this.callback([{ target, contentRect: CHART_BOX }]); }
      unobserve() {}
      disconnect() {}
    }
    const previousObserver = global.ResizeObserver;
    global.ResizeObserver = BoxObserver;
    const elementProto = dom.window.HTMLElement.prototype;
    const realRect = elementProto.getBoundingClientRect;
    elementProto.getBoundingClientRect = function rect() {
      return this.classList?.contains('recharts-responsive-container') ? { ...CHART_BOX } : realRect.call(this);
    };
    // A drawn line animates, and asks for animation frames, which this jsdom
    // does not provide: unanswered, the line stays at its first frame, which
    // nothing here reads, and the legend is drawn all the same.
    const previousFrame = global.requestAnimationFrame;
    const previousCancel = global.cancelAnimationFrame;
    global.requestAnimationFrame = () => 0;
    global.cancelAnimationFrame = () => {};
    // The tiles as "label value", each chart's legend and each table's header.
    const readReport = (page) => {
      const cardOf = (title) => page.queryAll('.chart-card').find((c) => text(c.querySelector('h4')) === title);
      const legend = (title) => [...(cardOf(title)?.querySelectorAll('.recharts-legend-item-text') || [])].map(text);
      const head = (title) => {
        const block = page.queryAll('.report-sheet [data-pdf-block]')
          .find((b) => b.querySelector('table') && text(b.querySelector('h4')) === title);
        return [...(block?.querySelectorAll('thead th') || [])].map(text);
      };
      return {
        tiles: page.queryAll('.stat-row .stat-tile')
          .map((t) => `${text(t.querySelector('.stat-label'))} ${text(t.querySelector('.stat-value'))}`),
        monthlyLegend: legend('Collected vs billed per month'),
        byTypeLegend: legend('Collected vs outstanding by charge type'),
        monthlyHead: head('Monthly'),
        byTypeHead: head('By charge type'),
        failed: /could not be displayed/i.test(root().textContent),
      };
    };

    seedSession(TREASURER_TOKEN, TREASURER_USER);
    resetNet(200, (url) => (url.includes('/reports/collections?') ? report({ ...TOTALS, no_fee_charges: 2 }) : undefined));
    let page = await globalThis.mountInteractive(root(), '/treasurer/reports');
    await page.settle();
    let seen = readReport(page);
    check('the Collections report shows a "No-fee charges" tile reading 2 right after "Payments recorded 67", so Paid '
        + 'charges 69 = 67 + 2 reads off the tiles',
      seen.tiles.includes('Paid charges 69') && seen.tiles.includes('No-fee charges 2')
        && seen.tiles.indexOf('No-fee charges 2') === seen.tiles.indexOf('Payments recorded 67') + 1, said(seen.tiles));
    check('  the seven tiles before it are unchanged and in their order; it is the eighth and last',
      said(seen.tiles) === said(['Total collected ₱10,549.00', 'Total outstanding ₱2,350.00', 'Total billed ₱12,899.00',
        'Voided amount ₱2,637.00', 'Paid charges 69', 'Unpaid charges 14', 'Payments recorded 67', 'No-fee charges 2']),
      said(seen.tiles));
    check('the monthly chart\'s legend names its series "Collected (by billed month)" and "Billed"',
      said([...seen.monthlyLegend].sort()) === said(['Billed', 'Collected (by billed month)']), said(seen.monthlyLegend));
    check('  and the Monthly table\'s header reads "Month | Collected (by billed month) | Billed"',
      said(seen.monthlyHead) === said(['Month', 'Collected (by billed month)', 'Billed']), said(seen.monthlyHead));
    check('the by-type chart and table, which are not by month, keep plain "Collected", and the report renders',
      said([...seen.byTypeLegend].sort()) === said(['Collected', 'Outstanding'])
        && said(seen.byTypeHead) === said(['Charge type', 'Charges', 'Collected', 'Outstanding']) && !seen.failed,
      said({ legend: seen.byTypeLegend, head: seen.byTypeHead, failed: seen.failed }));
    await page.unmount();

    // A server without the change (one deployed behind this page) sends no
    // no_fee_charges: no tile for it, and no blank one.
    seedSession(TREASURER_TOKEN, TREASURER_USER);
    resetNet(200, (url) => (url.includes('/reports/collections?') ? report({ ...TOTALS }) : undefined));
    page = await globalThis.mountInteractive(root(), '/treasurer/reports');
    await page.settle();
    seen = readReport(page);
    check('an answer without no_fee_charges shows the seven tiles as before, with no "No-fee charges" tile and no blank one',
      seen.tiles.length === 7 && seen.tiles.every((t) => !/^No.fee/.test(t) && !/ $/.test(t)) && !seen.failed, said(seen.tiles));
    await page.unmount();

    if (previousObserver === undefined) delete global.ResizeObserver;
    else global.ResizeObserver = previousObserver;
    if (previousFrame === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = previousFrame;
    if (previousCancel === undefined) delete global.cancelAnimationFrame;
    else global.cancelAnimationFrame = previousCancel;
    elementProto.getBoundingClientRect = realRect;
  }

  // =========================================================================
  // V. Document requests: a failed load is an error, never an empty list
  // =========================================================================
  // One component (SecretaryRequestsPage) is the Document requests list on
  // three routes: the Secretary's, Staff's and the Punong Barangay's. It had
  // the defect section M fixed on Payments: a request that failed stored an
  // empty list beside the error, so the page said "0 requests" and "No
  // pending requests." while it knew nothing, which reads as nobody waiting.
  // It showed "Loading requests…" on the first open only, so Refresh and a
  // new status left the old rows on screen while they were out, and an older
  // answer that arrived late could replace a newer one. A failed load must
  // say so, with Try again, and show no rows, no count and no empty text;
  // every load starts from the loading state; an older answer is dropped; and
  // the status control is labelled "Status", as Payments' is. The same checks
  // run for the three roles, each with its own projection: Staff's rows carry
  // no requester email and no resident account. The clock is UTC for this
  // section, so the Submitted dates are fixed. Every request is answered by
  // the fetch stub, and only GETs are sent.
  //
  // Since the status tabs (section W) the list is loaded once, with
  // ?status=all, and a tab filters what is loaded without a request. So a
  // load is started by the first open, Try again and Refresh only: the
  // checks that changed the status to start one now press Refresh or Try
  // again, the one that changed it over loaded rows checks that a tab shows
  // its own rows at once, and the select's label is now the tab group's.
  console.log('\n--- Document requests: a failed load is an error, never an empty list ---');
  {
    const previousTZV = process.env.TZ;
    process.env.TZ = 'UTC';
    const said = (v) => JSON.stringify(v);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    // The list's own URL: ?status=all since the tabs (before them, ?status=
    // for one status and nothing after it for All).
    const isList = (call) => call?.method === 'GET' && /\/document-requests(\?status=[a-z_]+)?$/.test(call.url);
    const statusOf = (call) => (isList(call) ? (call.url.match(/\?status=([a-z_]+)$/)?.[1] ?? 'all') : null);
    // A request in the list's real shape (SECRETARY_LIST_FIELDS in
    // routes/documentRequests.js). Staff's drops what STAFF_LIST_FIELDS
    // withholds: the resident's account and the requester's email.
    const listRequest = (id, status, first, last, documentType, staff) => ({
      request_id: id, purpose: `Purpose ${id}`, status, requested_at: '2026-10-08T02:00:00+00:00',
      claimed_at: status === 'claimed' ? '2026-10-10T03:00:00+00:00' : null,
      rejection_reason: status === 'rejected' ? 'Incomplete requirements' : null,
      processed_at: status === 'pending' ? null : '2026-10-09T02:00:00+00:00',
      document_types: { document_type_id: 500 + id, name: documentType, fee: '20.00' },
      resident_records: { resident_id: 800 + id, first_name: first, middle_name: null, last_name: last, suffix: null,
        ...(staff ? {} : { account: { username: `res_${id}` } }) },
      requester: { user_id: 700 + id, username: `res_${id}`, ...(staff ? {} : { email: `res_${id}@example.invalid` }) },
      charges: ['approved', 'ready_for_release', 'claimed'].includes(status)
        ? { charge_id: 900 + id, amount: '20.00', status: 'UNPAID', declared_method: null, declared_reference: null }
        : null,
    });
    const PENDING_TWO = (staff) => [
      listRequest(201, 'pending', 'Ana', 'Cruz', 'Barangay Clearance', staff),
      listRequest(202, 'pending', 'Ben', 'Reyes', 'Certificate of Residency', staff),
    ];
    const APPROVED_ONE = (staff) => [listRequest(203, 'approved', 'Carla', 'Santos', 'Barangay ID', staff)];
    const CLAIMED_TWO = (staff) => [
      listRequest(204, 'claimed', 'Dino', 'Tan', 'Barangay Clearance', staff),
      listRequest(205, 'claimed', 'Elsa', 'Uy', 'Certificate of Indigency', staff),
    ];
    const REJECTED_ONE = (staff) => [listRequest(206, 'rejected', 'Fe', 'Villa', 'Business Clearance', staff)];
    // Every request, what ?status=all answers: two pending, one approved, two
    // claimed, one rejected.
    const MIXED = (staff) => [...PENDING_TWO(staff), ...APPROVED_ONE(staff), ...CLAIMED_TWO(staff), ...REJECTED_ONE(staff)];
    // A status tab, by its label ("Approved 1"), as a person presses it.
    const tabNamed = (page, label) => page.queryAll('.pay-tabs button').find((b) => b.textContent.startsWith(`${label} `));
    const pressedTab = (page) => page.queryAll('.pay-tabs button[aria-pressed="true"]').map(text);
    // Holds back every answer asked for from here on until a check releases
    // it, so the page can be read while a load is out and answers can arrive
    // in any order. Returns the index the next held answer will have.
    const holdNext = () => {
      net.hold = true;
      return net.held.length;
    };
    // The page's words with a space between neighbouring elements' text:
    // textContent runs them together ("Refresh" then "No pending requests."
    // reads "RefreshNo pending requests."), where \b finds no word edge.
    const spaced = (el) => {
      const walker = el.ownerDocument.createTreeWalker(el, dom.window.NodeFilter.SHOW_TEXT);
      const parts = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    };
    // What the list area says, read the way a person would.
    const listView = (page) => {
      const all = spaced(root());
      return {
        heading: text(page.query('.list-head h2')),
        error: page.queryAll('[role="alert"]').map(text).find((t) => t.startsWith('Could not load the requests')) ?? null,
        tryAgain: !!tryAgainButton(page),
        rows: page.queryAll('table.data-table tbody tr').map((tr) => text(tr.querySelector('strong'))),
        // "0 requests", or "0 pending requests" since the heading names the tab.
        zero: /\b0 [a-z ]*requests?\b/.test(all),
        empty: /\bNo [a-z ]*requests\./.test(all),
        loading: all.includes('Loading requests…'),
      };
    };
    // The error with Try again, and nothing that could read as "nothing to
    // review": no rows, no count, no empty text.
    const errorOnly = (v) => !!v.error && v.tryAgain && v.heading === 'Document requests' && v.rows.length === 0
      && !v.zero && !v.empty && !v.loading;
    const loadingOnly = (v) => v.loading && !v.error && !v.tryAgain && v.heading === 'Document requests'
      && v.rows.length === 0 && !v.zero && !v.empty;
    // Each row as a person reads it: the name, the account note under it, the
    // document, purpose, status and submitted cells, and the row's button.
    const rowsRead = (page) => page.queryAll('table.data-table tbody tr').map((tr) => {
      const cells = [...tr.children];
      return [text(cells[0]?.querySelector('strong')), text(cells[0]?.querySelector('.small-note')) ?? '(no note)',
        ...cells.slice(1, 5).map(text), text(cells[5]?.querySelector('button'))].join(' | ');
    });
    const headersRead = (page) => page.queryAll('table.data-table thead th').map(text);
    const methodsSent = [];

    const ROLES = [
      { name: 'Secretary', route: '/secretary/requests', token: VALID, user: USER, staff: false, opener: 'Review', walkIn: true },
      { name: 'Staff', route: '/staff/requests', token: makeToken({ sub: '3', role: 'staff', exp: VALID_EXP }),
        user: { user_id: 3, username: 'staff1', role: 'staff', must_change_password: false },
        staff: true, opener: 'View', walkIn: false },
      { name: 'Punong Barangay', route: '/punong-barangay/requests',
        token: makeToken({ sub: '5', role: 'punong_barangay', exp: VALID_EXP }),
        user: { user_id: 5, username: 'pb_ubujan', role: 'punong_barangay', must_change_password: false },
        staff: false, opener: 'View', walkIn: false },
    ];
    for (const { name, route, token, user, staff, opener, walkIn } of ROLES) {
      // a. A successful load reads as it always has, on the Pending tab it
      // opens on, and the tab group is named. Any list URL gets every
      // request; which one the page asks for is check b's.
      seedSession(token, user);
      resetNet(200, (url) => (/\/document-requests\?/.test(url) ? { requests: MIXED(staff) } : undefined));
      let page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      const note = (id) => (staff ? '(no note)' : `@res_${id}`);
      const WANT_ROWS = [
        `Ana Cruz | ${note(201)} | Barangay Clearance | Purpose 201 | Pending | Oct 8, 2026, 2:00 AM | ${opener}`,
        `Ben Reyes | ${note(202)} | Certificate of Residency | Purpose 202 | Pending | Oct 8, 2026, 2:00 AM | ${opener}`,
      ];
      check(`${name}: a successful load shows its rows as before: "2 pending requests", the six column headers, and each `
          + `row's name, ${staff ? 'no account note' : 'account note'}, document, purpose, status, date and ${opener}, `
          + `${walkIn ? 'with' : 'with no'} Encode walk-in`,
        text(page.query('.list-head h2')) === '2 pending requests'
          && said(headersRead(page)) === said(['Requester', 'Document', 'Purpose', 'Status', 'Submitted', ''])
          && said(rowsRead(page)) === said(WANT_ROWS) && !!buttonNamed(root(), 'Encode walk-in') === walkIn,
        said({ heading: text(page.query('.list-head h2')), headers: headersRead(page), rows: rowsRead(page) }));
      const group = page.query('.pay-tabs');
      check(`${name}: the status tabs are a group labelled "Status"`,
        group?.getAttribute('role') === 'group' && group.getAttribute('aria-label') === 'Status',
        said({ role: group?.getAttribute('role') ?? null, label: group?.getAttribute('aria-label') ?? null }));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();

      // b. The first open fails: the loading state while it is out, then the
      // error, with Try again, and nothing else.
      seedSession(token, user);
      resetNet(200);
      let at = holdNext();
      page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      const opening = listView(page);
      const firstCall = net.calls[0];
      release(at, 500, { error: 'Network down' });
      await page.settle();
      const failed = listView(page);
      check(`${name}: the first open shows "Loading requests…" while status=all is out, and when it fails, `
          + '"Could not load the requests: Network down" with a Try again button',
        loadingOnly(opening) && statusOf(firstCall) === 'all'
          && failed.error === 'Could not load the requests: Network down' && failed.tryAgain,
        `${said(opening)} then ${said(failed)}`);
      check(`  ${name}: and no rows, no "0 requests", no "No pending requests.": it cannot read as nothing to review`,
        errorOnly(failed), said(failed));

      // c. Try again repeats the same load; its rows replace the error.
      at = holdNext();
      let sent = net.calls.length;
      await clickIf(page, tryAgainButton(page));
      const retrying = listView(page);
      const retryCall = net.calls[sent];
      release(at, 200, { requests: MIXED(staff) });
      await page.settle();
      const retried = listView(page);
      check(`${name}: Try again asks for status=all again, shows the loading state, not the error, while it is out, `
          + 'then "2 pending requests" and both Pending rows',
        net.calls.length === sent + 1 && statusOf(retryCall) === 'all' && loadingOnly(retrying)
          && !retried.error && !retried.tryAgain && retried.heading === '2 pending requests'
          && retried.rows.join('|') === 'Ana Cruz|Ben Reyes',
        `${retryCall?.url ?? 'no request'} ${said(retrying)} then ${said(retried)}`);

      // d. Another status over loaded rows: its own rows at once, never the
      // old status's rows under the new name. A tab filters what is loaded,
      // so there is nothing to wait for and no request.
      sent = net.calls.length;
      await clickIf(page, tabNamed(page, 'Approved'));
      const switched = listView(page);
      check(`${name}: choosing the Approved tab over the two Pending rows sends no request and shows only its own row at `
          + 'once, "1 approved request", never the Pending rows under the new name',
        net.calls.length === sent && said(pressedTab(page)) === said(['Approved 1']) && !switched.loading
          && switched.heading === '1 approved request' && switched.rows.join('|') === 'Carla Santos' && !switched.error,
        `${net.calls.length - sent} request(s) ${said(switched)}`);

      // e. Refresh over loaded rows, failing: the loading state, then the
      // error, and never the old row or its count.
      at = holdNext();
      sent = net.calls.length;
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const refreshing = listView(page);
      const refreshCall = net.calls[sent];
      release(at, 500, { error: 'Internal server error' });
      await page.settle();
      const refreshFailed = listView(page);
      check(`${name}: Refresh asks for status=all, shows the loading state, not the old row, while it is out, and when it `
          + 'fails, "Could not load the requests: Internal server error", never the old row or "1 approved request"',
        statusOf(refreshCall) === 'all' && loadingOnly(refreshing)
          && refreshFailed.error === 'Could not load the requests: Internal server error' && errorOnly(refreshFailed),
        `${refreshCall?.url ?? 'no request'} ${said(refreshing)} then ${said(refreshFailed)}`);

      // f. Two loads out at once, Try again and then Refresh before it has
      // answered, the older answer last: it is dropped. The Approved tab
      // chosen before the failed Refresh is still the one shown.
      at = holdNext();
      await clickIf(page, tryAgainButton(page));
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      release(at + 1, 200, { requests: MIXED(staff) });
      await page.settle();
      release(at, 200, { requests: CLAIMED_TWO(staff) });
      await page.settle();
      const raced = listView(page);
      check(`${name}: an older answer that arrives last cannot replace the newer list: Approved keeps its one row`,
        statusOf(net.calls.at(-2)) === 'all' && statusOf(net.calls.at(-1)) === 'all'
          && said(pressedTab(page)) === said(['Approved 1']) && raced.heading === '1 approved request'
          && raced.rows.join('|') === 'Carla Santos' && !raced.error,
        said(raced));

      // g. The same, Refresh pressed twice, with the older load failing last.
      at = holdNext();
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const olderCall = net.calls.at(-2);
      release(at + 1, 200, { requests: MIXED(staff) });
      await page.settle();
      release(at, 500, { error: 'boom' });
      await page.settle();
      const racedFail = listView(page);
      check(`  ${name}: nor can an older load that fails last (Refresh pressed twice) put its error over the newer list`,
        statusOf(olderCall) === 'all' && statusOf(net.calls.at(-1)) === 'all'
          && said(pressedTab(page)) === said(['Approved 1']) && racedFail.heading === '1 approved request'
          && racedFail.rows.join('|') === 'Carla Santos' && !racedFail.error && !racedFail.tryAgain,
        `${olderCall?.url ?? 'no request'} ${said(racedFail)}`);

      // h. No requests, loaded successfully, is a real empty state: on the
      // Cancelled tab, Refresh answered with no requests at all.
      await clickIf(page, tabNamed(page, 'Cancelled'));
      at = holdNext();
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      release(at, 200, { requests: [] });
      await page.settle();
      const none = listView(page);
      check(`${name}: a successful load of no requests still says "0 cancelled requests" and "No cancelled requests.", `
          + 'with no error',
        none.heading === '0 cancelled requests' && /\bNo cancelled requests\./.test(spaced(root())) && !none.error
          && !none.tryAgain && !none.loading && none.rows.length === 0,
        said(none));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
    }

    // i. Why it failed, when the server sent no reason: Payments' wording.
    seedSession(VALID);
    resetNet(200);
    net.fail = true;
    let page = await globalThis.mountInteractive(root(), '/secretary/requests');
    await page.settle();
    const unreachable = listView(page);
    check('a server that cannot be reached gets the plain fallback, "Could not load the requests: the server did not respond"',
      unreachable.error === 'Could not load the requests: the server did not respond' && errorOnly(unreachable)
        && !/Cannot reach the server|Failed to fetch/.test(root().textContent), said(unreachable));
    methodsSent.push(...net.calls.map((c) => c.method));
    await page.unmount();

    seedSession(VALID);
    resetNet(502);
    page = await globalThis.mountInteractive(root(), '/secretary/requests');
    await page.settle();
    const bare = listView(page);
    check('  so does an error answer with no message in it, never "Request failed (502)"',
      bare.error === 'Could not load the requests: the server did not respond' && errorOnly(bare)
        && !/Request failed/.test(root().textContent), said(bare));
    methodsSent.push(...net.calls.map((c) => c.method));
    await page.unmount();
    check('section V sent nothing but GETs', methodsSent.length > 0 && methodsSent.every((m) => m === 'GET'),
      `${methodsSent.length} request(s): ${[...new Set(methodsSent)].join(', ')}`);

    if (previousTZV === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZV;
  }

  // =========================================================================
  // W. Document requests: status tabs with counts
  // =========================================================================
  // The list had one status select, opening on Pending: each choice sent a
  // new GET /document-requests?status=…, and nothing said how many requests
  // a status held until it was chosen. It now loads every request once, GET
  // ?status=all, and seven tabs filter that list in the browser with no
  // request: Pending, Approved, Ready for release, Claimed, Rejected,
  // Cancelled and All, each with its count. The counts come from the whole
  // list, so they read the same whichever tab is chosen; the heading above
  // the rows names the tab ("3 pending requests", "11 requests" on All); and
  // a tab with nothing in it shows the empty text the select's status did.
  // The page opens on Pending, as the select did, and keeps the chosen tab
  // through Refresh, Try again, Back from a request and a filed walk-in,
  // which load the list again exactly when they did before; a load that
  // fails shows no tabs, as Payments does. The strip is the Payments page's
  // own (.pay-tabs: toggle buttons with aria-pressed in a group, the count in
  // a pill, the dimmed empty tab, the faded ends and the chosen tab brought
  // into view), lifted into components/ListTabs.jsx. utils/requestList.js is
  // checked case by case, then the real page for the Secretary, Staff and the
  // Punong Barangay against eleven stubbed requests, then the strip on a
  // narrow phone, laid out by hand as in section S. Every request is answered
  // by the fetch stub; the only writes, the Secretary's approve and walk-in,
  // go to the stub too.
  console.log('\n--- Document requests: status tabs with counts ---');
  {
    const previousTZW = process.env.TZ;
    process.env.TZ = 'UTC';
    const R = globalThis.requestList || {};
    // A missing export or a throw becomes a value the check prints.
    const attempt = (f) => { try { return f(); } catch (e) { return `threw: ${e.message}`; } };
    const said = (v) => JSON.stringify(v);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const KEYS = ['pending', 'approved', 'ready_for_release', 'claimed', 'rejected', 'cancelled', 'all'];
    // Counts compared key by key, whatever order they were built in, and
    // with no key besides the seven.
    const sameCounts = (got, want) => !!got && typeof got === 'object'
      && said(Object.keys(got).sort()) === said([...KEYS].sort()) && KEYS.every((k) => got[k] === want[k]);
    const counts = (pending, approved, ready, claimed, rejected, cancelled, all) =>
      ({ pending, approved, ready_for_release: ready, claimed, rejected, cancelled, all });

    // a. The helpers on their own.
    const order = attempt(() => R.REQUEST_TABS.map((t) => `${t.key}:${t.label}`).join(' | '));
    check('tabs: Pending, Approved, Ready for release, Claimed, Rejected, Cancelled, All, in that order, each status with its own label',
      order === 'pending:Pending | approved:Approved | ready_for_release:Ready for release | claimed:Claimed | '
        + 'rejected:Rejected | cancelled:Cancelled | all:All', said(order));
    const req = (id, status) => ({ request_id: id, status });
    const NINE = [req(1, 'claimed'), req(2, 'pending'), req(3, 'approved'), req(4, 'pending'), req(5, 'rejected'),
      req(6, 'ready_for_release'), req(7, 'claimed'), req(8, 'pending'), req(9, 'approved')];
    let got = attempt(() => R.tabCounts(NINE));
    check('tab counts: one per status and All, over the whole list given: 3 pending, 2 approved, 1 ready for release, '
        + '2 claimed, 1 rejected, 0 cancelled, 9 in all',
      sameCounts(got, counts(3, 2, 1, 2, 1, 0, 9)), said(got));
    got = attempt(() => R.tabCounts([]));
    check('  an empty list counts 0 for every tab, never a missing count', sameCounts(got, counts(0, 0, 0, 0, 0, 0, 0)), said(got));
    got = attempt(() => R.tabCounts([req(1, 'pending'), req(2, 'archived')]));
    check('  a status outside the six counts under All only, never as a tab of its own',
      sameCounts(got, counts(1, 0, 0, 0, 0, 0, 2)), said(got));
    const inTab = (r, tab) => attempt(() => R.inTab(r, tab));
    const IN_TAB = [[req(1, 'claimed'), 'all', true], [req(2, 'archived'), 'all', true], [req(3, 'claimed'), 'claimed', true],
      [req(4, 'claimed'), 'pending', false], [req(5, 'ready_for_release'), 'ready_for_release', true], [req(6, 'pending'), 'approved', false]];
    check('inTab: All takes every request, a status tab only its own status',
      IN_TAB.every(([r, tab, want]) => inTab(r, tab) === want), said(IN_TAB.map(([r, tab]) => inTab(r, tab))));
    const HEADS = [['pending', 6, '6 pending requests'], ['pending', 1, '1 pending request'], ['pending', 0, '0 pending requests'],
      ['ready_for_release', 2, '2 ready for release requests'], ['cancelled', 0, '0 cancelled requests'],
      ['all', 77, '77 requests'], ['all', 1, '1 request'], ['all', 1234, '1,234 requests']];
    const heads = HEADS.map(([tab, n]) => attempt(() => R.tabHeading(tab, n)));
    check('the heading for a tab: "6 pending requests", "1 pending request", "0 pending requests", "2 ready for release requests", '
        + '"0 cancelled requests", and on All "77 requests", "1 request", "1,234 requests"',
      said(heads) === said(HEADS.map((h) => h[2])), said(heads));

    // b. The real page. Eleven requests in the list's real shape (as in
    // section V: Staff's carries no resident account and no requester email),
    // newest first as the server sends them, the statuses mixed so that a tab
    // keeping a wrong row, or its rows in the wrong order, shows it.
    const listRequest = (id, status, first, last, staff) => ({
      request_id: id, purpose: `Purpose ${id}`, status, requested_at: '2026-10-08T02:00:00+00:00',
      claimed_at: status === 'claimed' ? '2026-10-10T03:00:00+00:00' : null,
      rejection_reason: status === 'rejected' ? 'Incomplete requirements' : null,
      processed_at: status === 'pending' ? null : '2026-10-09T02:00:00+00:00',
      document_types: { document_type_id: 500 + id, name: 'Barangay Clearance', fee: '20.00' },
      resident_records: { resident_id: 800 + id, first_name: first, middle_name: null, last_name: last, suffix: null,
        ...(staff ? {} : { account: { username: `res_${id}` } }) },
      requester: { user_id: 700 + id, username: `res_${id}`, ...(staff ? {} : { email: `res_${id}@example.invalid` }) },
      charges: ['approved', 'ready_for_release', 'claimed'].includes(status)
        ? { charge_id: 900 + id, amount: '20.00', status: 'UNPAID', declared_method: null, declared_reference: null }
        : null,
    });
    const ELEVEN = [
      [301, 'pending', 'Ana', 'Cruz'], [302, 'approved', 'Ben', 'Reyes'], [303, 'claimed', 'Carla', 'Santos'],
      [304, 'pending', 'Dino', 'Tan'], [305, 'ready_for_release', 'Elsa', 'Uy'], [306, 'claimed', 'Fe', 'Villa'],
      [307, 'rejected', 'Gil', 'Wong'], [308, 'approved', 'Hana', 'Yap'], [309, 'claimed', 'Ivy', 'Zamora'],
      [310, 'pending', 'Jun', 'Abad'], [311, 'claimed', 'Kim', 'Bello'],
    ];
    // What each tab must show, written by hand: its rows, in the order sent,
    // and its heading.
    const WANT = {
      Pending: { rows: ['Ana Cruz', 'Dino Tan', 'Jun Abad'], heading: '3 pending requests' },
      Approved: { rows: ['Ben Reyes', 'Hana Yap'], heading: '2 approved requests' },
      'Ready for release': { rows: ['Elsa Uy'], heading: '1 ready for release request' },
      Claimed: { rows: ['Carla Santos', 'Fe Villa', 'Ivy Zamora', 'Kim Bello'], heading: '4 claimed requests' },
      Rejected: { rows: ['Gil Wong'], heading: '1 rejected request' },
      Cancelled: { rows: [], heading: '0 cancelled requests' },
      All: { rows: ['Ana Cruz', 'Ben Reyes', 'Carla Santos', 'Dino Tan', 'Elsa Uy', 'Fe Villa', 'Gil Wong', 'Hana Yap',
        'Ivy Zamora', 'Jun Abad', 'Kim Bello'], heading: '11 requests' },
    };
    const STRIP = 'Pending 3 · Approved 2 · Ready for release 1 · Claimed 4 · Rejected 1 · Cancelled 0 · All 11';
    // The requests the stub holds, which Refresh, the approve and the walk-in
    // change as the server would; the list answer is built from them.
    const makeState = () => ({ list: ELEVEN.map(([id, status, first, last]) => ({ id, status, first, last })) });
    const listAnswer = (state, staff) => ({ requests: state.list.map((r) => listRequest(r.id, r.status, r.first, r.last, staff)) });
    const ROSA = { resident_id: 912, first_name: 'Rosa', middle_name: null, last_name: 'Lim', suffix: null,
      birthdate: '1990-01-01', address: 'Purok 2, Ubujan' };
    // Every list URL gets the whole list, whatever status it names: the page
    // must ask for ?status=all, and the request checks say whether it did.
    const answerFor = (state, staff) => (url, method) => {
      if (method === 'GET' && /\/document-requests\?/.test(url)) return listAnswer(state, staff);
      const one = url.match(/\/document-requests\/(\d+)(\/approve)?$/);
      if (one) {
        const r = state.list.find((x) => x.id === Number(one[1]));
        if (!r) return undefined;
        if (method === 'POST' && one[2]) r.status = 'approved';
        const request = { ...listRequest(r.id, r.status, r.first, r.last, staff), processed_by: null };
        return one[2] ? { request, message: 'Request approved.' } : { request };
      }
      if (method === 'GET' && url.endsWith('/document-types')) {
        return { document_types: [{ document_type_id: 7, name: 'Barangay Clearance', fee: '20.00', description: null }] };
      }
      if (method === 'GET' && url.includes('/resident-records?search=')) return { records: [ROSA] };
      if (method === 'POST' && url.endsWith('/document-requests')) {
        state.list.unshift({ id: 312, status: 'pending', first: 'Rosa', last: 'Lim' });
        return { message: 'Request recorded for Rosa Lim.' };
      }
      return undefined;
    };
    const tabsOf = (page) => page.queryAll('.pay-tabs button');
    const tabNamed = (page, label) => tabsOf(page).find((b) => b.textContent.startsWith(`${label} `));
    // What the list says, read the way a person would.
    const look = (page) => ({
      heading: text(page.query('.list-head h2')),
      strip: tabsOf(page).map(text).join(' · '),
      pressed: page.queryAll('.pay-tabs button[aria-pressed="true"]').map(text),
      rows: page.queryAll('table.data-table tbody tr').map((tr) => text(tr.querySelector('strong'))),
      table: !!page.query('table.data-table'),
      empty: text(page.query('.empty')),
      error: page.queryAll('[role="alert"]').map(text).find((t) => t.startsWith('Could not load the requests')) ?? null,
      loading: root().textContent.includes('Loading requests…'),
    });
    // The requests a step sent to /document-requests, as "GET /document-requests?status=all".
    const listCalls = (calls) => calls.filter((c) => c.url.includes('/document-requests'))
      .map((c) => `${c.method} ${c.url.replace(/^.*\/api/, '')}`);
    const holdNext = () => {
      net.hold = true;
      return net.held.length;
    };
    const rowButton = (page, name, label) => {
      const tr = page.queryAll('table.data-table tbody tr').find((row) => text(row.querySelector('strong')) === name);
      return tr ? [...tr.querySelectorAll('button')].find((b) => b.textContent === label) ?? null : null;
    };
    // jsdom has no scrollIntoView; this one records what asked to be shown,
    // so a check can tell that the page itself was never scrolled.
    const scrolled = [];
    const proto = dom.window.HTMLElement.prototype;
    const previousScroll = proto.scrollIntoView;
    proto.scrollIntoView = function scrollIntoView(options) { scrolled.push({ el: this, options }); };
    const methodsSent = [];

    const ROLES = [
      { name: 'Secretary', route: '/secretary/requests', token: VALID, user: USER, staff: false, opener: 'Review', walkIn: true },
      { name: 'Staff', route: '/staff/requests', token: makeToken({ sub: '3', role: 'staff', exp: VALID_EXP }),
        user: { user_id: 3, username: 'staff1', role: 'staff', must_change_password: false },
        staff: true, opener: 'View', walkIn: false },
      { name: 'Punong Barangay', route: '/punong-barangay/requests',
        token: makeToken({ sub: '5', role: 'punong_barangay', exp: VALID_EXP }),
        user: { user_id: 5, username: 'pb_ubujan', role: 'punong_barangay', must_change_password: false },
        staff: false, opener: 'View', walkIn: false },
    ];
    for (const { name, route, token, user, staff, opener, walkIn } of ROLES) {
      const state = makeState();
      seedSession(token, user);
      resetNet(200, answerFor(state, staff));
      const page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      let v = look(page);
      const group = page.query('.pay-tabs');
      const buttons = tabsOf(page);
      check(`${name}: seven tabs in order, each with its count, "${STRIP}", toggle buttons in a group named "Status"`,
        v.strip === STRIP && group?.getAttribute('role') === 'group' && group.getAttribute('aria-label') === 'Status'
          && buttons.length === 7 && buttons.every((b) => b.type === 'button' && ['true', 'false'].includes(b.getAttribute('aria-pressed'))),
        said({ strip: v.strip, role: group?.getAttribute('role') ?? null, label: group?.getAttribute('aria-label') ?? null,
          pressed: buttons.map((b) => b.getAttribute('aria-pressed')) }));
      check(`${name}: it opens on Pending, as the status select did: Pending alone pressed, "3 pending requests", and the three `
          + 'pending rows in the order sent',
        said(v.pressed) === said(['Pending 3']) && v.heading === WANT.Pending.heading && said(v.rows) === said(WANT.Pending.rows),
        said(v));
      check(`${name}: exactly one request on open, GET /document-requests?status=all`,
        net.calls.length === 1 && said(listCalls(net.calls)) === said(['GET /document-requests?status=all']),
        said(net.calls.map((c) => `${c.method} ${c.url}`)));

      // Every tab in turn, as a person presses them.
      const sentBefore = net.calls.length;
      const seen = {};
      const missing = [];
      for (const label of Object.keys(WANT)) {
        const tab = tabNamed(page, label);
        if (!tab) missing.push(label);
        await clickIf(page, tab);
        seen[label] = look(page);
      }
      check(`${name}: pressing each of the seven tabs in turn sends no request`,
        missing.length === 0 && net.calls.length === sentBefore,
        said({ missing, sent: net.calls.slice(sentBefore).map((c) => `${c.method} ${c.url}`) }));
      const wrongTabs = Object.keys(WANT).filter((label) => label !== 'All').filter((label) => {
        const s = seen[label];
        return !(said(s.rows) === said(WANT[label].rows) && s.heading === WANT[label].heading
          && s.pressed.length === 1 && s.pressed[0].startsWith(`${label} `));
      });
      check(`${name}: each status tab shows only its own requests, in the order sent, under its own heading, and is the one pressed`,
        wrongTabs.length === 0, said(wrongTabs.map((label) => ({ tab: label, ...seen[label] }))));
      check(`${name}: All shows every request, all eleven in the order sent, under "11 requests"`,
        said(seen.All.rows) === said(WANT.All.rows) && seen.All.heading === WANT.All.heading
          && said(seen.All.pressed) === said(['All 11']), said(seen.All));
      const strips = [...new Set(Object.values(seen).map((s) => s.strip))];
      check(`${name}: the counts are the whole list's, and read the same on every tab`, said(strips) === said([STRIP]), said(strips));
      const dimmed = tabsOf(page).filter((b) => b.classList.contains('pay-tab-empty'));
      check(`${name}: Cancelled, with none, is the one tab dimmed, still a button; pressed, it shows "0 cancelled requests" and `
          + 'the empty text the select showed, "No cancelled requests.", with no table',
        said(dimmed.map(text)) === said(['Cancelled 0']) && dimmed[0].disabled === false
          && said(seen.Cancelled.pressed) === said(['Cancelled 0']) && seen.Cancelled.heading === '0 cancelled requests'
          && seen.Cancelled.empty === 'No cancelled requests.' && !seen.Cancelled.table,
        said({ dimmed: dimmed.map(text), cancelled: seen.Cancelled }));

      // Refresh on Claimed, after a fifth claimed request has arrived. The
      // answer is held, so the page can be read while it is out.
      await clickIf(page, tabNamed(page, 'Claimed'));
      state.list.push({ id: 299, status: 'claimed', first: 'Lito', last: 'Gomez' });
      const STRIP12 = 'Pending 3 · Approved 2 · Ready for release 1 · Claimed 5 · Rejected 1 · Cancelled 0 · All 12';
      let at = holdNext();
      let sent = net.calls.length;
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const reloading = look(page);
      const refreshCall = net.calls[sent];
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      v = look(page);
      check(`${name}: Refresh loads the list again, once, GET ?status=all, with no tabs while it is out, and keeps Claimed: `
          + '"5 claimed requests" with the new count',
        net.calls.length === sent + 1 && said(listCalls([refreshCall].filter(Boolean))) === said(['GET /document-requests?status=all'])
          && reloading.strip === '' && reloading.loading
          && said(v.pressed) === said(['Claimed 5']) && v.heading === '5 claimed requests'
          && said(v.rows) === said([...WANT.Claimed.rows, 'Lito Gomez']) && v.strip === STRIP12,
        said({ reloading, v }));

      // A reload that fails: no tabs, as on Payments; then Try again.
      const hadTabs = tabsOf(page).length === 7;
      at = holdNext();
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      release(at, 500, { error: 'Network down' });
      await page.settle();
      v = look(page);
      check(`${name}: a load that fails takes the tabs away: the error and Try again under the heading "Document requests", `
          + 'with no strip, no rows and no empty text',
        hadTabs && !page.query('.pay-tabs') && v.heading === 'Document requests'
          && v.error === 'Could not load the requests: Network down'
          && !!tryAgainButton(page) && v.rows.length === 0 && !v.table && v.empty === null,
        said({ hadTabs, v }));
      at = holdNext();
      await clickIf(page, tryAgainButton(page));
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      v = look(page);
      check(`  ${name}: Try again brings the tabs back, still on Claimed`,
        said(v.pressed) === said(['Claimed 5']) && v.strip === STRIP12 && v.heading === '5 claimed requests' && !v.error,
        said(v));

      // Back from a request's detail, with nothing done there.
      await clickIf(page, tabNamed(page, 'Approved'));
      sent = net.calls.length;
      await clickIf(page, rowButton(page, 'Ben Reyes', opener));
      const opened = text(page.query('.pending-card h3'));
      await clickIf(page, buttonNamed(root(), '← Back to list'));
      v = look(page);
      check(`${name}: Back from a request's detail, with nothing done there, keeps Approved and does not load the list again `
          + '(the one request is the detail\'s own)',
        opened === 'Request #302' && said(v.pressed) === said(['Approved 2']) && said(v.rows) === said(WANT.Approved.rows)
          && said(listCalls(net.calls.slice(sent))) === said(['GET /document-requests/302']),
        said({ opened, v, calls: listCalls(net.calls.slice(sent)) }));

      if (walkIn) {
        // Back after approving: the list loads again, as it did, and the tab
        // stays. The approve goes to the stub.
        await clickIf(page, tabNamed(page, 'Pending'));
        await clickIf(page, rowButton(page, 'Ana Cruz', 'Review'));
        sent = net.calls.length;
        await clickIf(page, buttonNamed(root(), 'Approve request'));
        const approved = text(page.query('.pending-card .alert.success'));
        await clickIf(page, buttonNamed(root(), '← Back to list'));
        v = look(page);
        check('Secretary: Back after approving a request loads the list again, once, and keeps Pending, whose count drops: '
            + 'Ana Cruz has moved to Approved',
          approved === 'Request approved.'
            && said(listCalls(net.calls.slice(sent))) === said(['POST /document-requests/301/approve', 'GET /document-requests?status=all'])
            && said(v.pressed) === said(['Pending 2']) && said(v.rows) === said(['Dino Tan', 'Jun Abad'])
            && v.strip === 'Pending 2 · Approved 3 · Ready for release 1 · Claimed 5 · Rejected 1 · Cancelled 0 · All 12',
          said({ approved, calls: listCalls(net.calls.slice(sent)), v }));

        // Encode walk-in, left without filing: the list is not loaded again.
        await clickIf(page, tabNamed(page, 'Approved'));
        sent = net.calls.length;
        await clickIf(page, buttonNamed(root(), 'Encode walk-in'));
        const panel = text(page.query('.pending-card h3'));
        await clickIf(page, buttonNamed(root(), '← Back to list'));
        v = look(page);
        check('Secretary: Encode walk-in, then Back to list without filing, keeps Approved and does not load the list again',
          panel === 'Encode walk-in request' && said(v.pressed) === said(['Approved 3'])
            && listCalls(net.calls.slice(sent)).length === 0,
          said({ panel, v, calls: net.calls.slice(sent).map((c) => `${c.method} ${c.url}`) }));

        // Filing one: the list loads again, once, and the tab stays. The
        // resident picker searches 300ms after the last keystroke.
        sent = net.calls.length;
        await clickIf(page, buttonNamed(root(), 'Encode walk-in'));
        if (page.query('.pending-card input')) await page.fill('.pending-card input', 'Lim');
        await new Promise((resolve) => setTimeout(resolve, 350));
        await page.settle();
        await clickIf(page, page.query('.picker-option'));
        const typeSelect = page.query('select[name="document_type_id"]');
        if (typeSelect) {
          typeSelect.value = '7';
          typeSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        }
        await page.settle();
        const purpose = page.query('textarea[name="purpose"]');
        if (purpose) {
          Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(purpose, 'Scholarship');
          purpose.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
        await page.settle();
        if (page.query('.pending-card form')) await page.submit();
        await page.settle();
        v = look(page);
        const filed = text(page.query('.alert.success'));
        const posted = net.calls.slice(sent).find((c) => c.method === 'POST');
        check('Secretary: filing a walk-in loads the list again, once, and keeps Approved; the new request is counted under Pending',
          filed === 'Request recorded for Rosa Lim.'
            && said(listCalls(net.calls.slice(sent))) === said(['POST /document-requests', 'GET /document-requests?status=all'])
            && /"resident_id":912/.test(String(posted?.body)) && said(v.pressed) === said(['Approved 3'])
            && v.strip === 'Pending 3 · Approved 3 · Ready for release 1 · Claimed 5 · Rejected 1 · Cancelled 0 · All 13',
          said({ filed, calls: listCalls(net.calls.slice(sent)), body: posted?.body ?? null, v }));
      }
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
    }

    // c. The strip on a narrow phone, as the Secretary. Where the seven tabs
    // do not fit, the strip scrolls inside itself and fades the edge that has
    // tabs past it (data-fade: "start", "end" or "start end", absent while
    // they fit); a tab chosen, or focused, while part of it is out of view is
    // brought fully into view, clear of the fade, by moving the strip and
    // never the page. jsdom lays nothing out, so the strip is laid out by
    // hand: 300px holding 746px of tabs, 96, 112, 166, 98, 102, 110 and 62
    // wide. Drawing the fade is index.css's, and the layout harness's to see.
    {
      const FADE = 24; // the width of the faded edge in index.css
      const WIDTHS = [96, 112, 166, 98, 102, 110, 62];
      const MAX = WIDTHS.reduce((a, b) => a + b, 0) - 300; // 446, the strip's furthest scroll
      seedSession(VALID);
      resetNet(200, answerFor(makeState(), false));
      const page = await globalThis.mountInteractive(root(), '/secretary/requests');
      await page.settle();
      const strip = () => page.query('.pay-tabs');
      const fade = () => strip()?.getAttribute('data-fade') ?? null;
      const pressed = () => page.queryAll('.pay-tabs button[aria-pressed="true"]').map(text);
      // The strip's client and scroll widths, a scrollLeft held within them as
      // a browser holds it, and each tab's box from where it sits.
      const layOut = (clientWidth, widths = WIDTHS) => {
        const s = strip();
        if (!s) return;
        const lefts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
        const scrollWidth = Math.max(widths.reduce((a, b) => a + b, 0), clientWidth);
        let left = 0;
        const rect = (l, r) => ({ left: l, right: r, top: 0, bottom: 40, width: r - l, height: 40, x: l, y: 0 });
        Object.defineProperty(s, 'clientWidth', { configurable: true, get: () => clientWidth });
        Object.defineProperty(s, 'scrollWidth', { configurable: true, get: () => scrollWidth });
        Object.defineProperty(s, 'scrollLeft', {
          configurable: true, get: () => left, set: (x) => { left = Math.max(0, Math.min(Number(x) || 0, scrollWidth - clientWidth)); },
        });
        s.getBoundingClientRect = () => rect(0, clientWidth);
        [...s.querySelectorAll('.pay-tab')].forEach((b, i) => {
          b.getBoundingClientRect = () => rect(lefts[i] - left, lefts[i] + widths[i] - left);
        });
      };
      // The strip moved by hand, and the scroll event a browser then sends.
      const scrollStripTo = async (x) => {
        if (!strip()) return;
        strip().scrollLeft = x;
        strip().dispatchEvent(new dom.window.Event('scroll'));
        await page.settle();
      };
      const tabBox = (label) => {
        const b = tabNamed(page, label)?.getBoundingClientRect();
        return b ? { left: b.left, right: b.right } : null;
      };

      const fitting = fade();
      layOut(300);
      dom.window.dispatchEvent(new dom.window.Event('resize'));
      await page.settle();
      check('narrow phone: the tabs mark no edge while they fit, and "end" once the strip is narrower than they are (here on a resize)',
        !!strip() && fitting === null && fade() === 'end', said({ fitting, narrow: fade() }));
      const marks = [];
      for (const x of [200, MAX, 0]) {
        await scrollStripTo(x);
        marks.push(fade());
      }
      check('  scrolling the strip moves the mark: "start end" partway, "start" at its end, "end" back at the start',
        said(marks) === said(['start end', 'start', 'end']), said(marks));

      const scrollsBefore = scrolled.length;
      await clickIf(page, tabNamed(page, 'Ready for release'));
      const ready = { at: strip()?.scrollLeft ?? null, box: tabBox('Ready for release'), fade: fade(), pressed: pressed() };
      check('  choosing a tab partly out of view scrolls the strip until all of it shows, clear of the faded edges: '
          + 'Ready for release, and the page itself does not scroll',
        ready.at > 0 && !!ready.box && ready.box.left >= FADE && ready.box.right <= 300 - FADE && ready.fade === 'start end'
          && said(ready.pressed) === said(['Ready for release 1']) && scrolled.length === scrollsBefore,
        said({ ready, pageScrolls: scrolled.length - scrollsBefore }));
      await clickIf(page, tabNamed(page, 'All'));
      const last = { at: strip()?.scrollLeft ?? null, box: tabBox('All'), fade: fade() };
      await clickIf(page, tabNamed(page, 'Pending'));
      const first = { at: strip()?.scrollLeft ?? null, box: tabBox('Pending'), fade: fade() };
      check('  All, the last, scrolls it to its end, where nothing is past it and that edge is not faded; Pending, the '
          + 'first, back to its start',
        last.at === MAX && !!last.box && last.box.right <= 300 && last.fade === 'start'
          && first.at === 0 && first.box?.left === 0 && first.fade === 'end' && scrolled.length === scrollsBefore,
        said({ last, first }));
      // A browser scrolls a focused element into view only when none of it
      // shows (measured in Chrome 155, section S).
      tabNamed(page, 'Ready for release')?.focus();
      await page.settle();
      const focused = { at: strip()?.scrollLeft ?? null, box: tabBox('Ready for release'), pressed: pressed() };
      check('  a tab that takes keyboard focus while partly out of view is brought fully into view too, without being chosen',
        page.active() === tabNamed(page, 'Ready for release') && focused.at > 0 && !!focused.box && focused.box.left >= FADE
          && focused.box.right <= 300 - FADE && said(focused.pressed) === said(['Pending 3']), said(focused));
      layOut(800);
      await clickIf(page, tabNamed(page, 'Approved'));
      const widened = fade();
      layOut(300);
      await clickIf(page, tabNamed(page, 'Pending'));
      check('  the mark follows the strip after any render, not only a scroll or a resize: widened to fit, a tab press drops '
          + 'it; narrowed again, the next press brings "end" back',
        widened === null && fade() === 'end', said({ widened, narrowed: fade() }));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
    }

    const writes = methodsSent.filter((m) => m !== 'GET');
    check('section W sent GETs, and two POSTs, the Secretary\'s approve and walk-in, both answered by the fetch stub',
      methodsSent.length > 0 && said(writes) === said(['POST', 'POST']),
      `${methodsSent.length} request(s): ${[...new Set(methodsSent)].join(', ')}`);

    if (previousScroll === undefined) delete proto.scrollIntoView;
    else proto.scrollIntoView = previousScroll;
    if (previousTZW === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZW;
  }

  // =========================================================================
  // X. Document requests: the search box
  // =========================================================================
  // The Document requests list gains the Payments page's search box, lifted
  // into components/ListToolbar.jsx: the same look, name pattern, Clear (x)
  // button and Escape, and no browser autocomplete. It has a row of its own,
  // under the row that holds the heading and Refresh and over the status
  // tabs, and like the tabs it is drawn only once the list has loaded. It
  // filters the list already loaded, as you type, with no request, using
  // utils/chargeSearch.js's normalise, searchTerms and matchesTerms as they
  // are, over what utils/requestList.js says a row shows of who and what: the
  // requester's name, the resident's @account where the row shows one, and
  // the document type. Never the purpose, the rejection reason, an email, a
  // status word, a walk-in's filer or the request number; and for Staff,
  // whose rows show no account, no account at all, although their payload
  // still carries the filer's username. The search runs over the whole list
  // and the tabs split what matches: their counts follow it, the chosen tab
  // stays, and while a search is on the heading reads "N of M <tab> requests
  // match". It lives through Refresh, Try again and Back from a request, and
  // is kept nowhere in the browser. The helpers are checked case by case,
  // then the real page for the Secretary, Staff and the Punong Barangay
  // against ten stubbed requests. Every request is answered by the fetch
  // stub; the only write, the Secretary's approve, goes to it too.
  console.log('\n--- Document requests: the search box ---');
  {
    const previousTZX = process.env.TZ;
    process.env.TZ = 'UTC';
    const R = globalThis.requestList || {};
    const CS = globalThis.chargeSearch || {};
    // A missing export or a throw becomes a value the check prints.
    const attempt = (f) => { try { return f(); } catch (e) { return `threw: ${e.message}`; } };
    const said = (v) => JSON.stringify(v);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

    // Ten requests in the list's real shape (SECRETARY_LIST_FIELDS in
    // routes/documentRequests.js; Staff's drops what STAFF_LIST_FIELDS
    // withholds, the resident's account and the requester's email, and keeps
    // the requester's username). The purposes, the rejection reason and the
    // emails read like real ones, so a search that reached them would find
    // something. 405 and 410 are walk-ins filed by secretary1; 405's resident
    // has no online account. No request is cancelled.
    //   id, status, [first, middle, last, suffix], document type,
    //   the resident's account (null: none), the filer, purpose, rejection reason
    const SEARCH_LIST = [
      [401, 'pending', ['Juan', 'Miguel', 'Dela Cruz', null], 'Barangay Clearance', 'jmdc_1990', 'jmdc_1990',
        'Employment requirement', null],
      [402, 'pending', ['Maria', 'Elena', 'Santos', null], 'Certificate of Residency', 'msantos_88', 'msantos_88',
        'Scholarship application', null],
      [403, 'approved', ['Niño', null, 'Peñaflor', null], 'Certificate of Indigency', 'ninop', 'ninop', 'Medical assistance', null],
      [404, 'approved', ['Pedro', null, 'Dela Cruz', 'Jr.'], 'Barangay Clearance', 'pdc_2001', 'pdc_2001', 'Bank account opening', null],
      [405, 'ready_for_release', ['Rosa', null, 'Lim', null], 'Business Clearance', null, 'secretary1', 'Sari-sari store permit', null],
      [406, 'claimed', ['Ana', null, 'Cruz', null], 'Barangay ID', 'anacruz', 'anacruz', 'Valid ID for SSS', null],
      [407, 'rejected', ['Gil', null, 'Wong', null], 'First-time jobseeker', 'gwong', 'gwong', 'First job application',
        'Incomplete requirements: no birth certificate'],
      [408, 'claimed', ['Lito', null, 'Ramos', null], 'Certificate of Residency', 'lramos', 'lramos', 'School enrollment', null],
      [409, 'pending', ['Kim', null, 'Bello', null], 'Barangay Clearance', 'kbello', 'kbello', 'Police clearance requirement', null],
      [410, 'approved', ['Elsa', null, 'Uy', null], 'Certificate of Residency', 'elsa_uy', 'secretary1', 'Travel abroad', null],
    ];
    const asRequest = ([id, status, [first, middle, last, suffix], documentType, account, filer, purpose, rejection], staff) => ({
      request_id: id, purpose, status, requested_at: '2026-10-08T02:00:00+00:00',
      claimed_at: status === 'claimed' ? '2026-10-10T03:00:00+00:00' : null,
      rejection_reason: rejection, processed_at: status === 'pending' ? null : '2026-10-09T02:00:00+00:00',
      document_types: { document_type_id: 500 + id, name: documentType, fee: '20.00' },
      resident_records: { resident_id: 800 + id, first_name: first, middle_name: middle, last_name: last, suffix,
        ...(staff ? {} : { account: account ? { username: account } : null }) },
      requester: { user_id: filer === 'secretary1' ? 1 : 700 + id, username: filer,
        ...(staff ? {} : { email: `${filer}@example.invalid` }) },
      charges: ['approved', 'ready_for_release', 'claimed'].includes(status)
        ? { charge_id: 900 + id, amount: '20.00', status: 'UNPAID', declared_method: null, declared_reference: null }
        : null,
    });
    const SECRETARY_LIST = SEARCH_LIST.map((row) => asRequest(row, false));
    const STAFF_LIST = SEARCH_LIST.map((row) => asRequest(row, true));
    const IDS = SEARCH_LIST.map((row) => row[0]);

    // a. utils/chargeSearch.js's three, as the page uses them, unchanged.
    const normalised = ['Peñaflor', 'NIÑO', 'Dela Cruz'].map((s) => attempt(() => CS.normalise(s)));
    check('chargeSearch.normalise, as it is: lower case with the accents taken off: "Peñaflor" → "penaflor", "NIÑO" → "nino", '
        + '"Dela Cruz" → "dela cruz"',
      said(normalised) === said(['penaflor', 'nino', 'dela cruz']), said(normalised));
    const termsOf = ['  JUAN   dela  ', '', '   '].map((s) => attempt(() => CS.searchTerms(s)));
    check('  searchTerms: the words, normalised, extra spaces dropped: "  JUAN   dela  " → ["juan","dela"]; a blank search, '
        + 'or one of spaces only, has no words',
      said(termsOf) === said([['juan', 'dela'], [], []]), said(termsOf));
    const hits = [
      ['juan dela cruz', ['cruz', 'juan']], ['juan dela cruz', ['juan', 'santos']], ['juan dela cruz', ['cru']], ['juan dela cruz', []],
    ].map(([t, terms]) => attempt(() => CS.matchesTerms(t, terms)));
    check('  matchesTerms: every word must be in the text, in any order, and one missing word fails it; a word matches '
        + 'part of a word ("cru" finds "cruz"); no words match everything',
      said(hits) === said([true, false, true, true]), said(hits));

    // b. utils/requestList.js: what a request's search reads, and the words
    // around a search.
    const parts = (r) => attempt(() => R.searchParts(r));
    let got = parts(SECRETARY_LIST[0]);
    check('searchParts, a Secretary or Punong Barangay row: the name as the row shows it, the @account the row shows under '
        + 'it, and the document type: "Juan Miguel Dela Cruz", "@jmdc_1990", "Barangay Clearance"',
      said(got) === said(['Juan Miguel Dela Cruz', '@jmdc_1990', 'Barangay Clearance']), said(got));
    got = parts(STAFF_LIST[0]);
    check('  a Staff row shows no account, so its text has none, although the request still carries the filer\'s username, '
        + '"jmdc_1990", which is the resident\'s own account here',
      said(got) === said(['Juan Miguel Dela Cruz', 'Barangay Clearance']) && STAFF_LIST[0].requester.username === 'jmdc_1990',
      said(got));
    got = [SECRETARY_LIST[4], SECRETARY_LIST[9], SECRETARY_LIST[3]].map(parts);
    check('  a walk-in reads its resident, never its filer: Rosa Lim, with no online account, has no handle and no '
        + '"secretary1"; Elsa Uy has her own "@elsa_uy"; and a suffix reads as the row shows it, "Pedro Dela Cruz, Jr."',
      said(got) === said([['Rosa Lim', 'Business Clearance'], ['Elsa Uy', '@elsa_uy', 'Certificate of Residency'],
        ['Pedro Dela Cruz, Jr.', '@pdc_2001', 'Barangay Clearance']]), said(got));
    got = parts({ ...SECRETARY_LIST[0], resident_records: null, requester: { user_id: 9, username: 'filer_9' } });
    check('  a request with no resident name reads what its row shows in its place, the filer\'s "@filer_9"',
      said(got) === said(['@filer_9', 'Barangay Clearance']), said(got));
    // Nothing else a request carries reaches its text.
    const leaks = [...SECRETARY_LIST, ...STAFF_LIST].flatMap((r) => {
      const all = attempt(() => R.searchParts(r).join('\n'));
      if (typeof all !== 'string' || all.startsWith('threw')) return [`${r.request_id}: ${all}`];
      return [r.purpose, r.rejection_reason, r.requester.email, r.status, String(r.request_id), 'online']
        .filter(Boolean).filter((s) => all.toLowerCase().includes(s.toLowerCase())).map((s) => `${r.request_id}: ${s}`);
    });
    check('  no request\'s text holds its purpose, rejection reason, email, status, request number or the "No online account" '
        + 'note, in either projection', leaks.length === 0, said(leaks));
    const matchedIds = (list, query) => attempt(() => R.matchingRequests(list, query).map((r) => r.request_id));
    got = {
      blank: matchedIds(SECRETARY_LIST, ''), spaces: matchedIds(SECRETARY_LIST, '   '), nino: matchedIds(SECRETARY_LIST, 'NIÑO'),
      words: matchedIds(SECRETARY_LIST, 'clearance  DELA'), secretary: matchedIds(SECRETARY_LIST, 'msantos'),
      staff: matchedIds(STAFF_LIST, 'msantos'),
    };
    check('matchingRequests: a blank search, or spaces only, keeps all ten in the order sent; "NIÑO" finds 403; "clearance  DELA" '
        + '401 and 404; "msantos" finds 402 on the Secretary\'s list and nothing on Staff\'s',
      said(got) === said({ blank: IDS, spaces: IDS, nino: [403], words: [401, 404], secretary: [402], staff: [] }), said(got));
    const HEADS = [
      ['pending', 1, 3, '1 of 3 pending requests matches'], ['pending', 2, 3, '2 of 3 pending requests match'],
      ['pending', 0, 3, '0 of 3 pending requests match'], ['ready_for_release', 0, 1, '0 of 1 ready for release request match'],
      ['cancelled', 0, 0, '0 of 0 cancelled requests match'], ['all', 12, 77, '12 of 77 requests match'],
      ['all', 1, 1, '1 of 1 request matches'], ['all', 1234, 2345, '1,234 of 2,345 requests match'],
    ];
    const heads = HEADS.map(([tab, n, m]) => attempt(() => R.searchHeading(tab, n, m)));
    check('searchHeading, the Payments totals line\'s words for the tab: "1 of 3 pending requests matches", "2 of 3 pending '
        + 'requests match", "0 of 1 ready for release request match", "12 of 77 requests match" on All, "1,234 of 2,345"',
      said(heads) === said(HEADS.map((h) => h[3])), said(heads));
    const NONE = [
      ['pending', 'zzz', 'No pending requests match "zzz"'], ['all', 'zzz', 'No requests match "zzz"'],
      ['ready_for_release', '  Dela   CRUZ ', 'No ready for release requests match "Dela CRUZ"'],
    ];
    const nones = NONE.map(([tab, q]) => attempt(() => R.noMatchText(tab, q)));
    check('noMatchText names the tab, as the empty text without a search does, and quotes the search as typed, spaces '
        + 'tidied: \'No pending requests match "zzz"\', on All \'No requests match "zzz"\'',
      said(nones) === said(NONE.map((n) => n[2])), said(nones));
    const holders = [SECRETARY_LIST, STAFF_LIST, []].map((list) => attempt(() => R.searchPlaceholder(list)));
    check('searchPlaceholder promises an account only where the rows carry one: "Search name, account or document" for '
        + 'the Secretary\'s list, "Search name or document" for Staff\'s and for an empty list',
      said(holders) === said(['Search name, account or document', 'Search name or document', 'Search name or document']),
      said(holders));

    // c. The real page, for the three roles.
    const makeState = () => ({ rows: SEARCH_LIST.map((row) => [...row]) });
    const listAnswer = (state, staff) => ({ requests: state.rows.map((row) => asRequest(row, staff)) });
    const answerFor = (state, staff) => (url, method) => {
      if (method === 'GET' && /\/document-requests\?/.test(url)) return listAnswer(state, staff);
      const one = url.match(/\/document-requests\/(\d+)(\/approve)?$/);
      if (one) {
        const row = state.rows.find((x) => x[0] === Number(one[1]));
        if (!row) return undefined;
        if (method === 'POST' && one[2]) row[1] = 'approved';
        const request = { ...asRequest(row, staff), processed_by: null };
        return one[2] ? { request, message: 'Request approved.' } : { request };
      }
      return undefined;
    };
    const SEARCH_BOX = 'input[aria-label="Search requests"]';
    const box = (page) => page.query(SEARCH_BOX);
    const xButton = (page) => page.query('button[aria-label="Clear search"]');
    // Typed the way a keystroke types (the native setter and an input event);
    // with no box on screen, nothing is typed.
    const type = async (page, value) => { if (box(page)) await page.fill(SEARCH_BOX, value); };
    const tabsOf = (page) => page.queryAll('.pay-tabs button');
    const tabNamed = (page, label) => tabsOf(page).find((b) => b.textContent.startsWith(`${label} `));
    const emptyClear = (page) => (page.query('.empty') ? buttonNamed(page.query('.empty'), 'Clear search') ?? null : null);
    // What the list says, read the way a person would.
    const look = (page) => ({
      heading: text(page.query('.list-head h2')),
      search: box(page)?.value ?? null,
      strip: tabsOf(page).map(text).join(' · '),
      pressed: page.queryAll('.pay-tabs button[aria-pressed="true"]').map(text),
      dimmed: tabsOf(page).filter((b) => b.classList.contains('pay-tab-empty')).map(text),
      rows: page.queryAll('table.data-table tbody tr').map((tr) => text(tr.querySelector('strong'))),
      empty: text(page.query('.empty p')),
      clearSearch: !!emptyClear(page),
      error: page.queryAll('[role="alert"]').map(text).find((t) => t.startsWith('Could not load the requests')) ?? null,
      loading: root().textContent.includes('Loading requests…'),
    });
    const listCalls = (calls) => calls.filter((c) => c.url.includes('/document-requests'))
      .map((c) => `${c.method} ${c.url.replace(/^.*\/api/, '')}`);
    const holdNext = () => {
      net.hold = true;
      return net.held.length;
    };
    const rowButton = (page, rowName, label) => {
      const tr = page.queryAll('table.data-table tbody tr').find((row) => text(row.querySelector('strong')) === rowName);
      return tr ? [...tr.querySelectorAll('button')].find((b) => b.textContent === label) ?? null : null;
    };
    const noteOf = (page, rowName) => {
      const tr = page.queryAll('table.data-table tbody tr').find((row) => text(row.querySelector('strong')) === rowName);
      return tr ? (text(tr.querySelector('.small-note')) ?? '(no note)') : null;
    };
    const follows = (a, b) => !!a && !!b && !!(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    const STRIP10 = 'Pending 3 · Approved 3 · Ready for release 1 · Claimed 2 · Rejected 1 · Cancelled 0 · All 10';
    const PENDING3 = ['Juan Miguel Dela Cruz', 'Maria Elena Santos', 'Kim Bello'];
    const methodsSent = [];

    const ROLES = [
      { name: 'Secretary', route: '/secretary/requests', token: VALID, user: USER, staff: false, opener: 'Review', walkIn: true },
      { name: 'Staff', route: '/staff/requests', token: makeToken({ sub: '3', role: 'staff', exp: VALID_EXP }),
        user: { user_id: 3, username: 'staff1', role: 'staff', must_change_password: false },
        staff: true, opener: 'View', walkIn: false },
      { name: 'Punong Barangay', route: '/punong-barangay/requests',
        token: makeToken({ sub: '5', role: 'punong_barangay', exp: VALID_EXP }),
        user: { user_id: 5, username: 'pb_ubujan', role: 'punong_barangay', must_change_password: false },
        staff: false, opener: 'View', walkIn: false },
    ];
    for (const { name, route, token, user, staff, opener, walkIn } of ROLES) {
      const state = makeState();
      seedSession(token, user);
      resetNet(200, answerFor(state, staff));
      // The first open, held, then failing; then Try again.
      let at = holdNext();
      const page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      const opening = { box: !!box(page), strip: !!page.query('.pay-tabs'), loading: look(page).loading };
      release(at, 500, { error: 'Network down' });
      await page.settle();
      const failedOpen = { box: !!box(page), strip: !!page.query('.pay-tabs'), error: look(page).error };
      at = holdNext();
      await clickIf(page, tryAgainButton(page));
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      check(`${name}: like the tabs, the search box is not drawn while the list loads or after a load fails: no box under `
          + '"Loading requests…", none beside the error, and Try again brings it back with the tabs',
        !opening.box && !opening.strip && opening.loading && !failedOpen.box && !failedOpen.strip
          && failedOpen.error === 'Could not load the requests: Network down' && !!box(page) && !!page.query('.pay-tabs'),
        said({ opening, failedOpen, after: { box: !!box(page), strip: !!page.query('.pay-tabs') } }));

      const input = box(page);
      const wrapper = input?.closest('[role="search"]') ?? null;
      const icon = wrapper?.querySelector('svg') ?? null;
      const headRow = page.query('.doc-requests-head');
      const toolbar = input?.closest('.list-head') ?? null;
      const PLACEHOLDER = staff ? 'Search name or document' : 'Search name, account or document';
      check(`${name}: the box is the Payments one: type="search" in a role="search" wrapper, named "Search requests", reading `
          + `"${PLACEHOLDER}", no browser autocomplete or spellcheck, its icon hidden from screen readers, empty, no Clear (x)`,
        input?.type === 'search' && !!wrapper && input.getAttribute('aria-label') === 'Search requests'
          && input.getAttribute('placeholder') === PLACEHOLDER && input.getAttribute('autocomplete') === 'off'
          && input.getAttribute('spellcheck') === 'false' && icon?.getAttribute('aria-hidden') === 'true'
          && input.value === '' && !xButton(page),
        said({ type: input?.type ?? null, label: input?.getAttribute('aria-label') ?? null,
          placeholder: input?.getAttribute('placeholder') ?? null, autocomplete: input?.getAttribute('autocomplete') ?? null,
          spellcheck: input?.getAttribute('spellcheck') ?? null, icon: icon?.getAttribute('aria-hidden') ?? null, x: !!xButton(page) }));
      check(`${name}: it has a row of its own, under the row with the heading and Refresh and over the tabs, and is no form`,
        !!toolbar && !!headRow && toolbar !== headRow && follows(headRow, toolbar) && follows(toolbar, page.query('.pay-tabs'))
          && !input.closest('form'),
        said({ toolbar: toolbar?.className ?? null, head: headRow?.className ?? null }));
      // The heading says how many match, as the Payments totals line does,
      // and like it is a polite live region, so a screen reader hears the
      // count change as the search is typed.
      const liveHeading = headRow?.querySelector('h2');
      check(`${name}: the heading is a polite live region, as the Payments totals line is, so the count is heard as you type`,
        liveHeading?.getAttribute('aria-live') === 'polite', said({ ariaLive: liveHeading?.getAttribute('aria-live') ?? null }));
      let v = look(page);
      check(`${name}: with nothing typed the list reads as it did: Pending, "3 pending requests", its three rows, every count`,
        said(v.pressed) === said(['Pending 3']) && v.heading === '3 pending requests' && said(v.rows) === said(PENDING3)
          && v.strip === STRIP10, said(v));

      // Typing, a keystroke at a time.
      const writesAtOpen = store.sets;
      let sent = net.calls.length;
      const perKey = [];
      for (const s of ['c', 'cr', 'cru', 'cruz']) {
        await type(page, s);
        perKey.push(net.calls.length - sent);
      }
      v = look(page);
      check(`${name}: each keystroke filters at once and sends nothing: "c", "cr", "cru", "cruz", no request after any`,
        net.calls.length === sent && perKey.every((n) => n === 0) && v.search === 'cruz', said({ perKey, search: v.search }));
      check(`${name}: on Pending, "cruz" leaves Juan Miguel Dela Cruz; Pending stays chosen, and the heading reads "1 of 3 `
          + 'pending requests matches"',
        said(v.rows) === said(['Juan Miguel Dela Cruz']) && said(v.pressed) === said(['Pending 1'])
          && v.heading === '1 of 3 pending requests matches', said(v));
      check(`${name}: the counts follow the search, "Pending 1 · Approved 1 · Ready for release 0 · Claimed 1 · Rejected 0 · `
          + 'Cancelled 0 · All 3", and the tabs left with none are dimmed, still buttons',
        v.strip === 'Pending 1 · Approved 1 · Ready for release 0 · Claimed 1 · Rejected 0 · Cancelled 0 · All 3'
          && said(v.dimmed) === said(['Ready for release 0', 'Rejected 0', 'Cancelled 0'])
          && tabsOf(page).length === 7 && tabsOf(page).every((b) => b.disabled === false), said({ strip: v.strip, dimmed: v.dimmed }));

      // The tabs split what matches.
      sent = net.calls.length;
      await clickIf(page, tabNamed(page, 'All'));
      const onAll = look(page);
      await clickIf(page, tabNamed(page, 'Ready for release'));
      const onReady = look(page);
      check(`${name}: a tab press splits what matches and sends nothing: All shows the three Cruz rows under "3 of 10 requests match"`,
        said(onAll.rows) === said(['Juan Miguel Dela Cruz', 'Pedro Dela Cruz, Jr.', 'Ana Cruz'])
          && onAll.heading === '3 of 10 requests match' && said(onAll.pressed) === said(['All 3']), said(onAll));
      check(`${name}: Ready for release, where none match: "0 of 1 ready for release request match", and in place of the rows `
          + '\'No ready for release requests match "cruz"\' with a Clear search button',
        onReady.heading === '0 of 1 ready for release request match' && onReady.empty === 'No ready for release requests match "cruz"'
          && onReady.clearSearch && onReady.rows.length === 0 && !page.query('table.data-table')
          && said(onReady.pressed) === said(['Ready for release 0']) && net.calls.length === sent, said(onReady));
      await clickIf(page, emptyClear(page));
      v = look(page);
      check(`${name}: that Clear search empties the box, leaves focus in it and keeps Ready for release: its row, under the `
          + 'heading it had before, "1 ready for release request", and every count back',
        v.search === '' && !!box(page) && page.active() === box(page) && said(v.pressed) === said(['Ready for release 1'])
          && said(v.rows) === said(['Rosa Lim']) && v.heading === '1 ready for release request' && v.strip === STRIP10
          && net.calls.length === sent, said(v));

      // An empty tab: its own text with no search, the search's with one.
      await clickIf(page, tabNamed(page, 'Cancelled'));
      const noSearch = look(page);
      await type(page, 'zzz');
      const zzz = look(page);
      check(`${name}: an empty tab with no search keeps its text, "0 cancelled requests" and "No cancelled requests.", with no `
          + 'Clear search',
        noSearch.heading === '0 cancelled requests' && noSearch.empty === 'No cancelled requests.' && !noSearch.clearSearch,
        said(noSearch));
      check(`${name}: with "zzz", matching nothing: "0 of 0 cancelled requests match", 'No cancelled requests match "zzz"' `
          + 'with Clear search, and all seven tabs dimmed',
        zzz.heading === '0 of 0 cancelled requests match' && zzz.empty === 'No cancelled requests match "zzz"' && zzz.clearSearch
          && zzz.dimmed.length === 7 && said(zzz.pressed) === said(['Cancelled 0']), said(zzz));

      // What a search finds, on All.
      await clickIf(page, tabNamed(page, 'All'));
      const rowsFor = async (q) => {
        await type(page, q);
        return look(page).rows;
      };
      sent = net.calls.length;
      const found = {
        name: await rowsFor('juan'), middle: await rowsFor('elena'), document: await rowsFor('indigency'),
        documents: await rowsFor('residency'), cased: await rowsFor('  JUAN   dela  '), upper: await rowsFor('BARANGAY id'),
        words: await rowsFor('cruz clearance'), reversed: await rowsFor('clearance pedro'), apart: await rowsFor('juan santos'),
        accents: await rowsFor('nino penaflor'), accented: await rowsFor('NIÑO'),
      };
      check(`${name}: by the name the row shows, middle name and all: "juan" finds Juan Miguel Dela Cruz, "elena" Maria Elena Santos`,
        said(found.name) === said(['Juan Miguel Dela Cruz']) && said(found.middle) === said(['Maria Elena Santos']), said(found));
      check(`${name}: by document type: "indigency" finds Niño Peñaflor, "residency" the three Certificates of Residency, in `
          + 'the order sent',
        said(found.document) === said(['Niño Peñaflor'])
          && said(found.documents) === said(['Maria Elena Santos', 'Lito Ramos', 'Elsa Uy']), said(found));
      check(`${name}: case and extra spaces do not matter: "  JUAN   dela  " finds Juan Miguel Dela Cruz, "BARANGAY id" Ana Cruz`,
        said(found.cased) === said(['Juan Miguel Dela Cruz']) && said(found.upper) === said(['Ana Cruz']), said(found));
      check(`${name}: several words must all match the same request, in any order, across its name and document: "cruz `
          + 'clearance" finds the two Dela Cruz clearances, "clearance pedro" Pedro alone, "juan santos" nothing',
        said(found.words) === said(['Juan Miguel Dela Cruz', 'Pedro Dela Cruz, Jr.'])
          && said(found.reversed) === said(['Pedro Dela Cruz, Jr.']) && Array.isArray(found.apart) && found.apart.length === 0,
        said(found));
      check(`${name}: accents do not matter: "nino penaflor" and "NIÑO" find Niño Peñaflor`,
        said(found.accents) === said(['Niño Peñaflor']) && said(found.accented) === said(['Niño Peñaflor']), said(found));

      // The account: found exactly where the row shows it.
      await type(page, '');
      const notes = { maria: noteOf(page, 'Maria Elena Santos'), rosa: noteOf(page, 'Rosa Lim'), elsa: noteOf(page, 'Elsa Uy') };
      const accounts = { msantos: await rowsFor('msantos'), handle: await rowsFor('@elsa_uy'), self: await rowsFor('jmdc_1990') };
      if (staff) {
        check('Staff: the rows show no account note, and an account the row does not show is never found: "msantos", '
            + '"@elsa_uy" and "jmdc_1990" find nothing, though Staff\'s payload still carries the filers\' usernames',
          said(notes) === said({ maria: '(no note)', rosa: '(no note)', elsa: '(no note)' })
            && Object.values(accounts).every((rows) => rows.length === 0)
            && said(STAFF_LIST.filter((r) => ['msantos_88', 'jmdc_1990'].includes(r.requester.username)).map((r) => r.request_id))
              === said([401, 402]),
          said({ notes, accounts }));
      } else {
        check(`${name}: the rows show the resident's account under the name ("@msantos_88", "@elsa_uy"; Rosa Lim "No online `
            + 'account"), and a search finds it there: "msantos" Maria Elena Santos, "@elsa_uy" Elsa Uy (a walk-in, her own '
            + 'account), "jmdc_1990" Juan Miguel Dela Cruz',
          said(notes) === said({ maria: '@msantos_88', rosa: 'No online account', elsa: '@elsa_uy' })
            && said(accounts) === said({ msantos: ['Maria Elena Santos'], handle: ['Elsa Uy'], self: ['Juan Miguel Dela Cruz'] }),
          said({ notes, accounts }));
      }

      // What a search never reaches.
      const NEVER = ['scholarship', 'employment', 'bank account', 'incomplete', 'birth certificate', 'example.invalid',
        'pending', 'rejected', 'secretary1', 'online', '401'];
      const leaked = [];
      for (const q of NEVER) {
        const rows = await rowsFor(q);
        if (rows.length > 0) leaked.push({ q, rows });
      }
      check(`${name}: never matched: a purpose ("scholarship", "employment", "bank account"), the rejection reason `
          + '("incomplete", "birth certificate"), an email ("example.invalid"), a status ("pending", "rejected"), a walk-in\'s '
          + 'filer ("secretary1"), the "No online account" note ("online"), a request number ("401")',
        leaked.length === 0 && !!box(page), said(leaked));
      // With no box on screen nothing was typed, so "no request" would say nothing.
      check(`${name}: and none of those ${Object.keys(found).length + 3 + NEVER.length} searches sent a request`,
        !!box(page) && net.calls.length === sent, `${net.calls.length - sent} request(s), box ${box(page) ? 'present' : 'absent'}`);

      // Escape and the Clear (x) button.
      await clickIf(page, tabNamed(page, 'Pending'));
      await type(page, 'juan');
      const x = xButton(page);
      box(page)?.focus();
      await page.key('Escape');
      v = look(page);
      check(`${name}: Escape in the box empties it, keeps focus in it, and brings Pending's three rows back`,
        !!x && v.search === '' && page.active() === box(page) && said(v.rows) === said(PENDING3)
          && v.heading === '3 pending requests', said(v));
      await type(page, 'juan');
      const x2 = xButton(page);
      await clickIf(page, x2);
      v = look(page);
      check(`${name}: the Clear (x) button, there while the box has text, does the same: a type="button" named "Clear `
          + 'search"; pressed, the box is empty, focus is in it and the button is gone',
        !!x2 && x2.type === 'button' && x2.getAttribute('aria-label') === 'Clear search' && v.search === ''
          && page.active() === box(page) && !xButton(page) && said(v.rows) === said(PENDING3), said(v));
      await type(page, 'juan');
      tabNamed(page, 'Pending')?.focus();
      await page.key('Escape');
      v = look(page);
      check(`${name}: Escape clears only while the box has focus: pressed on a tab, the box keeps "juan" and its row`,
        page.active() === tabNamed(page, 'Pending') && v.search === 'juan' && said(v.rows) === said(['Juan Miguel Dela Cruz']),
        said(v));

      // Back from a request's detail.
      await clickIf(page, tabNamed(page, 'All'));
      await type(page, 'dela');
      sent = net.calls.length;
      await clickIf(page, rowButton(page, 'Pedro Dela Cruz, Jr.', opener));
      const opened = text(page.query('.pending-card h3'));
      await clickIf(page, buttonNamed(root(), '← Back to list'));
      v = look(page);
      const focusAfterBack = page.active()?.tagName ?? null;
      check(`${name}: Back from a request's detail keeps the search and the tab: "dela" in the box, All chosen, the two Dela `
          + 'Cruz rows under "2 of 10 requests match"; only the detail was requested',
        opened === 'Request #404' && v.search === 'dela' && said(v.pressed) === said(['All 2'])
          && said(v.rows) === said(['Juan Miguel Dela Cruz', 'Pedro Dela Cruz, Jr.']) && v.heading === '2 of 10 requests match'
          && said(listCalls(net.calls.slice(sent))) === said(['GET /document-requests/404']),
        said({ opened, v, calls: listCalls(net.calls.slice(sent)), focusAfterBack }));

      // Refresh, then a reload that fails, then Try again.
      at = holdNext();
      sent = net.calls.length;
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const reloading = { box: !!box(page), strip: !!page.query('.pay-tabs'), loading: look(page).loading };
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      v = look(page);
      check(`${name}: Refresh loads the list again, once, and keeps the search: no box and no tabs while it is out, then "dela" `
          + 'still in the box, All chosen, "2 of 10 requests match"',
        said(listCalls(net.calls.slice(sent))) === said(['GET /document-requests?status=all']) && !reloading.box
          && !reloading.strip && reloading.loading && v.search === 'dela' && said(v.pressed) === said(['All 2'])
          && v.heading === '2 of 10 requests match' && said(v.rows) === said(['Juan Miguel Dela Cruz', 'Pedro Dela Cruz, Jr.']),
        said({ reloading, v }));
      at = holdNext();
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      release(at, 500, { error: 'Internal server error' });
      await page.settle();
      const failedReload = { box: !!box(page), strip: !!page.query('.pay-tabs'), error: look(page).error };
      at = holdNext();
      await clickIf(page, tryAgainButton(page));
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      v = look(page);
      check(`${name}: a reload that fails takes the box away with the tabs, and Try again brings it back with "dela" in it`,
        !failedReload.box && !failedReload.strip && failedReload.error === 'Could not load the requests: Internal server error'
          && v.search === 'dela' && said(v.pressed) === said(['All 2']) && v.heading === '2 of 10 requests match',
        said({ failedReload, v }));

      if (walkIn) {
        // Back after approving: the list loads again, and the search and the
        // tab stay. The approve goes to the stub.
        await clickIf(page, tabNamed(page, 'Pending'));
        await type(page, 'maria');
        await clickIf(page, rowButton(page, 'Maria Elena Santos', 'Review'));
        sent = net.calls.length;
        await clickIf(page, buttonNamed(root(), 'Approve request'));
        const approved = text(page.query('.pending-card .alert.success'));
        await clickIf(page, buttonNamed(root(), '← Back to list'));
        v = look(page);
        check('Secretary: Back after approving loads the list again, once, and keeps the search and the tab: "maria" on '
            + 'Pending, where she no longer is: "0 of 2 pending requests match", \'No pending requests match "maria"\', '
            + 'and Approved 1 in the strip',
          approved === 'Request approved.'
            && said(listCalls(net.calls.slice(sent))) === said(['POST /document-requests/402/approve', 'GET /document-requests?status=all'])
            && v.search === 'maria' && said(v.pressed) === said(['Pending 0']) && v.heading === '0 of 2 pending requests match'
            && v.empty === 'No pending requests match "maria"'
            && v.strip === 'Pending 0 · Approved 1 · Ready for release 0 · Claimed 0 · Rejected 0 · Cancelled 0 · All 1',
          said({ approved, calls: listCalls(net.calls.slice(sent)), v }));
      }

      // Nothing kept in the browser; a new visit starts empty. The second
      // mount does not reseed the session, which would clear storage.
      const writesAfter = store.sets;
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
      resetNet(200, answerFor(makeState(), staff));
      const again = await globalThis.mountInteractive(root(), route);
      await again.settle();
      v = look(again);
      check(`${name}: nothing about the search is kept in the browser: no localStorage write, sessionStorage empty, and a `
          + 'new visit opens on Pending with an empty box',
        writesAfter === writesAtOpen && dom.window.sessionStorage.length === 0 && v.search === ''
          && said(v.pressed) === said(['Pending 3']) && v.heading === '3 pending requests',
        said({ writes: writesAfter - writesAtOpen, session: dom.window.sessionStorage.length, v }));
      methodsSent.push(...net.calls.map((c) => c.method));
      await again.unmount();
    }

    const writes = methodsSent.filter((m) => m !== 'GET');
    check('section X sent GETs, and one POST, the Secretary\'s approve, answered by the fetch stub',
      methodsSent.length > 0 && said(writes) === said(['POST']),
      `${methodsSent.length} request(s): ${[...new Set(methodsSent)].join(', ')}`);

    if (previousTZX === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZX;
  }

  // =========================================================================
  // Y. Document requests: the pager
  // =========================================================================
  // The list drew every request of a tab on one page: 77 on All, a very long
  // page on a phone. It gains the Payments pager, lifted into
  // components/ListPager.jsx with its classes, markup and behaviour: a nav
  // named "Pagination" under the rows; "Showing 1 to 25 of 77 results", its
  // figures in bold, in a polite live region; Rows per page (10, 25, 50 or
  // 100, 25 to start); then Previous, the page numbers, each a button named
  // "Page N" with the current one marked aria-current="page" and a "…" as
  // text where pages are left out, and Next; "Page 1 of 4" for a phone. Like
  // Payments' it shows from 11 matches. It pages the list already loaded,
  // with no request, and only the rows drawn are one page: the heading and
  // the tab counts still count every match, and the search still runs over
  // the whole list. A tab, a search or a new Rows per page goes back to page
  // 1, and Rows per page stays as chosen until a new visit. Refresh, Try
  // again and Back from a request keep the page; a list that shrank under it
  // lands on its last page, never an empty one past the end, and stays there.
  // utils/paging.js is sections O's and P's, unchanged, and nothing was added
  // to utils/requestList.js, so there is no new helper to check on its own.
  // The real page for the Secretary, Staff and the Punong Barangay, against
  // 77 stubbed requests in the order and with the statuses of the live list
  // on 13 Oct 2026 (6 pending, 50 approved, 4 ready for release, 5 claimed, 5
  // rejected, 7 cancelled), each named by its place in All, "Res 001" to "Res
  // 077". Every request is answered by the fetch stub; the only writes, the
  // Secretary's approve and mark ready for release, go to it too.
  console.log('\n--- Document requests: the pager ---');
  {
    const said = (v) => JSON.stringify(v);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    // The live list's statuses, newest first, a letter each: P pending, A
    // approved, R ready for release, C claimed, J rejected, X cancelled.
    const SEQ = 'RPPXAPPPRXAJCAXAPACAAAAAAAAAAAAACRAAAAAAAAXAAAAAAAAAAAAAAACCAAAAAAAJAXXAXJJRJ';
    const LETTER = { P: 'pending', A: 'approved', R: 'ready_for_release', C: 'claimed', J: 'rejected', X: 'cancelled' };
    // The document type turns with the place in All, so "clearance" finds
    // every third request, from Res 001.
    const TYPES = ['Certificate of Indigency', 'Barangay Clearance', 'Certificate of Residency'];
    const num = (n) => String(n).padStart(3, '0');
    const nameOf = (n) => `Res ${num(n)}`;
    // Request n in the list's real shape (as in sections V to X: Staff's has
    // no resident account and no requester email). A billed request's charge
    // is paid, so the Secretary can mark an approved one ready for release.
    const asRequest = (n, status, staff) => ({
      request_id: 1000 + n, purpose: `Purpose ${n}`, status, requested_at: '2026-10-08T02:00:00+00:00',
      claimed_at: status === 'claimed' ? '2026-10-10T03:00:00+00:00' : null,
      rejection_reason: status === 'rejected' ? 'Incomplete requirements' : null,
      processed_at: status === 'pending' ? null : '2026-10-09T02:00:00+00:00',
      document_types: { document_type_id: 600 + (n % 3), name: TYPES[n % 3], fee: '20.00' },
      resident_records: { resident_id: 3000 + n, first_name: 'Res', middle_name: null, last_name: num(n), suffix: null,
        ...(staff ? {} : { account: { username: `res_${num(n)}` } }) },
      requester: { user_id: 4000 + n, username: `res_${num(n)}`, ...(staff ? {} : { email: `res_${num(n)}@example.invalid` }) },
      charges: ['approved', 'ready_for_release', 'claimed'].includes(status)
        ? { charge_id: 5000 + n, amount: '20.00', status: 'PAID', declared_method: null, declared_reference: null }
        : null,
    });
    // The requests the stub holds, which the approve, the mark ready for
    // release and another session's changes alter as the server would.
    const makeState = (seq = SEQ) => ({ list: [...seq].map((c, i) => ({ n: i + 1, status: LETTER[c] })) });
    const listAnswer = (state, staff) => ({ requests: state.list.map((r) => asRequest(r.n, r.status, staff)) });
    const answerFor = (state, staff) => (url, method) => {
      if (method === 'GET' && /\/document-requests\?/.test(url)) return listAnswer(state, staff);
      const one = url.match(/\/document-requests\/(\d+)(?:\/(approve|ready-for-release))?$/);
      if (one) {
        const r = state.list.find((x) => 1000 + x.n === Number(one[1]));
        if (!r) return undefined;
        if (method === 'POST' && one[2] === 'approve') r.status = 'approved';
        if (method === 'POST' && one[2] === 'ready-for-release') r.status = 'ready_for_release';
        const request = { ...asRequest(r.n, r.status, staff), processed_by: null };
        if (!one[2]) return { request };
        return { request, message: one[2] === 'approve' ? 'Request approved.' : 'Request marked ready for release.' };
      }
      return undefined;
    };
    const names = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => nameOf(from + i));
    const where = (state, status) => state.list.filter((r) => r.status === status).map((r) => r.n);
    const STRIP77 = 'Pending 6 · Approved 50 · Ready for release 4 · Claimed 5 · Rejected 5 · Cancelled 7 · All 77';
    // Worked out by hand from SEQ: "clearance" is every third request from Res 001.
    const STRIP_CLEARANCE = 'Pending 1 · Approved 15 · Ready for release 3 · Claimed 2 · Rejected 0 · Cancelled 5 · All 26';
    const SEARCH_BOX = 'input[aria-label="Search requests"]';
    const box = (page) => page.query(SEARCH_BOX);
    const type = async (page, value) => { if (box(page)) await page.fill(SEARCH_BOX, value); };
    const tabsOf = (page) => page.queryAll('.pay-tabs button');
    const tabNamed = (page, label) => tabsOf(page).find((b) => b.textContent.startsWith(`${label} `));
    const pagerOf = (page) => page.query('nav.pay-pager');
    const sizeSelect = (page) => page.query('.pay-pager select');
    const numberButton = (page, n) => page.query(`.pay-pager button[aria-label="Page ${n}"]`);
    const stepButton = (page, label) => (pagerOf(page) ? buttonNamed(pagerOf(page), label) ?? null : null);
    const listHeading = (page) => page.query('.doc-requests-head h2');
    const rowOf = (page, rowName) =>
      page.queryAll('table.data-table tbody tr').find((tr) => text(tr.querySelector('strong')) === rowName) ?? null;
    const rowButton = (page, rowName, label) => {
      const tr = rowOf(page, rowName);
      return tr ? [...tr.querySelectorAll('button')].find((b) => b.textContent === label) ?? null : null;
    };
    // What the list and its pager say, read the way a person would.
    const look = (page) => ({
      heading: text(page.query('.list-head h2')),
      strip: tabsOf(page).map(text).join(' · '),
      pressed: page.queryAll('.pay-tabs button[aria-pressed="true"]').map(text),
      rows: page.queryAll('table.data-table tbody tr').map((tr) => text(tr.querySelector('strong'))),
      pager: !!pagerOf(page),
      showing: text(page.query('.pay-pager-count')),
      bold: page.queryAll('.pay-pager-count strong').map(text),
      numbers: page.queryAll('.pay-pager-numbers li').map(text).join(' '),
      current: page.queryAll('.pay-pager [aria-current="page"]').map(text),
      short: text(page.query('.pay-pager-short')),
      size: sizeSelect(page)?.value ?? null,
      search: box(page)?.value ?? null,
      error: page.queryAll('[role="alert"]').map(text).find((t) => t.startsWith('Could not load the requests')) ?? null,
      loading: root().textContent.includes('Loading requests…'),
    });
    // The pager is on page n of m, showing `from` to `to` of `of`: the count
    // line, the one number marked aria-current="page" and the phone's "Page n
    // of m" must all say so.
    const onPage = (v, n, m, from, to, of) => v.showing === `Showing ${from} to ${to} of ${of} results`
      && said(v.current) === said([String(n)]) && v.short === `Page ${n} of ${m}`;
    const brief = (v) => ({ showing: v.showing, current: v.current, short: v.short, numbers: v.numbers, size: v.size,
      rows: v.rows.length ? [v.rows.length, v.rows[0], v.rows.at(-1)] : [] });
    // Focus first, as a press does in a browser: a dispatched click in jsdom
    // moves no focus, and some checks are about where focus ends up.
    const press = async (page, el) => {
      if (!el) return;
      el.focus();
      await page.click(el);
    };
    const setRows = async (page, value) => {
      const select = sizeSelect(page);
      if (select) {
        select.value = String(value);
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      await page.settle();
    };
    const holdNext = () => {
      net.hold = true;
      return net.held.length;
    };
    const listCalls = (calls) => calls.filter((c) => c.url.includes('/document-requests'))
      .map((c) => `${c.method} ${c.url.replace(/^.*\/api/, '')}`);
    // jsdom has no scrollIntoView; this one records what asked to be shown.
    const scrolled = [];
    const proto = dom.window.HTMLElement.prototype;
    const previousScroll = proto.scrollIntoView;
    proto.scrollIntoView = function scrollIntoView(options) { scrolled.push({ el: this, options }); };
    const methodsSent = [];

    const ROLES = [
      { name: 'Secretary', route: '/secretary/requests', token: VALID, user: USER, staff: false, opener: 'Review', walkIn: true },
      { name: 'Staff', route: '/staff/requests', token: makeToken({ sub: '3', role: 'staff', exp: VALID_EXP }),
        user: { user_id: 3, username: 'staff1', role: 'staff', must_change_password: false },
        staff: true, opener: 'View', walkIn: false },
      { name: 'Punong Barangay', route: '/punong-barangay/requests',
        token: makeToken({ sub: '5', role: 'punong_barangay', exp: VALID_EXP }),
        user: { user_id: 5, username: 'pb_ubujan', role: 'punong_barangay', must_change_password: false },
        staff: false, opener: 'View', walkIn: false },
    ];
    for (const { name, route, token, user, staff, opener, walkIn } of ROLES) {
      let state = makeState();
      const APPROVED = where(state, 'approved');
      const APPROVED_CLEARANCE = APPROVED.filter((n) => n % 3 === 1);
      seedSession(token, user);
      resetNet(200, answerFor(state, staff));
      let page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      const writesAtOpen = store.sets;
      let v = look(page);
      check(`${name}: it opens on Pending, whose 6 requests fit one page, and at 10 matches or fewer there is no pager: no `
          + 'Pagination nav, no Rows per page, no Previous or Next',
        said(v.pressed) === said(['Pending 6']) && v.rows.length === 6 && v.strip === STRIP77 && !v.pager && v.size === null
          && !buttonNamed(root(), 'Previous') && !buttonNamed(root(), 'Next'),
        said({ pressed: v.pressed, rows: v.rows.length, pager: v.pager, size: v.size }));

      // All: 77 requests, four pages of 25. From here to the search for "070"
      // nothing may send a request.
      const sentBeforePaging = net.calls.length;
      await clickIf(page, tabNamed(page, 'All'));
      v = look(page);
      check(`${name}: All, 77 requests at 25 a page: "Showing 1 to 25 of 77 results", pages "1 2 3 4" with 1 the current one, `
          + '"Page 1 of 4" for a phone, and only the first 25 rows, "Res 001" to "Res 025", under "77 requests"',
        v.heading === '77 requests' && onPage(v, 1, 4, 1, 25, 77) && v.numbers === '1 2 3 4' && said(v.rows) === said(names(1, 25)),
        said({ heading: v.heading, ...brief(v) }));
      const nav = pagerOf(page);
      const countLine = page.query('.pay-pager-count');
      check(`${name}: the pager is a nav named "Pagination" right under the rows' table, as on Payments; its count line is a `
          + 'polite live region with its three figures in bold: "1", "25", "77"',
        nav?.getAttribute('aria-label') === 'Pagination' && !!nav.previousElementSibling?.classList.contains('table-wrap')
          && countLine?.getAttribute('aria-live') === 'polite' && said(v.bold) === said(['1', '25', '77']),
        said({ label: nav?.getAttribute('aria-label') ?? null, after: nav?.previousElementSibling?.className ?? null,
          live: countLine?.getAttribute('aria-live') ?? null, bold: v.bold }));
      const select = sizeSelect(page);
      const sizeLabel = nav?.querySelector('label') ?? null;
      const options = select ? [...select.options].map((o) => o.textContent) : null;
      check(`${name}: Rows per page is a select labelled "Rows per page", offering 10, 25, 50 and 100, with 25 chosen`,
        !!select && sizeLabel?.textContent === 'Rows per page' && !!select.id && sizeLabel.htmlFor === select.id
          && select.labels?.[0] === sizeLabel && said(options) === said(['10', '25', '50', '100']) && select.value === '25',
        said({ label: sizeLabel?.textContent ?? null, for: sizeLabel?.htmlFor ?? null, id: select?.id ?? null, options,
          value: select?.value ?? null }));
      const numberButtons = page.queryAll('.pay-pager-numbers button')
        .map((b) => `${b.getAttribute('type')}:${b.getAttribute('aria-label')}:${b.getAttribute('aria-current')}`);
      const previous = stepButton(page, 'Previous');
      const next = stepButton(page, 'Next');
      check(`${name}: each number is a type="button" named "Page N", only the current one marked aria-current="page"; Previous `
          + 'and Next are buttons whose arrows are hidden from screen readers, Previous aria-disabled on page 1, never disabled',
        said(numberButtons) === said(['button:Page 1:page', 'button:Page 2:null', 'button:Page 3:null', 'button:Page 4:null'])
          && previous?.type === 'button' && next?.type === 'button' && previous.getAttribute('aria-disabled') === 'true'
          && next.getAttribute('aria-disabled') !== 'true' && !previous.disabled && !next.disabled
          && [previous, next].every((b) => b.querySelector('svg')?.getAttribute('aria-hidden') === 'true'),
        said({ numberButtons, previous: previous?.getAttribute('aria-disabled') ?? null, next: next?.getAttribute('aria-disabled') ?? null }));

      scrolled.length = 0;
      await press(page, next);
      v = look(page);
      check(`${name}: Next: page 2, "Res 026" to "Res 050", "Showing 26 to 50 of 77 results"; the list heading is brought into `
          + 'view (block "nearest"), and focus stays on Next',
        onPage(v, 2, 4, 26, 50, 77) && said(v.rows) === said(names(26, 50)) && scrolled.length === 1
          && scrolled[0].el === listHeading(page) && scrolled[0].options?.block === 'nearest' && !!next && page.active() === next,
        said({ ...brief(v), scrolls: scrolled.length, onto: scrolled[0]?.el?.tagName ?? null,
          focus: page.active()?.textContent ?? null }));
      await press(page, numberButton(page, 4));
      v = look(page);
      const nextAtEnd = stepButton(page, 'Next');
      check(`${name}: "Page 4", the last: exactly the last two rows, "Res 076" and "Res 077", "Showing 76 to 77 of 77 results", `
          + 'and Next unavailable',
        onPage(v, 4, 4, 76, 77, 77) && said(v.rows) === said(['Res 076', 'Res 077'])
          && nextAtEnd?.getAttribute('aria-disabled') === 'true', said(brief(v)));
      scrolled.length = 0;
      await press(page, nextAtEnd);
      v = look(page);
      check(`  ${name}: pressing the unavailable Next does nothing: no scroll, still page 4, and focus stays on it, aria-disabled `
          + 'and never disabled',
        onPage(v, 4, 4, 76, 77, 77) && scrolled.length === 0 && !!nextAtEnd && page.active() === nextAtEnd && !nextAtEnd.disabled,
        said({ ...brief(v), scrolls: scrolled.length, focusOnNext: !!nextAtEnd && page.active() === nextAtEnd }));
      scrolled.length = 0;
      await press(page, numberButton(page, 4));
      check(`  ${name}: nor does pressing the current page: no scroll, still page 4`,
        onPage(look(page), 4, 4, 76, 77, 77) && scrolled.length === 0, `${scrolled.length} scroll(s)`);
      await press(page, stepButton(page, 'Previous'));
      v = look(page);
      check(`${name}: Previous from page 4: page 3, "Res 051" to "Res 075", "Showing 51 to 75 of 77 results"`,
        onPage(v, 3, 4, 51, 75, 77) && said(v.rows) === said(names(51, 75)), said(brief(v)));
      const perPage = [];
      for (const n of [1, 2, 3, 4]) {
        await press(page, numberButton(page, n));
        const x = look(page);
        perPage.push({ page: x.current, heading: x.heading, strip: x.strip, rows: x.rows.length });
      }
      check(`${name}: the heading and the tab counts are the whole list's on every page: "77 requests" and "${STRIP77}" on `
          + 'pages 1 to 4, which draw 25, 25, 25 and 2 rows',
        perPage.every((p) => p.heading === '77 requests' && p.strip === STRIP77)
          && said(perPage.map((p) => [p.page, p.rows])) === said([[['1'], 25], [['2'], 25], [['3'], 25], [['4'], 2]]),
        said(perPage.map((p) => ({ page: p.page, heading: p.heading, rows: p.rows, strip: p.strip === STRIP77 ? 'same' : p.strip }))));
      await press(page, numberButton(page, 1));
      const previousAtStart = stepButton(page, 'Previous');
      scrolled.length = 0;
      await press(page, previousAtStart);
      v = look(page);
      check(`${name}: on page 1, Previous is unavailable the same way: pressing it does nothing and focus stays on it; Next is `
          + 'available',
        onPage(v, 1, 4, 1, 25, 77) && scrolled.length === 0 && !!previousAtStart && page.active() === previousAtStart
          && previousAtStart.getAttribute('aria-disabled') === 'true' && !previousAtStart.disabled
          && stepButton(page, 'Next')?.getAttribute('aria-disabled') !== 'true',
        said({ ...brief(v), scrolls: scrolled.length }));

      // Rows per page.
      await press(page, numberButton(page, 3));
      scrolled.length = 0;
      await setRows(page, 10);
      v = look(page);
      check(`${name}: Rows per page 10, from page 3: back to page 1, "Res 001" to "Res 010", "Showing 1 to 10 of 77 results", `
          + 'pages "1 2 3 4 5 … 8", and the list heading brought into view, as for a page change',
        v.size === '10' && onPage(v, 1, 8, 1, 10, 77) && v.numbers === '1 2 3 4 5 … 8' && said(v.rows) === said(names(1, 10))
          && scrolled.length === 1 && scrolled[0].el === listHeading(page),
        said({ ...brief(v), scrolls: scrolled.length }));
      const gaps = page.queryAll('.pay-pager-numbers li').filter((li) => li.textContent === '…');
      check(`  ${name}: the "…" is plain text: not a button, and nothing in it can take focus`,
        gaps.length === 1 && gaps.every((li) => !li.matches('[tabindex]') && !li.querySelector('button, a, input, select, [tabindex]')),
        gaps.map((li) => li.outerHTML).join(' ') || 'no "…" drawn');
      // Eight pages: pages 1 to 4 draw "1 2 3 4 5 … 8", the last four "1 …"
      // and the last five (utils/paging.js), so 8 pages have no middle shape.
      await press(page, numberButton(page, 5));
      v = look(page);
      check(`${name}: "Page 5" of 8, one of the last four: "1 … 4 5 6 7 8", "Res 041" to "Res 050", "Showing 41 to 50 of 77 `
          + 'results", and focus stays on the button for page 5',
        onPage(v, 5, 8, 41, 50, 77) && v.numbers === '1 … 4 5 6 7 8' && said(v.rows) === said(names(41, 50))
          && page.active()?.getAttribute('aria-label') === 'Page 5',
        said({ ...brief(v), focus: page.active()?.getAttribute('aria-label') ?? page.active()?.tagName }));
      await press(page, numberButton(page, 8));
      v = look(page);
      check(`${name}: "Page 8" of 8: "1 … 4 5 6 7 8", "Res 071" to "Res 077", "Showing 71 to 77 of 77 results"`,
        onPage(v, 8, 8, 71, 77, 77) && v.numbers === '1 … 4 5 6 7 8' && said(v.rows) === said(names(71, 77)), said(brief(v)));
      await press(page, numberButton(page, 4));
      v = look(page);
      check(`${name}: "Page 4" of 8, among the first four: "1 2 3 4 5 … 8", "Showing 31 to 40 of 77 results"`,
        onPage(v, 4, 8, 31, 40, 77) && v.numbers === '1 2 3 4 5 … 8' && said(v.rows) === said(names(31, 40)), said(brief(v)));
      await setRows(page, 50);
      const at50 = look(page);
      await press(page, numberButton(page, 2));
      const at50second = look(page);
      await setRows(page, 100);
      const at100 = look(page);
      check(`${name}: Rows per page 50: "Showing 1 to 50 of 77 results", pages "1 2", and page 2 "Res 051" to "Res 077"; 100: all `
          + '77 on one page, "Showing 1 to 77 of 77 results", a single "1", Previous and Next both unavailable',
        at50.size === '50' && onPage(at50, 1, 2, 1, 50, 77) && at50.numbers === '1 2' && said(at50.rows) === said(names(1, 50))
          && onPage(at50second, 2, 2, 51, 77, 77) && said(at50second.rows) === said(names(51, 77))
          && at100.size === '100' && onPage(at100, 1, 1, 1, 77, 77) && at100.numbers === '1' && at100.rows.length === 77
          && stepButton(page, 'Previous')?.getAttribute('aria-disabled') === 'true'
          && stepButton(page, 'Next')?.getAttribute('aria-disabled') === 'true',
        said({ at50: brief(at50), at50second: brief(at50second), at100: brief(at100) }));

      // A tab, a search, and Rows per page kept through both.
      await setRows(page, 10);
      await press(page, numberButton(page, 3));
      const allThird = look(page);
      await clickIf(page, tabNamed(page, 'Approved'));
      v = look(page);
      check(`${name}: a tab change goes back to page 1 and keeps Rows per page: page 3 of All at 10 a page, then Approved, `
          + '"Showing 1 to 10 of 50 results", pages "1 2 3 4 5", its first ten rows, under "50 approved requests"',
        onPage(allThird, 3, 8, 21, 30, 77) && v.size === '10' && onPage(v, 1, 5, 1, 10, 50) && v.numbers === '1 2 3 4 5'
          && said(v.rows) === said(APPROVED.slice(0, 10).map(nameOf)) && v.heading === '50 approved requests',
        said({ before: brief(allThird), after: brief(v), heading: v.heading }));
      await press(page, numberButton(page, 3));
      const approvedThird = look(page);
      await type(page, 'clearance');
      const searched = look(page);
      check(`${name}: a search goes back to page 1 and keeps Rows per page: page 3 of Approved, then "clearance", `
          + '"Showing 1 to 10 of 15 results", the first ten approved clearances, under "15 of 50 approved requests match"',
        onPage(approvedThird, 3, 5, 21, 30, 50) && searched.size === '10' && onPage(searched, 1, 2, 1, 10, 15)
          && said(searched.rows) === said(APPROVED_CLEARANCE.slice(0, 10).map(nameOf))
          && searched.heading === '15 of 50 approved requests match',
        said({ before: brief(approvedThird), after: brief(searched), heading: searched.heading }));
      await press(page, numberButton(page, 2));
      v = look(page);
      check(`  ${name}: its page 2 holds the other five, and the heading and the counts stay those of every match: "15 of 50 `
          + `approved requests match" and "${STRIP_CLEARANCE}" on both pages`,
        onPage(v, 2, 2, 11, 15, 15) && said(v.rows) === said(APPROVED_CLEARANCE.slice(10).map(nameOf))
          && searched.strip === STRIP_CLEARANCE && v.strip === STRIP_CLEARANCE && v.heading === searched.heading,
        said({ ...brief(v), heading: v.heading, strip: v.strip }));
      await clickIf(page, page.query('button[aria-label="Clear search"]'));
      v = look(page);
      check(`${name}: the Clear (x) button is a search change too: from page 2 of the clearances back to page 1 of Approved's `
          + '50, still at 10 a page',
        v.search === '' && v.size === '10' && onPage(v, 1, 5, 1, 10, 50) && v.strip === STRIP77, said(brief(v)));
      await setRows(page, 25);
      await clickIf(page, tabNamed(page, 'All'));
      await press(page, numberButton(page, 3));
      const allThird25 = look(page);
      await clickIf(page, tabNamed(page, 'Approved'));
      v = look(page);
      check(`${name}: from page 3 of All at 25 a page, Approved opens on its page 1, "Showing 1 to 25 of 50 results", not its last`,
        onPage(allThird25, 3, 4, 51, 75, 77) && onPage(v, 1, 2, 1, 25, 50)
          && said(v.rows) === said(APPROVED.slice(0, 25).map(nameOf)),
        said({ before: brief(allThird25), after: brief(v) }));

      // The search runs over the whole list before paging.
      await clickIf(page, tabNamed(page, 'All'));
      const allFirst = look(page);
      await type(page, '070');
      v = look(page);
      check(`${name}: the search runs over the whole list, not the page shown: Res 070 is on page 3, not among page 1's rows, `
          + 'and "070" finds it: one match, "1 of 77 requests matches", and no pager',
        onPage(allFirst, 1, 4, 1, 25, 77) && !allFirst.rows.includes('Res 070') && said(v.rows) === said(['Res 070'])
          && v.heading === '1 of 77 requests matches' && !v.pager,
        said({ first: brief(allFirst), searched: { rows: v.rows, heading: v.heading, pager: v.pager } }));
      await type(page, '');
      check(`${name}: none of those page, Rows per page, tab and search changes sent a request`,
        !!pagerOf(page) && net.calls.length === sentBeforePaging,
        `${net.calls.length - sentBeforePaging} request(s): ${said(listCalls(net.calls.slice(sentBeforePaging)))}`);

      // Refresh, a reload that fails, Try again, and Back from a request.
      await setRows(page, 50);
      await press(page, numberButton(page, 2));
      let at = holdNext();
      let sent = net.calls.length;
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const reloading = { pager: !!pagerOf(page), loading: look(page).loading };
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      v = look(page);
      check(`${name}: Refresh loads the list again, once, with no pager while it is out, and keeps the page and Rows per page: `
          + 'page 2 at 50, "Showing 51 to 77 of 77 results", "Res 051" to "Res 077"',
        net.calls.length === sent + 1 && !reloading.pager && reloading.loading && v.size === '50'
          && onPage(v, 2, 2, 51, 77, 77) && said(v.rows) === said(names(51, 77)),
        said({ requests: net.calls.length - sent, reloading, after: brief(v) }));
      at = holdNext();
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      release(at, 500, { error: 'Internal server error' });
      await page.settle();
      const failed = look(page);
      at = holdNext();
      await clickIf(page, tryAgainButton(page));
      release(at, 200, listAnswer(state, staff));
      await page.settle();
      net.hold = false;
      v = look(page);
      check(`${name}: a reload that fails shows no pager beside the error, and Try again brings it back on the same page: page 2 `
          + 'at 50',
        !failed.pager && failed.error === 'Could not load the requests: Internal server error' && failed.rows.length === 0
          && v.size === '50' && onPage(v, 2, 2, 51, 77, 77),
        said({ failed: { pager: failed.pager, error: failed.error, rows: failed.rows.length }, after: brief(v) }));
      sent = net.calls.length;
      await clickIf(page, rowButton(page, 'Res 060', opener));
      const opened = text(page.query('.pending-card h3'));
      await clickIf(page, buttonNamed(root(), '← Back to list'));
      v = look(page);
      check(`${name}: Back from a request's detail, with nothing done there, keeps the page: Res 060's, page 2 at 50; only the `
          + 'detail was requested',
        opened === 'Request #1060' && v.size === '50' && onPage(v, 2, 2, 51, 77, 77)
          && said(listCalls(net.calls.slice(sent))) === said(['GET /document-requests/1060']),
        said({ opened, after: brief(v), calls: listCalls(net.calls.slice(sent)) }));

      if (walkIn) {
        // Back after approving: the list loads again, and the page stays
        // where it still exists.
        await setRows(page, 10);
        await press(page, numberButton(page, 2));
        sent = net.calls.length;
        await clickIf(page, rowButton(page, 'Res 017', 'Review'));
        await clickIf(page, buttonNamed(root(), 'Approve request'));
        const approved = text(page.query('.pending-card .alert.success'));
        await clickIf(page, buttonNamed(root(), '← Back to list'));
        v = look(page);
        const badge = text(rowOf(page, 'Res 017')?.querySelector('.badge'));
        check('Secretary: Back after approving a request loads the list again, once, and keeps the page where it still exists: '
            + 'page 2 of All at 10, "Showing 11 to 20 of 77 results", with Res 017 now Approved',
          approved === 'Request approved.' && said(listCalls(net.calls.slice(sent))) === said(['GET /document-requests/1017',
            'POST /document-requests/1017/approve', 'GET /document-requests?status=all'])
            && v.size === '10' && onPage(v, 2, 8, 11, 20, 77) && said(v.rows) === said(names(11, 20)) && badge === 'Approved',
          said({ approved, calls: listCalls(net.calls.slice(sent)), after: brief(v), badge }));

        // Back after the last page's only request has left the tab: the page
        // before, now the last, and never an empty page past the end.
        await setRows(page, 25);
        await clickIf(page, tabNamed(page, 'Approved'));
        await press(page, numberButton(page, 3));
        const third = look(page);
        sent = net.calls.length;
        await clickIf(page, rowButton(page, 'Res 072', 'Review'));
        await clickIf(page, buttonNamed(root(), 'Mark ready for release'));
        const marked = text(page.query('.pending-card .alert.success'));
        await clickIf(page, buttonNamed(root(), '← Back to list'));
        v = look(page);
        check('Secretary: Back after the only request on the last page has left the tab lands on the page before it, now the '
            + 'last: Approved\'s page 3 held Res 072 alone, "Showing 51 to 51 of 51 results"; marked ready for release, the list '
            + 'reloads and shows page 2, "Showing 26 to 50 of 50 results", never an empty page 3',
          onPage(third, 3, 3, 51, 51, 51) && said(third.rows) === said(['Res 072']) && marked === 'Request marked ready for release.'
            && said(listCalls(net.calls.slice(sent))) === said(['GET /document-requests/1072',
              'POST /document-requests/1072/ready-for-release', 'GET /document-requests?status=all'])
            && onPage(v, 2, 2, 26, 50, 50) && v.rows.length === 25 && v.heading === '50 approved requests',
          said({ third: brief(third), marked, calls: listCalls(net.calls.slice(sent)), after: brief(v) }));
      }

      // Nothing kept in the browser; a new visit starts at 25 a page, page 1.
      // The second mount does not reseed the session, which would clear storage.
      const writesAfter = store.sets;
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
      resetNet(200, answerFor(makeState(), staff));
      page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      await clickIf(page, tabNamed(page, 'All'));
      v = look(page);
      check(`${name}: nothing about the pager is kept in the browser: no localStorage write, sessionStorage empty, no cookie; and `
          + 'a new visit starts again at 25 a page, on page 1',
        writesAfter === writesAtOpen && dom.window.sessionStorage.length === 0 && dom.window.document.cookie === ''
          && v.size === '25' && onPage(v, 1, 4, 1, 25, 77),
        said({ writes: writesAfter - writesAtOpen, session: dom.window.sessionStorage.length,
          cookie: dom.window.document.cookie, after: brief(v) }));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();

      // A Refresh that shrinks the tab under the page, then one that grows it.
      state = makeState();
      seedSession(token, user);
      resetNet(200, answerFor(state, staff));
      page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      await clickIf(page, tabNamed(page, 'Approved'));
      await press(page, numberButton(page, 2));
      const second = look(page);
      const firstTwentyFive = APPROVED.slice(0, 25).map(nameOf);
      for (const n of APPROVED.slice(25)) state.list.find((r) => r.n === n).status = 'ready_for_release';
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const shrunk = look(page);
      for (const r of state.list) if (r.status === 'pending') r.status = 'approved';
      await clickIf(page, buttonNamed(root(), 'Refresh'));
      const grown = look(page);
      check(`${name}: a Refresh that shrinks the tab under the page lands on its last page, never an empty one past the end, and `
          + 'stays there when the tab grows again: on page 2 of Approved\'s 50, another session marks 25 ready for release, '
          + 'and Refresh shows page 1, "Showing 1 to 25 of 25 results"; then the six pending are approved, and Refresh still '
          + 'shows page 1, "Showing 1 to 25 of 31 results"',
        onPage(second, 2, 2, 26, 50, 50) && onPage(shrunk, 1, 1, 1, 25, 25) && said(shrunk.rows) === said(firstTwentyFive)
          && onPage(grown, 1, 2, 1, 25, 31) && grown.rows.length === 25,
        said({ second: brief(second), shrunk: brief(shrunk), grown: brief(grown) }));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();

      // 10 matches or fewer: no pager. 11: the pager, on one page.
      resetNet(200, answerFor(makeState('P'.repeat(10)), staff));
      page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      const ten = look(page);
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
      resetNet(200, answerFor(makeState('P'.repeat(11)), staff));
      page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      const eleven = look(page);
      const elevenSteps = [stepButton(page, 'Previous'), stepButton(page, 'Next')].map((b) => b?.getAttribute('aria-disabled') ?? null);
      check(`${name}: the pager shows from 11 matches, as on Payments: 10 pending requests, no pager at all, not even Rows per `
          + 'page; 11, the pager, "Showing 1 to 11 of 11 results", a single "1", Rows per page 25, Previous and Next unavailable',
        ten.rows.length === 10 && !ten.pager && ten.size === null
          && eleven.rows.length === 11 && onPage(eleven, 1, 1, 1, 11, 11) && eleven.numbers === '1' && eleven.size === '25'
          && said(elevenSteps) === said(['true', 'true']),
        said({ ten: { rows: ten.rows.length, pager: ten.pager, size: ten.size }, eleven: { ...brief(eleven), steps: elevenSteps } }));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();

      // The middle shape needs more than 8 pages: 95 pending requests at 10 a
      // page make 10, and page 5 is neither among the first four nor the last.
      resetNet(200, answerFor(makeState('P'.repeat(95)), staff));
      page = await globalThis.mountInteractive(root(), route);
      await page.settle();
      await setRows(page, 10);
      const shapes = [look(page)];
      await press(page, numberButton(page, 5));
      shapes.push(look(page));
      const middleGaps = page.queryAll('.pay-pager-numbers li').filter((li) => li.textContent === '…');
      await press(page, numberButton(page, 10));
      shapes.push(look(page));
      check(`${name}: above 7 pages there are always 7 slots: 95 requests at 10 a page, "1 2 3 4 5 … 10" on page 1, `
          + '"1 … 4 5 6 … 10" on page 5 (Res 041 to Res 050), with both "…" plain text, and "1 … 6 7 8 9 10" on page 10 '
          + '(Res 091 to Res 095)',
        onPage(shapes[0], 1, 10, 1, 10, 95) && shapes[0].numbers === '1 2 3 4 5 … 10'
          && onPage(shapes[1], 5, 10, 41, 50, 95) && shapes[1].numbers === '1 … 4 5 6 … 10'
          && said(shapes[1].rows) === said(names(41, 50))
          && middleGaps.length === 2 && middleGaps.every((li) => !li.querySelector('button, a, input, select, [tabindex]'))
          && onPage(shapes[2], 10, 10, 91, 95, 95) && shapes[2].numbers === '1 … 6 7 8 9 10'
          && said(shapes[2].rows) === said(names(91, 95)),
        said(shapes.map(brief)));
      methodsSent.push(...net.calls.map((c) => c.method));
      await page.unmount();
    }

    const writes = methodsSent.filter((m) => m !== 'GET');
    check('section Y sent GETs, and two POSTs, the Secretary\'s approve and mark ready for release, both answered by the fetch stub',
      methodsSent.length > 0 && said(writes) === said(['POST', 'POST']),
      `${methodsSent.length} request(s): ${[...new Set(methodsSent)].join(', ')}`);

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
