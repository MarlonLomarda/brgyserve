const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/residents/me — the logged-in user's own resident record,
// resolved through the profiles.resident_id link set by the Secretary.
router.get('/me', authenticate, async (req, res) => {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('resident_id')
    .eq('user_id', req.user.user_id)
    .maybeSingle();
  if (profileError) {
    throw new Error(`Failed to load profile: ${profileError.message}`);
  }

  if (!profile?.resident_id) {
    return res.status(404).json({ error: 'No resident record is linked to this account yet' });
  }

  const { data: resident, error } = await supabase
    .from('resident_records')
    .select('*')
    .eq('resident_id', profile.resident_id)
    .single();
  if (error) {
    throw new Error(`Failed to load resident record: ${error.message}`);
  }

  res.json({ resident });
});

module.exports = router;
