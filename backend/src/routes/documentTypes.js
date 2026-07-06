const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const MAX_FEE = 99999999.99; // numeric(10,2) ceiling

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
  const fee = parseFee(body?.fee);
  if (fee === null) return { error: 'fee must be a number between 0 and 99,999,999.99' };
  const description = String(body?.description ?? '').trim() || null;
  return { value: { name, description, fee } };
}

// Case-insensitive duplicate-name check (excludeId for updates).
async function nameTaken(name, excludeId = null) {
  let query = supabase.from('document_types').select('document_type_id').ilike('name', name);
  if (excludeId !== null) query = query.neq('document_type_id', excludeId);
  const { data, error } = await query;
  if (error) throw new Error(`Duplicate-name check failed: ${error.message}`);
  return data.length > 0;
}

// GET /api/document-types — ACTIVE types only; any authenticated user.
// This is what residents will use to choose a document in later stages.
router.get('/', authenticate, async (req, res) => {
  const { data, error } = await supabase
    .from('document_types')
    .select('document_type_id, name, description, fee')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(`Failed to load document types: ${error.message}`);
  res.json({ document_types: data });
});

// Everything below is Secretary-only management.
router.use(authenticate, requireRole('secretary'));

// GET /api/document-types/all — includes deactivated types
router.get('/all', async (req, res) => {
  const { data, error } = await supabase
    .from('document_types')
    .select('document_type_id, name, description, fee, is_active')
    .order('name', { ascending: true });
  if (error) throw new Error(`Failed to load document types: ${error.message}`);
  res.json({ document_types: data });
});

// POST /api/document-types — create
router.post('/', async (req, res) => {
  const { error: validationError, value } = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (await nameTaken(value.name)) {
    return res.status(409).json({ error: 'A document type with that name already exists' });
  }

  const { data, error } = await supabase
    .from('document_types')
    .insert(value)
    .select('document_type_id, name, description, fee, is_active')
    .single();
  if (error) throw new Error(`Failed to create document type: ${error.message}`);

  res.status(201).json({ message: 'Document type created', document_type: data });
});

// PUT /api/document-types/:id — update name/description/fee
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid document type id' });

  const { error: validationError, value } = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (await nameTaken(value.name, id)) {
    return res.status(409).json({ error: 'A document type with that name already exists' });
  }

  const { data, error } = await supabase
    .from('document_types')
    .update(value)
    .eq('document_type_id', id)
    .select('document_type_id, name, description, fee, is_active')
    .maybeSingle();
  if (error) throw new Error(`Failed to update document type: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Document type not found' });

  res.json({ message: 'Document type updated', document_type: data });
});

// POST /api/document-types/:id/deactivate | /activate
// Deactivation hides the type from residents (no new requests) without
// deleting it — request history and fee context stay intact, and it is
// reversible. Hard deletes are deliberately not offered.
async function setActive(req, res, isActive) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid document type id' });

  const { data, error } = await supabase
    .from('document_types')
    .update({ is_active: isActive })
    .eq('document_type_id', id)
    .select('document_type_id, name, is_active')
    .maybeSingle();
  if (error) throw new Error(`Failed to update document type: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Document type not found' });

  res.json({
    message: `"${data.name}" ${isActive ? 'reactivated' : 'deactivated'}`,
    document_type: data,
  });
}

router.post('/:id/deactivate', (req, res) => setActive(req, res, false));
router.post('/:id/activate', (req, res) => setActive(req, res, true));

module.exports = router;
