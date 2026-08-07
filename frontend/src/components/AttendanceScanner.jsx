import jsQR from 'jsqr';
import { useCallback, useEffect, useRef, useState } from 'react';

// ===========================================================================
// EVENTS STAGE 3d — scanning a household QR code at an assembly.
//
// Decoding happens here; recording does not. This component turns camera
// frames (or typed characters) into a token and hands it to `onScan`, which
// owns the request. So the scanner cannot record anything the roster's
// "Mark present" button could not, and there is one place attendance is
// written rather than two.
//
// THE TYPED FALLBACK IS NOT A SECOND-CLASS PATH. The camera needs a secure
// context (https or localhost), so over plain http on a phone it is blocked
// outright by the browser — and permission can be refused, hardware can be
// missing, and a printed code can be too worn to read. Every one of those
// ends at the same input box, always visible, never hidden behind an error.
// ===========================================================================

// The same code sits in front of the lens for seconds at a time. Repeats are
// harmless server-side (the unique constraint makes them a no-op), so this
// only stops the request flood — and the timer is refreshed while the code
// stays in view, meaning a token is re-sent only after it has left and
// returned.
const REPEAT_SCAN_COOLDOWN_MS = 4000;
const DECODE_INTERVAL_MS = 200;
// Decoding gains nothing above this width, and a full-resolution frame costs
// real time on the phone this is used from.
const MAX_FRAME_WIDTH = 640;

// How long a live camera may go without producing a single frame before the
// panel stops trusting it. A camera can be granted, opened and held while
// delivering nothing — from here that is indistinguishable from success, and
// it renders as a black box. Exported so the tests read this value rather
// than keeping their own copy of it.
export const FRAME_WATCHDOG_MS = 3000;

// Every camera failure ends at the same place: the token box. During an
// assembly the operator needs to keep recording, not debug a webcam, so each
// message names that box as the way forward rather than just reporting a fault.
function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access was refused. Allow it in your browser settings, or use the token box below.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device. Use the token box below instead.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is being used by another app. Close it and try again, or use the token box below.';
    case 'OverconstrainedError':
      return 'No usable camera was found. Use the token box below instead.';
    default:
      return `The camera could not be started (${err?.name || 'unknown error'}). Use the token box below instead.`;
  }
}

export default function AttendanceScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const mountedRef = useRef(true);
  // A read is in flight — pause decoding so one code cannot queue several
  // requests while the first is still going.
  const busyRef = useRef(false);
  const lastScanRef = useRef({ token: null, at: 0 });

  const [camState, setCamState] = useState('idle'); // idle | starting | live | error
  const [camError, setCamError] = useState('');
  // Dimensions of the first decoded frame, or null if none has arrived. This
  // is the ONLY positive evidence the camera is actually working, so it is
  // shown on screen instead of being inferred from the absence of an error.
  const [frameSize, setFrameSize] = useState(null);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      // Every track must be stopped or the camera indicator stays lit after
      // the panel is closed.
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  const startCamera = useCallback(async () => {
    setCamError('');
    setResult(null);

    if (!window.isSecureContext) {
      setCamState('error');
      setCamError(
        'Browsers only allow camera access over a secure (https) connection. ' +
          'On a phone opening this over plain http, use the token box below.'
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamState('error');
      setCamError('This browser cannot open a camera. Type the token below instead.');
      return;
    }

    setCamState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `ideal`, not `exact`: a laptop with only a front camera should still
        // work rather than failing the whole request.
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      // The panel may have been closed while permission was being granted.
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      // The <video> element does not exist yet — it is only rendered once
      // camState is 'live' — so the stream CANNOT be attached here.
      // videoRef.current is null at this point. Attaching happens in the
      // effect below, which runs after the element has been committed.
      setFrameSize(null);
      setCamState('live');
    } catch (err) {
      if (!mountedRef.current) return;
      setCamState('error');
      setCamError(describeCameraError(err));
    }
  }, []);

  // Attach the stream once the <video> is actually in the DOM.
  //
  // This effect exists because of a real defect: the attach used to live in
  // startCamera(), guarded by `if (videoRef.current)`. The element was not
  // mounted yet, so the guard was always false and silently skipped the only
  // thing that mattered — the camera stayed open, the panel rendered, and
  // nothing ever decoded. An effect keyed on camState is the first moment the
  // element can be reached.
  useEffect(() => {
    if (camState !== 'live') return undefined;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return undefined;

    video.srcObject = stream;

    const track = stream.getTracks?.()[0];
    // What the browser actually handed over. A camera fault is invisible in a
    // screenshot, so leave a trail that identifies the device and its settings.
    console.info('[scanner] stream attached', {
      label: track?.label,
      readyState: track?.readyState,
      settings: track?.getSettings?.(),
    });

    let cancelled = false;
    video.play().catch((err) => {
      if (cancelled) return;
      // Deliberately NOT swallowed. A rejected play() leaves a stream attached
      // that never renders and never decodes, which looks exactly like a dead
      // camera and reports nothing.
      console.warn('[scanner] play() rejected', err);
      stopCamera();
      setCamState('error');
      setCamError(
        `The camera stream could not be played (${err?.name || 'unknown error'}). ` +
          'Use the token box below to keep recording.'
      );
    });
    return () => {
      cancelled = true;
    };
  }, [camState, stopCamera]);

  // A camera can be granted, opened and held while delivering no frames at
  // all — a driver that grabs the device and produces nothing looks identical
  // to success from here. Without this the panel just shows a black box, which
  // is the exact failure this component already had once. The timer is
  // cancelled as soon as a frame arrives, so a merely slow camera is fine.
  useEffect(() => {
    if (camState !== 'live' || frameSize) return undefined;
    const timer = setTimeout(() => {
      // videoWidth is the authority — metadata events can be missed.
      if (videoRef.current?.videoWidth) return;
      const track = streamRef.current?.getTracks?.()[0];
      console.warn(`[scanner] no frames after ${FRAME_WATCHDOG_MS}ms`, {
        label: track?.label,
        readyState: track?.readyState,
      });
      stopCamera();
      setCamState('error');
      setCamError(
        'The camera opened but sent no video. Use the token box below to keep recording — ' +
          'you can try the camera again afterwards.'
      );
    }, FRAME_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [camState, frameSize, stopCamera]);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    setFrameSize({ width: video.videoWidth, height: video.videoHeight });
  }

  const send = useCallback(
    async (token) => {
      busyRef.current = true;
      setResult({ type: 'info', text: 'Recording…' });
      try {
        const outcome = await onScan(token);
        if (mountedRef.current) setResult(outcome);
      } finally {
        busyRef.current = false;
      }
    },
    [onScan]
  );

  const handleDecoded = useCallback(
    (token) => {
      if (!token) return;
      const now = Date.now();
      if (lastScanRef.current.token === token && now - lastScanRef.current.at < REPEAT_SCAN_COOLDOWN_MS) {
        // Still the same code in view — keep the cooldown alive rather than
        // letting it lapse and re-sending while nothing has changed.
        lastScanRef.current.at = now;
        return;
      }
      lastScanRef.current = { token, at: now };
      send(token);
    },
    [send]
  );

  const readFrame = useCallback(() => {
    if (busyRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return;

    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height);
    // Our codes are the standard dark-on-light, so skipping the inverted pass
    // halves the work per frame.
    const found = jsQR(frame.data, width, height, { inversionAttempts: 'dontInvert' });
    if (found?.data) handleDecoded(found.data.trim());
  }, [handleDecoded]);

  useEffect(() => {
    if (camState !== 'live') return undefined;
    const timer = setInterval(readFrame, DECODE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [camState, readFrame]);

  function submitTyped(e) {
    e.preventDefault();
    const token = typed.trim();
    if (!token) return;
    // Typing the same token twice is a deliberate act, so the cooldown that
    // exists for the camera must not swallow it.
    lastScanRef.current = { token: null, at: 0 };
    setTyped('');
    send(token);
  }

  function close() {
    stopCamera();
    setCamState('idle');
    setFrameSize(null);
    onClose();
  }

  return (
    <div className="scan-panel">
      <div className="pending-head">
        <div>
          <h4>Scan household QR</h4>
          <p className="muted small-note">
            Point the camera at the code on the resident&rsquo;s phone. Scanning the same code twice
            is harmless.
          </p>
        </div>
        <button className="btn secondary" type="button" onClick={close}>
          Close scanner
        </button>
      </div>

      {result && <div className={`alert ${result.type}`}>{result.text}</div>}

      {camState === 'live' ? (
        <>
          <div className="scan-stage">
            <video
              ref={videoRef}
              className="scan-video"
              autoPlay
              playsInline
              muted
              onLoadedMetadata={handleLoadedMetadata}
            />
            {/* Purely a sighting aid — the decoder reads the whole frame. */}
            <div className="scan-reticle" aria-hidden="true" />
          </div>
          {/* Proof frames are arriving, rather than leaving "is this working?"
              to be guessed from a dark rectangle. */}
          {frameSize && (
            <p className="scan-status muted small-note">
              Camera live — {frameSize.width} × {frameSize.height}
            </p>
          )}
        </>
      ) : (
        <div className="scan-placeholder">
          {camState === 'starting' ? (
            <p className="muted">Starting the camera…</p>
          ) : (
            <button className="btn" type="button" onClick={startCamera}>
              {camState === 'error' ? 'Try the camera again' : 'Start camera'}
            </button>
          )}
        </div>
      )}

      {camError && <div className="alert info">{camError}</div>}

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <form className="scan-manual" onSubmit={submitTyped}>
        <label htmlFor="qr-token">Or type the token under the code</label>
        <div className="head-actions">
          <input
            id="qr-token"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="e.g. 326de832-2fce-4cd1-832f-0e2a63fc994a"
            autoComplete="off"
            spellCheck="false"
          />
          <button className="btn secondary" type="submit" disabled={!typed.trim()}>
            Record
          </button>
        </div>
      </form>
    </div>
  );
}
