const express = require('express');
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const { REQUEST_STATUS } = require('../constants/requestStatus');

const router = express.Router();

router.use(authenticate);

const REQUEST_FIELDS =
  'request_id, purpose, status, requested_at, claimed_at, document_types ( document_type_id, name, fee )';

// POST /api/document-requests — the logged-in resident submits a request.
// resident_id comes from the account's profiles.resident_id link, so only
// accounts the Secretary has approved and linked can file requests.
router.post('/', async (req, res) => {
  const documentTypeId = Number(req.body?.document_type_id);
  const purpose = String(req.body?.purpose ?? '').trim();

  if (!Number.isInteger(documentTypeId)) {
    return res.status(400).json({ error: 'A document_type_id is required' });
  }
  if (!purpose) {
    return res.status(400).json({ error: 'purpose is required' });
  }
  if (purpose.length > 1000) {
    return res.status(400).json({ error: 'purpose must be 1000 characters or fewer' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('resident_id')
    .eq('user_id', req.user.user_id)
    .maybeSingle();
  if (profileError) {
    throw new Error(`Failed to load profile: ${profileError.message}`);
  }
  if (!profile?.resident_id) {
    return res.status(409).json({
      error:
        'Your account is not linked to a resident record yet. Document requests become available once the Barangay Secretary approves your registration.',
    });
  }

  const { data: docType, error: typeError } = await supabase
    .from('document_types')
    .select('document_type_id, name, is_active')
    .eq('document_type_id', documentTypeId)
    .maybeSingle();
  if (typeError) {
    throw new Error(`Failed to load document type: ${typeError.message}`);
  }
  if (!docType) {
    return res.status(404).json({ error: 'Document type not found' });
  }
  if (!docType.is_active) {
    return res.status(400).json({ error: 'That document type is not currently offered' });
  }

  const { data: request, error } = await supabase
    .from('document_requests')
    .insert({
      document_type_id: documentTypeId,
      requested_by_user_id: req.user.user_id,
      resident_id: profile.resident_id,
      purpose,
      status: REQUEST_STATUS.PENDING,
    })
    .select(REQUEST_FIELDS)
    .single();
  if (error) {
    throw new Error(`Failed to submit request: ${error.message}`);
  }

  res.status(201).json({
    message: 'Request submitted. You can track its status under My Requests.',
    request,
  });
});

// GET /api/document-requests/mine — only the logged-in user's own requests,
// newest first. The requested_by_user_id filter is what keeps residents from
// ever seeing each other's requests.
router.get('/mine', async (req, res) => {
  const { data, error } = await supabase
    .from('document_requests')
    .select(REQUEST_FIELDS)
    .eq('requested_by_user_id', req.user.user_id)
    .order('requested_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to load requests: ${error.message}`);
  }
  res.json({ requests: data });
});

// GET /api/document-requests/mine/:id — one of the logged-in user's requests;
// 404 for anything that exists but belongs to someone else.
router.get('/mine/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const { data, error } = await supabase
    .from('document_requests')
    .select(REQUEST_FIELDS)
    .eq('request_id', id)
    .eq('requested_by_user_id', req.user.user_id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load request: ${error.message}`);
  }
  if (!data) {
    return res.status(404).json({ error: 'Request not found' });
  }
  res.json({ request: data });
});

module.exports = router;
