const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  ITEM_TYPE,
  RETURNABLE_TYPES,
  RENTAL_STATUS,
  RETURN_OUTCOMES,
  STORED_RENTAL_STATUSES,
} = require('../constants/rentals');
const { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD } = require('../constants/charges');
const { notify } = require('../services/notifications');
const { RELATED_TYPE } = require('../constants/notifications');

const router = express.Router();

router.use(authenticate);

const RENTAL_FIELDS =
  'request_id, quantity_requested, start_datetime, end_datetime, purpose, status, return_note, returned_at, rental_items ( item_id, name, type, fee ), charges ( charge_id, amount, status, declared_method, declared_reference, declared_at )';

// Management/staff views: adds the requester (with their profile name), the
// item's capacity numbers (the edit form needs them), and the return record.
// rental_requests has three FKs to users, so each user embed names its
// constraint.
//
// WHO A BOOKING IS FOR is no longer the requester. Since migration 022 a row
// names its borrower directly — resident_id for a registered resident, or the
// outside_borrower_* pair for a guest from another barangay — and the
// requester is only WHO FILED IT. For a self-service booking those are the
// same person; for a walk-in the requester is the Secretary. The list must
// show the borrower, so both are returned and the screen prefers the
// borrower. rental_requests has exactly one FK to resident_records, so that
// embed needs no constraint name.
//
// The resident embed also carries the BORROWER'S OWN ACCOUNT as `account`
// (resident_records -> profiles -> users; profiles.resident_id is UNIQUE, so
// PostgREST returns one object and the spread flattens it to `{ username }`,
// or null for a resident with no online account). The sub-line under the
// borrower's name used to print requester.username, which on a walk-in is the
// Secretary who typed it. Same hop as documentRequests.js's Secretary list;
// unlike that file, this list has ONE projection for all three roles, so
// Staff receive it here — they already receive the requester's username,
// email and profile name from this same constant.
const MANAGE_FIELDS = `
  request_id, quantity_requested, start_datetime, end_datetime, purpose, status,
  return_note, returned_at,
  resident_id, outside_borrower_name, outside_borrower_contact,
  rental_items ( item_id, name, type, fee, quantity_total, quantity_available ),
  resident_records ( resident_id, first_name, middle_name, last_name, suffix,
    account:profiles ( ...users ( username ) ) ),
  requester:users!rental_requests_requested_by_user_id_fkey ( user_id, username, email,
    profiles ( first_name, middle_name, last_name, suffix ) ),
  returned_by:users!rental_requests_returned_by_user_id_fkey ( user_id, username,
    profiles ( first_name, last_name ) ),
  charges ( charge_id, amount, status, declared_method, declared_reference, declared_at )
`;

// Roles that may CREATE a booking. A resident books for themselves; the
// Secretary may additionally encode a WALK-IN — for a registered resident, or
// for a guest from another barangay who has no resident record at all (a real,
// current practice: outsiders rent select items, mostly costumes). Before this
// gate the route carried NO role check, so this is a real narrowing; verified
// that the only caller is BookRentalPage.jsx behind <ProtectedRoute
// role="resident">, so nothing Staff, Treasurer or the Punong Barangay does
// today touches it.
const CREATE_ROLES = ['resident', 'secretary'];

const GUEST_NAME_MAX = 200;
const GUEST_CONTACT_MAX = 50;

// A guest's contact must be a Philippine MOBILE number in one of three forms
// and nothing else: 09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX — digits only,
// no spaces or dashes, the plus allowed only before 63. It is the destination
// every notice about the booking goes to, and unlike a resident's number it
// cannot be corrected from a record later, because a guest has none. The
// first guest row through the form stored "09123456789213213ssdd", which the
// presence and length checks accepted; this is the rule that refuses it.
// FORMAT ONLY: the presence, both-or-neither and length checks that mirror
// the migration 022 CHECK stay exactly as they are, and this runs after them.
// The booking form applies the same pattern before posting, but THIS is the
// guard — the form can be bypassed with a direct call, this cannot.
const PH_MOBILE_RE = /^(09\d{9}|\+?639\d{9})$/;

// The caller's own linked resident record, or null when their account has none.
async function ownResidentId(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('resident_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  return data?.resident_id ?? null;
}

// The account belonging to a resident, or null when they never registered
// online. profiles.resident_id is UNIQUE (migration 002), so at most one row.
// Null is a real answer: charges.user_id and notifications.user_id are both
// nullable for exactly this, and a guest can NEVER have one — registration
// requires matching an existing resident record, which a guest lacks.
async function accountOfResident(residentId) {
  if (!residentId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('resident_id', residentId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to resolve the resident's account: ${error.message}`);
  }
  return data?.user_id ?? null;
}

// Everything the booking flow needs about a RESIDENT borrower, in one place:
// the record (existence and archive status), their contact number, and their
// own account if any. `requireActive` is the walk-in check — a resident
// booking for themselves is already active by virtue of being logged in.
async function residentBorrower(residentId, { requireActive = false, walkIn = false } = {}) {
  const { data: record, error } = await supabase
    .from('resident_records')
    .select('resident_id, contact_number, is_archived')
    .eq('resident_id', residentId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load resident record: ${error.message}`);
  }
  if (requireActive) {
    if (!record) {
      return { status: 400, error: `No resident record #${residentId} exists` };
    }
    if (record.is_archived) {
      return {
        status: 400,
        error: `Resident record #${residentId} is archived — archived residents cannot be given new bookings`,
      };
    }
  }
  return {
    kind: 'resident',
    walkIn,
    residentId,
    contactNumber: record?.contact_number ?? null,
    accountId: await accountOfResident(residentId),
  };
}

// WHO THE BOOKING IS FOR. Three shapes, mirroring the CHECK constraint
// migration 022 put on rental_requests, validated HERE so a bad body is a
// clear 400 naming the rule rather than a raw constraint violation:
//
//   resident (self-service)          -> their own linked record; any identity
//                                       fields in the body are IGNORED, the
//                                       subject comes from the session
//   secretary + resident_id          -> walk-in for a registered resident
//   secretary + outside_borrower_*   -> guest walk-in, both fields required,
//                                       no resident_id
//   secretary + neither              -> the Secretary's own record, so one
//                                       who is also a resident can still book
//                                       for themselves as before
//   secretary + both                 -> 400
//
// Returns { kind: 'resident', ... } | { kind: 'guest', ... } | { status, error }.
async function resolveBorrower(req) {
  const body = req.body ?? {};

  if (req.user.role === 'resident') {
    const residentId = await ownResidentId(req.user.user_id);
    if (!residentId) {
      return {
        status: 409,
        error:
          'Your account is not linked to a resident record yet. Facility booking becomes available once the Barangay Secretary approves your registration.',
      };
    }
    return residentBorrower(residentId);
  }

  const rawResident = body.resident_id;
  const hasResident = rawResident !== undefined && rawResident !== null && rawResident !== '';
  const guestName = String(body.outside_borrower_name ?? '').trim();
  const guestContact = String(body.outside_borrower_contact ?? '').trim();
  const hasGuest = Boolean(guestName || guestContact);

  if (hasResident && hasGuest) {
    return {
      status: 400,
      error: 'A booking is for EITHER a registered resident (resident_id) OR an outside borrower (outside_borrower_name + outside_borrower_contact) — not both',
    };
  }

  if (hasGuest) {
    if (!guestName || !guestContact) {
      return {
        status: 400,
        error: 'A guest booking needs BOTH outside_borrower_name and outside_borrower_contact',
      };
    }
    if (guestName.length > GUEST_NAME_MAX) {
      return { status: 400, error: `outside_borrower_name must be ${GUEST_NAME_MAX} characters or fewer` };
    }
    if (guestContact.length > GUEST_CONTACT_MAX) {
      return { status: 400, error: `outside_borrower_contact must be ${GUEST_CONTACT_MAX} characters or fewer` };
    }
    if (!PH_MOBILE_RE.test(guestContact)) {
      return {
        status: 400,
        error: 'outside_borrower_contact must be a Philippine mobile number: 09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX, digits only',
      };
    }
    return { kind: 'guest', walkIn: true, name: guestName, contact: guestContact };
  }

  if (hasResident) {
    const residentId = Number(rawResident);
    if (!Number.isInteger(residentId)) {
      return { status: 400, error: 'resident_id must be a whole number' };
    }
    return residentBorrower(residentId, { requireActive: true, walkIn: true });
  }

  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return {
      status: 409,
      error:
        'Your account is not linked to a resident record, so this booking needs either a resident_id or the outside borrower fields — say who it is for.',
    };
  }
  return residentBorrower(residentId);
}

// Where a notification about an EXISTING booking goes, and which account it
// is recorded against. Reads the columns migration 022 added, so the booking
// must have been loaded with resident_id, outside_borrower_name,
// outside_borrower_contact and resident_records ( contact_number ).
async function borrowerNotifyTarget(booking) {
  if (booking.outside_borrower_name) {
    // A guest: the number typed at the counter, and no account to record it
    // against, because a guest cannot have one.
    return { userId: null, destination: booking.outside_borrower_contact };
  }
  return {
    userId: await accountOfResident(booking.resident_id),
    destination: booking.resident_records?.contact_number,
  };
}

// Rental fee = item fee (per unit per booking) x quantity — the SAME formula
// the booking screen shows as "estimated fee", so the charge always matches
// what the resident saw. Rounded to centavos.
const rentalAmount = (item, quantity) => Math.round(Number(item.fee) * quantity * 100) / 100;

const chargeOf = (row) => (Array.isArray(row?.charges) ? row.charges[0] || null : row?.charges || null);

const isReturnable = (type) => RETURNABLE_TYPES.includes(type);

// Derived display status (stage 5) — NEVER stored. A booking past its end that
// is still 'confirmed' is either a facility that auto-completes (no physical
// return) or a physical item that is overdue until Staff mark it returned.
// Everything else (cancelled, the return outcomes, still-upcoming confirmed)
// shows its stored status. Computed here so the time-comparison lives in one
// place; every management/mine response carries `derived_status`.
function deriveStatus(row) {
  if (!row) return row;
  if (row.status !== RENTAL_STATUS.CONFIRMED) return row.status;
  if (new Date(row.end_datetime) >= new Date()) return RENTAL_STATUS.CONFIRMED;
  return isReturnable(row.rental_items?.type) ? RENTAL_STATUS.OVERDUE : RENTAL_STATUS.COMPLETED;
}
const withDerived = (row) => (row ? { ...row, derived_status: deriveStatus(row) } : row);

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
// refused) — which is also what makes cancelling free the slot.
// Options: beforeId limits the check to rows inserted earlier (POST
// concurrency, see below); excludeId ignores one booking — used when EDITING
// so a booking never conflicts with its own current slot.
async function overlappingBookings(itemId, startIso, endIso, { beforeId = null, excludeId = null } = {}) {
  let query = supabase
    .from('rental_requests')
    .select('request_id, quantity_requested, start_datetime, end_datetime')
    .eq('item_id', itemId)
    .neq('status', RENTAL_STATUS.CANCELLED)
    .lt('start_datetime', endIso)
    .gt('end_datetime', startIso)
    .order('start_datetime', { ascending: true });
  if (beforeId !== null) query = query.lt('request_id', beforeId);
  if (excludeId !== null) query = query.neq('request_id', excludeId);
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

// THE conflict check — shared by resident booking (POST) and Secretary edits
// (PUT), so there is exactly one implementation of the availability rules.
// Returns null when the slot fits, or the refusal message when it doesn't.
async function findConflict(item, quantity, startIso, endIso, opts = {}) {
  const overlapping = await overlappingBookings(item.item_id, startIso, endIso, opts);
  if (unitsUsed(overlapping) + quantity > item.quantity_available) {
    return conflictMessage(item, quantity, overlapping);
  }
  return null;
}

// Field validation shared by booking and editing. Returns { error } or the
// parsed values. Same-day bookings by construction: one date, two times.
function parseBookingBody(body) {
  const date = String(body?.date ?? '').trim();
  const startTime = String(body?.start_time ?? '').trim();
  const endTime = String(body?.end_time ?? '').trim();
  const purpose = String(body?.purpose ?? '').trim();
  const quantity = body?.quantity_requested === undefined ? 1 : Number(body?.quantity_requested);

  if (!DATE_RE.test(date)) {
    return { error: 'date must be in YYYY-MM-DD format' };
  }
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return { error: 'start_time and end_time must be in HH:MM (24-hour) format' };
  }
  if (!purpose) {
    return { error: 'purpose is required' };
  }
  if (purpose.length > 1000) {
    return { error: 'purpose must be 1000 characters or fewer' };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'quantity_requested must be a whole number of at least 1' };
  }

  const start = new Date(`${date}T${startTime}:00+08:00`);
  const end = new Date(`${date}T${endTime}:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: 'Invalid date or time' };
  }
  if (end <= start) {
    return { error: 'End time must be after the start time (bookings run within one day)' };
  }
  if (start <= new Date()) {
    return { error: 'The booking must start in the future' };
  }

  return { start, end, startIso: start.toISOString(), endIso: end.toISOString(), purpose, quantity };
}

// Item-dependent rules shared by booking and editing.
function itemQuantityError(item, quantity) {
  if (item.type === ITEM_TYPE.FACILITY && quantity !== 1) {
    return `The ${item.name} is booked as a whole — quantity must be 1`;
  }
  if (quantity > item.quantity_available) {
    return `Only ${item.quantity_available} unit${item.quantity_available === 1 ? '' : 's'} of ${item.name} exist${item.quantity_available === 1 ? 's' : ''} — you asked for ${quantity}`;
  }
  return null;
}

// POST /api/rental-requests — a resident books for themselves, or the
// Secretary encodes a WALK-IN. SELF-SERVICE either way: the conflict check
// runs here at submission and a passing request is confirmed instantly, and
// because both paths go through this ONE handler a walk-in is checked against
// exactly the availability rules a resident's own booking is — there is no
// second code path that could skip them.
//
// requested_by_user_id records WHO FILED IT; who it is FOR is resident_id or
// the outside_borrower_* pair — see resolveBorrower().
router.post('/', requireRole(...CREATE_ROLES), async (req, res) => {
  const itemId = Number(req.body?.item_id);
  if (!Number.isInteger(itemId)) {
    return res.status(400).json({ error: 'An item_id is required' });
  }
  const parsed = parseBookingBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { start, end, startIso, endIso, purpose, quantity } = parsed;

  const borrower = await resolveBorrower(req);
  if (borrower.error) {
    return res.status(borrower.status).json({ error: borrower.error });
  }
  const isGuest = borrower.kind === 'guest';

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
  const quantityError = itemQuantityError(item, quantity);
  if (quantityError) {
    return res.status(400).json({ error: quantityError });
  }

  // CONFLICT CHECK, pass 1 (pre-insert): capacity for the slot is
  // quantity_available; units used = sum of quantity_requested over
  // overlapping non-cancelled bookings. Facilities are the same math with
  // capacity 1 — any overlap fills the slot.
  const conflict = await findConflict(item, quantity, startIso, endIso);
  if (conflict) {
    return res.status(409).json({ error: conflict });
  }

  const { data: created, error: insertError } = await supabase
    .from('rental_requests')
    .insert({
      item_id: itemId,
      requested_by_user_id: req.user.user_id,
      // Exactly one of the two borrower shapes, matching the CHECK from
      // migration 022. The nulls are written explicitly rather than omitted
      // so the row states which path it took.
      resident_id: isGuest ? null : borrower.residentId,
      outside_borrower_name: isGuest ? borrower.name : null,
      outside_borrower_contact: isGuest ? borrower.contact : null,
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
  const lateConflict = await findConflict(item, quantity, startIso, endIso, { beforeId: created.request_id });
  if (lateConflict) {
    await supabase.from('rental_requests').delete().eq('request_id', created.request_id);
    return res.status(409).json({ error: lateConflict });
  }

  // Stage 4: a confirmed booking always carries exactly one RENTAL charge
  // (same pattern as document approval). Zero-fee rentals get an amount-0
  // charge auto-marked PAID, matching the document rule. No transactions in
  // supabase-js, so compensate: if the charge can't be created, delete the
  // booking rather than leave a confirmed booking with nothing to collect.
  // The charge belongs to the BORROWER's account, never the submitter's: for a
  // walk-in the submitter is the Secretary, and keying the charge to
  // req.user.user_id would bill barangay staff. A resident with no account,
  // and every guest, gets null — a hall-only charge the Treasurer settles.
  const amount = rentalAmount(item, quantity);
  const { error: chargeError } = await supabase.from('charges').insert({
    charge_type: CHARGE_TYPE.RENTAL,
    amount,
    status: amount > 0 ? CHARGE_STATUS.UNPAID : CHARGE_STATUS.PAID,
    user_id: isGuest ? null : borrower.accountId,
    rental_request_id: created.request_id,
    created_at: new Date().toISOString(),
  });
  // 23505 = a charge already exists for this booking (UNIQUE
  // charges.rental_request_id, migration 010) — benign, keep going.
  if (chargeError && chargeError.code !== '23505') {
    await supabase.from('rental_requests').delete().eq('request_id', created.request_id);
    throw new Error(`Booking reverted — failed to create its charge: ${chargeError.message}`);
  }

  // Re-read so the response carries the charge just created.
  const { data: withCharge } = await supabase
    .from('rental_requests')
    .select(RENTAL_FIELDS)
    .eq('request_id', created.request_id)
    .maybeSingle();

  // Recorded, not sent. "-" and "x" instead of an em dash and a multiplication
  // sign: both are outside the GSM alphabet and would double the message cost.
  // To the BORROWER, not the submitter. A guest's number is the one typed at
  // the counter, used directly — there is no resident record to join through.
  await notify({
    userId: isGuest ? null : borrower.accountId,
    destination: isGuest ? borrower.contact : borrower.contactNumber,
    relatedType: RELATED_TYPE.RENTAL_REQUEST,
    relatedTo: created.request_id,
    message: `BrgyServe: your booking is CONFIRMED - ${quantity > 1 ? `${quantity}x ` : ''}${item.name} on ${dateFmt.format(start)}, ${timeFmt.format(start)} to ${timeFmt.format(end)}.`,
  });

  const when = `${item.name} on ${dateFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}`;
  res.status(201).json({
    message: borrower.walkIn
      ? `Walk-in booking recorded for ${isGuest ? borrower.name : `resident #${borrower.residentId}`}: ${when}.`
      : `Booking confirmed: ${when}.`,
    request: withDerived(withCharge || created),
  });
});

// POST /api/rental-requests/mine/:id/pay — the resident declares HOW they are
// paying for their booking, exactly like the document flow: stored as
// declared_* on the charge, verified later by the Treasurer/Secretary in the
// shared payments queue. Re-declarable while the charge stays UNPAID.
router.post('/mine/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
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

  // Scoped by resident_id like GET /mine: the charge on a walk-in is the
  // resident's to settle, and filtering on the submitter would 404 them out of
  // a booking their own list shows. Additive for self-service bookings — same
  // reasoning as the document routes. A GUEST booking carries resident_id null
  // and so matches nothing here, which is correct: a guest has no account to
  // call this route from, and settles at the hall with the Treasurer.
  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select('request_id, status, charges ( charge_id, amount, status )')
    .eq('request_id', id)
    .eq('resident_id', residentId) // own bookings only
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const charge = chargeOf(booking);
  if (!charge) {
    return res.status(409).json({ error: 'This booking has no charge yet — contact the barangay' });
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

// GET /api/rental-requests/mine — the bookings FOR the logged-in resident,
// newest first. Filtered by resident_id, not requested_by_user_id, so a
// walk-in the Secretary encoded for this resident shows up in their own list;
// for a self-service booking the two columns name the same person, so nothing
// a resident already saw here changes. A guest booking can never appear
// anywhere here — a guest has no account to view it from, by construction.
// rental_requests has no created-at column, so request_id order stands in
// for insertion order.
//
// A caller with no linked record gets an empty list, not an error — "you have
// no bookings" is true of an account with no resident behind it.
router.get('/mine', async (req, res) => {
  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.json({ requests: [] });
  }

  const { data, error } = await supabase
    .from('rental_requests')
    .select(RENTAL_FIELDS)
    .eq('resident_id', residentId)
    .order('request_id', { ascending: false });
  if (error) {
    throw new Error(`Failed to load bookings: ${error.message}`);
  }
  res.json({ requests: data.map(withDerived) });
});

// ---------------------------------------------------------------------------
// Stage 3 — schedule management. Secretary can view/edit/cancel ANY booking;
// Barangay Staff and the Punong Barangay can VIEW the list and detail but
// have no write access. Residents never see these (their own bookings only,
// via /mine above).
// ---------------------------------------------------------------------------

const VIEW_ROLES = ['secretary', 'staff', 'punong_barangay'];

// GET /api/rental-requests?status=confirmed — all bookings across residents,
// optionally filtered, newest-scheduled first. Besides the stored statuses,
// two VIRTUAL filters are derived from confirmed + past-end bookings:
// 'overdue' (physical items awaiting return) and 'completed' (facilities that
// auto-completed). 'all' or omitted = everything.
const VIRTUAL_FILTERS = [RENTAL_STATUS.OVERDUE, RENTAL_STATUS.COMPLETED];

router.get('/', requireRole(...VIEW_ROLES), async (req, res) => {
  const status = req.query.status;
  const isVirtual = VIRTUAL_FILTERS.includes(status);

  let query = supabase
    .from('rental_requests')
    .select(MANAGE_FIELDS)
    .order('start_datetime', { ascending: false });

  if (status && status !== 'all' && !isVirtual) {
    if (!STORED_RENTAL_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Unknown status '${status}' (expected one of: ${STORED_RENTAL_STATUSES.join(', ')}, overdue, completed, or 'all')`,
      });
    }
    query = query.eq('status', status);
  } else if (isVirtual) {
    // overdue/completed are derived from confirmed bookings past their end —
    // fetch confirmed, then keep the ones whose derived status matches.
    query = query.eq('status', RENTAL_STATUS.CONFIRMED);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load bookings: ${error.message}`);
  }

  let rows = data.map(withDerived);
  if (isVirtual) {
    rows = rows.filter((r) => r.derived_status === status);
  }
  res.json({ requests: rows });
});

// GET /api/rental-requests/:id — one booking's detail (view roles).
router.get('/:id', requireRole(...VIEW_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  const { data, error } = await supabase
    .from('rental_requests')
    .select(MANAGE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load booking: ${error.message}`);
  }
  if (!data) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json({ request: withDerived(data) });
});

// PUT /api/rental-requests/:id — Secretary reschedules a booking (date,
// times, quantity, purpose; the item itself is fixed). The stage 2 conflict
// check re-runs on the new values with THIS booking excluded from the
// comparison — otherwise every edit would collide with its own current slot.
router.put('/:id', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  const parsed = parseBookingBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { startIso, endIso, purpose, quantity } = parsed;

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select('request_id, item_id, status, quantity_requested, start_datetime, end_datetime, purpose')
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (booking.status !== RENTAL_STATUS.CONFIRMED) {
    return res.status(409).json({
      error: `Only confirmed bookings can be edited — this booking is '${booking.status}'`,
    });
  }

  // The item is loaded even if since deactivated: deactivation only blocks
  // NEW bookings, not managing existing ones.
  const { data: item, error: itemError } = await supabase
    .from('rental_items')
    .select('item_id, name, type, quantity_total, quantity_available, fee')
    .eq('item_id', booking.item_id)
    .maybeSingle();
  if (itemError || !item) {
    throw new Error(`Failed to load rental item: ${itemError?.message || 'not found'}`);
  }
  const quantityError = itemQuantityError(item, quantity);
  if (quantityError) {
    return res.status(400).json({ error: quantityError });
  }

  // Conflict check on the NEW values, excluding this booking's own row.
  const conflict = await findConflict(item, quantity, startIso, endIso, { excludeId: id });
  if (conflict) {
    return res.status(409).json({ error: conflict });
  }

  const { data: updated, error } = await supabase
    .from('rental_requests')
    .update({ start_datetime: startIso, end_datetime: endIso, quantity_requested: quantity, purpose })
    .eq('request_id', id)
    .eq('status', RENTAL_STATUS.CONFIRMED) // guard: not if just cancelled
    .select(MANAGE_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to update booking: ${error.message}`);
  }
  if (!updated) {
    return res.status(409).json({ error: 'Booking status just changed — refresh and try again' });
  }

  // Post-update re-check (same compensation idea as the POST route): if a
  // racing submission landed between check and update, restore the previous
  // schedule and refuse. Rare double-race leftovers are accepted — a single
  // Secretary edits, and the POST route's own pass-2 covers the other side.
  const lateConflict = await findConflict(item, quantity, startIso, endIso, { excludeId: id });
  if (lateConflict) {
    await supabase
      .from('rental_requests')
      .update({
        start_datetime: booking.start_datetime,
        end_datetime: booking.end_datetime,
        quantity_requested: booking.quantity_requested,
        purpose: booking.purpose,
      })
      .eq('request_id', id);
    return res.status(409).json({ error: lateConflict });
  }

  // Stage 4: a quantity change changes what is owed (fee × quantity), so an
  // UNPAID charge is recomputed to match. A PAID charge is left alone — it
  // records money actually received; any difference after a paid booking is
  // edited is settled offline by the Treasurer.
  let response = updated;
  if (quantity !== booking.quantity_requested) {
    const { error: chargeError } = await supabase
      .from('charges')
      .update({ amount: rentalAmount(item, quantity) })
      .eq('rental_request_id', id)
      .eq('status', CHARGE_STATUS.UNPAID);
    if (chargeError) {
      throw new Error(`Booking updated but failed to update its charge: ${chargeError.message}`);
    }
    const { data: fresh } = await supabase
      .from('rental_requests')
      .select(MANAGE_FIELDS)
      .eq('request_id', id)
      .maybeSingle();
    if (fresh) response = fresh;
  }

  res.json({ message: 'Booking updated', request: withDerived(response) });
});

// POST /api/rental-requests/:id/cancel — Secretary cancels a booking. The
// conflict check ignores cancelled rows, so the slot/units free up
// immediately. SMS stub tells the resident, since this is done TO them.
router.post('/:id/cancel', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(
      'request_id, status, resident_id, outside_borrower_name, outside_borrower_contact, start_datetime, rental_items ( name ), resident_records ( contact_number )'
    )
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (booking.status !== RENTAL_STATUS.CONFIRMED) {
    return res.status(409).json({
      error: `Only confirmed bookings can be cancelled — this booking is '${booking.status}'`,
    });
  }

  const { data: cancelled, error } = await supabase
    .from('rental_requests')
    .update({ status: RENTAL_STATUS.CANCELLED, processed_by_user_id: req.user.user_id })
    .eq('request_id', id)
    .eq('status', RENTAL_STATUS.CONFIRMED)
    .select('request_id')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to cancel booking: ${error.message}`);
  }
  if (!cancelled) {
    return res.status(409).json({ error: 'Booking status just changed — refresh and try again' });
  }

  // Stage 4: an UNPAID charge on a cancelled booking is VOIDed — nothing is
  // owed anymore, and VOID (unlike deletion) keeps the billing record while
  // dropping it off the verification queue. A PAID charge stays PAID: it
  // records money actually received, and any refund is handled offline.
  const { error: voidError } = await supabase
    .from('charges')
    .update({ status: CHARGE_STATUS.VOID })
    .eq('rental_request_id', id)
    .eq('status', CHARGE_STATUS.UNPAID);
  if (voidError) {
    throw new Error(`Booking cancelled but failed to void its charge: ${voidError.message}`);
  }

  const { data: fresh } = await supabase
    .from('rental_requests')
    .select(MANAGE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();

  // To the BORROWER — previously looked up through requested_by_user_id, which
  // for a walk-in is the Secretary who filed it, not the person whose slot
  // was just cancelled.
  const target = await borrowerNotifyTarget(booking);
  await notify({
    userId: target.userId,
    destination: target.destination,
    relatedType: RELATED_TYPE.RENTAL_REQUEST,
    relatedTo: id,
    message: `BrgyServe: your booking of ${booking.rental_items?.name || 'a rental item'} on ${dateFmt.format(new Date(booking.start_datetime))} has been CANCELLED by the barangay. Please contact the barangay hall for details.`,
  });

  res.json({ message: 'Booking cancelled — the slot has been freed', request: withDerived(fresh) });
});

// ---------------------------------------------------------------------------
// Stage 5 — return tracking. Barangay Staff (view-only everywhere else in
// rentals) get exactly ONE write action: recording that a physical item has
// been returned. Facilities have no return step (they auto-complete). This is
// deliberately Staff-only — edit/cancel remain Secretary-only above.
// ---------------------------------------------------------------------------

// POST /api/rental-requests/:id/return — Staff mark a confirmed physical-item
// booking as returned / returned_late / returned_with_issue (+ optional note).
router.post('/:id/return', requireRole('staff'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  const outcome = String(req.body?.outcome ?? '').trim().toLowerCase();
  if (!RETURN_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${RETURN_OUTCOMES.join(', ')}` });
  }
  const note = String(req.body?.note ?? '').trim() || null;
  if (note && note.length > 1000) {
    return res.status(400).json({ error: 'note must be 1000 characters or fewer' });
  }

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(
      'request_id, status, resident_id, outside_borrower_name, outside_borrower_contact, rental_items ( name, type ), resident_records ( contact_number )'
    )
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  // Facilities have no return step — they auto-complete after their end.
  if (!isReturnable(booking.rental_items?.type)) {
    return res.status(400).json({
      error: `${booking.rental_items?.name || 'This item'} is a facility — facilities have no return step (they complete automatically after their booked time).`,
    });
  }
  if (booking.status !== RENTAL_STATUS.CONFIRMED) {
    return res.status(409).json({
      error: `Only confirmed bookings can be marked returned — this booking is '${booking.status}'`,
    });
  }

  const { data: updated, error } = await supabase
    .from('rental_requests')
    .update({
      status: outcome,
      return_note: note,
      returned_at: new Date().toISOString(),
      returned_by_user_id: req.user.user_id,
    })
    .eq('request_id', id)
    .eq('status', RENTAL_STATUS.CONFIRMED) // guard: not if just cancelled
    .select(MANAGE_FIELDS)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to mark returned: ${error.message}`);
  }
  if (!updated) {
    return res.status(409).json({ error: 'Booking status just changed — refresh and try again' });
  }

  // To the BORROWER — see the cancel route.
  const target = await borrowerNotifyTarget(booking);
  const spoken = {
    [RENTAL_STATUS.RETURNED]: 'returned',
    [RENTAL_STATUS.RETURNED_LATE]: 'returned (late)',
    [RENTAL_STATUS.RETURNED_WITH_ISSUE]: 'returned with an issue noted',
  }[outcome];
  await notify({
    userId: target.userId,
    destination: target.destination,
    relatedType: RELATED_TYPE.RENTAL_REQUEST,
    relatedTo: id,
    message: `BrgyServe: your rental of ${booking.rental_items?.name || 'an item'} has been recorded as ${spoken}. Thank you.`,
  });

  res.json({ message: 'Return recorded', request: withDerived(updated) });
});

module.exports = router;
