const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, requireRole('secretary'));

const PROFILE_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, phone_number';

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
    .select('resident_id, first_name, last_name, is_archived')
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

  res.json({ message: 'Profile linked to resident record', user_id: userId, resident_id: residentId });
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
