const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { REQUEST_STATUS, REQUEST_STATUSES } = require('../constants/requestStatus');
const { logSmsNotification } = require('../services/smsNotification');

const router = express.Router();

router.use(authenticate);

const REQUEST_FIELDS =
  'request_id, purpose, status, requested_at, claimed_at, rejection_reason, document_types ( document_type_id, name, fee )';

// Secretary views. document_requests has two FKs to users, so the requester
// embed must name its FK constraint explicitly.
const SECRETARY_LIST_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username, email )
`;

const SECRETARY_DETAIL_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix, birthdate,
    birthplace, address, sex, civil_status, contact_number, date_registered ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username, email ),
  processed_by:users!document_requests_processed_by_user_id_fkey ( user_id, username )
`;

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

// ---------------------------------------------------------------------------
// Secretary processing (the Secretary handles the whole document pipeline;
// Staff and the Punong Barangay only view — the Captain signs physically).
// ---------------------------------------------------------------------------

// GET /api/document-requests?status=pending — all requests across residents,
// optionally filtered by status ('all' or omitted = everything), newest first.
router.get('/', requireRole('secretary'), async (req, res) => {
  const status = req.query.status;
  let query = supabase
    .from('document_requests')
    .select(SECRETARY_LIST_FIELDS)
    .order('requested_at', { ascending: false });

  if (status && status !== 'all') {
    if (!REQUEST_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Unknown status '${status}' (expected one of: ${REQUEST_STATUSES.join(', ')}, or 'all')`,
      });
    }
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load requests: ${error.message}`);
  }
  res.json({ requests: data });
});

// GET /api/document-requests/:id — full detail including the requester's
// linked resident record, so the Secretary can verify the requester.
router.get('/:id', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const { data, error } = await supabase
    .from('document_requests')
    .select(SECRETARY_DETAIL_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load request: ${error.message}`);
  }
  if (!data) {
    return res.status(404).json({ error: 'Request not found' });
  }
  res.json({ request: data });
});

// Status machine: approve/reject are only valid from 'pending'. The update is
// additionally guarded with .eq('status', 'pending') so two Secretaries
// deciding simultaneously can't both win.
async function decideRequest(req, res, decision) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  let reason = null;
  if (decision === 'reject') {
    reason = String(req.body?.reason ?? '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'A rejection reason is required' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ error: 'Rejection reason must be 500 characters or fewer' });
    }
  }

  const { data: existing, error: loadError } = await supabase
    .from('document_requests')
    .select('request_id, status, document_types ( name ), resident_records ( contact_number )')
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (existing.status !== REQUEST_STATUS.PENDING) {
    return res.status(409).json({
      error: `Only pending requests can be ${decision === 'approve' ? 'approved' : 'rejected'} — this request is already '${existing.status}'`,
    });
  }

  const update = {
    status: decision === 'approve' ? REQUEST_STATUS.APPROVED : REQUEST_STATUS.REJECTED,
    rejection_reason: reason,
    processed_by_user_id: req.user.user_id,
    processed_at: new Date().toISOString(),
  };

  const { data: request, error } = await supabase
    .from('document_requests')
    .update(update)
    .eq('request_id', id)
    .eq('status', REQUEST_STATUS.PENDING)
    .select(SECRETARY_DETAIL_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to ${decision} request: ${error.message}`);
  }
  if (!request) {
    return res.status(409).json({ error: 'Request was already processed by someone else' });
  }

  // SMS hook — stub only (see services/smsNotification.js); a later
  // ready-for-release stage adds its own notification at this same point.
  const docName = existing.document_types?.name || 'document';
  logSmsNotification(
    existing.resident_records?.contact_number,
    decision === 'approve'
      ? `BrgyServe: your ${docName} request has been APPROVED. Please settle the fee at the barangay hall to proceed.`
      : `BrgyServe: your ${docName} request has been REJECTED. Reason: ${reason}`
  );

  res.json({
    message: `Request ${decision === 'approve' ? 'approved' : 'rejected'}`,
    request,
  });
}

router.post('/:id/approve', requireRole('secretary'), (req, res) => decideRequest(req, res, 'approve'));
router.post('/:id/reject', requireRole('secretary'), (req, res) => decideRequest(req, res, 'reject'));

module.exports = router;
