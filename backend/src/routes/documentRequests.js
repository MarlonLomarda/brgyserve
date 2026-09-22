const express = require("express");
const supabase = require("../config/supabase");
const { authenticate, requireRole } = require("../middleware/auth");
const {
  REQUEST_STATUS,
  REQUEST_STATUSES,
} = require("../constants/requestStatus");
const {
  CHARGE_STATUS,
  CHARGE_TYPE,
  PAYMENT_METHOD,
} = require("../constants/charges");
const { notify } = require("../services/notifications");
const { RELATED_TYPE } = require("../constants/notifications");

const router = express.Router();

router.use(authenticate);

// Roles that may READ the cross-resident views (GET / and GET /:id). The
// Punong Barangay and Staff are view-only here: the four write routes below
// (approve, reject, ready-for-release, claim) stay requireRole('secretary')
// and must never be widened to this list.
const VIEW_ROLES = ["secretary", "punong_barangay", "staff"];

// Roles that may CREATE a request. A resident files their own; the Secretary
// may additionally encode a WALK-IN for a resident standing at the hall.
// Before this gate the route carried NO role check at all — any authenticated
// role could reach it — so this is a real narrowing. Verified before landing
// it: the only callers are RequestDocumentPage.jsx and BookRentalPage.jsx,
// both behind <ProtectedRoute role="resident">, so nothing Staff, Treasurer or
// the Punong Barangay does today touches this endpoint.
//
// Documents are RESIDENTS-ONLY and there is deliberately no guest path here —
// Chapter 1 restricts document requests to registered residents. Only rentals
// take an outside borrower (see routes/rentalRequests.js).
const CREATE_ROLES = ["resident", "secretary"];

// The caller's own linked resident record, or null when their account has none.
async function ownResidentId(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("resident_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  return data?.resident_id ?? null;
}

// The account belonging to a resident, or null when they never registered
// online. profiles.resident_id is UNIQUE (migration 002), so this is at most
// one row.
//
// NULL IS A REAL ANSWER, NOT A FAILURE. A walk-in is filed for whoever is at
// the counter, and most residents have no account — charges.user_id and
// notifications.user_id are both nullable precisely for this, and
// routes/charges.js already says so of the household fines it lists.
async function accountOfResident(residentId) {
  if (!residentId) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("resident_id", residentId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Failed to resolve the resident's account: ${error.message}`,
    );
  }
  return data?.user_id ?? null;
}

// WHO THE REQUEST IS FOR. A resident always files for themselves and any
// resident_id in their body is ignored — the subject comes from the session,
// never from the request. The Secretary may name another resident, which is
// the walk-in path, and falls back to their own linked record when they don't,
// so a Secretary who is also a resident can still file for themselves exactly
// as before.
//
// Returns { residentId } on success, or { status, error } for the caller to
// return unchanged.
async function resolveSubjectResident(req) {
  const raw = req.body?.resident_id;
  const namesAnother =
    req.user.role === "secretary" &&
    raw !== undefined &&
    raw !== null &&
    raw !== "";

  if (namesAnother) {
    const residentId = Number(raw);
    if (!Number.isInteger(residentId)) {
      return { status: 400, error: "resident_id must be a whole number" };
    }

    const { data: resident, error } = await supabase
      .from("resident_records")
      .select("resident_id, is_archived")
      .eq("resident_id", residentId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load resident record: ${error.message}`);
    }
    if (!resident) {
      return { status: 400, error: `No resident record #${residentId} exists` };
    }
    if (resident.is_archived) {
      return {
        status: 400,
        error: `Resident record #${residentId} is archived — archived residents cannot be given new document requests`,
      };
    }
    return { residentId, walkIn: true };
  }

  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return {
      status: 409,
      error:
        req.user.role === "secretary"
          ? "Your account is not linked to a resident record, so this request needs a resident_id — pick the resident it is for."
          : "Your account is not linked to a resident record yet. Document requests become available once the Barangay Secretary approves your registration.",
    };
  }
  return { residentId, walkIn: false };
}

const REQUEST_FIELDS =
  "request_id, purpose, status, requested_at, claimed_at, rejection_reason, document_types ( document_type_id, name, fee ), charges ( charge_id, amount, status, declared_method, declared_reference, declared_at )";

// Secretary views. document_requests has two FKs to users, so the requester
// embed must name its FK constraint explicitly.
//
// THE RESIDENT EMBED CARRIES THE SUBJECT'S OWN ACCOUNT as `account`, and on a
// walk-in that is a different person from the requester. The list's sub-line
// used to print requester.username under the resident's name — right on every
// self-service row, where the two columns name the same person, and wrong on
// every walk-in, where it named the Secretary who typed it ("Grace Tanfelix /
// @secretary1"). resident_records -> profiles -> users is the hop the resident
// list already makes for its Account column; profiles.resident_id is UNIQUE
// (migration 002), so PostgREST returns one object, and the spread flattens
// users into it: `account: { username }`, or `account: null` for a resident
// who never registered online. That null is a real answer, not a withheld
// one — the withheld case is STAFF_LIST_FIELDS below, where the key is absent.
const SECRETARY_LIST_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix,
    account:profiles ( ...users ( username ) ) ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username, email ),
  charges ( charge_id, amount, status, declared_method, declared_reference )
`;

// The list, narrowed for Staff. Same rule and same reason as
// STAFF_DETAIL_FIELDS below: email is a contact detail, and withholding it on
// the detail screen while the LIST hands it over would withhold nothing.
//
// The resident embed here needs no narrowing — it is only
// (resident_id, first_name, middle_name, last_name, suffix), all five within
// the permitted eight. It is restated in full rather than shared with the
// Secretary constant so that adding a restricted column to one projection
// cannot silently widen the other.
//
// It also does NOT carry the `account` embed the Secretary's list gained. The
// resident's linked account is one of the things the resident list withholds
// from Staff (routes/residentRecords.js never even runs the lookup for them),
// and the account behind a walk-in's subject is exactly that datum. The key
// is ABSENT rather than null, so the screen — which tests `'account' in
// resident_records` and never the viewer's role — renders no sub-line for
// Staff instead of claiming the resident has no account. Staff keep the
// requester's username, the filer's identity, exactly as before.
const STAFF_LIST_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username ),
  charges ( charge_id, amount, status, declared_method, declared_reference )
`;

const listFieldsFor = (role) =>
  role === "staff" ? STAFF_LIST_FIELDS : SECRETARY_LIST_FIELDS;

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

// The SAME detail view with TWO embeds narrowed for Staff — see the
// data-minimization note in routes/residentRecords.js, which is the canonical
// statement of which eight columns Staff may see. This is the second place the
// rule is applied; the resident record reaches Staff through BOTH modules, so
// narrowing only the master list would leave the identical columns readable
// here.
//
// THE REQUESTER EMBED DROPS `email` FOR STAFF, and that is not an afterthought:
// email is a contact detail, exactly like contact_number, which the decision
// already withholds. HTTP verification of the first cut found the hole — a
// Staff caller could not read a resident's contact_number on the resident
// screen, but could read that same person's email address here, one click
// away. Narrowing one screen and not the other withholds nothing.
//
// user_id and username STAY. A document request is defined by who filed it and
// Staff processing the queue must see that; username identifies the filer
// without being a way to contact them. The Punong Barangay keeps the full
// requester, as they keep the full resident record.
const STAFF_DETAIL_FIELDS = `
  request_id, purpose, status, requested_at, claimed_at, rejection_reason, processed_at,
  document_types ( document_type_id, name, fee ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix, birthdate, address ),
  requester:users!document_requests_requested_by_user_id_fkey ( user_id, username ),
  processed_by:users!document_requests_processed_by_user_id_fkey ( user_id, username ),
  charges ( charge_id, amount, status, created_at, declared_method, declared_reference, declared_at,
    payments ( payment_id, amount, payment_method, reference_no, created_at ) )
`;

const detailFieldsFor = (role) =>
  role === "staff" ? STAFF_DETAIL_FIELDS : SECRETARY_DETAIL_FIELDS;

// POST /api/document-requests — a resident submits their own request, or the
// Secretary encodes a walk-in for a resident at the hall.
//
// requested_by_user_id records WHO FILED IT and resident_id WHO IT IS FOR.
// For a self-service request those are the same person; for a walk-in the
// first is the Secretary and the second is the resident, which is the whole
// point of keeping both columns.
router.post("/", requireRole(...CREATE_ROLES), async (req, res) => {
  const documentTypeId = Number(req.body?.document_type_id);
  const purpose = String(req.body?.purpose ?? "").trim();

  if (!Number.isInteger(documentTypeId)) {
    return res.status(400).json({ error: "A document_type_id is required" });
  }
  if (!purpose) {
    return res.status(400).json({ error: "purpose is required" });
  }
  if (purpose.length > 1000) {
    return res
      .status(400)
      .json({ error: "purpose must be 1000 characters or fewer" });
  }

  const subject = await resolveSubjectResident(req);
  if (subject.error) {
    return res.status(subject.status).json({ error: subject.error });
  }

  const { data: docType, error: typeError } = await supabase
    .from("document_types")
    .select("document_type_id, name, is_active")
    .eq("document_type_id", documentTypeId)
    .maybeSingle();
  if (typeError) {
    throw new Error(`Failed to load document type: ${typeError.message}`);
  }
  if (!docType) {
    return res.status(404).json({ error: "Document type not found" });
  }
  if (!docType.is_active) {
    return res
      .status(400)
      .json({ error: "That document type is not currently offered" });
  }

  const { data: request, error } = await supabase
    .from("document_requests")
    .insert({
      document_type_id: documentTypeId,
      requested_by_user_id: req.user.user_id,
      resident_id: subject.residentId,
      purpose,
      status: REQUEST_STATUS.PENDING,
    })
    .select(REQUEST_FIELDS)
    .single();
  if (error) {
    throw new Error(`Failed to submit request: ${error.message}`);
  }

  res.status(201).json({
    message: subject.walkIn
      ? `Walk-in request recorded for resident #${subject.residentId}. It is now pending your review.`
      : "Request submitted. You can track its status under My Requests.",
    request,
  });
});

// GET /api/document-requests/mine — the requests FOR the logged-in resident,
// newest first. Filtered by resident_id, not requested_by_user_id, so a
// walk-in the Secretary encoded for this resident shows up in their own list.
// For a self-submitted request the two columns name the same person, so
// nothing a resident already saw here changes.
//
// A caller with no linked record gets an empty list, not an error: "you have
// no requests" is a true statement about an account with no resident behind
// it, and a GET should not refuse where there is simply nothing to show.
router.get("/mine", async (req, res) => {
  const selectedStatus = req.query?.status;

  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.json({ requests: [] });
  }

  let query = supabase
    .from("document_requests")
    .select(REQUEST_FIELDS)
    .eq("resident_id", residentId)
    .order("requested_at", { ascending: false });

  if (selectedStatus) {
    if (!REQUEST_STATUSES.includes(selectedStatus)) {
      return res.status(400).json({
        error: `Unknown status '${selectedStatus}' (expected one of: ${REQUEST_STATUSES.join(", ")} or leave it blank.)`,
      });
    }

    query = query.eq("status", selectedStatus);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to load requests: ${error.message}`);
  }

  res.json({ requests: data });
});

// GET /api/document-requests/mine/:id — one of the logged-in resident's
// requests, by resident_id like the list above; 404 for anything that exists
// but is for someone else.
router.get("/mine/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.status(404).json({ error: "Request not found" });
  }

  const { data, error } = await supabase
    .from("document_requests")
    .select(REQUEST_FIELDS)
    .eq("request_id", id)
    .eq("resident_id", residentId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load request: ${error.message}`);
  }
  if (!data) {
    return res.status(404).json({ error: "Request not found" });
  }
  res.json({ request: data });
});

// POST /api/document-requests/mine/:id/cancel — the resident withdraws a
// request that is FOR them while it is still pending. Any other status (or
// anyone else's request, which 404s via the ownership filter) is refused.
//
// Scoped by resident_id, not requested_by_user_id, to match GET /mine: a
// walk-in the Secretary encoded is the resident's request to withdraw, and
// filtering on the submitter would 404 them out of the row their own list
// shows. Additive for self-submitted requests — POST / sets resident_id from
// the submitter's own profile on that path, so the two columns already name
// the same person, and profiles.resident_id is UNIQUE (migration 002) so no
// second account can match this filter.
//
// The PENDING-only rule below is unchanged: a charge is created on APPROVAL,
// never at pending, so a cancellable request can never have one to void.
router.post("/mine/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.status(404).json({ error: "Request not found" });
  }

  const { data: existing, error: loadError } = await supabase
    .from("document_requests")
    .select("request_id, status")
    .eq("request_id", id)
    .eq("resident_id", residentId)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: "Request not found" });
  }
  if (existing.status !== REQUEST_STATUS.PENDING) {
    return res.status(409).json({
      error: `Only pending requests can be cancelled — this request is already '${existing.status}'`,
    });
  }

  const { data: request, error } = await supabase
    .from("document_requests")
    .update({ status: REQUEST_STATUS.CANCELLED })
    .eq("request_id", id)
    .eq("resident_id", residentId)
    .eq("status", REQUEST_STATUS.PENDING) // guard: don't cancel a just-decided request
    .select(REQUEST_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to cancel request: ${error.message}`);
  }
  if (!request) {
    return res.status(409).json({
      error: "Request was already processed and can no longer be cancelled",
    });
  }

  res.json({ message: "Request cancelled", request });
});

// POST /api/document-requests/mine/:id/pay — the resident declares HOW they
// are paying: 'onsite' (cash at the barangay hall) or 'gcash' (submits a
// reference number). This does NOT mark the charge paid — the declaration is
// stored on the charge (declared_*), and only Treasurer/Secretary
// verification creates a payments row and flips the charge to PAID.
// Declarations can be re-submitted while UNPAID (e.g. mistyped reference).
router.post("/mine/:id/pay", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  const method = String(req.body?.method ?? "").toLowerCase();
  const reference = String(req.body?.reference_no ?? "").trim();
  if (method !== PAYMENT_METHOD.ONSITE && method !== PAYMENT_METHOD.GCASH) {
    return res
      .status(400)
      .json({ error: "method must be 'onsite' or 'gcash'" });
  }
  if (method === PAYMENT_METHOD.GCASH && !reference) {
    return res
      .status(400)
      .json({ error: "A GCash reference number is required" });
  }
  if (reference.length > 100) {
    return res
      .status(400)
      .json({ error: "Reference number must be 100 characters or fewer" });
  }

  // Scoped by resident_id like GET /mine and the cancel route: the charge on a
  // walk-in is the resident's to settle, and filtering on the submitter would
  // 404 them out of a request their own list shows. Additive for
  // self-submitted requests — same reasoning as the cancel route above.
  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.status(404).json({ error: "Request not found" });
  }

  const { data: request, error: loadError } = await supabase
    .from("document_requests")
    .select("request_id, status, charges ( charge_id, amount, status )")
    .eq("request_id", id)
    .eq("resident_id", residentId) // own requests only
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  const charge = Array.isArray(request.charges)
    ? request.charges[0]
    : request.charges;
  if (!charge) {
    return res.status(409).json({
      error: "This request has no charge yet — it must be approved first",
    });
  }
  if (charge.status !== CHARGE_STATUS.UNPAID) {
    return res
      .status(409)
      .json({ error: `This charge is already ${charge.status.toLowerCase()}` });
  }

  const { data: updated, error } = await supabase
    .from("charges")
    .update({
      declared_method: method,
      declared_reference: method === PAYMENT_METHOD.GCASH ? reference : null,
      declared_at: new Date().toISOString(),
    })
    .eq("charge_id", charge.charge_id)
    .eq("status", CHARGE_STATUS.UNPAID) // guard: not if just verified
    .select(
      "charge_id, amount, status, declared_method, declared_reference, declared_at",
    )
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to record payment declaration: ${error.message}`);
  }
  if (!updated) {
    return res.status(409).json({
      error: "This charge was just processed — refresh to see its status",
    });
  }

  res.json({
    message:
      method === PAYMENT_METHOD.GCASH
        ? "GCash reference submitted — awaiting verification by the barangay."
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
//
// The resident embed here is within the permitted eight for Staff, but the
// REQUESTER embed is not — see STAFF_LIST_FIELDS.
router.get("/", requireRole(...VIEW_ROLES), async (req, res) => {
  const status = req.query.status;
  let query = supabase
    .from("document_requests")
    .select(listFieldsFor(req.user.role))
    .order("requested_at", { ascending: false });

  if (status && status !== "all") {
    if (!REQUEST_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Unknown status '${status}' (expected one of: ${REQUEST_STATUSES.join(", ")}, or 'all')`,
      });
    }
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load requests: ${error.message}`);
  }
  res.json({ requests: data });
});

// GET /api/document-requests/:id — full detail including the requester's
// linked resident record, so the Secretary can verify the requester.
router.get("/:id", requireRole(...VIEW_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  const { data, error } = await supabase
    .from("document_requests")
    .select(detailFieldsFor(req.user.role))
    .eq("request_id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load request: ${error.message}`);
  }
  if (!data) {
    return res.status(404).json({ error: "Request not found" });
  }
  res.json({ request: data });
});

// Status machine: approve/reject are only valid from 'pending'. The update is
// additionally guarded with .eq('status', 'pending') so two Secretaries
// deciding simultaneously can't both win.
async function decideRequest(req, res, decision) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  let reason = null;
  if (decision === "reject") {
    reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      return res.status(400).json({ error: "A rejection reason is required" });
    }
    if (reason.length > 500) {
      return res
        .status(400)
        .json({ error: "Rejection reason must be 500 characters or fewer" });
    }
  }

  const { data: existing, error: loadError } = await supabase
    .from("document_requests")
    .select(
      "request_id, status, resident_id, document_types ( name, fee ), resident_records ( contact_number )",
    )
    .eq("request_id", id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: "Request not found" });
  }
  if (existing.status !== REQUEST_STATUS.PENDING) {
    return res.status(409).json({
      error: `Only pending requests can be ${decision === "approve" ? "approved" : "rejected"} — this request is already '${existing.status}'`,
    });
  }

  // The RESIDENT's own account — not the submitter's. For a walk-in the
  // submitter is the Secretary, and a charge or notification keyed to
  // requested_by_user_id would land on barangay staff instead of the person
  // the document is for. Null when the resident never registered online.
  const subjectAccountId = await accountOfResident(existing.resident_id);

  const update = {
    status:
      decision === "approve"
        ? REQUEST_STATUS.APPROVED
        : REQUEST_STATUS.REJECTED,
    rejection_reason: reason,
    processed_by_user_id: req.user.user_id,
    processed_at: new Date().toISOString(),
  };

  const { data: request, error } = await supabase
    .from("document_requests")
    .update(update)
    .eq("request_id", id)
    .eq("status", REQUEST_STATUS.PENDING)
    .select(SECRETARY_DETAIL_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to ${decision} request: ${error.message}`);
  }
  if (!request) {
    return res
      .status(409)
      .json({ error: "Request was already processed by someone else" });
  }

  const docName = existing.document_types?.name || "document";
  const fee = Number(existing.document_types?.fee ?? 0);
  let finalRequest = request;

  if (decision === "approve") {
    // Stage 4a: approval creates the charge (document fee only for now; fines
    // become separate FINE-type charge rows later, so this stays one row).
    // Zero-fee documents (e.g. Certificate of Indigency): the charge is still
    // created — financial records stay complete — but auto-marked PAID, since
    // there is nothing to collect and the request should not wait on the
    // Treasurer before release.
    const { error: chargeError } = await supabase.from("charges").insert({
      charge_type: CHARGE_TYPE.DOCUMENT,
      amount: fee,
      status: fee > 0 ? CHARGE_STATUS.UNPAID : CHARGE_STATUS.PAID,
      user_id: subjectAccountId,
      document_request_id: id,
      created_at: new Date().toISOString(),
    });
    // 23505 = a charge already exists for this request (UNIQUE
    // charges.document_request_id, migration 007) — benign, keep going.
    if (chargeError && chargeError.code !== "23505") {
      // supabase-js has no transactions, so compensate: revert the approval
      // rather than leave an approved request without its charge.
      await supabase
        .from("document_requests")
        .update({
          status: REQUEST_STATUS.PENDING,
          processed_by_user_id: null,
          processed_at: null,
        })
        .eq("request_id", id);
      throw new Error(
        `Approval reverted — failed to create charge: ${chargeError.message}`,
      );
    }

    // Re-read so the response includes the charge just created.
    const { data: withCharge } = await supabase
      .from("document_requests")
      .select(SECRETARY_DETAIL_FIELDS)
      .eq("request_id", id)
      .maybeSingle();
    if (withCharge) finalRequest = withCharge;
  }

  // Recorded, not sent (SMS_MODE=SIMULATED). Runs AFTER the approval and its
  // charge are committed, and notify() never throws, so nothing here can undo
  // the decision above. "PHP" rather than the peso sign keeps the message
  // inside the GSM alphabet and therefore inside one SMS segment.
  await notify({
    userId: subjectAccountId,
    destination: existing.resident_records?.contact_number,
    relatedType: RELATED_TYPE.DOCUMENT_REQUEST,
    relatedTo: id,
    message:
      decision === "approve"
        ? fee > 0
          ? `BrgyServe: your ${docName} request has been APPROVED. Please settle the PHP ${fee.toFixed(2)} fee at the barangay hall (cash) or via GCash to proceed.`
          : `BrgyServe: your ${docName} request has been APPROVED. No fee is required - please wait for the release notice.`
        : `BrgyServe: your ${docName} request has been REJECTED. Reason: ${reason}`,
  });

  res.json({
    message: `Request ${decision === "approve" ? "approved" : "rejected"}`,
    request: finalRequest,
  });
}

router.post("/:id/approve", requireRole("secretary"), (req, res) =>
  decideRequest(req, res, "approve"),
);
router.post("/:id/reject", requireRole("secretary"), (req, res) =>
  decideRequest(req, res, "reject"),
);

// ---------------------------------------------------------------------------
// Stage 4c — release flow. Two Secretary-only transitions complete the
// lifecycle: approved → ready_for_release (only once the charge is PAID) and
// ready_for_release → claimed (sets claimed_at). Like approve/reject, each
// update is re-guarded with .eq('status', …) so concurrent actions can't
// both win.
// ---------------------------------------------------------------------------

// POST /api/document-requests/:id/ready-for-release
router.post(
  "/:id/ready-for-release",
  requireRole("secretary"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const { data: existing, error: loadError } = await supabase
      .from("document_requests")
      .select(
        "request_id, status, resident_id, charges ( charge_id, status ), document_types ( name ), resident_records ( contact_number )",
      )
      .eq("request_id", id)
      .maybeSingle();
    if (loadError) {
      throw new Error(`Failed to load request: ${loadError.message}`);
    }
    if (!existing) {
      return res.status(404).json({ error: "Request not found" });
    }
    if (existing.status !== REQUEST_STATUS.APPROVED) {
      return res.status(409).json({
        error: `Only approved requests can be marked ready for release — this request is '${existing.status}'`,
      });
    }

    // A document is not releasable until its fee is settled. Zero-fee documents
    // pass automatically (their charge is auto-marked PAID on approval).
    const charge = Array.isArray(existing.charges)
      ? existing.charges[0]
      : existing.charges;
    if (!charge) {
      return res
        .status(409)
        .json({ error: "This request has no charge — re-check its approval" });
    }
    if (charge.status !== CHARGE_STATUS.PAID) {
      return res.status(409).json({
        error: `Payment has not been verified yet (charge is ${charge.status}) — record it under Payments first`,
      });
    }

    const { data: request, error } = await supabase
      .from("document_requests")
      .update({ status: REQUEST_STATUS.READY_FOR_RELEASE })
      .eq("request_id", id)
      .eq("status", REQUEST_STATUS.APPROVED)
      .select(SECRETARY_DETAIL_FIELDS)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to mark ready for release: ${error.message}`);
    }
    if (!request) {
      return res
        .status(409)
        .json({ error: "Request status just changed — refresh and try again" });
    }

    // The resident's own account, or null — see decideRequest. Before this the
    // line read existing.requested_by_user_id, which the select above never
    // fetched: it was always undefined, so every READY TO CLAIM notification
    // ever recorded here carried a null user_id. Resolving it properly fixes
    // that as well as the walk-in case.
    await notify({
      userId: await accountOfResident(existing.resident_id),
      destination: existing.resident_records?.contact_number,
      relatedType: RELATED_TYPE.DOCUMENT_REQUEST,
      relatedTo: id,
      message: `BrgyServe: your ${existing.document_types?.name || "document"} is READY TO CLAIM. Please pick it up at the barangay hall during office hours.`,
    });

    // Wording changed deliberately: sending is simulated, so the old
    // "the resident has been notified" was a claim the system cannot make.
    res.json({ message: "Request marked ready for release", request });
  },
);

// POST /api/document-requests/:id/claim — the resident picked the document up.
router.post("/:id/claim", requireRole("secretary"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  const { data: existing, error: loadError } = await supabase
    .from("document_requests")
    .select("request_id, status")
    .eq("request_id", id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load request: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: "Request not found" });
  }
  if (existing.status !== REQUEST_STATUS.READY_FOR_RELEASE) {
    return res.status(409).json({
      error: `Only requests that are ready for release can be claimed — this request is '${existing.status}'`,
    });
  }

  const { data: request, error } = await supabase
    .from("document_requests")
    .update({
      status: REQUEST_STATUS.CLAIMED,
      claimed_at: new Date().toISOString(),
    })
    .eq("request_id", id)
    .eq("status", REQUEST_STATUS.READY_FOR_RELEASE)
    .select(SECRETARY_DETAIL_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to mark as claimed: ${error.message}`);
  }
  if (!request) {
    return res
      .status(409)
      .json({ error: "Request status just changed — refresh and try again" });
  }

  res.json({
    message: "Document released — request marked as claimed",
    request,
  });
});

module.exports = router;
