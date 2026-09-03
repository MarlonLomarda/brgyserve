const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { authenticate, allowPendingPasswordChange } = require('../middleware/auth');
const { rejectionMessage } = require('../constants/registration');
const { NOTIFICATION_TYPE, RELATED_TYPE } = require('../constants/notifications');
const { notify, escapeHtml } = require('../services/notifications');
const { frontendOrigin } = require('../utils/frontendOrigin');
const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
} = require('../middleware/rateLimit');
const { validatePassword } = require('../constants/passwordPolicy');
const {
  TOKEN_TTL_MINUTES,
  REQUEST_COOLDOWN_MINUTES,
  generateToken,
  hashToken,
  FORGOT_PASSWORD_RESPONSE,
  INVALID_TOKEN_MESSAGE,
  RESET_SUCCESS_MESSAGE,
  resetEmail,
  resetLogMessage,
} = require('../constants/passwordReset');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/auth/register — resident self-registration.
// The account is created pending (is_active = false, no resident link) and
// cannot log in until the Secretary links a resident record and activates it.
// RATE LIMITED — mounted at ROUTE level, deliberately, not with router.use().
// Router-level would also cover /change-password and /reset-password, which
// are not the exposure: one needs a session, the other needs a 256-bit token.
// Route level also puts the limiter AFTER cors() (server.js:93) in the
// effective order, so a 429 still carries Access-Control-Allow-Origin and the
// browser can read the message — verified: cors() sets that header before it
// calls next(), so anything short-circuiting later inherits it.
router.post('/register', registerLimiter, async (req, res) => {
  const body = req.body || {};
  const {
    username, email, password,
    first_name, middle_name, last_name, suffix,
    birthdate, address, contact_number,
  } = body;

  const required = ['username', 'email', 'password', 'first_name', 'last_name', 'address'];
  const missing = required.filter((f) => !body[f] || String(body[f]).trim() === '');
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }
  // Runs AFTER the required-fields check above, which is what guarantees a
  // username to check the password against. It runs BEFORE the username
  // uniqueness lookup on purpose: a weak password is refused without a
  // database round trip, and the refusal cannot vary with whether the
  // username was taken.
  const passwordCheck = validatePassword(password, { username });
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error });
  }
  if (birthdate && !DATE_RE.test(birthdate)) {
    return res.status(400).json({ error: 'birthdate must be in YYYY-MM-DD format' });
  }

  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('user_id')
    .eq('username', username)
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Username lookup failed: ${lookupError.message}`);
  }
  if (existing) {
    return res.status(409).json({ error: 'Username is already taken' });
  }

  const password_hash = await bcrypt.hash(String(password), 10);

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      username,
      password_hash,
      email,
      email_verified: false,
      role: 'resident',
      must_change_password: false,
      is_active: false, // pending until the Secretary approves
    })
    .select('user_id, username, email, role, is_active')
    .single();

  if (userError) {
    if (userError.code === '23505') {
      return res.status(409).json({ error: 'Username is already taken' });
    }
    throw new Error(`Failed to create user: ${userError.message}`);
  }

  const { error: profileError } = await supabase.from('profiles').insert({
    user_id: user.user_id,
    first_name,
    middle_name: middle_name || null,
    last_name,
    suffix: suffix || null,
    phone_number: contact_number || null,
    birthdate: birthdate || null,
    address,
    resident_id: null, // linked later by the Secretary
  });

  if (profileError) {
    // don't leave an account without a profile behind
    await supabase.from('users').delete().eq('user_id', user.user_id);
    throw new Error(`Failed to create profile: ${profileError.message}`);
  }

  res.status(201).json({
    message: 'Registration received. Your account is pending approval by the Barangay Secretary.',
    user,
  });
});

// Why an account with is_active = false cannot log in, and which of the four
// reasons it is. The block itself never changes: none of these accounts may
// log in. Only the message differs.
//
// THIS USED TO BE DERIVED FROM EXISTING STATE ALONE, and the comment here
// argued that no extra column was needed because only two paths ever cleared
// is_active. That argument died with registration rejection (migration 017).
// A pending registration is created with is_active = false, so "rejected"
// could not be expressed by clearing a flag that was already clear — pending
// and rejected were the SAME row state, and this function had no way to tell
// them apart. It answered "pending approval" for both, which meant a declined
// applicant was told to keep waiting for a review that had already happened.
// users.is_rejected exists to make that distinction real.
//
// The four cases, in the order they are checked:
//   1. REJECTED     — is_rejected. Checked FIRST and before the resident
//                     branch, because a rejected resident satisfies that
//                     branch too and it would swallow this one. The applicant
//                     is shown the reason code's canned sentence, which tells
//                     them what to do next; the Secretary's internal note is
//                     never included.
//   2. ARCHIVED     — linked to an archived resident_records row, so the
//                     archive cascade deactivated a previously ACTIVE account.
//   3. PENDING      — any other resident: awaiting Secretary approval. Correct
//                     both before and after a record is linked, since linking
//                     and activating are separate steps.
//   4. ANYTHING ELSE — a safe generic message rather than falling through to
//                     one of the above and stating something untrue.
async function inactiveMessage(user) {
  // Decided before any query: rejection is a fact on the user row itself and
  // does not depend on whether a resident record was ever linked — which
  // matters, because the commonest reason to reject is that no record matches.
  if (user.is_rejected) {
    return rejectionMessage(user.rejection_reason);
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('resident_id, resident_records ( is_archived )')
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }

  const linked = profile?.resident_records;
  const isArchived = Array.isArray(linked) ? linked[0]?.is_archived : linked?.is_archived;
  if (profile?.resident_id && isArchived) {
    return 'This account has been deactivated. Please contact the Barangay Office.';
  }
  if (user.role === 'resident') {
    return 'Account is pending approval by the Barangay Secretary';
  }
  return 'This account is inactive. Please contact the Barangay Office.';
}

// POST /api/auth/login
// RATE LIMITED — 5 per 15 minutes, with skipSuccessfulRequests.
//
// WHAT COUNTS, since it is decided by STATUS and not by intent: the library
// decrements the counter on `finish` when `response.statusCode < 400`. So a
// successful sign-in (200) is refunded, a wrong password (401) counts, and a
// 403 from the inactive-account branch below ALSO counts — including when the
// password was correct. A pending or rejected applicant retrying their own
// correct password therefore burns the allowance like a failed guess. That is
// the default behaviour and it is left in place: telling those two apart in
// the limiter would mean giving the 403 branch a different rate-limit outcome
// from the 401 one, which is a distinction an attacker can measure.
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select(
      'user_id, username, password_hash, email, role, is_active, must_change_password, is_rejected, rejection_reason'
    )
    .eq('username', username)
    .maybeSingle();
  if (error) {
    throw new Error(`Login lookup failed: ${error.message}`);
  }

  const valid = user && (await bcrypt.compare(String(password), user.password_hash));
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: await inactiveMessage(user) });
  }

  const token = jwt.sign(
    { sub: String(user.user_id), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.json({
    token,
    user: {
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      role: user.role,
      must_change_password: user.must_change_password,
    },
  });
});

// POST /api/auth/change-password — any authenticated user.
// allowPendingPasswordChange keeps this route reachable for users still on a
// temporary password (authenticate blocks them everywhere else).
router.post('/change-password', allowPendingPasswordChange, authenticate, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  // req.user is loaded fresh from the database by authenticate(), which
  // selects username among its six columns — so the username the blocklist
  // checks against is the stored one, not anything the caller supplied.
  const passwordCheck = validatePassword(new_password, { username: req.user.username });
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('user_id, password_hash')
    .eq('user_id', req.user.user_id)
    .single();
  if (error || !user) {
    throw new Error(`Failed to load user for password change: ${error?.message || 'not found'}`);
  }

  const valid = await bcrypt.compare(String(current_password), user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const password_hash = await bcrypt.hash(String(new_password), 10);
  const { error: updateError } = await supabase
    .from('users')
    .update({ password_hash, must_change_password: false })
    .eq('user_id', req.user.user_id);
  if (updateError) {
    throw new Error(`Failed to update password: ${updateError.message}`);
  }

  res.json({ message: 'Password changed successfully' });
});

// ===========================================================================
// PASSWORD RESET — POST /forgot-password and POST /reset-password
//
// BOTH ARE UNAUTHENTICATED, which is the whole point: the caller is someone
// who cannot log in. That makes them the second and third unauthenticated
// write endpoints in this API after /register, and the only ones with an
// OUTBOUND, METERED side effect — hence the cooldown below.
//
// RESIDENTS ONLY. A staff-type account (secretary, punong_barangay,
// treasurer, staff) gets nothing, silently: those accounts are created by the
// Secretary with a temporary password and the same office can reissue one, so
// an email path for them would add an attack surface with no user behind it.
// Pending and rejected accounts get nothing either — neither may log in, so a
// working password would change nothing for them, and sending mail to a
// declined applicant would read as progress that has not happened.
//
// THE RESPONSE IS BYTE-IDENTICAL ON EVERY PATH. See FORGOT_PASSWORD_RESPONSE
// in constants/passwordReset.js for why, and for the timing caveat that is
// NOT closed.
//
// SESSION INVALIDATION IS DEFERRED — a known, accepted limit, recorded in
// CLAUDE.md. Changing password_hash does not end existing sessions: the JWT
// carries only sub and role, and authenticate() re-reads user_id, username,
// email, role, is_active and must_change_password — never password_hash. A
// token issued before the reset keeps working until it expires, up to 8 hours.
// This is PRE-EXISTING behaviour that /change-password has always had, not
// something reset introduces. The fix is users.password_changed_at plus an
// iat check in authenticate(), and it is deliberately NOT bundled here: it
// edits the middleware every route depends on, and mixing it into the largest
// change in this module would put the riskiest edit inside the biggest one.
// ===========================================================================

// A broad prefilter only. PostgREST's ilike treats `_` as a single-character
// wildcard and `*` as an alias for `%`, so the pattern is NOT the authority on
// which row matched — the exact, case-insensitive comparison in JS below is.
// That way a submitted "%@gmail.com" matches rows in the prefilter and then
// matches nobody, rather than resolving to somebody else's account.
const EMAIL_PREFILTER_LIMIT = 25;

async function eligibleResidentByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, username, email, role, is_active, is_rejected')
    .ilike('email', email)
    .limit(EMAIL_PREFILTER_LIMIT);
  if (error) {
    throw new Error(`Password reset lookup failed: ${error.message}`);
  }

  const wanted = email.toLowerCase();
  return (
    (data || []).find(
      (u) =>
        String(u.email || '').toLowerCase() === wanted &&
        u.role === 'resident' &&
        u.is_active === true &&
        u.is_rejected !== true
    ) || null
  );
}

// POST /api/auth/forgot-password — UNAUTHENTICATED.
//
// RATE LIMITED — 10 per hour, and the limiter runs BEFORE the handler, which
// is the point rather than an ordering detail. It has not looked at the
// address when it decides, so its behaviour cannot vary with whether an
// account exists — the same property FORGOT_PASSWORD_RESPONSE protects on the
// success path. A limiter that only fired for real accounts would reopen the
// enumeration oracle this whole route is written around.
//
// THE PER-USER COOLDOWN BELOW IS UNCHANGED AND STILL DOES ITS OWN JOB. This
// limiter counts REQUESTS from one address; the cooldown counts EMAILS to one
// account, in the password_resets table, and survives a restart. Neither
// covers the other: the cooldown ignores a caller cycling addresses that do
// not exist, and this limiter ignores one account targeted from many networks.
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  // A 400 here is about the SHAPE of the request, not about whether an account
  // exists, so it discloses nothing: the answer is the same for every caller
  // who omits the field.
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }

  const user = await eligibleResidentByEmail(email);
  // Unknown address, staff account, pending or rejected: stop here and answer
  // exactly as if a link had been sent.
  if (!user) {
    return res.json(FORGOT_PASSWORD_RESPONSE);
  }

  // Per-user cooldown, counted against the table rather than memory. This is
  // the ONLY rate limiting in the API; it protects the Resend quota (100/day)
  // from one person holding down the button, and it survives a restart.
  const since = new Date(Date.now() - REQUEST_COOLDOWN_MINUTES * 60_000).toISOString();
  const { count: recent, error: cooldownError } = await supabase
    .from('password_resets')
    .select('reset_id', { count: 'exact', head: true })
    .eq('user_id', user.user_id)
    .gt('created_at', since);
  if (cooldownError) {
    throw new Error(`Password reset cooldown check failed: ${cooldownError.message}`);
  }
  // Silently. Telling the caller they are rate limited would itself confirm
  // the address exists — the one thing this route must never do.
  if ((recent || 0) > 0) {
    return res.json(FORGOT_PASSWORD_RESPONSE);
  }

  const token = generateToken();
  const { error: insertError } = await supabase.from('password_resets').insert({
    user_id: user.user_id,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000).toISOString(),
    used_at: null,
  });
  if (insertError) {
    throw new Error(`Failed to record password reset request: ${insertError.message}`);
  }

  // Only for the greeting. A failure here must not stop the email.
  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name')
    .eq('user_id', user.user_id)
    .maybeSingle();

  const url = `${frontendOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  const mail = resetEmail({ name: profile?.first_name || null, url });
  const safeUrl = escapeHtml(url);

  // THE REDACTION SPLIT. `message` carries the link and goes to Resend;
  // `logMessage` is what lands in notifications.message, which every Secretary
  // can read on /secretary/notifications. They are written separately in
  // constants/passwordReset.js rather than derived from one another.
  await notify({
    type: NOTIFICATION_TYPE.EMAIL,
    userId: user.user_id,
    destination: user.email,
    subject: mail.subject,
    message: mail.text,
    html:
      `<p>${escapeHtml(mail.text.split('\n')[0])}</p>` +
      '<p>Someone asked to reset the password for your BrgyServe account ' +
      '(Barangay Ubujan, Tagbilaran City).</p>' +
      `<p><a href="${safeUrl}">Choose a new password</a></p>` +
      `<p>Or paste this into your browser:<br>${safeUrl}</p>` +
      `<p>The link works for ${TOKEN_TTL_MINUTES} minutes and can only be used once.</p>` +
      '<p>If you did not ask for this, you can ignore this email &mdash; your password ' +
      'has not changed. If it keeps happening, please visit the Barangay Office.</p>' +
      '<p>BrgyServe<br>Barangay Ubujan, Tagbilaran City, Bohol</p>',
    logMessage: resetLogMessage(),
    relatedType: RELATED_TYPE.ACCOUNT,
    relatedTo: user.user_id,
  });

  // The row is KEPT even when the send failed, so the cooldown still counts.
  // The alternative — deleting it so the resident can retry at once — would
  // make a provider outage the one way to bypass the only rate limit in the
  // API, and a failure is already visible as a FAILED row on the Secretary's
  // notifications screen.
  res.json(FORGOT_PASSWORD_RESPONSE);
});

// POST /api/auth/reset-password — UNAUTHENTICATED. The token is the authority.
router.post('/reset-password', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const newPassword = req.body?.new_password;

  if (!token) {
    return res.status(400).json({ error: INVALID_TOKEN_MESSAGE, code: 'RESET_TOKEN_INVALID' });
  }
  // PRESENCE ONLY HERE. The full policy check needs the account's username to
  // run its blocklist rule, and the username is not known until the token has
  // been resolved to a user below — so the rules are applied there, not here.
  // This one is about the SHAPE of the request and discloses nothing.
  if (!newPassword) {
    return res.status(400).json({ error: 'A new password is required.' });
  }

  // The stored value is a SHA-256 hash, so the raw token is hashed and the
  // hash looked up. token_hash is UNIQUE, which is what makes this resolve to
  // at most one row with no ordering or tie-break.
  const { data: reset, error: lookupError } = await supabase
    .from('password_resets')
    .select('reset_id, user_id, expires_at, used_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Password reset lookup failed: ${lookupError.message}`);
  }

  // Unknown, already used, and expired all give the SAME answer, and that
  // answer says what to do next rather than only stating the verdict.
  if (!reset || reset.used_at || new Date(reset.expires_at).getTime() <= Date.now()) {
    return res.status(400).json({ error: INVALID_TOKEN_MESSAGE, code: 'RESET_TOKEN_INVALID' });
  }

  // Re-checked at USE time, not just at request time: an account can be
  // archived (which deactivates it) or rejected in the hour a link is alive,
  // and a token must not outlive the eligibility that produced it.
  // `username` is selected for the password blocklist and for nothing else.
  // It is never returned to the caller — the response is the fixed success
  // message — so this does not turn a reset link into a way to read the
  // username off an account.
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('user_id, username, role, is_active, is_rejected')
    .eq('user_id', reset.user_id)
    .maybeSingle();
  if (userError) {
    throw new Error(`Password reset user lookup failed: ${userError.message}`);
  }
  if (!user || user.role !== 'resident' || !user.is_active || user.is_rejected) {
    // Deliberately NOT the "request a new one" wording: a new link would land
    // in exactly the same place, so this points at the only thing that helps.
    return res.status(400).json({
      error: 'This account is not active, so its password cannot be reset. Please contact the Barangay Office.',
      code: 'RESET_ACCOUNT_INACTIVE',
    });
  }

  // THE POLICY IS CHECKED HERE — after the account is resolved, and BEFORE
  // the token is claimed below.
  //
  // After, because the blocklist needs this account's username and there was
  // no username to check against until now. Before the claim, because the
  // claim is irreversible: a password refused for being too weak must leave
  // the link still usable, or a resident who types "password" once has burned
  // the email and has to wait out the 15-minute cooldown for another. A
  // rejected password must cost them a retry, not the token.
  const passwordCheck = validatePassword(newPassword, { username: user.username });
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  // CLAIM THE TOKEN FIRST, with a status-guarded update — the same read-then-
  // write gap closer used by document approval, charge verification and
  // attendance recording. Two simultaneous submissions of one link both pass
  // the checks above; only one can match `used_at IS NULL` here, and the loser
  // gets the invalid-token answer.
  //
  // THE ORDER MATTERS AND IT IS THIS WAY ROUND ON PURPOSE. If the password
  // were set first and the claim then failed, the token would still be
  // reusable — a live key left lying around. Claiming first means the worst
  // case is a burned token and an unchanged password, which costs the resident
  // one more email and leaks nothing.
  const { data: claimed, error: claimError } = await supabase
    .from('password_resets')
    .update({ used_at: new Date().toISOString() })
    .eq('reset_id', reset.reset_id)
    .is('used_at', null)
    .select('reset_id');
  if (claimError) {
    throw new Error(`Failed to consume the reset token: ${claimError.message}`);
  }
  if (!claimed || claimed.length === 0) {
    return res.status(400).json({ error: INVALID_TOKEN_MESSAGE, code: 'RESET_TOKEN_INVALID' });
  }

  const password_hash = await bcrypt.hash(String(newPassword), 10);
  const { error: updateError } = await supabase
    .from('users')
    .update({ password_hash })
    .eq('user_id', user.user_id);
  if (updateError) {
    throw new Error(`Failed to set the new password: ${updateError.message}`);
  }

  // Any other link the resident still holds dies with this one. Requesting
  // twice is possible once the cooldown lapses, and the second request must
  // not leave the first email as a working key to an account whose owner has
  // just proved they are back in control of it.
  const { error: sweepError } = await supabase
    .from('password_resets')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', user.user_id)
    .is('used_at', null);
  if (sweepError) {
    // Not fatal: the password is already changed and the used token is
    // already burned. Logged rather than raised so a housekeeping failure
    // cannot turn a successful reset into a 500 the resident has to retry.
    console.error(`[password reset] failed to invalidate other tokens: ${sweepError.message}`);
  }

  // NO CONFIRMATION EMAIL. It was considered and left out: it is a second send
  // against a 100/day quota for a message the resident learns from the screen
  // they are looking at. If it is ever added it belongs behind the same
  // redaction split, with nothing about the token in the recorded row.
  //
  // must_change_password is deliberately NOT touched. This route only ever
  // serves residents, and residents are never created with that flag — only
  // Secretary-created staff accounts are. Clearing a flag this flow does not
  // own would be reaching outside it.
  res.json({ message: RESET_SUCCESS_MESSAGE });
});

module.exports = router;
