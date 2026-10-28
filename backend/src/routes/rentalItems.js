const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { ITEM_TYPE, ITEM_TYPES, RENTAL_STATUS, RETURNABLE_TYPES } = require('../constants/rentals');
const { logActivity, diffFields } = require('../services/activityLog');
const { ACTIONS } = require('../constants/activityLog');
const { MIDNIGHT, clockMinutes } = require('../constants/rentalBookingRules');

const router = express.Router();

const MAX_FEE = 99999999.99; // numeric(10,2) ceiling
const MAX_QUANTITY = 100000;

const ITEM_FIELDS =
  'item_id, name, type, description, quantity_total, quantity_available, fee, is_active, booking_opens_at, booking_closes_at';

// Returns the fee as a number rounded to centavos, or null if invalid.
function parseFee(fee) {
  const n = Number(fee);
  if (fee === '' || fee === null || fee === undefined || !Number.isFinite(n)) return null;
  if (n < 0 || n > MAX_FEE) return null;
  return Math.round(n * 100) / 100;
}

function validateBody(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) return { error: 'name is required' };
  if (name.length > 100) return { error: 'name must be 100 characters or fewer' };

  const type = String(body?.type ?? '').trim().toLowerCase();
  if (!ITEM_TYPES.includes(type)) {
    return { error: `type must be one of: ${ITEM_TYPES.join(', ')}` };
  }

  const quantity = Number(body?.quantity_total);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return { error: 'quantity_total must be a whole number of at least 1' };
  }
  // Whole facilities (court, hall) are booked as one unit.
  if (type === ITEM_TYPE.FACILITY && quantity !== 1) {
    return { error: 'Facilities are single-unit — quantity_total must be 1' };
  }

  const fee = parseFee(body?.fee);
  if (fee === null) return { error: 'fee must be a number between 0 and 99,999,999.99' };

  const description = String(body?.description ?? '').trim() || null;

  const hours = parseHours(body);
  if (hours.error) return { error: hours.error };

  // quantity_available mirrors quantity_total for now: a single number cannot
  // express per-time-slot availability, so the stage-2 conflict check derives
  // free units per slot from approved bookings against quantity_available.
  // Keeping the columns separate lets damaged/retired stock lower it later.
  return {
    value: { name, type, description, quantity_total: quantity, quantity_available: quantity, fee, ...hours.value },
  };
}

// The item's booking hours (migration 025), "HH:MM". Optional as a PAIR: a
// body with neither leaves them as they are (a new item takes the
// database's 07:00 to 17:00), one with either must carry both. A close of
// "00:00" or "24:00" is midnight, stored as 24:00 (a `time` holds it), since
// a close at the day's first minute could never be after the opening. The
// opening must be before the close; the database CHECKs that too.
function parseHours(body) {
  const opensRaw = body?.booking_opens_at;
  const closesRaw = body?.booking_closes_at;
  if (opensRaw === undefined && closesRaw === undefined) return { value: {} };
  if (opensRaw === undefined || closesRaw === undefined) {
    return { error: 'booking_opens_at and booking_closes_at must be sent together' };
  }
  const opens = clockMinutes(String(opensRaw).trim());
  if (opens === null || opens === MIDNIGHT) {
    return { error: 'booking_opens_at must be a time in HH:MM (24-hour) format' };
  }
  const closesText = String(closesRaw).trim();
  let closes = clockMinutes(closesText);
  if (closes === 0) closes = MIDNIGHT;
  if (closes === null) {
    return { error: 'booking_closes_at must be a time in HH:MM (24-hour) format, or 24:00 for midnight' };
  }
  if (opens >= closes) {
    return { error: 'The opening time must be before the closing time' };
  }
  // As PostgREST sends a `time` back ("07:00:00"), so the log's diff of the
  // row before and after compares like with like.
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  return { value: { booking_opens_at: clock(opens), booking_closes_at: clock(closes) } };
}

// Case-insensitive duplicate-name check (excludeId for updates).
async function nameTaken(name, excludeId = null) {
  let query = supabase.from('rental_items').select('item_id').ilike('name', name);
  if (excludeId !== null) query = query.neq('item_id', excludeId);
  const { data, error } = await query;
  if (error) throw new Error(`Duplicate-name check failed: ${error.message}`);
  return data.length > 0;
}

// What an item's bookings hold, as plain counts for the lower-stock warning:
// its confirmed bookings (not cancelled, not returned) that are upcoming, or
// overdue and not yet returned (a facility's past booking is completed, an
// item's is overdue: deriveStatus in rentalRequests.js). No overlap rule here:
// that is the database's (migration 024). Warning when the new total is below
// ALL their units together is never wrong in the "no warning" direction: no
// moment, and no single booking, can hold more than all of them. It can warn
// for bookings on different days that never meet; the Secretary may then
// lower it anyway.
async function heldUnits(itemId, type) {
  const { data, error } = await supabase
    .from('rental_requests')
    .select('quantity_requested, end_datetime')
    .eq('item_id', itemId)
    .eq('status', RENTAL_STATUS.CONFIRMED);
  if (error) throw new Error(`Failed to load the item's bookings: ${error.message}`);
  const now = new Date();
  const held = data
    .filter((b) => RETURNABLE_TYPES.includes(type) || new Date(b.end_datetime) > now)
    .map((b) => b.quantity_requested);
  return {
    bookings: held.length,
    units: held.reduce((sum, n) => sum + n, 0),
    largest: held.length ? Math.max(...held) : 0,
  };
}

// GET /api/rental-items — ACTIVE items only; any authenticated user.
// This is what residents will use to pick an item when booking (stage 2).
// Each item carries its booking hours (migration 025), which the booking
// forms show and hold the time fields to.
router.get('/', authenticate, async (req, res) => {
  const { data, error } = await supabase
    .from('rental_items')
    .select('item_id, name, type, description, quantity_total, quantity_available, fee, booking_opens_at, booking_closes_at')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(`Failed to load rental items: ${error.message}`);
  res.json({ rental_items: data });
});

// Everything below is Secretary-only management.
router.use(authenticate, requireRole('secretary'));

// GET /api/rental-items/all — includes deactivated items
router.get('/all', async (req, res) => {
  const { data, error } = await supabase
    .from('rental_items')
    .select(ITEM_FIELDS)
    .order('name', { ascending: true });
  if (error) throw new Error(`Failed to load rental items: ${error.message}`);
  res.json({ rental_items: data });
});

// POST /api/rental-items — create
router.post('/', async (req, res) => {
  const { error: validationError, value } = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (await nameTaken(value.name)) {
    return res.status(409).json({ error: 'A rental item with that name already exists' });
  }

  const { data, error } = await supabase
    .from('rental_items')
    .insert({ ...value, is_active: true })
    .select(ITEM_FIELDS)
    .single();
  if (error) throw new Error(`Failed to create rental item: ${error.message}`);

  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.CREATE,
    table: 'rental_items',
    recordId: data.item_id,
    after: data,
  });

  res.status(201).json({ message: 'Rental item created', rental_item: data });
});

// PUT /api/rental-items/:id — update name/type/description/quantity/fee
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid rental item id' });

  const { error: validationError, value } = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (await nameTaken(value.name, id)) {
    return res.status(409).json({ error: 'A rental item with that name already exists' });
  }

  // The row as it was, so the activity log can record what changed.
  const { data: before, error: beforeError } = await supabase
    .from('rental_items')
    .select(ITEM_FIELDS)
    .eq('item_id', id)
    .maybeSingle();
  if (beforeError) throw new Error(`Failed to load rental item: ${beforeError.message}`);
  if (!before) return res.status(404).json({ error: 'Rental item not found' });

  // Lowering the stock below what bookings already hold: WARN, THEN ALLOW
  // (step C3). Existing bookings stay; new ones are refused by the database's
  // own rule until enough units are free. Only `confirm_lower_stock: true`
  // saves it.
  if (value.quantity_total < before.quantity_total && req.body?.confirm_lower_stock !== true) {
    const held = await heldUnits(id, before.type);
    if (value.quantity_total < held.units) {
      return res.status(409).json({
        error: `Upcoming or overdue bookings hold ${held.units} units of this item, more than the new total of ${value.quantity_total}.`,
        code: 'STOCK_BELOW_BOOKED',
        bookings: held.bookings,
        units: held.units,
        largest: held.largest,
        new_total: value.quantity_total,
      });
    }
  }

  const { data, error } = await supabase
    .from('rental_items')
    .update(value)
    .eq('item_id', id)
    .select(ITEM_FIELDS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update rental item: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Rental item not found' });

  const diff = diffFields(before, data);
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.UPDATE,
    table: 'rental_items',
    recordId: id,
    before: diff.before,
    after: diff.after,
  });

  res.json({ message: 'Rental item updated', rental_item: data });
});

// POST /api/rental-items/:id/deactivate | /activate
// Deactivation hides the item from new bookings without deleting it —
// future rental_requests rows reference items, so booking history and fee
// context must survive. Same soft-delete rationale as document types;
// hard deletes are deliberately not offered.
async function setActive(req, res, isActive) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid rental item id' });

  const { data, error } = await supabase
    .from('rental_items')
    .update({ is_active: isActive })
    .eq('item_id', id)
    .select('item_id, name, is_active')
    .maybeSingle();
  if (error) throw new Error(`Failed to update rental item: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Rental item not found' });

  // The new state only: the update is not guarded on the old one, so this
  // route cannot say what it was before.
  await logActivity({
    userId: req.user.user_id,
    action: isActive ? ACTIONS.ACTIVATE : ACTIONS.DEACTIVATE,
    table: 'rental_items',
    recordId: id,
    after: { is_active: isActive },
  });

  res.json({
    message: `"${data.name}" ${isActive ? 'reactivated' : 'deactivated'}`,
    rental_item: data,
  });
}

router.post('/:id/deactivate', (req, res) => setActive(req, res, false));
router.post('/:id/activate', (req, res) => setActive(req, res, true));

module.exports = router;
