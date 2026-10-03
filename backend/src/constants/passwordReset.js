// Canonical vocabulary and tuning for password reset, and for the
// set-password links staff-type accounts receive (see the section at the end).
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

// ===========================================================================
// SET-PASSWORD LINKS — how a staff-type account gets its password
//
// When the Secretary creates an account for an official (POST /api/secretary/
// accounts), the official is emailed a one-time link and chooses their own
// password at /set-password. The Secretary never sees one. The Secretary can
// send another link later from the staff accounts list, which also makes it
// the way to reset an official's forgotten password: /forgot-password is for
// residents only.
//
// SAME TABLE, SAME TOKEN, SAME HASH as a reset link. What keeps the two kinds
// apart is the ACCOUNT'S ROLE, not a column: /forgot-password issues tokens
// only to residents and /reset-password refuses any account that is not one,
// while set-password links go only to STAFF_TYPE_ROLES and /set-password
// refuses any account outside them. A row therefore cannot be spent through
// the wrong route, and no migration was needed. If staff ever get a
// self-service forgot-password, that stops being true and password_resets
// needs a purpose column.
// ===========================================================================

// Every staff-type role: the roles the Secretary can create an account for,
// and the only roles /set-password sets a password for. routes/secretary.js
// takes its STAFF_ROLES from here, so the two lists cannot drift apart.
const STAFF_TYPE_ROLES = Object.freeze(['secretary', 'punong_barangay', 'treasurer', 'staff']);

// Longer than a reset link's 60 minutes, on purpose. A reset is asked for by
// someone waiting at their inbox; a set-password email arrives unannounced,
// and an expired one costs the official a trip back to the Barangay Office.
const SET_PASSWORD_TTL_HOURS = 72;

// One set-password email per account per 15 minutes, counted from
// password_resets like the reset cooldown. Only a Secretary can send one, so
// this is not a security control: it stops a double-clicked button spending
// the Resend quota (100/day) and filling the official's inbox.
const SET_PASSWORD_COOLDOWN_MINUTES = 15;

// One answer for every link that will not work: used, expired, unknown, or
// not a set-password link at all. Like INVALID_TOKEN_MESSAGE it says what to
// do next, but the next step differs: an official cannot request a link
// themselves, so it sends them to the Barangay Office.
const SET_PASSWORD_INVALID_MESSAGE =
  `This set-password link is no longer valid. Links work only once and expire after ${SET_PASSWORD_TTL_HOURS} hours, so this happens most often when the link has already been used or an older email was opened. Please ask the Barangay Office to send you a new link.`;

const SET_PASSWORD_SUCCESS_MESSAGE =
  'Your password is set. You can now sign in with your username and this password. Your username is in the email that brought you here.';

const SET_PASSWORD_EMAIL_SUBJECT = 'Set up your BrgyServe account';
const NEW_PASSWORD_EMAIL_SUBJECT = 'Set a new password for your BrgyServe account';

// The email. Two openings, because one link serves two cases:
//   * a new account (must_change_password still true): nobody knows its
//     password, so signing in cannot work until the link is used;
//   * an account already in use: the Secretary is resetting it, and the
//     current password keeps working until the link is used.
// There is deliberately no "if you did not ask for this" line. The official
// did not ask; the Barangay Office did.
//
// The username is included because the Secretary chose it, not the official,
// and nobody can sign in without it.
//
// THE REDACTION SPLIT APPLIES EXACTLY AS IT DOES TO RESETS. The link is in
// this text only; setPasswordLogMessage() below is what notifications.message
// records, and the two are written separately for the reason given above
// resetEmail().
function setPasswordEmail({ name, username, url, existingAccount = false }) {
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const opening = existingAccount
    ? 'The Barangay Secretary has sent you a link to set a new password for your BrgyServe account (Barangay Ubujan, Tagbilaran City).'
    : 'The Barangay Secretary has set up a BrgyServe account for you (Barangay Ubujan, Tagbilaran City).';
  const signingIn = existingAccount
    ? 'Your current password keeps working until you set a new one with this link.'
    : 'Signing in will not work until you have set your password with this link.';
  const text = [
    greeting,
    '',
    opening,
    '',
    `Your username: ${username}`,
    '',
    'Open this link to choose your password:',
    '',
    url,
    '',
    `The link works for ${SET_PASSWORD_TTL_HOURS} hours and can only be used once. ${signingIn}`,
    '',
    'If the link has expired or does not work, ask the Barangay Office to send you a new one.',
    '',
    'BrgyServe',
    'Barangay Ubujan, Tagbilaran City, Bohol',
  ].join('\n');

  return {
    subject: existingAccount ? NEW_PASSWORD_EMAIL_SUBJECT : SET_PASSWORD_EMAIL_SUBJECT,
    text,
    url,
  };
}

// What lands in notifications.message for a set-password email.
const setPasswordLogMessage = () =>
  `BrgyServe: a set-password link was emailed to this address. The link itself is not recorded here. It expires in ${SET_PASSWORD_TTL_HOURS} hours.`;

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
  STAFF_TYPE_ROLES,
  SET_PASSWORD_TTL_HOURS,
  SET_PASSWORD_COOLDOWN_MINUTES,
  SET_PASSWORD_INVALID_MESSAGE,
  SET_PASSWORD_SUCCESS_MESSAGE,
  SET_PASSWORD_EMAIL_SUBJECT,
  NEW_PASSWORD_EMAIL_SUBJECT,
  setPasswordEmail,
  setPasswordLogMessage,
};
