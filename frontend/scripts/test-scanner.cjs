// Tests for the Events 3d QR scanner's camera lifecycle.
//
//   cd frontend && npm run test:scan        (no backend required)
//
// WHY THIS EXISTS. The scanner shipped with a defect that no API test could
// see: the <video> element is only rendered once camState is 'live', but the
// stream was attached inside startCamera() while camState was still
// 'starting'. videoRef.current was null, the `if (videoRef.current)` guard
// silently skipped the attach, and the element mounted with no source. The
// camera was held open (the browser said "Using now"), the panel rendered,
// and nothing decoded — a black box with no error anywhere.
//
// The lesson is that a guard quietly skipped the only thing the function
// existed to do. So these tests assert the POSITIVE facts — a stream IS
// attached, play() IS called, frames ARE reported — rather than merely that
// nothing threw. They were confirmed to FAIL against the pre-fix component.
const path = require('path');
const fs = require('fs');
const { rolldown } = require('rolldown');
const { JSDOM } = require('jsdom');

const HERE = __dirname;
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

// --- jsdom ------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
// Node 22 ships its own read-only `navigator`, so a plain assignment is
// silently ignored and the component would see Node's, which has no
// mediaDevices at all.
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = dom.window.requestAnimationFrame;

// --- instrument the media element ------------------------------------------
const media = { srcObjectSets: [], playCalls: 0, playRejects: null, domAtGrant: null };

// Reads the state of the track that was attached, tolerating the case where
// nothing ever was. A run against broken code has to report a clean FAIL
// rather than throwing here and taking the rest of the suite with it.
const attachedTrackState = (i = 0) =>
  media.srcObjectSets[i]?.getTracks?.()[0]?.readyState ?? '(never attached)';

Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'srcObject', {
  configurable: true,
  get() { return this._srcObject ?? null; },
  set(v) { this._srcObject = v; if (v) media.srcObjectSets.push(v); },
});
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'readyState', {
  configurable: true,
  get() { return this._readyState ?? 0; },
});
for (const prop of ['videoWidth', 'videoHeight']) {
  Object.defineProperty(dom.window.HTMLVideoElement.prototype, prop, {
    configurable: true,
    get() { return this[`_${prop}`] ?? 0; },
  });
}
dom.window.HTMLMediaElement.prototype.play = function play() {
  media.playCalls += 1;
  if (media.playRejects) return Promise.reject(media.playRejects);
  return Promise.resolve();
};

// The decode loop calls getContext('2d'); jsdom has no canvas backend, so
// give it one that returns blank frames. jsQR finds nothing in them, which is
// the correct outcome — this test is about the camera, not about decoding.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    drawImage() {},
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h,
    }),
  };
};

// --- a live-looking MediaStream ---------------------------------------------
function makeStream() {
  const track = {
    kind: 'video',
    label: 'ov9734_techfront_camera',
    readyState: 'live',
    getSettings: () => ({ width: 640, height: 480 }),
    stop() { this.readyState = 'ended'; },
  };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}

let currentGetUserMedia = null;
Object.defineProperty(dom.window.navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: (...args) => currentGetUserMedia(...args) },
});
const setSecure = (value) =>
  Object.defineProperty(dom.window, 'isSecureContext', { value, configurable: true });

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scenario helper --------------------------------------------------------
async function scenario({ secure = true, getUserMedia, onScan } = {}) {
  media.srcObjectSets = [];
  media.playCalls = 0;
  media.domAtGrant = null;
  setSecure(secure);
  currentGetUserMedia = getUserMedia || (async () => makeStream().stream);

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = await globalThis.mountScanner(container, {
    onScan: onScan || (async () => ({ type: 'success', text: 'ok' })),
    onClose: () => {},
  });

  const q = (sel) => container.querySelector(sel);
  const text = (sel) => [...container.querySelectorAll(sel)].map((n) => n.textContent).join(' || ');
  const button = (re) => [...container.querySelectorAll('button')].find((b) => re.test(b.textContent));
  const click = async (el) => {
    await globalThis.act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });
    await globalThis.act(async () => { await flush(); });
  };

  return {
    container, root, q, text, button, click,
    async startCamera() { await this.click(button(/start camera|try the camera again/i)); },
    async settle(ms) { await globalThis.act(async () => { await wait(ms); }); },
    cleanup: async () => {
      await globalThis.act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

(async () => {
  const out = path.join(HERE, '.scanner-bundle.cjs');
  const bundle = await rolldown({
    input: path.join(HERE, 'scanner-entry.jsx'),
    platform: 'node',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    onwarn: () => {},
  });
  await bundle.write({ file: out, format: 'cjs' });
  await bundle.close();
  require(out);
  check('the real AttendanceScanner bundled and loaded', typeof globalThis.mountScanner === 'function');

  const origError = console.error;
  const origInfo = console.info;
  console.error = () => {};
  console.info = () => {}; // the component's own camera diagnostics

  const WATCHDOG_MS = globalThis.scannerModule?.FRAME_WATCHDOG_MS ?? 3000;

  // =========================================================================
  section('THE DEFECT: the acquired stream must reach the <video> element');
  // =========================================================================
  {
    const s = await scenario();
    check('before starting, the placeholder shows and there is no <video>',
      !s.q('video') && !!s.q('.scan-placeholder'));

    await s.startCamera();

    const video = s.q('video');
    check('the <video> element is mounted once the camera is live', !!video);
    check('the stream IS attached to it', media.srcObjectSets.length === 1,
      `${media.srcObjectSets.length} srcObject assignment(s)`);
    check('  and it is attached to the element actually in the DOM',
      !!video?.srcObject && video.srcObject === media.srcObjectSets[0]);
    check('play() IS called', media.playCalls === 1, `${media.playCalls} call(s)`);
    await s.cleanup();
  }

  // =========================================================================
  section('the element carries what Chromium needs to autoplay a MediaStream');
  // =========================================================================
  {
    const s = await scenario();
    await s.startCamera();
    const video = s.q('video');
    check('autoplay attribute present', video?.hasAttribute('autoplay'));
    check('playsinline attribute present', video?.hasAttribute('playsinline'));
    // React assigns muted as a PROPERTY, not an attribute; the property is
    // what the autoplay policy evaluates.
    check('muted is set as a property', video?.muted === true);
    await s.cleanup();
  }

  // =========================================================================
  section('frames arriving is reported, not assumed');
  // =========================================================================
  {
    const s = await scenario();
    await s.startCamera();
    const video = s.q('video');
    check('no resolution is claimed before any frame arrives', !s.q('.scan-status'));

    await globalThis.act(async () => {
      video._videoWidth = 640;
      video._videoHeight = 480;
      video._readyState = 4;
      video.dispatchEvent(new dom.window.Event('loadedmetadata'));
      await flush();
    });
    check('the live resolution is shown once frames arrive', !!s.q('.scan-status'),
      s.text('.scan-status'));
    check('  and it reports the real dimensions', /640/.test(s.text('.scan-status')) && /480/.test(s.text('.scan-status')),
      s.text('.scan-status'));
    await s.cleanup();
  }

  // =========================================================================
  section('a stream that never delivers frames reports itself');
  // =========================================================================
  {
    const s = await scenario();
    await s.startCamera();
    check('still showing the camera immediately after starting', !!s.q('video'));

    await s.settle(WATCHDOG_MS + 250);

    const alerts = s.text('.alert');
    check('the watchdog fires instead of leaving a black box', /no video|no frames/i.test(alerts), alerts);
    check('  and it points at the typed-token box as the way forward',
      /token box below|token below/i.test(alerts), alerts);
    check('  the camera is released so the device is not held open',
      attachedTrackState() === 'ended', attachedTrackState());
    check('  the token box is still usable', !!s.q('#qr-token'));
    await s.cleanup();
  }

  // =========================================================================
  section('a blocked play() is surfaced, never swallowed');
  // =========================================================================
  {
    media.playRejects = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    const s = await scenario();
    await s.startCamera();
    await s.settle(50);

    const alerts = s.text('.alert');
    check('the rejection reaches the operator', /could not be played/i.test(alerts), alerts);
    check('  it names the underlying reason', /NotAllowedError/.test(alerts), alerts);
    check('  and points at the typed-token box',
      /token box below|token below/i.test(alerts), alerts);
    check('  the camera is released', attachedTrackState() === 'ended', attachedTrackState());
    await s.cleanup();
    media.playRejects = null;
  }

  // =========================================================================
  section('the paths that never reach a camera at all');
  // =========================================================================
  {
    const s = await scenario({ secure: false });
    await s.startCamera();
    const alerts = s.text('.alert');
    check('an insecure context explains itself', /secure|https/i.test(alerts), alerts);
    check('  and points at the typed-token box', /token box below|token below/i.test(alerts), alerts);
    check('  no <video> is left showing a black box', !s.q('video'));
    await s.cleanup();
  }
  {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const s = await scenario({ getUserMedia: async () => { throw denied; } });
    await s.startCamera();
    const alerts = s.text('.alert');
    check('a refused permission explains itself', /refused|allow it/i.test(alerts), alerts);
    check('  and points at the typed-token box', /token box below|token below/i.test(alerts), alerts);
    await s.cleanup();
  }

  // =========================================================================
  section('the typed fallback works with no camera involved');
  // =========================================================================
  {
    const sent = [];
    const s = await scenario({
      onScan: async (token) => { sent.push(token); return { type: 'success', text: `recorded ${token}` }; },
    });
    check('the token box is available without starting the camera', !!s.q('#qr-token'));

    const input = s.q('#qr-token');
    await globalThis.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '326de832-2fce-4cd1-832f-0e2a63fc994a');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await flush();
    });
    await globalThis.act(async () => {
      s.q('form.scan-manual').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      await flush();
    });
    check('submitting a typed token calls onScan exactly once', sent.length === 1, JSON.stringify(sent));
    check('  with the token verbatim', sent[0] === '326de832-2fce-4cd1-832f-0e2a63fc994a');
    check('  and the outcome is shown', /recorded/.test(s.text('.alert')), s.text('.alert'));
    await s.cleanup();
  }

  // =========================================================================
  section('the camera is always released');
  // =========================================================================
  {
    const s = await scenario();
    await s.startCamera();
    check('the track is live while scanning', attachedTrackState() === 'live', attachedTrackState());
    await s.cleanup();
    check('unmounting stops the track', attachedTrackState() === 'ended', attachedTrackState());
  }
  {
    const s = await scenario();
    await s.startCamera();
    await s.click(s.button(/close scanner/i));
    check('closing the panel stops the track', attachedTrackState() === 'ended', attachedTrackState());
    await s.cleanup();
  }

  console.error = origError;
  console.info = origInfo;
  fs.rmSync(out, { force: true });
  console.log(`\n${fail === 0 ? `ALL PASSED (${pass})` : `${fail} FAILED, ${pass} passed`}`);
})()
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  })
  // The scanner's decode loop is an interval; if a scenario failed before its
  // cleanup ran, that interval would hold the event loop open forever. Exit on
  // the recorded result rather than waiting for the loop to drain.
  .finally(() => process.exit(process.exitCode ? 1 : 0));
