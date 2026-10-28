const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { logActivity, diffFields } = require('../services/activityLog');
const { ACTIONS } = require('../constants/activityLog');
const { MAX_DAYS_AHEAD_MIN, MAX_DAYS_AHEAD_MAX } = require('../constants/rentalBookingRules');

// The barangay-wide booking rules (migration 025): one row, id 1. Today it
// holds one number, how many days ahead a booking may start. Each item's
// hours live on the item itself (rental_items.booking_opens_at and
// booking_closes_at, routes/rentalItems.js). The rules are enforced by the
// booking routes (routes/rentalRequests.js); this file only reads and
// changes them.
const router = express.Router();

router.use(authenticate);

// Reads the one row. Missing or unreadable is thrown (a 500), never answered
// with a made-up default: a booking form would then show a limit the server
// does not enforce.
async function readSettings() {
  const { data, error } = await supabase
    .from('rental_settings')
    .select('max_days_ahead')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the booking rules: ${error.message}`);
  if (!data) throw new Error('The booking rules (rental_settings) have no row');
  return data;
}

// GET /api/rental-settings — any authenticated user, read only. The booking
// forms show the limit beside the date, and the Rental items page shows it
// for the Secretary to change.
router.get('/', async (req, res) => {
  const settings = await readSettings();
  res.json({ max_days_ahead: settings.max_days_ahead });
});

// PUT /api/rental-settings — the Secretary changes the limit. A whole number
// from 1 to 366 (the database CHECKs the same range). Bookings already made
// are not touched; the new limit applies to the next booking or edit.
router.put('/', requireRole('secretary'), async (req, res) => {
  const raw = req.body?.max_days_ahead;
  const n = typeof raw === 'number' ? raw : /^\s*\d+\s*$/.test(String(raw ?? '')) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < MAX_DAYS_AHEAD_MIN || n > MAX_DAYS_AHEAD_MAX) {
    return res.status(400).json({
      error: `max_days_ahead must be a whole number from ${MAX_DAYS_AHEAD_MIN} to ${MAX_DAYS_AHEAD_MAX}`,
    });
  }

  const before = await readSettings();
  const { data, error } = await supabase
    .from('rental_settings')
    .update({ max_days_ahead: n })
    .eq('id', 1)
    .select('max_days_ahead')
    .maybeSingle();
  if (error) throw new Error(`Failed to save the booking rules: ${error.message}`);
  if (!data) throw new Error('The booking rules (rental_settings) have no row');

  // A save that changed nothing logs nothing (logActivity skips an empty
  // UPDATE).
  const diff = diffFields(before, data);
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.UPDATE,
    table: 'rental_settings',
    recordId: 1,
    before: diff.before,
    after: diff.after,
  });

  res.json({ message: 'Booking rules saved', max_days_ahead: data.max_days_ahead });
});

module.exports = router;
