const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { authenticate, allowPendingPasswordChange } = require('../middleware/auth');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/auth/register — resident self-registration.
// The account is created pending (is_active = false, no resident link) and
// cannot log in until the Secretary links a resident record and activates it.
router.post('/register', async (req, res) => {
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
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
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

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('user_id, username, password_hash, email, role, is_active, must_change_password')
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
    return res.status(403).json({ error: 'Account is pending approval by the Barangay Secretary' });
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
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
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

module.exports = router;
