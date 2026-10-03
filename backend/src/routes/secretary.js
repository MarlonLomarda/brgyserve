const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { findMatches } = require('../services/nameMatching');
const { notify, escapeHtml } = require('../services/notifications');
const { NOTIFICATION_TYPE, NOTIFICATION_STATUS, RELATED_TYPE } = require('../constants/notifications');
const { generateTemporaryPassword } = require('../constants/passwordPolicy');
const { validateUsername } = require('../constants/usernamePolicy');
const { PH_MOBILE_RE, CONTACT_NUMBER_ERROR } = require('../constants/phoneNumber');
const { logActivity, pick } = require('../services/activityLog');
const { ACTIONS, RESIDENT_LOG_FIELDS } = require('../constants/activityLog');
const { frontendOrigin } = require('../utils/frontendOrigin');
const {
  STAFF_TYPE_ROLES,
  SET_PASSWORD_TTL_HOURS,
  SET_PASSWORD_COOLDOWN_MINUTES,
  generateToken,
  hashToken,
  setPasswordEmail,
  setPasswordLogMessage,
} = require('../constants/passwordReset');
const {
  findUserByEmail,
  validateEmail,
  uniqueViolationField,
  EMAIL_TAKEN_MESSAGE,
} = require('../utils/userEmail');
const {
  REJECTION_REASONS,
  isRejectionReason,
  reasonRequiresNote,
  rejectionMessage,
  deriveResidency,
  withResidency,
} = require('../constants/registration');

// Staff-type roles the Secretary may create accounts for (per the
// "Authentication & account rules" in docs/brgyserve-use-cases.md, this
// includes another secretary — succession is a real need). Residents
// self-register and are deliberately NOT creatable here. The list lives in
// constants/passwordReset.js because /set-password must accept exactly these
// roles and no others.
const STAFF_ROLES = STAFF_TYPE_ROLES;

// The accounts on the staff accounts list, which is where the Secretary sends
// a set-password link: every staff-type role except 'secretary', so neither
// the Secretary's own account nor another Secretary's is on it.
const MANAGED_ROLES = STAFF_ROLES.filter((r) => r !== 'secretary');

// How a new staff account gets its first password. EMAIL is the default and
// the intended path. TEMPORARY_PASSWORD is the old behaviour, kept as a
// fallback for when email is not working. The CREATE log row records which
// one was used.
const DELIVERY = Object.freeze({ EMAIL: 'email', TEMPORARY_PASSWORD: 'temporary_password' });

// A set-password email that left the server, or that SIMULATED mode wrote to
// the server log instead. Either way the link exists somewhere a person can
// reach it. FAILED and SKIPPED mean nobody has it.
const LINK_REACHED = [NOTIFICATION_STATUS.SENT, NOTIFICATION_STATUS.SIMULATED];

// The HTML body, built from the plain-text one so the two cannot say
// different things: each paragraph becomes a <p>, and the paragraph that is
// the bare URL becomes a link. The words come from constants/passwordReset.js.
function htmlFromText(text, url, linkText) {
  const safeUrl = escapeHtml(url);
  return text
    .split('\n\n')
    .map((para) => (para === url
      ? `<p><a href="${safeUrl}">${escapeHtml(linkText)}</a></p><p>Or paste this into your browser:<br>${safeUrl}</p>`
      : `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`))
    .join('');
}

// Issues a set-password link for a staff-type account and emails it.
//
// `account` needs user_id, username, email and must_change_password; the last
// picks the email's wording (new account, or a reset of one already in use).
// Returns notify()'s { ok, status }. Throws only when the token row cannot be
// written, and the caller decides what that means.
//
// THE NEW TOKEN IS WRITTEN FIRST, THEN SENT, THEN THE RESULT DECIDES:
//   * The link reached someone (SENT, or SIMULATED): every OLDER unused link
//     for the account is marked used, so only the newest email works — the
//     rule /reset-password applies once a link is spent.
//   * It did not (FAILED): the new row is DELETED and the older links are left
//     alone. Nobody received the new one, so keeping it would only start the
//     15-minute cooldown on a send that never happened, and make the staff
//     list's "last link sent" untrue. An older link the official may already
//     hold keeps working.
// This is deliberately NOT what /forgot-password does, which keeps its row
// after a failed send. That row is the only rate limit on an anonymous
// endpoint; here only a signed-in Secretary can send, so a retry is not abuse.
async function sendSetPasswordLink(account, { name = null } = {}) {
  const token = generateToken();
  const { data: row, error } = await supabase
    .from('password_resets')
    .insert({
      user_id: account.user_id,
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + SET_PASSWORD_TTL_HOURS * 3_600_000).toISOString(),
      used_at: null,
    })
    .select('reset_id')
    .single();
  if (error) {
    throw new Error(`Failed to record the set-password link: ${error.message}`);
  }

  const url = `${frontendOrigin()}/set-password?token=${encodeURIComponent(token)}`;
  const mail = setPasswordEmail({
    name,
    username: account.username,
    url,
    existingAccount: account.must_change_password !== true,
  });

  // THE REDACTION SPLIT: the link is in `message` and `html`, which go to the
  // provider; `logMessage` is what notifications.message records, and the
  // Secretary notifications screen shows it. See services/notifications.js.
  const result = await notify({
    type: NOTIFICATION_TYPE.EMAIL,
    userId: account.user_id,
    destination: account.email,
    subject: mail.subject,
    message: mail.text,
    html: htmlFromText(mail.text, url, 'Set your password'),
    logMessage: setPasswordLogMessage(),
    relatedType: RELATED_TYPE.ACCOUNT,
    relatedTo: account.user_id,
  });

  // Housekeeping either way, so a failure here is logged, not raised: the
  // send has already happened or failed, and that is what the caller reports.
  if (LINK_REACHED.includes(result.status)) {
    const { error: sweepError } = await supabase
      .from('password_resets')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', account.user_id)
      .is('used_at', null)
      .neq('reset_id', row.reset_id);
    if (sweepError) {
      console.error(`[set-password link] failed to retire older links: ${sweepError.message}`);
    }
  } else {
    const { error: dropError } = await supabase
      .from('password_resets')
      .delete()
      .eq('reset_id', row.reset_id);
    if (dropError) {
      console.error(`[set-password link] failed to drop an unsent link: ${dropError.message}`);
    }
  }

  return { ok: result.ok, status: result.status };
}

const router = express.Router();

router.use(authenticate, requireRole('secretary'));

const PROFILE_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, phone_number';

// The linked resident record's masterlist registration date, reached through
// profiles.resident_id. A NESTED EMBED rather than a second query: that FK is
// single-column and unambiguous, and routes/auth.js already runs the identical
// shape (`profiles → resident_records ( is_archived )`) in inactiveMessage, so
// this is a proven pattern here rather than a guess. It also costs no extra
// round trip and gives every pending card — linked or not — the same shape,
// so the screen has one case to render instead of two.
//
// Only the two columns the review screen needs. The rest of the record is
// available at GET /api/resident-records/:id and has no business being copied
// into this payload.
const LINKED_RECORD_FIELDS = 'resident_id, masterlist_registered_on';

// profiles is one-to-one and the embed is to-one, but PostgREST can return
// either an object or a single-element array depending on how it resolves the
// relationship — normalize both, the same way loadResidentAccount already
// normalizes profiles itself.
const one = (v) => (Array.isArray(v) ? v[0] || null : v || null);

// Flattens the embed into the shape the screen consumes, with the residency
// derived once here so the time comparison stays in a single place.
//
// null when there is no linked record AND null when the record has no date on
// file. Both mean "there is nothing to show", and the screen renders nothing
// for either — a placeholder would read as "under six months".
function linkedRecordOf(profile) {
  const record = one(profile?.resident_records);
  if (!record) return null;
  return {
    resident_id: record.resident_id,
    masterlist_registered_on: record.masterlist_registered_on,
    residency: deriveResidency(record.masterlist_registered_on),
  };
}

// The rejection state (migration 017). These are read on every pending-account
// path because three separate routes now have to agree about it: reject
// refuses to re-reject, un-reject refuses a non-rejected account, and activate
// refuses a rejected one.
//
// These are NOT the "withheld field" case from the Standing Rules. A pending
// account genuinely HAS no rejection reason, so null here is a true statement
// about the account rather than a claim standing in for data the server chose
// not to send — nothing is being withheld from anyone, and the client is free
// to read them as null.
const REJECTION_FIELDS =
  'is_rejected, rejection_reason, rejection_note, rejected_at, rejected_by_user_id';

// Valid values for the ?status= filter on the pending list. 'pending' and
// 'rejected' are both is_active = false — the difference is is_rejected.
const PENDING_STATUS_FILTERS = ['pending', 'rejected', 'all'];

// Resolves rejected_by_user_id -> username for a set of account rows.
//
// Deliberately a second query rather than a PostgREST embed. The embed would
// be a self-referential join on users and has to be disambiguated by FK
// constraint name (users!users_rejected_by_user_id_fkey), which cannot be
// verified until migration 017 is applied — and a query shape that is only
// discovered to be wrong in production is not worth the round trip it saves.
// The id set here is at most the number of Secretaries, so .in() is safe.
async function attachRejectedBy(rows) {
  const ids = [...new Set(rows.map((r) => r.rejected_by_user_id).filter((v) => v != null))];
  if (ids.length === 0) {
    return rows.map((r) => ({ ...r, rejected_by_username: null }));
  }

  const { data, error } = await supabase
    .from('users')
    .select('user_id, username')
    .in('user_id', ids);
  if (error) {
    throw new Error(`Failed to load rejecting accounts: ${error.message}`);
  }

  const byId = new Map((data || []).map((u) => [u.user_id, u.username]));
  return rows.map((r) => ({
    ...r,
    rejected_by_username: r.rejected_by_user_id != null
      ? byId.get(r.rejected_by_user_id) || null
      : null,
  }));
}

// What the Secretary is told after creating an account in EMAIL mode, by the
// email's status. The screen words this itself; the message is the fallback.
const CREATED_BY_EMAIL_MESSAGE = {
  [NOTIFICATION_STATUS.SENT]:
    `Account created. A set-password link was emailed to the address you entered. It works once and expires in ${SET_PASSWORD_TTL_HOURS} hours.`,
  [NOTIFICATION_STATUS.SIMULATED]:
    'Account created. Email is simulated on this server, so the set-password link was not sent; it was written to the server log instead.',
};
const CREATED_EMAIL_NOT_SENT_MESSAGE =
  'Account created, but the set-password email could not be sent. Use "Send set-password link" on the staff accounts list to try again.';

// POST /api/secretary/accounts — create a staff-type account.
//
// delivery 'email' (the default): nobody is given a password. The account is
// created with an unusable one, and the official is emailed a one-time link
// to choose their own at /set-password. The response says whether the email
// went, and never contains a password.
//
// delivery 'temporary_password': the old behaviour, kept as an explicit
// fallback for when email is not working. A generated password is returned
// ONCE for the Secretary to hand over, and must_change_password forces the
// official to replace it on first login.
router.post('/accounts', async (req, res) => {
  const {
    username, email, role,
    first_name, middle_name, last_name, suffix, phone_number,
  } = req.body || {};

  const required = { username, email, role, first_name, last_name };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || String(v).trim() === '')
    .map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }
  if (!STAFF_ROLES.includes(role)) {
    return res.status(400).json({
      error: `role must be one of: ${STAFF_ROLES.join(', ')} (residents self-register)`,
    });
  }

  // Absent means EMAIL. Anything else that is not one of the two is refused
  // rather than guessed at, since the two differ in who ever sees a password.
  const delivery = req.body?.delivery ?? DELIVERY.EMAIL;
  if (!Object.values(DELIVERY).includes(delivery)) {
    return res.status(400).json({
      error: `delivery must be one of: ${Object.values(DELIVERY).join(', ')}`,
    });
  }

  // The address is how a new official gets a password at all, so a typo
  // strands the account. Its shape is checked before any database round trip,
  // and the TRIMMED value is what is checked for uniqueness and stored.
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) {
    return res.status(400).json({ error: emailCheck.error });
  }
  const cleanEmail = emailCheck.value;

  // The SAME rules the resident registration form applies — one validator, so
  // a staff account cannot be created in a shape a resident is refused. The
  // trimmed value is used from here down for the uniqueness lookup, the
  // temporary password (whose blocklist refuses a password containing the
  // username) and the insert.
  const usernameCheck = validateUsername(username);
  if (!usernameCheck.ok) {
    return res.status(400).json({ error: usernameCheck.error });
  }
  const cleanUsername = usernameCheck.value;

  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('user_id')
    .eq('username', cleanUsername)
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Username lookup failed: ${lookupError.message}`);
  }
  if (existing) {
    return res.status(409).json({ error: 'Username is already taken' });
  }

  // Same rule as resident registration, same helper — a staff account cannot
  // be created on an address another account already holds. The Secretary is
  // the one who hears about it, so the message names the email rather than
  // sending them off to change the username.
  const emailOwner = await findUserByEmail(cleanEmail);
  if (emailOwner) {
    return res.status(409).json({ error: EMAIL_TAKEN_MESSAGE, code: 'EMAIL_TAKEN' });
  }

  // TEMPORARY_PASSWORD: generated by constants/passwordPolicy.js, beside the
  // rules it has to satisfy. It used to be built inline here, and it quietly
  // failed the digit rule 12.94% of the time — see the note above
  // generateTemporaryPassword() for the measurement and for why the format
  // guarantees every rule from its fixed parts rather than from the random
  // ones. The username is passed because the policy refuses a password
  // containing it.
  //
  // EMAIL: the hash of 32 random bytes that are thrown away here. Nobody ever
  // knows the password it matches, so the account cannot be signed into until
  // /set-password replaces it, and login needs no special case: it runs its
  // usual bcrypt compare against a real hash, which simply never matches.
  const temporaryPassword = delivery === DELIVERY.TEMPORARY_PASSWORD
    ? generateTemporaryPassword(cleanUsername)
    : null;
  const password_hash = await bcrypt.hash(
    temporaryPassword ?? crypto.randomBytes(32).toString('base64url'),
    10,
  );

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      username: cleanUsername,
      password_hash,
      email: cleanEmail,
      email_verified: false, // set true by /set-password, never here
      role,
      // Either delivery: cleared by the forced change on first login, or by
      // /set-password when the emailed link is used.
      must_change_password: true,
      is_active: true,
    })
    .select('user_id, username, email, role')
    .single();
  if (userError) {
    // The race backstop, naming whichever constraint actually fired. An
    // unrecognised 23505 is re-thrown rather than reported as either.
    if (userError.code === '23505') {
      const field = uniqueViolationField(userError);
      if (field === 'email') {
        return res.status(409).json({ error: EMAIL_TAKEN_MESSAGE, code: 'EMAIL_TAKEN' });
      }
      if (field === 'username') {
        return res.status(409).json({ error: 'Username is already taken' });
      }
    }
    throw new Error(`Failed to create account: ${userError.message}`);
  }

  const { error: profileError } = await supabase.from('profiles').insert({
    user_id: user.user_id,
    first_name,
    middle_name: middle_name || null,
    last_name,
    suffix: suffix || null,
    phone_number: phone_number || null,
  });
  if (profileError) {
    await supabase.from('users').delete().eq('user_id', user.user_id);
    throw new Error(`Failed to create profile: ${profileError.message}`);
  }

  // EMAIL: the link is issued only now that the profile exists, so the
  // profile failure above never has a token row to unwind. If the token row
  // cannot be written, the account is useless — nobody knows its password and
  // no link exists — so everything written is removed, children before the
  // user (every foreign key to users is NO ACTION), and the Secretary simply
  // tries again. A failed SEND is a different case: the account stays, and the
  // response says the email did not go.
  let linkEmail = null;
  if (delivery === DELIVERY.EMAIL) {
    try {
      linkEmail = await sendSetPasswordLink(
        { ...user, must_change_password: true },
        { name: first_name },
      );
    } catch (err) {
      await supabase.from('password_resets').delete().eq('user_id', user.user_id);
      await supabase.from('profiles').delete().eq('user_id', user.user_id);
      await supabase.from('users').delete().eq('user_id', user.user_id);
      throw err;
    }
  }

  // Never the temporary password, its hash, the link, or the new official's
  // email and phone. How the password was delivered is recorded, and for an
  // email what became of it — under email_status, because the deny-list in
  // constants/activityLog.js drops every key containing "password".
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.CREATE,
    table: 'users',
    recordId: user.user_id,
    after: {
      username: user.username,
      role: user.role,
      delivery,
      ...(linkEmail ? { email_status: linkEmail.status } : {}),
    },
  });

  if (delivery === DELIVERY.TEMPORARY_PASSWORD) {
    return res.status(201).json({
      message: 'Account created. Share the temporary password securely; the user must change it on first login.',
      user,
      delivery,
      temporary_password: temporaryPassword,
    });
  }

  res.status(201).json({
    message: CREATED_BY_EMAIL_MESSAGE[linkEmail.status] || CREATED_EMAIL_NOT_SENT_MESSAGE,
    user,
    delivery,
    set_password_email: linkEmail,
  });
});

// GET /api/secretary/staff-accounts
//
// The accounts the Secretary manages here — every staff-type role but
// 'secretary' — with when each was last sent a set-password link. Newest
// account first, so one just created is at the top.
//
// The column list is explicit and must stay that way: users holds
// password_hash, and nothing about this screen needs it.
//
// last_link_sent_at is the newest password_resets row for the account. A
// staff-type account only ever has rows from set-password links, since
// /forgot-password issues none to it, and a link whose email failed is
// deleted rather than kept. null means no link has been sent, which is true
// for every account created with a temporary password.
router.get('/staff-accounts', async (req, res) => {
  const { data: accounts, error } = await supabase
    .from('users')
    .select('user_id, username, role, email, is_active, must_change_password')
    .in('role', MANAGED_ROLES)
    .order('user_id', { ascending: false });
  if (error) {
    throw new Error(`Failed to load staff accounts: ${error.message}`);
  }

  // One read for all of them. The id list is the number of staff accounts,
  // which is small, so .in() is safe here.
  const lastLink = new Map();
  if (accounts.length > 0) {
    const { data: links, error: linkError } = await supabase
      .from('password_resets')
      .select('user_id, created_at')
      .in('user_id', accounts.map((a) => a.user_id))
      .order('created_at', { ascending: false });
    if (linkError) {
      throw new Error(`Failed to load set-password links: ${linkError.message}`);
    }
    for (const link of links) {
      if (!lastLink.has(link.user_id)) lastLink.set(link.user_id, link.created_at);
    }
  }

  res.json({
    accounts: accounts.map((a) => ({
      ...a,
      last_link_sent_at: lastLink.get(a.user_id) ?? null,
    })),
  });
});

// POST /api/secretary/staff-accounts/:userId/send-set-password-link
//
// Emails a new set-password link: for an account still waiting for its
// first password, or as an admin reset for one already in use. In the second
// case nothing about the account changes until the link is used — the
// current password keeps working, so an official who never opens the email
// has lost nothing.
//
// The same roles as the list. A resident, a Secretary or an unknown id is a
// 404: none of them is on that list.
router.post('/staff-accounts/:userId/send-set-password-link', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const { data: account, error } = await supabase
    .from('users')
    .select('user_id, username, email, role, is_active, must_change_password')
    .eq('user_id', userId)
    .in('role', MANAGED_ROLES)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load staff account: ${error.message}`);
  }
  if (!account) {
    return res.status(404).json({ error: 'Staff account not found' });
  }
  // /set-password refuses an inactive account, so the link would be dead on
  // arrival.
  if (!account.is_active) {
    return res.status(409).json({
      error: 'This account is inactive, so a set-password link would not let anyone sign in.',
    });
  }

  // Counted from password_resets, so it survives a restart. Only links that
  // were actually sent are rows there (sendSetPasswordLink drops an unsent
  // one), so a failed send never locks the Secretary out of retrying.
  const since = new Date(Date.now() - SET_PASSWORD_COOLDOWN_MINUTES * 60_000).toISOString();
  const { data: recent, error: cooldownError } = await supabase
    .from('password_resets')
    .select('created_at')
    .eq('user_id', userId)
    .gt('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (cooldownError) {
    throw new Error(`Set-password cooldown check failed: ${cooldownError.message}`);
  }
  if (recent.length > 0) {
    const nextAt = new Date(recent[0].created_at).getTime() + SET_PASSWORD_COOLDOWN_MINUTES * 60_000;
    const minutes = Math.max(1, Math.ceil((nextAt - Date.now()) / 60_000));
    return res.status(429).json({
      error:
        `A set-password link was sent to @${account.username} less than ${SET_PASSWORD_COOLDOWN_MINUTES} minutes ago. ` +
        `Ask them to check their inbox and spam folder, or send another in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      code: 'SET_PASSWORD_LINK_COOLDOWN',
      retry_after_minutes: minutes,
    });
  }

  // Only for the greeting. A failure here must not stop the email.
  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name')
    .eq('user_id', userId)
    .maybeSingle();

  const linkEmail = await sendSetPasswordLink(account, { name: profile?.first_name || null });

  // What became of the email, and nothing else: no address, no link.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.SEND_SET_PASSWORD_LINK,
    table: 'users',
    recordId: userId,
    after: { email_status: linkEmail.status },
  });

  res.json({
    message: sentLinkMessage(linkEmail.status, account.username),
    user_id: userId,
    set_password_email: linkEmail,
  });
});

// The send route's message, by the email's status. Like the creation
// messages, the screen words this itself and this is the fallback.
function sentLinkMessage(status, username) {
  if (status === NOTIFICATION_STATUS.SENT) {
    return `A set-password link was emailed to @${username}. It works once and expires in ${SET_PASSWORD_TTL_HOURS} hours.`;
  }
  if (status === NOTIFICATION_STATUS.SIMULATED) {
    return `Email is simulated on this server, so the set-password link for @${username} was written to the server log instead of being sent.`;
  }
  return `The set-password email to @${username} could not be sent. Nothing else was changed, so you can try again.`;
}

async function loadResidentAccount(userId) {
  const { data, error } = await supabase
    .from('users')
    .select(
      `user_id, username, email, is_active, ${REJECTION_FIELDS}, ` +
      `profiles ( ${PROFILE_FIELDS}, resident_records ( ${LINKED_RECORD_FIELDS} ) )`
    )
    .eq('user_id', userId)
    .eq('role', 'resident')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load resident account: ${error.message}`);
  }
  if (!data) return null;
  // profiles is one-to-one (PK+FK) but normalize in case the client returns an array
  const profile = one(data.profiles);
  return { ...data, profile, linked_record: linkedRecordOf(profile) };
}

// GET /api/secretary/pending-residents?status=pending|rejected|all
//
// Resident accounts that cannot log in. is_active = false is what "not yet
// let in" means, and BOTH outcomes share it — a rejected account is not
// reactivated, it is marked. So the base filter is unchanged and is_rejected
// selects between them.
//
// A rejected account that simply disappeared from every view would be a
// decision nobody could correct, and the applicant is being told at login to
// visit the office about it. Hence 'rejected' and 'all', following the
// ?archived= filter on resident records and ?view= on events.
//
// An unknown value is a 400, never a silent fall back to the default: a
// caller asking for a filter this route does not have is asking the wrong
// question, and answering with the pending list would look like an answer.
router.get('/pending-residents', async (req, res) => {
  const status = String(req.query.status ?? 'pending').toLowerCase();
  if (!PENDING_STATUS_FILTERS.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${PENDING_STATUS_FILTERS.join(', ')}`,
    });
  }

  let query = supabase
    .from('users')
    .select(
      `user_id, username, email, ${REJECTION_FIELDS}, ` +
      `profiles ( ${PROFILE_FIELDS}, resident_records ( ${LINKED_RECORD_FIELDS} ) )`
    )
    .eq('role', 'resident')
    .eq('is_active', false)
    .order('user_id', { ascending: true });

  if (status !== 'all') {
    query = query.eq('is_rejected', status === 'rejected');
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load pending accounts: ${error.message}`);
  }

  // The embed is flattened here so the linked branch of the review card has
  // the masterlist date without a second request — it previously fetched no
  // resident record at all.
  const withLinked = (data || []).map((row) => ({
    ...row,
    linked_record: linkedRecordOf(one(row.profiles)),
  }));

  res.json({ pending: await attachRejectedBy(withLinked), status });
});

// GET /api/secretary/pending-residents/:userId/match-suggestions
// Ranked fuzzy-match candidates from resident_records for the account's
// claimed name — the two-stage engine (pg_trgm blocking + Jaro-Winkler
// scoring) with its DEFAULTS thresholds. Records already linked to another
// account are flagged so the UI can disable them.
router.get('/pending-residents/:userId/match-suggestions', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const account = await loadResidentAccount(userId);
  if (!account) {
    return res.status(404).json({ error: 'Resident account not found' });
  }
  const claimed = account.profile || {};
  if (!claimed.first_name || !claimed.last_name) {
    return res.status(409).json({ error: 'The account has no claimed name to match on' });
  }

  const matches = await findMatches(claimed.first_name, claimed.last_name);

  const { data: linkedRows, error: linkedError } = await supabase
    .from('profiles')
    .select('resident_id')
    .not('resident_id', 'is', null);
  if (linkedError) {
    throw new Error(`Failed to load linked records: ${linkedError.message}`);
  }
  const linkedIds = new Set(linkedRows.map((r) => r.resident_id));

  // HYDRATE the masterlist date onto the candidates rather than adding it to
  // match_resident_candidates' RETURNS TABLE.
  //
  // Adding an output column to that function CANNOT be done with CREATE OR
  // REPLACE — PostgreSQL refuses with "cannot change return type of existing
  // function" and requires a DROP first, which would remove the duplicate
  // checker from the database mid-migration. That checker guards BOTH entry
  // points into the master list, and the function is the measured Stage 1 of
  // the research contribution. One extra read is the cheaper trade by a wide
  // margin.
  //
  // The id list is bounded by DEFAULTS.maxCandidates (50), so .in() is safe
  // here — this is not the four-figure list that GET /unassigned-residents and
  // fine generation had to avoid putting in a query string.
  let datesById = {};
  if (matches.length > 0) {
    const { data: dates, error: dateError } = await supabase
      .from('resident_records')
      .select('resident_id, masterlist_registered_on')
      .in('resident_id', matches.map((m) => m.resident_id));
    if (dateError) {
      throw new Error(`Failed to load masterlist dates: ${dateError.message}`);
    }
    datesById = Object.fromEntries(dates.map((d) => [d.resident_id, d.masterlist_registered_on]));
  }

  res.json({
    claimed,
    // withResidency derives from masterlist_registered_on and yields null when
    // there is no date on file, which is what the screen renders nothing for.
    suggestions: matches.map((m) => withResidency({
      resident_id: m.resident_id,
      first_name: m.first_name,
      middle_name: m.middle_name,
      last_name: m.last_name,
      suffix: m.suffix,
      birthdate: m.birthdate,
      address: m.address,
      masterlist_registered_on: datesById[m.resident_id] ?? null,
      score: m.score,
      already_linked: linkedIds.has(m.resident_id),
    })),
  });
});

// POST /api/secretary/pending-residents/:userId/link
// Link the account to an EXISTING resident_records row.
router.post('/pending-residents/:userId/link', async (req, res) => {
  const userId = Number(req.params.userId);
  const residentId = Number(req.body?.resident_id);
  if (!Number.isInteger(userId) || !Number.isInteger(residentId)) {
    return res.status(400).json({ error: 'A numeric resident_id is required' });
  }

  const account = await loadResidentAccount(userId);
  if (!account) {
    return res.status(404).json({ error: 'Resident account not found' });
  }

  const { data: resident, error: residentError } = await supabase
    .from('resident_records')
    .select('resident_id, first_name, last_name, is_archived, contact_number')
    .eq('resident_id', residentId)
    .maybeSingle();
  if (residentError) {
    throw new Error(`Failed to load resident record: ${residentError.message}`);
  }
  if (!resident) {
    return res.status(404).json({ error: 'Resident record not found' });
  }
  if (resident.is_archived) {
    return res.status(409).json({ error: 'Resident record is archived' });
  }

  const { error: linkError } = await supabase
    .from('profiles')
    .update({ resident_id: residentId })
    .eq('user_id', userId);

  if (linkError) {
    if (linkError.code === '23505') {
      return res.status(409).json({ error: 'That resident record is already linked to another account' });
    }
    throw new Error(`Failed to link resident record: ${linkError.message}`);
  }

  // BUG FIX: the contact number a resident gives at registration lands in
  // profiles.phone_number. The create-and-link path copies it into the
  // resident record; THIS path used to drop it silently, so linking to an
  // existing record with no number on file lost the only number the barangay
  // had — and every notification reads resident_records.contact_number.
  //
  // The record still wins on conflict: this only fills a blank, it never
  // overwrites a number the Secretary entered. Failure is non-fatal, because
  // the link itself succeeded and that is what the caller asked for.
  let contactBackfilled = false;
  const claimed = account.profile?.phone_number;
  if (claimed && !String(resident.contact_number || '').trim()) {
    const { error: backfillError } = await supabase
      .from('resident_records')
      .update({ contact_number: claimed })
      .eq('resident_id', residentId);
    if (backfillError) {
      console.error(`[secretary/link] contact backfill failed: ${backfillError.message}`);
    } else {
      contactBackfilled = true;
    }
  }

  // profiles is keyed by user_id, so that is the record. Whether a number was
  // backfilled is noted; the number itself is not.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.LINK,
    table: 'profiles',
    recordId: userId,
    before: { resident_id: account.profile?.resident_id ?? null },
    after: { resident_id: residentId, contact_backfilled: contactBackfilled },
  });

  res.json({
    message: 'Profile linked to resident record',
    user_id: userId,
    resident_id: residentId,
    contact_backfilled: contactBackfilled,
  });
});

// POST /api/secretary/pending-residents/:userId/create-resident
// Create a NEW resident_records row (defaults come from the info the resident
// claimed at registration; the body can override any field) and link it.
router.post('/pending-residents/:userId/create-resident', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const account = await loadResidentAccount(userId);
  if (!account) {
    return res.status(404).json({ error: 'Resident account not found' });
  }
  if (account.profile?.resident_id) {
    return res.status(409).json({ error: 'Account is already linked to a resident record' });
  }

  const p = account.profile || {};
  const body = req.body || {};

  // A contact_number OVERRIDE is checked like every other contact number
  // (constants/phoneNumber.js) — optional, validated only when non-blank, and
  // stored trimmed; a blank override stores null rather than an empty string.
  // The fallback, the applicant's claimed profiles.phone_number, is NOT
  // re-checked here: registration validates it, and the review screen sends no
  // override, so refusing a bad fallback would leave the Secretary no way past
  // it. Every claimed number on file matched on 25 Sep 2026 (8 of 8).
  const hasContactOverride = body.contact_number !== undefined && body.contact_number !== null;
  const contactOverride = hasContactOverride ? String(body.contact_number).trim() : '';
  if (contactOverride && !PH_MOBILE_RE.test(contactOverride)) {
    return res.status(400).json({ error: CONTACT_NUMBER_ERROR });
  }

  const record = {
    first_name: body.first_name ?? p.first_name,
    middle_name: body.middle_name ?? p.middle_name,
    last_name: body.last_name ?? p.last_name,
    suffix: body.suffix ?? p.suffix,
    birthdate: body.birthdate ?? p.birthdate,
    birthplace: body.birthplace ?? null,
    address: body.address ?? p.address,
    sex: body.sex ?? null,
    civil_status: body.civil_status ?? null,
    religion: body.religion ?? null,
    educational_attainment: body.educational_attainment ?? null,
    contact_number: hasContactOverride ? contactOverride || null : p.phone_number,
    date_registered: new Date().toISOString(),
    is_archived: false,
  };

  const missing = ['first_name', 'last_name', 'address'].filter((f) => !record[f]);
  if (missing.length) {
    return res.status(400).json({
      error: `Cannot create resident record; missing: ${missing.join(', ')}. Provide them in the request body.`,
    });
  }

  const { data: resident, error: insertError } = await supabase
    .from('resident_records')
    .insert(record)
    .select()
    .single();
  if (insertError) {
    throw new Error(`Failed to create resident record: ${insertError.message}`);
  }

  const { error: linkError } = await supabase
    .from('profiles')
    .update({ resident_id: resident.resident_id })
    .eq('user_id', userId);
  if (linkError) {
    // don't leave an unlinked orphan record behind
    await supabase.from('resident_records').delete().eq('resident_id', resident.resident_id);
    throw new Error(`Failed to link new resident record: ${linkError.message}`);
  }

  // Same identifying fields as the master list's add route, plus the account
  // it was linked to in the same step.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.CREATE,
    table: 'resident_records',
    recordId: resident.resident_id,
    after: { ...pick(resident, RESIDENT_LOG_FIELDS), linked_user_id: userId },
  });

  res.status(201).json({ message: 'Resident record created and linked', user_id: userId, resident });
});

// POST /api/secretary/pending-residents/:userId/activate
// Only allowed once a resident record has been linked, and never for an
// account that has been rejected.
router.post('/pending-residents/:userId/activate', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const account = await loadResidentAccount(userId);
  if (!account) {
    return res.status(404).json({ error: 'Resident account not found' });
  }
  if (account.is_active) {
    return res.status(409).json({ error: 'Account is already active' });
  }
  // A rejected account is still is_active = false, so without this check it
  // matched the pending list and could be activated straight from it — the
  // decision undone by the next click, with nothing to show it had been made.
  // Reversing a rejection has to be the deliberate act, which is un-reject.
  if (account.is_rejected) {
    return res.status(409).json({
      error: 'This registration was rejected. Un-reject it first if the applicant is now eligible.',
    });
  }
  if (!account.profile?.resident_id) {
    return res.status(409).json({ error: 'Link a resident record before activating the account' });
  }

  // Status-guarded like every other transition in the codebase: the same two
  // conditions checked above, re-asserted in the WHERE clause so a rejection
  // landing between the read and the write cannot be activated over.
  const { data: activated, error } = await supabase
    .from('users')
    .update({ is_active: true })
    .eq('user_id', userId)
    .eq('is_active', false)
    .eq('is_rejected', false)
    .select('user_id')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to activate account: ${error.message}`);
  }
  if (!activated) {
    return res.status(409).json({ error: 'Account state just changed — refresh and try again' });
  }

  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.ACTIVATE,
    table: 'users',
    recordId: userId,
    before: { is_active: false },
    after: { is_active: true },
  });

  res.json({ message: 'Account activated. The resident can now log in.', user_id: userId });
});

// ---------------------------------------------------------------------------
// Registration rejection (migration 017).
//
// WHY THIS EXISTS: the Secretary could previously only ever ACTIVATE a pending
// registration. An ineligible applicant sat in the list forever, and — worse —
// was told at login that their account was "pending approval by the Barangay
// Secretary", which was false the moment a decision had been made.
//
// WHY IT IS NOT JUST is_active = false: a pending registration is created with
// is_active = false, so that flag was already clear. Rejecting had literally
// no state to write. Migration 017 adds the five columns this pair maintains.
//
// Rejection is REVERSIBLE. It is a judgement about eligibility, and eligibility
// changes — a resident gets added to the masterlist, or reaches six months of
// residency. Un-rejecting returns the account to exactly the pending state it
// was in before, from which the normal link-and-activate flow continues.
// ---------------------------------------------------------------------------

// POST /api/secretary/pending-residents/:userId/reject
// Body: { reason: <code>, note?: <string> }
router.post('/pending-residents/:userId/reject', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const reason = String(req.body?.reason ?? '').trim();
  if (!isRejectionReason(reason)) {
    return res.status(400).json({
      error: `reason must be one of: ${REJECTION_REASONS.join(', ')}`,
    });
  }

  const note = String(req.body?.note ?? '').trim();
  // Only OTHER demands a note: the two specific codes already say why, while
  // OTHER says nothing at all unless the Secretary writes it down.
  if (reasonRequiresNote(reason) && !note) {
    return res.status(400).json({ error: 'A note is required when the reason is OTHER' });
  }
  if (note.length > 255) {
    return res.status(400).json({ error: 'note must be 255 characters or fewer' });
  }

  const account = await loadResidentAccount(userId);
  if (!account) {
    return res.status(404).json({ error: 'Resident account not found' });
  }
  if (account.is_active) {
    return res.status(409).json({
      error: 'This account is already active and cannot be rejected. Archive the resident record instead if the account should lose access.',
    });
  }
  if (account.is_rejected) {
    return res.status(409).json({
      error: 'This registration has already been rejected. Un-reject it first to change the reason.',
    });
  }

  const { data: rejected, error } = await supabase
    .from('users')
    .update({
      is_rejected: true,
      rejection_reason: reason,
      // Stored as null rather than '' when absent, so the CHECK constraint's
      // "not rejected => all null" branch stays meaningful and the column
      // never holds an empty string standing in for "no note".
      rejection_note: note || null,
      rejected_at: new Date().toISOString(),
      rejected_by_user_id: req.user.user_id,
    })
    .eq('user_id', userId)
    .eq('is_active', false)
    .eq('is_rejected', false)
    .select(`user_id, username, ${REJECTION_FIELDS}`)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to reject registration: ${error.message}`);
  }
  if (!rejected) {
    return res.status(409).json({ error: 'Account state just changed — refresh and try again' });
  }

  // Recorded, not sent (SMS_MODE=SIMULATED). Runs AFTER the rejection is
  // committed and notify() never throws, so a notification problem cannot
  // undo the decision.
  //
  // THE PHONE NUMBER COMES FROM profiles.phone_number, AND THIS IS THE ONE
  // CALL SITE WHERE IT MUST. Everywhere else resident_records.contact_number
  // wins, because the record is what the barangay maintains and the profile is
  // only what the resident claimed. A rejected applicant usually has NO linked
  // resident record at all — being unmatchable is the commonest reason to
  // reject one — so the claimed number is the only number in existence. This
  // is an exception by availability, not by preference.
  //
  // Only the reason code's canned sentence is sent. The Secretary's note is
  // internal and never leaves the office.
  await notify({
    userId,
    destination: account.profile?.phone_number,
    relatedType: RELATED_TYPE.ACCOUNT,
    relatedTo: userId,
    message: `BrgyServe: ${rejectionMessage(reason)}`,
  });

  // The reason CODE only. The Secretary's note is internal free text and
  // stays on the users row.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.REJECT,
    table: 'users',
    recordId: userId,
    before: { is_rejected: false },
    after: { is_rejected: true, rejection_reason: reason },
  });

  res.json({
    message: `Registration rejected. @${rejected.username} is told the reason when they try to sign in.`,
    user_id: userId,
    rejection: rejected,
  });
});

// POST /api/secretary/pending-residents/:userId/unreject
// Clears all five columns, returning the account to the pending state.
router.post('/pending-residents/:userId/unreject', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const account = await loadResidentAccount(userId);
  if (!account) {
    return res.status(404).json({ error: 'Resident account not found' });
  }
  if (!account.is_rejected) {
    return res.status(409).json({ error: 'This registration has not been rejected' });
  }

  // All four detail columns are cleared together with the flag. The CHECK
  // constraint added in migration 017 requires it — "not rejected" means all
  // four are null — and it is the right behaviour anyway: leaving a stale
  // reason behind would make a later reader think the account is still marked.
  const { data: restored, error } = await supabase
    .from('users')
    .update({
      is_rejected: false,
      rejection_reason: null,
      rejection_note: null,
      rejected_at: null,
      rejected_by_user_id: null,
    })
    .eq('user_id', userId)
    .eq('is_rejected', true)
    .select('user_id, username')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to un-reject registration: ${error.message}`);
  }
  if (!restored) {
    return res.status(409).json({ error: 'Account state just changed — refresh and try again' });
  }

  // Deliberately NOT notified. Nothing has been granted — the account is back
  // to awaiting review, exactly where it started — so a message saying so
  // would announce a non-event, and the applicant would still not be able to
  // log in. They are told when the account is ACTIVATED, which is the point at
  // which something actually changed for them.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.UNREJECT,
    table: 'users',
    recordId: userId,
    before: { is_rejected: true, rejection_reason: account.rejection_reason ?? null },
    after: { is_rejected: false },
  });

  res.json({
    message: `Rejection cleared. @${restored.username} is awaiting review again.`,
    user_id: userId,
  });
});

module.exports = router;
