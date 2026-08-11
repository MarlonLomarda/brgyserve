const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { findMatches } = require('../services/nameMatching');

// Staff-type roles the Secretary may create accounts for (per the
// "Authentication & account rules" in docs/brgyserve-use-cases.md, this
// includes another secretary — succession is a real need). Residents
// self-register and are deliberately NOT creatable here.
const STAFF_ROLES = ['secretary', 'punong_barangay', 'treasurer', 'staff'];

const router = express.Router();

router.use(authenticate, requireRole('secretary'));

const PROFILE_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, phone_number';

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
    .select(`user_id, username, email, is_active, profiles ( ${PROFILE_FIELDS} )`)
    .eq('user_id', userId)
    .eq('role', 'resident')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load resident account: ${error.message}`);
  }
  if (!data) return null;
  // profiles is one-to-one (PK+FK) but normalize in case the client returns an array
  const profile = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;
  return { ...data, profile: profile || null };
}

// GET /api/secretary/pending-residents — resident accounts awaiting review
router.get('/pending-residents', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select(`user_id, username, email, profiles ( ${PROFILE_FIELDS} )`)
    .eq('role', 'resident')
    .eq('is_active', false)
    .order('user_id', { ascending: true });

  if (error) {
    throw new Error(`Failed to load pending accounts: ${error.message}`);
  }
  res.json({ pending: data });
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

  res.json({
    claimed,
    suggestions: matches.map((m) => ({
      resident_id: m.resident_id,
      first_name: m.first_name,
      middle_name: m.middle_name,
      last_name: m.last_name,
      suffix: m.suffix,
      birthdate: m.birthdate,
      address: m.address,
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
// Only allowed once a resident record has been linked.
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
  if (!account.profile?.resident_id) {
    return res.status(409).json({ error: 'Link a resident record before activating the account' });
  }

  const { error } = await supabase
    .from('users')
    .update({ is_active: true })
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to activate account: ${error.message}`);
  }

  res.json({ message: 'Account activated. The resident can now log in.', user_id: userId });
});

module.exports = router;
