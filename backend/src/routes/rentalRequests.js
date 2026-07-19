const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const { ITEM_TYPE, RENTAL_STATUS } = require('../constants/rentals');
const { logSmsNotification } = require('../services/smsNotification');

const router = express.Router();

router.use(authenticate);

const RENTAL_FIELDS =
  'request_id, quantity_requested, start_datetime, end_datetime, purpose, status, rental_items ( item_id, name, type, fee )';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// All barangay bookings are Philippine local time; composing with an explicit
// +08:00 offset keeps stored timestamps correct no matter where the server runs.
const TZ = 'Asia/Manila';
const timeFmt = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, dateStyle: 'medium' });

// Overlap rule (half-open ranges): existing and requested slots overlap iff
//   existing.start < requested.end AND existing.end > requested.start
// Strict comparisons make ranges that merely touch at an endpoint
// (existing 2pm-6pm vs requested 6pm-9pm) NOT overlap.
// Only non-cancelled bookings hold units ('completed' rentals are in the past
// and can never overlap a future slot anyway, since backdated bookings are
// refused). beforeId limits the check to rows inserted earlier (see the
// concurrency note in the POST handler).
async function overlappingBookings(itemId, startIso, endIso, beforeId = null) {
  let query = supabase
    .from('rental_requests')
    .select('request_id, quantity_requested, start_datetime, end_datetime')
    .eq('item_id', itemId)
    .neq('status', RENTAL_STATUS.CANCELLED)
    .lt('start_datetime', endIso)
    .gt('end_datetime', startIso)
    .order('start_datetime', { ascending: true });
  if (beforeId !== null) query = query.lt('request_id', beforeId);
  const { data, error } = await query;
  if (error) throw new Error(`Conflict check failed: ${error.message}`);
  return data;
}

const unitsUsed = (rows) => rows.reduce((sum, r) => sum + r.quantity_requested, 0);

function conflictMessage(item, quantity, overlapping) {
  if (item.type === ITEM_TYPE.FACILITY) {
    const first = overlapping[0];
    return `The ${item.name} is already booked from ${timeFmt.format(new Date(first.start_datetime))} to ${timeFmt.format(new Date(first.end_datetime))} on that date — please pick a different time.`;
  }
  const free = Math.max(0, item.quantity_available - unitsUsed(overlapping));
  return `Only ${free} of ${item.quantity_available} ${item.name} ${free === 1 ? 'is' : 'are'} available for that time — you asked for ${quantity}.`;
}

// POST /api/rental-requests — the resident books an item. SELF-SERVICE: the
// conflict check runs here at submission, and a passing request is confirmed
// instantly (no Secretary approval step).
router.post('/', async (req, res) => {
  const itemId = Number(req.body?.item_id);
  const date = String(req.body?.date ?? '').trim();
  const startTime = String(req.body?.start_time ?? '').trim();
  const endTime = String(req.body?.end_time ?? '').trim();
  const purpose = String(req.body?.purpose ?? '').trim();
  const quantity = req.body?.quantity_requested === undefined ? 1 : Number(req.body?.quantity_requested);

  if (!Number.isInteger(itemId)) {
    return res.status(400).json({ error: 'An item_id is required' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  }
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return res.status(400).json({ error: 'start_time and end_time must be in HH:MM (24-hour) format' });
  }
  if (!purpose) {
    return res.status(400).json({ error: 'purpose is required' });
  }
  if (purpose.length > 1000) {
    return res.status(400).json({ error: 'purpose must be 1000 characters or fewer' });
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'quantity_requested must be a whole number of at least 1' });
  }

  // Same-day bookings by construction: one date, two times on it.
  const start = new Date(`${date}T${startTime}:00+08:00`);
  const end = new Date(`${date}T${endTime}:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ error: 'Invalid date or time' });
  }
  if (end <= start) {
    return res.status(400).json({ error: 'End time must be after the start time (bookings run within one day)' });
  }
  if (start <= new Date()) {
    return res.status(400).json({ error: 'The booking must start in the future' });
  }

  // Bookings are for verified residents — same rule as document requests.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('resident_id, resident_records ( contact_number )')
    .eq('user_id', req.user.user_id)
    .maybeSingle();
  if (profileError) {
    throw new Error(`Failed to load profile: ${profileError.message}`);
  }
  if (!profile?.resident_id) {
    return res.status(409).json({
      error:
        'Your account is not linked to a resident record yet. Facility booking becomes available once the Barangay Secretary approves your registration.',
    });
  }

  const { data: item, error: itemError } = await supabase
    .from('rental_items')
    .select('item_id, name, type, quantity_total, quantity_available, fee, is_active')
    .eq('item_id', itemId)
    .maybeSingle();
  if (itemError) {
    throw new Error(`Failed to load rental item: ${itemError.message}`);
  }
  if (!item) {
    return res.status(404).json({ error: 'Rental item not found' });
  }
  if (!item.is_active) {
    return res.status(400).json({ error: 'That item is not currently available for rental' });
  }
  if (item.type === ITEM_TYPE.FACILITY && quantity !== 1) {
    return res.status(400).json({ error: `The ${item.name} is booked as a whole — quantity must be 1` });
  }
  if (quantity > item.quantity_available) {
    return res.status(400).json({
      error: `Only ${item.quantity_available} unit${item.quantity_available === 1 ? '' : 's'} of ${item.name} exist${item.quantity_available === 1 ? 's' : ''} — you asked for ${quantity}`,
    });
  }

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  // CONFLICT CHECK, pass 1 (pre-insert): capacity for the slot is
  // quantity_available; units used = sum of quantity_requested over
  // overlapping non-cancelled bookings. Facilities are the same math with
  // capacity 1 — any overlap fills the slot.
  const overlapping = await overlappingBookings(itemId, startIso, endIso);
  if (unitsUsed(overlapping) + quantity > item.quantity_available) {
    return res.status(409).json({ error: conflictMessage(item, quantity, overlapping) });
  }

  const { data: created, error: insertError } = await supabase
    .from('rental_requests')
    .insert({
      item_id: itemId,
      requested_by_user_id: req.user.user_id,
      quantity_requested: quantity,
      start_datetime: startIso,
      end_datetime: endIso,
      purpose,
      status: RENTAL_STATUS.CONFIRMED,
      processed_by_user_id: null, // self-service: nobody approves
    })
    .select(RENTAL_FIELDS)
    .single();
  if (insertError) {
    throw new Error(`Failed to create booking: ${insertError.message}`);
  }

  // CONFLICT CHECK, pass 2 (post-insert): supabase-js has no transactions, so
  // two simultaneous submissions could both pass pass 1. Re-check counting
  // only rows inserted BEFORE ours (request_id < ours): the earliest insert
  // sees no one ahead of it and always survives; a loser deletes its own row
  // and is refused. Deterministic, and never double-books.
  const earlier = await overlappingBookings(itemId, startIso, endIso, created.request_id);
  if (unitsUsed(earlier) + quantity > item.quantity_available) {
    await supabase.from('rental_requests').delete().eq('request_id', created.request_id);
    return res.status(409).json({ error: conflictMessage(item, quantity, earlier) });
  }

  logSmsNotification(
    profile.resident_records?.contact_number,
    `BrgyServe: your booking is CONFIRMED — ${quantity > 1 ? `${quantity}× ` : ''}${item.name} on ${dateFmt.format(start)}, ${timeFmt.format(start)} to ${timeFmt.format(end)}.`
  );

  res.status(201).json({
    message: `Booking confirmed: ${item.name} on ${dateFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}.`,
    request: created,
  });
});

// GET /api/rental-requests/mine — only the logged-in user's own bookings,
// newest first (the requested_by_user_id filter keeps residents from seeing
// each other's bookings). rental_requests has no created-at column, so
// request_id order stands in for insertion order.
router.get('/mine', async (req, res) => {
  const { data, error } = await supabase
    .from('rental_requests')
    .select(RENTAL_FIELDS)
    .eq('requested_by_user_id', req.user.user_id)
    .order('request_id', { ascending: false });
  if (error) {
    throw new Error(`Failed to load bookings: ${error.message}`);
  }
  res.json({ requests: data });
});

module.exports = router;
