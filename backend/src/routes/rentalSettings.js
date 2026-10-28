const express = require('express');
const { authenticate } = require('../middleware/auth');
const { MAX_DAYS_AHEAD } = require('../constants/rentalBookingRules');

// How far ahead a booking may start, for the booking forms. Each item's
// hours live on the item itself (rental_items.booking_opens_at and
// booking_closes_at, routes/rentalItems.js). The rules are enforced by the
// booking routes (routes/rentalRequests.js); this file only says the limit.
//
// Since step O43 (28 Oct 2026) the limit is a constant in the code
// (MAX_DAYS_AHEAD, constants/rentalBookingRules.js), never read from the
// database: PUT /api/rental-settings and the Rental items page's Booking
// rules box were removed, and migration 026 drops the rental_settings table.
const router = express.Router();

router.use(authenticate);

// GET /api/rental-settings — any authenticated user, read only. The booking
// forms and the Edit panel show the limit beside the date.
router.get('/', (req, res) => {
  res.json({ max_days_ahead: MAX_DAYS_AHEAD });
});

module.exports = router;
