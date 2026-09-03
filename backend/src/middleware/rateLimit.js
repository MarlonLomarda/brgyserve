const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// ===========================================================================
// RATE LIMITING — the unauthenticated auth routes only.
//
// These live here rather than inline in routes/auth.js for the same reason
// the constants files exist: the limits, the wording and the key are one
// subject, and a limiter defined beside the handler it guards drifts from its
// siblings. routes/auth.js mounts them; it does not configure them.
//
// WHY THE AUTH ROUTES AND NOTHING ELSE. Every other router in this API is
// behind `authenticate`, so an attacker needs a valid session before they can
// spend anything. `/login`, `/register` and `/forgot-password` are the only
// routes reachable with no credentials at all — /login is an unlimited
// password oracle, /register writes rows to `users` AND `profiles` on every
// call, and /forgot-password has an outbound, metered side effect.
//
// THIS DOES NOT REPLACE THE FORGOT-PASSWORD COOLDOWN in routes/auth.js. That
// one keys on a resolved `user_id` and lives in the `password_resets` table,
// so it survives a restart and limits EMAILS SENT. This one keys on the
// caller's address and lives in memory, so it limits REQUESTS MADE. They
// answer different questions and both are wanted: the cooldown does nothing
// about a caller cycling a thousand addresses that do not exist, and this
// limiter does nothing about one account being targeted from many networks.
//
// THE STORE IS IN MEMORY, AND THE COUNTERS RESET ON EVERY COLD START. Render's
// free tier sleeps after about 15 minutes idle and a wake is a fresh Node
// process, as is every deploy. That matters less than it sounds for a
// sustained attacker — they keep the instance awake by attacking it, so the
// idle timer never fires, and going quiet for 15 minutes to clear a counter
// is the outcome the limiter wanted anyway. What it does cost is the record:
// after a redeploy there is nothing to show anyone was ever limited.
// ===========================================================================

// ---------------------------------------------------------------------------
// THE KEY
//
// `cf-connecting-ip` FIRST, and it is trustworthy here specifically because
// Cloudflare rejects a client-supplied one at the edge with error 1000 — a
// forged header never reaches this process. Measured, not assumed.
//
// `x-forwarded-for` is deliberately NOT read directly. A forged one is
// PREPENDED to the real chain rather than rejected, so its leftmost entry is
// caller-controlled and must never be trusted. `req.ip` is the safe way to
// read that header, because `trust proxy` (server.js) tells Express how many
// hops to count in from the socket rather than believing the left end.
//
// ipKeyGenerator() is the library's own helper and is applied to BOTH
// branches. It masks IPv6 to a /56 so one customer's allocation cannot be
// rotated for fresh buckets — verified: 2001:db8:...:5678 -> 2001:db8:1234:5600::/56,
// while IPv4 and IPv4-mapped addresses pass through unchanged. Calling it also
// keeps the library's own ERR_ERL_KEY_GEN_IPV6 check quiet, which fires on a
// custom keyGenerator that touches req.ip without it.
// ---------------------------------------------------------------------------
function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  const address = typeof cf === 'string' && cf.trim() ? cf.trim() : req.ip;
  // Neither available is not a normal state — it means the request arrived
  // with no socket address, which should not happen behind a proxy. Pooling
  // those into one bucket fails CLOSED (they share a limit) rather than open
  // (an undefined key, which the store would treat as its own bucket).
  if (!address) return 'unknown';
  return ipKeyGenerator(address);
}

// How long the caller is being asked to wait, derived from the window so the
// sentence and the setting cannot drift apart.
function waitPhrase(windowMs) {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

// ---------------------------------------------------------------------------
// EVERY LIMITER ANSWERS WITH JSON, NEVER THE LIBRARY'S PLAIN-TEXT DEFAULT.
//
// The default body is the string "Too many requests, please try again later."
// frontend/src/api/client.js:31 calls res.json() on it, that throws, `data`
// stays null, and line 37 falls back to "Request failed (429)" — a message
// that reads like a bug rather than a policy. A { error } object is what
// reaches the screen intact.
// ---------------------------------------------------------------------------
function authLimiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: clientKey,
    skipSuccessfulRequests,
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json({ error: message });
    },
  });
}

// 5 attempts per 15 minutes.
//
// skipSuccessfulRequests: a response under 400 is decremented back off the
// counter when it finishes, so a resident who signs in correctly on the fifth
// try is not left one attempt from a lockout. It counts by STATUS, so a 401
// (wrong password) counts and — worth knowing — so does a 403 from an
// inactive, pending or rejected account, even with the correct password.
// See the note in routes/auth.js above the mount.
const loginLimiter = authLimiter({
  windowMs: 15 * 60_000,
  limit: 5,
  skipSuccessfulRequests: true,
  message:
    `Too many sign-in attempts from this connection. Please wait ${waitPhrase(15 * 60_000)} and try again, ` +
    'or use "Forgot your password?" if you cannot remember it.',
});

// 5 per hour. Deliberately tighter than login in practice: a real person
// registers once, so a second attempt is a typo and a sixth is not a person.
const registerLimiter = authLimiter({
  windowMs: 60 * 60_000,
  limit: 5,
  message:
    `Too many registration attempts from this connection. Please wait ${waitPhrase(60 * 60_000)} and try again. ` +
    'If you already registered, your account is waiting for the Barangay Secretary to review it.',
});

// 10 per hour.
//
// THE WORDING MUST NOT VARY WITH WHETHER AN ACCOUNT EXISTS, and structurally
// it cannot: this limiter is mounted BEFORE the handler, so it has never
// looked at the address and has nothing to vary on. That is the same property
// FORGOT_PASSWORD_RESPONSE protects on the success path — see
// constants/passwordReset.js — and it would be undone by a limiter that only
// fired for real accounts.
const forgotPasswordLimiter = authLimiter({
  windowMs: 60 * 60_000,
  limit: 10,
  message:
    `Too many password reset requests from this connection. Please wait ${waitPhrase(60 * 60_000)} and try again. ` +
    'If you already requested a link, please check your inbox and your spam folder.',
});

module.exports = { loginLimiter, registerLimiter, forgotPasswordLimiter, clientKey, waitPhrase };
