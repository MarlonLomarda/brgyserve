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
// with whatever status the current test wants.
const net = { calls: [], status: 200, body: { ok: true } };
global.fetch = async (url, options = {}) => {
  const auth = options.headers?.Authorization || null;
  net.calls.push({ url: String(url), token: auth ? auth.replace('Bearer ', '') : null });
  return {
    ok: net.status >= 200 && net.status < 300,
    status: net.status,
    json: async () => (net.status === 401 ? { error: 'Invalid or expired token' } : net.body),
  };
};
function resetNet(status = 200) {
  net.calls = [];
  net.status = status;
}
function seedSession(token) {
  store.data.clear();
  store.removes = 0;
  store.sets = 0;
  if (token) store.data.set(STORAGE_KEY, JSON.stringify({ token, user: USER }));
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
  check('CONTROL: a valid token still renders the logged-in view',
    !/Sign in to BrgyServe/i.test(validHtml) && validHtml.length > 0,
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

  console.error = origError;
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
});
