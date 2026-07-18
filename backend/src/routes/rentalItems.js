const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { ITEM_TYPE, ITEM_TYPES } = require('../constants/rentals');

const router = express.Router();

const MAX_FEE = 99999999.99; // numeric(10,2) ceiling
const MAX_QUANTITY = 100000;

const ITEM_FIELDS = 'item_id, name, type, description, quantity_total, quantity_available, fee, is_active';

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

  // quantity_available mirrors quantity_total for now: a single number cannot
  // express per-time-slot availability, so the stage-2 conflict check derives
  // free units per slot from approved bookings against quantity_available.
  // Keeping the columns separate lets damaged/retired stock lower it later.
  return {
    value: { name, type, description, quantity_total: quantity, quantity_available: quantity, fee },
  };
}

// Case-insensitive duplicate-name check (excludeId for updates).
async function nameTaken(name, excludeId = null) {
  let query = supabase.from('rental_items').select('item_id').ilike('name', name);
  if (excludeId !== null) query = query.neq('item_id', excludeId);
  const { data, error } = await query;
  if (error) throw new Error(`Duplicate-name check failed: ${error.message}`);
  return data.length > 0;
}

// GET /api/rental-items — ACTIVE items only; any authenticated user.
// This is what residents will use to pick an item when booking (stage 2).
router.get('/', authenticate, async (req, res) => {
  const { data, error } = await supabase
    .from('rental_items')
    .select('item_id, name, type, description, quantity_total, quantity_available, fee')
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

  const { data, error } = await supabase
    .from('rental_items')
    .update(value)
    .eq('item_id', id)
    .select(ITEM_FIELDS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update rental item: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Rental item not found' });

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

  res.json({
    message: `"${data.name}" ${isActive ? 'reactivated' : 'deactivated'}`,
    rental_item: data,
  });
}

router.post('/:id/deactivate', (req, res) => setActive(req, res, false));
router.post('/:id/activate', (req, res) => setActive(req, res, true));

module.exports = router;
