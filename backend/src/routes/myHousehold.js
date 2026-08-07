const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { HOUSEHOLD_ROLE } = require('../constants/households');

const router = express.Router();

// ===========================================================================
// EVENTS STAGE 3c — the resident's household QR code
//
// The QR token is what stage 3d will scan to record attendance, so this route
// is the only place a resident can obtain one.
//
// THE HOUSEHOLD IS DERIVED FROM THE SESSION AND NOTHING ELSE. There is no
// household_id parameter anywhere — not in the path, not in the query, not in
// the body — so a resident cannot ask for somebody else's code by guessing an
// id. The chain is: token -> users.user_id -> profiles.resident_id ->
// the one active household_members row -> household_qr.
//
// Residents only. Households with no account behind them are handled by the
// Secretary recording attendance by hand, which already works; there is
// deliberately no Secretary-side QR view.
//
// The response carries ONLY what is needed to draw the code. No household
// number, no head name, no address, no member list — a QR code shown on a
// phone at an assembly should not double as a roster of who lives where.
// ===========================================================================

// Every "no code to show" outcome, kept in one place so the page can explain
// itself instead of rendering an error. None of these is a failure: a resident
// who simply is not in a household is a normal state.
const NO_HOUSEHOLD = {
  NO_RECORD: 'no_resident_record',
  NO_MEMBERSHIP: 'no_membership',
  INACTIVE_HOUSEHOLD: 'household_inactive',
  NO_QR: 'no_qr',
};

router.use(authenticate, requireRole('resident'));

// GET /api/my-household — the session owner's household QR token, or a reason
// there isn't one. Always 200: "you have no household" is information, not an
// error, and the page renders a plain message for it.
router.get('/', async (req, res) => {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('resident_id')
    .eq('user_id', req.user.user_id)
    .maybeSingle();
  if (profileError) throw new Error(`Failed to load profile: ${profileError.message}`);

  if (!profile?.resident_id) {
    return res.json({ has_household: false, reason: NO_HOUSEHOLD.NO_RECORD });
  }

  // A resident holds at most one active membership (Households stage 2), so
  // this resolves to a single household or to none.
  const { data: membership, error: memberError } = await supabase
    .from('household_members')
    .select('household_id, role')
    .eq('resident_id', profile.resident_id)
    .is('date_ended', null)
    .maybeSingle();
  if (memberError) throw new Error(`Failed to load household membership: ${memberError.message}`);

  if (!membership) {
    return res.json({ has_household: false, reason: NO_HOUSEHOLD.NO_MEMBERSHIP });
  }

  // Deactivating a household ends every membership, so an active membership in
  // an inactive household should not exist — checked anyway rather than handing
  // out a code for a dissolved household.
  const { data: household, error: householdError } = await supabase
    .from('household_records')
    .select('household_id, is_active')
    .eq('household_id', membership.household_id)
    .maybeSingle();
  if (householdError) throw new Error(`Failed to load household: ${householdError.message}`);

  if (!household || !household.is_active) {
    return res.json({ has_household: false, reason: NO_HOUSEHOLD.INACTIVE_HOUSEHOLD });
  }

  const { data: qr, error: qrError } = await supabase
    .from('household_qr')
    .select('qr_token, is_active')
    .eq('household_id', membership.household_id)
    .eq('is_active', true)
    .maybeSingle();
  if (qrError) throw new Error(`Failed to load the household QR: ${qrError.message}`);

  if (!qr?.qr_token) {
    return res.json({ has_household: false, reason: NO_HOUSEHOLD.NO_QR });
  }

  res.json({
    has_household: true,
    qr_token: qr.qr_token,
    // Whether this resident is the head — the page uses it only to word the
    // caption, never to reveal who the head is.
    is_head: membership.role === HOUSEHOLD_ROLE.HEAD,
  });
});

module.exports = router;
