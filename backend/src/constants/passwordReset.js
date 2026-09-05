// Canonical vocabulary and tuning for password reset.
//
// Single source of truth, and it is not decoration: the neutral response below
// is compared BYTE FOR BYTE by scripts/test-password-reset.js across every
// branch of the forgot-password route. Pinning it here is what makes that
// assertion possible — two hand-written copies of "the same" sentence in two
// branches is exactly how an enumeration oracle gets built by accident.

const crypto = require('crypto');

// ===========================================================================
// TOKENS
//
// 32 random bytes, base64url-encoded to 43 characters — 256 bits of entropy.
// Stored as a SHA-256 hash (64 hex characters, which is what makes
// password_resets.token_hash varchar(64)); the raw token exists only in the
// email and in the resident's URL bar.
//
// THE FAST HASH IS DELIBERATE, AND IT IS THE OPPOSITE OF THE PASSWORD RULE.
// bcrypt is slow on purpose because a password is low-entropy and guessable,
// so making each guess expensive is the whole defence. A 256-bit random token
// is not guessable at any price, so slowness buys nothing and only makes
// verification expensive on a route that anyone can call unauthenticated.
//
// household_qr.qr_token IS STORED RAW, and that is a different case rather
// than an inconsistency: it is a long-lived identifier that gets scanned
// repeatedly and grants no account access, while a reset token IS the account
// password for as long as it lives.
// ===========================================================================

const TOKEN_BYTES = 32;

const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// How long a link works. Long enough to survive a slow mail delivery and a
// resident who reads their email an hour later; short enough that an old email
// sitting in an inbox is not a standing key to the account.
const TOKEN_TTL_MINUTES = 60;

// Per-user cooldown between reset requests, counted against password_resets
// rather than an in-memory counter, so it survives a restart.
//
// THIS IS NOT THE SAME THING AS forgotPasswordLimiter, and neither replaces
// the other. This cooldown keys on a resolved user_id and limits EMAILS SENT
// TO ONE ACCOUNT; the limiter in middleware/rateLimit.js keys on the caller's
// address and limits REQUESTS MADE FROM ONE CONNECTION. The cooldown does
// nothing about a caller cycling a thousand addresses that do not exist, and
// the limiter does nothing about one account targeted from many networks.
//
// (This comment used to say "there is no rate limiting anywhere in this API".
// That was true when it was written and stopped being true in 71bfc37, which
// added limiters to /login, /register and /forgot-password.)
//
// What the cooldown stops is the realistic case: someone hammering the form
// and burning the Resend free-tier quota (100/day, 3,000/month) for the whole
// barangay. It does NOT stop distributed abuse.
const REQUEST_COOLDOWN_MINUTES = 15;

// ===========================================================================
// THE NEUTRAL RESPONSE
//
// Returned by POST /api/auth/forgot-password on EVERY path: address found,
// address unknown, account pending, account rejected, account not a resident,
// still inside the cooldown, and provider failure. Byte-identical, same 200.
//
// If it varied, the form would be a way to ask "does this person have an
// account here" — and answering that for a barangay's residents is exactly
// the kind of disclosure the Data Privacy Act commitment in Chapter 1 rules
// out. The wording says what WOULD have happened rather than what did.
//
// KNOWN LIMIT, stated rather than papered over: the response BODY is
// identical, but the eligible path additionally writes a row and makes an
// outbound HTTPS call, so it takes measurably longer. Equalising that needs
// fixed-delay padding, which is deferred; the content oracle is closed, the
// timing one is narrowed but not.
// ===========================================================================

const FORGOT_PASSWORD_RESPONSE = Object.freeze({
  message:
    'If that email address belongs to an active resident account, a password reset link is on its way to it. The link works for 60 minutes. Please check your spam folder if it does not arrive.',
});

// What the resident is told when a token will not work. It must say what to do
// NEXT — the same rule the rejection reason codes follow. "Invalid or expired"
// alone leaves someone who clicked an older email with nowhere to go, and the
// commonest cause of landing here is exactly that.
const INVALID_TOKEN_MESSAGE =
  'This password reset link is no longer valid. Links expire after 60 minutes and can only be used once, so this happens most often when an older email was opened or the link has already been used. Please request a new one.';

const RESET_SUCCESS_MESSAGE = 'Your password has been changed. You can now sign in with it.';

// ===========================================================================
// THE EMAIL, AND THE REDACTED ROW THAT RECORDS IT
//
// Two functions, and the split between them is the point. resetEmail() builds
// what is SENT and contains the link; resetLogMessage() builds what is
// RECORDED in notifications.message and contains no link, no token and no
// query string. /secretary/notifications renders that column on screen, so a
// link in it would be a working reset URL for someone else's account in front
// of every Secretary.
//
// They are deliberately NOT derived from one another. A redaction implemented
// as "take the sent message and strip the link" is one regex away from
// leaking; two separately written strings cannot leak by accident.
// ===========================================================================

const RESET_EMAIL_SUBJECT = 'Reset your BrgyServe password';

function resetEmail({ name, url }) {
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const text = [
    greeting,
    '',
    'Someone asked to reset the password for your BrgyServe account (Barangay Ubujan, Tagbilaran City).',
    '',
    'Open this link to choose a new password:',
    url,
    '',
    `The link works for ${TOKEN_TTL_MINUTES} minutes and can only be used once.`,
    '',
    'If you did not ask for this, you can ignore this email — your password has not changed. If it keeps happening, please visit the Barangay Office.',
    '',
    'BrgyServe',
    'Barangay Ubujan, Tagbilaran City, Bohol',
  ].join('\n');

  return { subject: RESET_EMAIL_SUBJECT, text, url };
}

// What lands in notifications.message. Says that a link was sent and nothing
// about what the link is — enough for the Secretary to see the request
// happened and answer a resident who says nothing arrived.
const resetLogMessage = () =>
  `BrgyServe: a password reset link was emailed to this address. The link itself is not recorded here. It expires in ${TOKEN_TTL_MINUTES} minutes.`;

module.exports = {
  TOKEN_BYTES,
  TOKEN_TTL_MINUTES,
  REQUEST_COOLDOWN_MINUTES,
  generateToken,
  hashToken,
  FORGOT_PASSWORD_RESPONSE,
  INVALID_TOKEN_MESSAGE,
  RESET_SUCCESS_MESSAGE,
  RESET_EMAIL_SUBJECT,
  resetEmail,
  resetLogMessage,
};
