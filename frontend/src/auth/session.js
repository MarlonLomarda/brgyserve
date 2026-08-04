// Reads the `exp` claim out of a session token so an expired session can be
// dropped before it is used.
//
// THIS IS A UX GUARD, NOT A SECURITY CONTROL. The token is decoded here, never
// verified — no signature is checked and no secret is involved. The server
// verifies the signature and the expiry on every request (see
// backend/src/middleware/auth.js) and remains the only authority on whether a
// token is good. Editing localStorage to fake a later `exp` gains nothing.
//
// Session tokens are signed in backend/src/routes/auth.js with an `expiresIn`
// option, so `exp` is always present on a real one.

// The browser clock and the server clock are not the same clock. A browser
// running a minute fast must not throw away a session the server still
// accepts, so a token counts as expired only once it is past `exp` by this
// margin.
const CLOCK_SKEW_LEEWAY_SECONDS = 60;

// Returns the decoded payload, or null if the token is not a readable JWT.
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // JWTs use base64url; atob wants plain base64 with padding.
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function isTokenExpired(token, nowMs = Date.now()) {
  const payload = decodeJwtPayload(token);
  // Fail OPEN. A token that cannot be read, or one carrying no expiry, is left
  // alone so a valid session behaves exactly as it did before this check
  // existed. If such a token really is bad the server returns 401, and that
  // path now ends the session cleanly.
  if (!payload || typeof payload.exp !== 'number') return false;
  return nowMs > (payload.exp + CLOCK_SKEW_LEEWAY_SECONDS) * 1000;
}
