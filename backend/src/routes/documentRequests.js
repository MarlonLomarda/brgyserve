const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { REQUEST_STATUS, REQUEST_STATUSES } = require('../constants/requestStatus');
const { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD } = require('../constants/charges');
const { notify } = require('../services/notifications');
const { RELATED_TYPE } = require('../constants/notifications');

const router = express.Router();

router.use(authenticate);

const REQUEST_FIELDS =
  'request_id, purpose, status, requested_at, claimed_at, rejection_reason, document_types ( document_type_id, name, fee ), charges ( charge_id, amount, status, declared_method, declared_reference, declared_at )';

// Secretary views. document_requests has two FKs to users, so the requester
// embed must name its FK constraint explicitly.
const SECRETARY_LIST_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username, email ),
  charges ( charge_id, amount, status, declared_method, declared_reference )
`;

const SECRETARY_DETAIL_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix, birthdate,
    birthplace, address, sex, civil_status, contact_number, date_registered ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username, email ),
  processed_by:users!document_requests_processed_by_user_id_fkey ( user_id, username ),
  charges ( charge_id, amount, status, created_at, declared_method, declared_reference, declared_at,
    payments ( payment_id, amount, payment_method, reference_no, created_at ) )
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

// POST /api/document-requests/mine/:id/cancel — the resident withdraws their
// OWN request while it is still pending. Any other status (or anyone else's
// request, which 404s via the ownership filter) is refused.
router.post('/mine/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const { data: existing, error: loadError } = await supabase
    .from('document_requests')
    .select('request_id, status')
    .eq('request_id', id)
    .eq('requested_by_user_id', req.user.user_id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (existing.status !== REQUEST_STATUS.PENDING) {
    return res.status(409).json({
      error: `Only pending requests can be cancelled — this request is already '${existing.status}'`,
    });
  }

  const { data: request, error } = await supabase
    .from('document_requests')
    .update({ status: REQUEST_STATUS.CANCELLED })
    .eq('request_id', id)
    .eq('requested_by_user_id', req.user.user_id)
    .eq('status', REQUEST_STATUS.PENDING) // guard: don't cancel a just-decided request
    .select(REQUEST_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to cancel request: ${error.message}`);
  }
  if (!request) {
    return res.status(409).json({ error: 'Request was already processed and can no longer be cancelled' });
  }

  res.json({ message: 'Request cancelled', request });
});

// POST /api/document-requests/mine/:id/pay — the resident declares HOW they
// are paying: 'onsite' (cash at the barangay hall) or 'gcash' (submits a
// reference number). This does NOT mark the charge paid — the declaration is
// stored on the charge (declared_*), and only Treasurer/Secretary
// verification creates a payments row and flips the charge to PAID.
// Declarations can be re-submitted while UNPAID (e.g. mistyped reference).
router.post('/mine/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const method = String(req.body?.method ?? '').toLowerCase();
  const reference = String(req.body?.reference_no ?? '').trim();
  if (method !== PAYMENT_METHOD.ONSITE && method !== PAYMENT_METHOD.GCASH) {
    return res.status(400).json({ error: "method must be 'onsite' or 'gcash'" });
  }
  if (method === PAYMENT_METHOD.GCASH && !reference) {
    return res.status(400).json({ error: 'A GCash reference number is required' });
  }
  if (reference.length > 100) {
    return res.status(400).json({ error: 'Reference number must be 100 characters or fewer' });
  }

  const { data: request, error: loadError } = await supabase
    .from('document_requests')
    .select('request_id, status, charges ( charge_id, amount, status )')
    .eq('request_id', id)
    .eq('requested_by_user_id', req.user.user_id) // own requests only
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const charge = Array.isArray(request.charges) ? request.charges[0] : request.charges;
  if (!charge) {
    return res.status(409).json({ error: 'This request has no charge yet — it must be approved first' });
  }
  if (charge.status !== CHARGE_STATUS.UNPAID) {
    return res.status(409).json({ error: `This charge is already ${charge.status.toLowerCase()}` });
  }

  const { data: updated, error } = await supabase
    .from('charges')
    .update({
      declared_method: method,
      declared_reference: method === PAYMENT_METHOD.GCASH ? reference : null,
      declared_at: new Date().toISOString(),
    })
    .eq('charge_id', charge.charge_id)
    .eq('status', CHARGE_STATUS.UNPAID) // guard: not if just verified
    .select('charge_id, amount, status, declared_method, declared_reference, declared_at')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to record payment declaration: ${error.message}`);
  }
  if (!updated) {
    return res.status(409).json({ error: 'This charge was just processed — refresh to see its status' });
  }

  res.json({
    message:
      method === PAYMENT_METHOD.GCASH
        ? 'GCash reference submitted — awaiting verification by the barangay.'
        : "Noted — please pay in cash at the barangay hall treasurer's desk.",
    charge: updated,
  });
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
    .select('request_id, status, requested_by_user_id, document_types ( name, fee ), resident_records ( contact_number )')
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

  const docName = existing.document_types?.name || 'document';
  const fee = Number(existing.document_types?.fee ?? 0);
  let finalRequest = request;

  if (decision === 'approve') {
    // Stage 4a: approval creates the charge (document fee only for now; fines
    // become separate FINE-type charge rows later, so this stays one row).
    // Zero-fee documents (e.g. Certificate of Indigency): the charge is still
    // created — financial records stay complete — but auto-marked PAID, since
    // there is nothing to collect and the request should not wait on the
    // Treasurer before release.
    const { error: chargeError } = await supabase.from('charges').insert({
      charge_type: CHARGE_TYPE.DOCUMENT,
      amount: fee,
      status: fee > 0 ? CHARGE_STATUS.UNPAID : CHARGE_STATUS.PAID,
      user_id: existing.requested_by_user_id,
      document_request_id: id,
      created_at: new Date().toISOString(),
    });
    // 23505 = a charge already exists for this request (UNIQUE
    // charges.document_request_id, migration 007) — benign, keep going.
    if (chargeError && chargeError.code !== '23505') {
      // supabase-js has no transactions, so compensate: revert the approval
      // rather than leave an approved request without its charge.
      await supabase
        .from('document_requests')
        .update({ status: REQUEST_STATUS.PENDING, processed_by_user_id: null, processed_at: null })
        .eq('request_id', id);
      throw new Error(`Approval reverted — failed to create charge: ${chargeError.message}`);
    }

    // Re-read so the response includes the charge just created.
    const { data: withCharge } = await supabase
      .from('document_requests')
      .select(SECRETARY_DETAIL_FIELDS)
      .eq('request_id', id)
      .maybeSingle();
    if (withCharge) finalRequest = withCharge;
  }

  // Recorded, not sent (SMS_MODE=SIMULATED). Runs AFTER the approval and its
  // charge are committed, and notify() never throws, so nothing here can undo
  // the decision above. "PHP" rather than the peso sign keeps the message
  // inside the GSM alphabet and therefore inside one SMS segment.
  await notify({
    userId: existing.requested_by_user_id,
    destination: existing.resident_records?.contact_number,
    relatedType: RELATED_TYPE.DOCUMENT_REQUEST,
    relatedTo: id,
    message:
      decision === 'approve'
        ? fee > 0
          ? `BrgyServe: your ${docName} request has been APPROVED. Please settle the PHP ${fee.toFixed(2)} fee at the barangay hall (cash) or via GCash to proceed.`
          : `BrgyServe: your ${docName} request has been APPROVED. No fee is required - please wait for the release notice.`
        : `BrgyServe: your ${docName} request has been REJECTED. Reason: ${reason}`,
  });

  res.json({
    message: `Request ${decision === 'approve' ? 'approved' : 'rejected'}`,
    request: finalRequest,
  });
}

router.post('/:id/approve', requireRole('secretary'), (req, res) => decideRequest(req, res, 'approve'));
router.post('/:id/reject', requireRole('secretary'), (req, res) => decideRequest(req, res, 'reject'));

// ---------------------------------------------------------------------------
// Stage 4c — release flow. Two Secretary-only transitions complete the
// lifecycle: approved → ready_for_release (only once the charge is PAID) and
// ready_for_release → claimed (sets claimed_at). Like approve/reject, each
// update is re-guarded with .eq('status', …) so concurrent actions can't
// both win.
// ---------------------------------------------------------------------------

// POST /api/document-requests/:id/ready-for-release
router.post('/:id/ready-for-release', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const { data: existing, error: loadError } = await supabase
    .from('document_requests')
    .select(
      'request_id, status, charges ( charge_id, status ), document_types ( name ), resident_records ( contact_number )'
    )
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (existing.status !== REQUEST_STATUS.APPROVED) {
    return res.status(409).json({
      error: `Only approved requests can be marked ready for release — this request is '${existing.status}'`,
    });
  }

  // A document is not releasable until its fee is settled. Zero-fee documents
  // pass automatically (their charge is auto-marked PAID on approval).
  const charge = Array.isArray(existing.charges) ? existing.charges[0] : existing.charges;
  if (!charge) {
    return res.status(409).json({ error: 'This request has no charge — re-check its approval' });
  }
  if (charge.status !== CHARGE_STATUS.PAID) {
    return res.status(409).json({
      error: `Payment has not been verified yet (charge is ${charge.status}) — record it under Payments first`,
    });
  }

  const { data: request, error } = await supabase
    .from('document_requests')
    .update({ status: REQUEST_STATUS.READY_FOR_RELEASE })
    .eq('request_id', id)
    .eq('status', REQUEST_STATUS.APPROVED)
    .select(SECRETARY_DETAIL_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to mark ready for release: ${error.message}`);
  }
  if (!request) {
    return res.status(409).json({ error: 'Request status just changed — refresh and try again' });
  }

  await notify({
    userId: existing.requested_by_user_id,
    destination: existing.resident_records?.contact_number,
    relatedType: RELATED_TYPE.DOCUMENT_REQUEST,
    relatedTo: id,
    message: `BrgyServe: your ${existing.document_types?.name || 'document'} is READY TO CLAIM. Please pick it up at the barangay hall during office hours.`,
  });

  // Wording changed deliberately: sending is simulated, so the old
  // "the resident has been notified" was a claim the system cannot make.
  res.json({ message: 'Request marked ready for release', request });
});

// POST /api/document-requests/:id/claim — the resident picked the document up.
router.post('/:id/claim', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const { data: existing, error: loadError } = await supabase
    .from('document_requests')
    .select('request_id, status')
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (existing.status !== REQUEST_STATUS.READY_FOR_RELEASE) {
    return res.status(409).json({
      error: `Only requests that are ready for release can be claimed — this request is '${existing.status}'`,
    });
  }

  const { data: request, error } = await supabase
    .from('document_requests')
    .update({ status: REQUEST_STATUS.CLAIMED, claimed_at: new Date().toISOString() })
    .eq('request_id', id)
    .eq('status', REQUEST_STATUS.READY_FOR_RELEASE)
    .select(SECRETARY_DETAIL_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to mark as claimed: ${error.message}`);
  }
  if (!request) {
    return res.status(409).json({ error: 'Request status just changed — refresh and try again' });
  }

  res.json({ message: 'Document released — request marked as claimed', request });
});

module.exports = router;
