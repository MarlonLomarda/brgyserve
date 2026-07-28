// Render test for the Reporting module.
//
// The API tests confirm the endpoints return correct JSON; this confirms the
// components can actually RENDER it. That gap is not theoretical — a payload
// from one report was briefly handed to another report's renderer, which
// threw and blanked the whole content area in the browser while every API
// test still passed.
//
// Bundles the real components with the project's own bundler (rolldown, via
// Vite), server-renders each against LIVE API data, and mounts the
// ErrorBoundary in jsdom (boundaries do not catch during SSR).
//
// Requires the backend running on :5000 with the usual test accounts.
//   cd frontend && npm run test:reports

const path = require('path');
const { rolldown } = require('rolldown');

const BASE = process.env.VITE_API_URL || 'http://localhost:5000/api';
const HERE = __dirname;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}
const login = (u, p) =>
  fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  })
    .then((r) => r.json())
    .then((d) => d.token);
const get = (p, t) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());

const SECRETARY = ['secretary1', 'UbujanSec-7324d66f!'];
const TREASURER = ['treasurer_test_mr8zecuq', 'MyNewSecret-123'];

(async () => {
  // 1) bundle the real components (JSX -> CJS) so Node can execute them
  const out = path.join(HERE, '.report-render-bundle.cjs');
  const REACT_PKGS = ['react', 'react-dom', 'react-dom/server', 'react-dom/client', 'react/jsx-runtime'];
  const bundle = await rolldown({
    input: path.join(HERE, 'report-render-entry.jsx'),
    platform: 'node',
    external: REACT_PKGS,
    onwarn: () => {},
  });
  await bundle.write({ file: out, format: 'cjs' });
  await bundle.close();
  require(out);
  check('report components bundled and loaded', typeof globalThis.renderReport === 'function');
  check('all four renderers registered', globalThis.rendererKeys.length === 4, globalThis.rendererKeys.join(', '));

  // 2) real payloads from the live API
  const sec = await login(...SECRETARY);
  const tre = await login(...TREASURER);
  if (!sec || !tre) {
    console.log('\nCould not log in — is the backend running on :5000 with the test accounts?');
    process.exitCode = 1;
    return;
  }
  const owner = { 'document-requests': sec, residents: sec, 'facility-utilization': sec, collections: tre };
  const payloads = {};
  for (const [key, tok] of Object.entries(owner)) payloads[key] = await get(`/reports/${key}`, tok);
  check('fetched all four live payloads', Object.values(payloads).every((p) => p && p.totals));

  // 3) mount every report with its OWN live data
  const expectText = {
    'document-requests': 'By document type',
    residents: 'By civil status',
    'facility-utilization': 'By item',
    collections: 'By payment method',
  };
  for (const key of Object.keys(payloads)) {
    const r = globalThis.renderReport(key, payloads[key]);
    check(`RENDER ${key} with live data`, r.ok, r.error || `${r.html.length} chars of HTML`);
    if (r.ok) {
      check(`  ${key}: renders its own tables`, r.html.includes(expectText[key]));
      // recharts' ResponsiveContainer has no width during SSR, so the SVG
      // geometry only exists in a real browser; what IS verifiable here is
      // that a chart container was emitted for every chart.
      const charts = (r.html.match(/class="chart-card"/g) || []).length;
      check(`  ${key}: emits chart containers`, charts > 0, `${charts} chart card(s)`);
    }
  }

  // 4) regression guard for the blank-page bug: one report's data in another
  //    report's renderer must fail loudly, never silently
  const cross = globalThis.renderReport('residents', payloads['document-requests']);
  check('cross-report data throws (blank-page regression guard)', !cross.ok,
    cross.ok ? 'DID NOT THROW — are the shapes interchangeable?' : cross.error);
  const cross2 = globalThis.renderReport('facility-utilization', payloads['document-requests']);
  check('facility with foreign data throws too', !cross2.ok, cross2.error);

  // 4b) ErrorBoundary — real client mount, since boundaries do not catch in SSR
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = dom.window.document.getElementById('root');
  const origError = console.error;
  console.error = () => {}; // React logs the caught error; keep output readable

  const badHtml = await globalThis.mountGuarded('residents', payloads['document-requests'], root);
  check('ErrorBoundary catches the bad render (no blank screen)',
    /could not be displayed/i.test(badHtml), badHtml.slice(0, 80).replace(/\s+/g, ' '));
  check('ErrorBoundary surfaces the underlying error message', badHtml.includes('map'));
  const goodHtml = await globalThis.mountGuarded('residents', payloads.residents, root);
  check('ErrorBoundary is transparent when the report is fine',
    goodHtml.includes('By civil status') && !/could not be displayed/i.test(goodHtml));
  console.error = origError;

  // 5) an empty date range must render the components, not crash them
  const emptyRange = 'from=1990-01-01&to=1990-12-31';
  for (const [key, tok] of Object.entries(owner)) {
    const data = await get(`/reports/${key}?${emptyRange}`, tok);
    const empty = globalThis.isEmptyFn(key, data);
    const r = globalThis.renderReport(key, data);
    check(`EMPTY range ${key}: isEmpty=${empty}, renders without throwing`, r.ok, r.error || 'ok');
  }

  // 6) isEmpty must never throw, whatever it is handed
  check('isEmpty(null) is true, no throw', globalThis.isEmptyFn('residents', null) === true);
  check('isEmpty on a foreign payload does not throw', (() => {
    try {
      globalThis.isEmptyFn('residents', payloads['document-requests']);
      return true;
    } catch {
      return false;
    }
  })());
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
});
