const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { findMatches } = require('../services/nameMatching');
const { notify } = require('../services/notifications');
const { RELATED_TYPE } = require('../constants/notifications');
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
// self-register and are deliberately NOT creatable here.
const STAFF_ROLES = ['secretary', 'punong_barangay', 'treasurer', 'staff'];

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

// POST /api/secretary/accounts — create a staff-type account.
// The generated temporary password is returned ONCE so the Secretary can hand
// it over; must_change_password forces the user to replace it on first login.
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

  const temporaryPassword = `Temp-${crypto.randomBytes(9).toString('base64url')}`;
  const password_hash = await bcrypt.hash(temporaryPassword, 10);

  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      username,
      password_hash,
      email,
      email_verified: false,
      role,
      must_change_password: true, // forced change on first login
      is_active: true,            // staff accounts can log in immediately
    })
    .select('user_id, username, email, role')
    .single();
  if (userError) {
    if (userError.code === '23505') {
      return res.status(409).json({ error: 'Username is already taken' });
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

  res.status(201).json({
    message: 'Account created. Share the temporary password securely; the user must change it on first login.',
    user,
    temporary_password: temporaryPassword,
  });
});

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
    contact_number: body.contact_number ?? p.phone_number,
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
  res.json({
    message: `Rejection cleared. @${restored.username} is awaiting review again.`,
    user_id: userId,
  });
});

module.exports = router;
