// DEV ONLY — public HTTPS tunnel for PayMongo webhooks.
//
// PayMongo confirms a GCash payment by calling a webhook, which needs a
// publicly reachable HTTPS url, but development runs on localhost:5000. This
// starts a cloudflared quick tunnel and points the (single, permanent)
// PayMongo webhook at whatever random *.trycloudflare.com hostname it gets,
// so the whole thing is one command instead of a manual chore per session.
//
// Run it AFTER `npm run dev`, from /backend:
//     npm run tunnel
// Leave it running. Restarting the API does NOT need the tunnel restarted —
// cloudflared forwards to a port, not a process — so the url only changes
// when this script is restarted, roughly once per work session.
//
// Quick tunnels are testing-only by Cloudflare's own documentation (no uptime
// guarantee). When the API is deployed, none of this is needed: set
// PUBLIC_BASE_URL to the deployed origin and run `npm run tunnel:sync` once to
// repoint the webhook, then drop the tunnel from the workflow.
require('dotenv').config();

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const { syncWebhook } = require('./paymongoWebhook');

const BACKEND_PORT = process.env.PORT || 5000;
// Pinned so the hostname can be read from cloudflared's metrics server rather
// than scraped out of its log output; it picks a random port otherwise.
const METRICS = process.env.CLOUDFLARED_METRICS || '127.0.0.1:20241';
const HOSTNAME_TIMEOUT_MS = 60000;
// Measured behaviour, not paranoia: quick tunnels sometimes come back with a
// hostname Cloudflare never publishes in DNS, and that hostname never
// recovers — so wait only briefly before discarding it.
const READY_TIMEOUT_MS = 45000;
const TUNNEL_ATTEMPTS = 3;
// Requesting tunnels back-to-back makes this MORE likely, not less (every
// spaced-out tunnel worked; every rapid one failed), which reads like a soft
// throttle on rapid creation. So pause before asking for another.
const RETRY_BACKOFF_MS = 30000;

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    // Fall back to PATH (also covers non-Windows).
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    throw new Error(
      'cloudflared not found. Install it with:  winget install --id Cloudflare.cloudflared\n' +
      'or set CLOUDFLARED_PATH in backend/.env to its full path.'
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cloudflared exposes the assigned hostname at /quicktunnel on its metrics
// server once the tunnel is registered.
async function waitForHostname(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${METRICS}/quicktunnel`);
      const body = await res.json();
      if (body?.hostname) return `https://${body.hostname}`;
    } catch { /* metrics server not up yet */ }
    await sleep(500);
  }
  return null;
}

// Any HTTP status means DNS resolved and Cloudflare's edge is routing to the
// tunnel — which is all PayMongo needs to accept the url. A 502 only means the
// API itself is down, which is reported separately.
async function waitForTunnelLive(base, deadline) {
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

// Reuse a cloudflared that is already running (started by hand, or left over
// from a previous session) instead of starting a second tunnel. Also the
// escape hatch if spawning one from here misbehaves: run
//     cloudflared tunnel --url http://localhost:5000 --metrics 127.0.0.1:20241
// in its own terminal and this picks it up.
async function findExistingTunnel() {
  try {
    const body = await fetch(`http://${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json());
    if (!body?.hostname) return null;
    const base = `https://${body.hostname}`;
    return (await waitForTunnelLive(base, Date.now() + 10000)) ? base : null;
  } catch {
    return null;
  }
}

// Starts one tunnel and returns it only if its hostname actually resolves;
// otherwise cleans the process up so the next attempt starts fresh.
async function startTunnel(bin) {
  const child = spawn(bin, [
    'tunnel',
    '--url', `http://localhost:${BACKEND_PORT}`,
    '--metrics', METRICS,
    '--no-autoupdate',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // cloudflared logs to stderr; surface only genuine errors so the useful
  // output isn't buried in connection chatter.
  child.stderr.on('data', (d) => {
    const text = d.toString();
    if (/ERR|error/.test(text) && !/INF/.test(text)) process.stderr.write(text);
  });

  const discard = async (reason) => {
    console.log(`             ${reason}`);
    child.kill();
    await sleep(2000); // let the metrics port free up before retrying
    return null;
  };

  const base = await waitForHostname(Date.now() + HOSTNAME_TIMEOUT_MS);
  if (!base) return discard('cloudflared never reported a hostname');

  console.log(`tunnel up:   ${base}`);
  if (!(await waitForTunnelLive(base, Date.now() + READY_TIMEOUT_MS))) {
    return discard('hostname never resolved (Cloudflare did not publish it) — discarding');
  }
  return { child, base };
}

// PayMongo occasionally still rejects a just-published hostname; retry only
// that specific error rather than masking real failures.
async function withResolveRetry(fn, attempts = 4) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !/could not be resolved/i.test(e.message)) throw e;
      console.log(`  PayMongo could not resolve the url yet — retrying (${i}/${attempts - 1})`);
      await sleep(5000);
    }
  }
}

(async () => {
  const bin = findCloudflared();
  console.log(`cloudflared: ${bin}`);
  console.log(`forwarding:  http://localhost:${BACKEND_PORT}\n`);

  let child = null;
  let base = await findExistingTunnel();
  if (base) {
    console.log(`tunnel up:   ${base}  (reusing the cloudflared already running on ${METRICS})`);
  } else {
    let tunnel = null;
    for (let attempt = 1; attempt <= TUNNEL_ATTEMPTS && !tunnel; attempt += 1) {
      if (attempt > 1) {
        console.log(`\nwaiting ${RETRY_BACKOFF_MS / 1000}s before requesting another tunnel...`);
        await sleep(RETRY_BACKOFF_MS);
        console.log(`attempt ${attempt} of ${TUNNEL_ATTEMPTS}:`);
      }
      tunnel = await startTunnel(bin);
    }
    if (!tunnel) {
      throw new Error(
        `Could not get a working tunnel in ${TUNNEL_ATTEMPTS} attempts.\n` +
        'Quick tunnels have no uptime guarantee. Either run this again, or start\n' +
        'cloudflared yourself in another terminal and re-run — this reuses it:\n' +
        `  cloudflared tunnel --url http://localhost:${BACKEND_PORT} --metrics ${METRICS}`
      );
    }
    ({ child, base } = tunnel);

    // Only now does an exit mean something is wrong.
    child.on('exit', (code) => {
      console.error(`\ncloudflared exited (code ${code}). The webhook url is dead until you restart this.`);
      process.exit(code ?? 1);
    });
  }

  try {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body.status) {
      console.log(`health:      HTTP 200 — ${body.status} (${body.supabase})\n`);
    } else {
      console.warn(`health:      tunnel is live but the API answered HTTP ${res.status} — is \`npm run dev\` running?\n`);
    }
  } catch (e) {
    console.warn(`health:      could not read /api/health (${e.message})\n`);
  }

  console.log('PayMongo webhook:');
  const hook = await withResolveRetry(() => syncWebhook(base));
  console.log(`  id:          ${hook.id}`);
  console.log(`  url:         ${hook.url}`);
  console.log(`  status:      ${hook.status}`);
  console.log(`  events:      ${hook.events.join(', ')}`);
  console.log(`  livemode:    ${hook.livemode}  ${hook.livemode ? '*** LIVE — expected false in development ***' : '(test mode)'}`);
  console.log(`  secret:      fingerprint ${hook.secretFingerprint} (value written to backend/.env, never printed)`);
  if (hook.secretRotated) {
    console.log('\n  !! The webhook secret CHANGED — restart `npm run dev` so the API picks it up.');
  }
  console.log(
    child
      ? '\nReady. Leave this running; press Ctrl+C to stop the tunnel.'
      : '\nReady. Nothing needs to stay running here — the tunnel is in its own terminal.\n' +
        'Re-run this after restarting that tunnel to repoint the webhook.'
  );

  const shutdown = () => {
    if (child) child.kill(); // never kill a tunnel we did not start
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
