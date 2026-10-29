const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  ITEM_TYPE,
  RETURNABLE_TYPES,
  RENTAL_STATUS,
  RETURN_OUTCOMES,
  STORED_RENTAL_STATUSES,
  PURPOSE_TYPE,
  DECLINE_REASON_MIN,
  DECLINE_REASON_MAX,
} = require('../constants/rentals');
const { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD } = require('../constants/charges');
const { notify } = require('../services/notifications');
const { RELATED_TYPE } = require('../constants/notifications');
const { PH_MOBILE_RE, PH_MOBILE_FORMS } = require('../constants/phoneNumber');
const { MIDNIGHT, MAX_DAYS_AHEAD, clockMinutes, bookingRuleRefusal } = require('../constants/rentalBookingRules');
const { logActivity, diffFields, pick } = require('../services/activityLog');
const { ACTIONS } = require('../constants/activityLog');
const paymongo = require('../services/paymongo');

const router = express.Router();

router.use(authenticate);

const RENTAL_FIELDS =
  'request_id, quantity_requested, start_datetime, end_datetime, purpose, status, return_note, returned_at, cancellation_reason, rental_items ( item_id, name, type, fee ), charges ( charge_id, amount, status, declared_method, declared_reference, declared_at )';

// Management/staff views: adds the requester (with their profile name), the
// item's capacity numbers and booking hours (the Edit panel shows the hours
// and holds its time fields to them, step O43), and the return record.
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
//
// Migration 027 adds decline_reason, purpose_type and requested_at, when the
// request was made. requested_at is NULL on every booking made before 027
// (nothing stored it), so withDerived() drops the key when it is NULL: an
// unknown time is absent, never null (CLAUDE.md, a withheld field is absent).
// The item's funeral_eligible (027) is read too: the Approve panel offers
// "Free for funeral" only on an item marked for it (batch R2b).
const MANAGE_FIELDS = `
  request_id, quantity_requested, start_datetime, end_datetime, purpose, status,
  return_note, returned_at, cancellation_reason,
  decline_reason, purpose_type, requested_at,
  resident_id, outside_borrower_name, outside_borrower_contact,
  rental_items ( item_id, name, type, fee, quantity_total, quantity_available,
    booking_opens_at, booking_closes_at, funeral_eligible ),
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

// A guest's contact must be a Philippine MOBILE number (PH_MOBILE_RE, shared
// with registration in constants/phoneNumber.js). It is the destination every
// notice about the booking goes to, and unlike a resident's number it cannot
// be corrected from a record later, because a guest has none. The first guest
// row through the form stored "09123456789213213ssdd", which the presence and
// length checks accepted; this is the rule that refuses it.
// FORMAT ONLY: the presence, both-or-neither and length checks that mirror
// the migration 022 CHECK stay exactly as they are, and this runs after them.
// The booking form applies the same pattern before posting, but THIS is the
// guard — the form can be bypassed with a direct call, this cannot.

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
        error: `outside_borrower_contact must be a Philippine mobile number: ${PH_MOBILE_FORMS}`,
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

// WHAT APPROVING A REQUEST WILL CHARGE, worked out in ONE place: the approve
// route charges it (unless the Secretary waives the fee for a funeral) and
// the Secretary's list shows it as fee_if_approved (withManaged, below), so
// the number on the Approve panel and the charge cannot be worked out two
// ways. Fee x quantity, rentalAmount() as POST / bills a booking; batch R3's
// pricing changes this one function. A booking read without its item counts
// as PHP 0, as the approve route always did.
const feeIfApproved = (booking) => rentalAmount(booking.rental_items ?? { fee: 0 }, booking.quantity_requested);

const chargeOf = (row) => (Array.isArray(row?.charges) ? row.charges[0] || null : row?.charges || null);

const isReturnable = (type) => RETURNABLE_TYPES.includes(type);

// Derived display status (stage 5) — NEVER stored. A booking past its end that
// is still 'confirmed' is either a facility that auto-completes (no physical
// return) or a physical item that is overdue until Staff mark it returned. A
// request still 'pending' once its START has passed is 'expired' (migration
// 027): nobody approved it in time, and it can no longer be approved.
// Everything else (cancelled, declined, the return outcomes, a pending
// request still ahead, still-upcoming confirmed) shows its stored status.
// Computed here so the time-comparison lives in one place; every
// management/mine response carries `derived_status`.
function deriveStatus(row) {
  if (!row) return row;
  if (row.status === RENTAL_STATUS.PENDING) {
    return new Date(row.start_datetime) > new Date() ? RENTAL_STATUS.PENDING : RENTAL_STATUS.EXPIRED;
  }
  if (row.status !== RENTAL_STATUS.CONFIRMED) return row.status;
  if (new Date(row.end_datetime) >= new Date()) return RENTAL_STATUS.CONFIRMED;
  return isReturnable(row.rental_items?.type) ? RENTAL_STATUS.OVERDUE : RENTAL_STATUS.COMPLETED;
}
// A requested_at that is NULL (every booking made before migration 027;
// nothing stored it) is left out, never sent as null: the time is unknown,
// and null would read as a value (CLAUDE.md, a withheld field is absent).
// Only the Secretary's projection, MANAGE_FIELDS, reads the column.
function withDerived(row) {
  if (!row) return row;
  const out = { ...row, derived_status: deriveStatus(row) };
  if (out.requested_at === null) delete out.requested_at;
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// All barangay bookings are Philippine local time; composing with an explicit
// +08:00 offset keeps stored timestamps correct no matter where the server runs.
const TZ = 'Asia/Manila';
const timeFmt = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, dateStyle: 'medium' });

// WHETHER A SLOT IS FREE IS THE DATABASE'S DECISION (migration 024). Booking
// (create_rental_booking), moving a booking (update_rental_booking_time) and
// the booking forms' question (rental_availability) all go through one rule,
// rental_holds(), inside functions that lock the item's row first, so two
// bookings for the same item can no longer both pass a check and both be
// written. That rule holds equipment and furniture for 24 hours after their
// return (or their booked end, whichever is later) and keeps an overdue,
// unreturned booking's units until Staff mark it returned. There is no copy
// of it here, and there must not be one: the route validates the body and
// says the function's refusal in words (refusalOf, below).

const END_NOT_AFTER_START = 'End time must be after the start time (bookings run within one day)';
const START_NOT_IN_FUTURE = 'The booking must start in the future';
const QUANTITY_BELOW_ONE = 'quantity_requested must be a whole number of at least 1';
const ITEM_NOT_FOUND = 'Rental item not found';
const ITEM_INACTIVE = 'That item is not currently available for rental';
const NOT_STARTED_EDIT = 'Only a booking that has not started can be changed.';

// The format checks for a date and two times: the booking body's and the
// availability question's. Returns an error sentence or null. The end may
// also be "24:00", midnight (see slotTimes).
function slotFormatError(date, startTime, endTime) {
  if (!DATE_RE.test(date)) return 'date must be in YYYY-MM-DD format';
  if (!TIME_RE.test(startTime) || !(TIME_RE.test(endTime) || endTime === '24:00')) {
    return 'start_time and end_time must be in HH:MM (24-hour) format';
  }
  return null;
}

// An end time of "00:00" or "24:00" is MIDNIGHT AT THE END OF THE DATE, 00:00
// of the next day (migration 025): a booking runs within one day, so an end at
// the day's own first minute could never be after its start, and was always
// refused. Whether the item may be booked until midnight is the booking
// rules' question (bookingRuleRefusal), not this one.
const endsAtMidnight = (endTime) => endTime === '00:00' || endTime === '24:00';

// One Manila date and two Manila times as two moments. Same-day bookings by
// construction: one date, two times. Returns { error } or { start, end }.
function slotTimes(date, startTime, endTime) {
  const start = new Date(`${date}T${startTime}:00+08:00`);
  const end = endsAtMidnight(endTime)
    ? new Date(new Date(`${date}T00:00:00+08:00`).getTime() + MIDNIGHT * 60000)
    : new Date(`${date}T${endTime}:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: 'Invalid date or time' };
  }
  if (end <= start) return { error: END_NOT_AFTER_START };
  return { start, end };
}

// Today's date in Manila, "YYYY-MM-DD", whatever zone the server runs in.
const manilaDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });

// THE BOOKING RULES (migration 025): the item's own hours, and how far ahead
// a booking may start (MAX_DAYS_AHEAD, from today in Manila; a constant since
// step O43, never read from the database). Checked on a resident's booking, a
// walk-in and the Secretary's edit alike; bookings already stored are not
// checked again. Enforced HERE, never inside migration 024's functions, which
// decide only whether a slot is free. Returns the refusal sentence or null.
function bookingRulesRefusal(parsed, item) {
  return bookingRuleRefusal(
    { date: parsed.date, startMinutes: parsed.startMinutes, endMinutes: parsed.endMinutes },
    item,
    MAX_DAYS_AHEAD,
    manilaDayFmt.format(new Date())
  );
}

// Field validation shared by booking and editing. Returns { error } or the
// parsed values.
function parseBookingBody(body) {
  const date = String(body?.date ?? '').trim();
  const startTime = String(body?.start_time ?? '').trim();
  const endTime = String(body?.end_time ?? '').trim();
  const purpose = String(body?.purpose ?? '').trim();
  const quantity = body?.quantity_requested === undefined ? 1 : Number(body?.quantity_requested);

  const formatError = slotFormatError(date, startTime, endTime);
  if (formatError) {
    return { error: formatError };
  }
  if (!purpose) {
    return { error: 'purpose is required' };
  }
  if (purpose.length > 1000) {
    return { error: 'purpose must be 1000 characters or fewer' };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: QUANTITY_BELOW_ONE };
  }

  const times = slotTimes(date, startTime, endTime);
  if (times.error) {
    return { error: times.error };
  }
  const { start, end } = times;
  if (start <= new Date()) {
    return { error: START_NOT_IN_FUTURE };
  }

  return {
    start, end, startIso: start.toISOString(), endIso: end.toISOString(), purpose, quantity,
    // For the booking rules: the date, and the times as minutes on it.
    date,
    startMinutes: clockMinutes(startTime),
    endMinutes: endsAtMidnight(endTime) ? MIDNIGHT : clockMinutes(endTime),
  };
}

const isOrAre = (n) => (n === 1 ? 'is' : 'are');

// A coded refusal from migration 024's functions, as the status and sentence
// the caller is given: the words the route gave before the check moved into
// the database, plus two short add-ons for units that are overdue (stuck) or
// resting for 24 hours after an earlier booking (one already returned, or one
// that has not ended yet, so "after being returned" would be wrong). `item`
// names the item ({ name }). A code or reason this file does not know is
// thrown, never answered with a sentence it cannot stand behind (the same rule
// as an unrecognised 23505).
function refusalOf(result, item) {
  const name = item?.name ?? 'item';
  switch (result.code) {
    case 'TIME_INVALID':
      if (result.reason === 'END_NOT_AFTER_START') return { status: 400, error: END_NOT_AFTER_START };
      if (result.reason === 'START_NOT_IN_FUTURE') return { status: 400, error: START_NOT_IN_FUTURE };
      break;
    case 'QUANTITY_INVALID':
      if (result.reason === 'BELOW_ONE') return { status: 400, error: QUANTITY_BELOW_ONE };
      if (result.reason === 'FACILITY_WHOLE') {
        return { status: 400, error: `The ${name} is booked as a whole — quantity must be 1` };
      }
      if (result.reason === 'MORE_THAN_EXIST') {
        const n = result.quantity_available;
        return {
          status: 400,
          error: `Only ${n} unit${n === 1 ? '' : 's'} of ${name} exist${n === 1 ? 's' : ''} — you asked for ${result.requested}`,
        };
      }
      break;
    case 'ITEM_NOT_FOUND':
      return { status: 404, error: ITEM_NOT_FOUND };
    case 'ITEM_INACTIVE':
      return { status: 400, error: ITEM_INACTIVE };
    // A funeral booking placed by the Secretary's walk-in (a later batch;
    // POST / sends 'general' today, so nothing reaches these yet).
    case 'FUNERAL_NOT_ALLOWED':
      return { status: 400, error: `The ${name} is not marked for funeral use, so it cannot be booked free for a funeral.` };
    case 'FUNERAL_RESIDENTS_ONLY':
      return { status: 400, error: 'A funeral fee can be waived only for a barangay resident, so this booking cannot be free.' };
    case 'BOOKING_NOT_FOUND':
      return { status: 404, error: 'Booking not found' };
    case 'BOOKING_STARTED':
      return { status: 409, error: NOT_STARTED_EDIT };
    case 'FACILITY_TAKEN': {
      // The first clash by its start, as the route always named it.
      const first = Array.isArray(result.clashes) ? result.clashes[0] : null;
      if (first) {
        return {
          status: 409,
          error: `The ${name} is already booked from ${timeFmt.format(new Date(first.start))} to ${timeFmt.format(new Date(first.end))} on that date — please pick a different time.`,
        };
      }
      break;
    }
    case 'NOT_ENOUGH_LEFT': {
      const { left, stuck, resting } = result;
      const parts = [
        `Only ${left} of ${result.quantity_available} ${name} ${isOrAre(left)} available for that time — you asked for ${result.requested}.`,
      ];
      if (stuck > 0) parts.push(`${stuck} ${isOrAre(stuck)} overdue and not yet returned.`);
      if (resting > 0) parts.push(`${resting} ${isOrAre(resting)} resting for 24 hours after an earlier booking.`);
      return { status: 409, error: parts.join(' ') };
    }
    default:
      break;
  }
  throw new Error(`Unrecognised booking refusal: ${result.code}${result.reason ? ` (${result.reason})` : ''}`);
}

// A migration-024 function's answer, or a thrown error when the call failed.
async function callBookingFunction(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new Error(`${name} failed: ${error.message}`);
  }
  return data;
}

// RENTAL_FIELDS' own columns. If the re-read after a booking fails, the answer
// is built from these and the item, never from the function's row as it came
// back, which carries the borrower's contact number.
const RENTAL_COLUMNS = [
  'request_id', 'quantity_requested', 'start_datetime', 'end_datetime', 'purpose', 'status',
  'return_note', 'returned_at', 'cancellation_reason',
];

// POST /api/rental-requests — a resident books for themselves, or the
// Secretary encodes a WALK-IN. The booking is checked and written in one call
// to place_rental_booking (migration 027; it replaces 024's
// create_rental_booking, which stays in the database until migration 028 for
// the code that ran before), CONFIRMED at once when the slot is free, for
// both kinds as before: the approval step (a resident's request stored
// 'pending') is built but not yet switched on. Because both paths go through
// this ONE handler a walk-in is checked against exactly the availability
// rules a resident's own booking is — there is no second code path that
// could skip them.
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

  // For the fee, the item's name in the sentences, the booking rules, and the
  // answer. Whether it exists, is active and has the units is the function's
  // to say.
  const { data: item, error: itemError } = await supabase
    .from('rental_items')
    .select('item_id, name, type, fee, is_active, booking_opens_at, booking_closes_at')
    .eq('item_id', itemId)
    .maybeSingle();
  if (itemError) {
    throw new Error(`Failed to load rental item: ${itemError.message}`);
  }

  // The item's hours and how far ahead: for a resident and a walk-in alike.
  // An unknown or inactive item is left to the function's own refusal, as
  // before, so the order of the answers does not change for one.
  if (item?.is_active) {
    const ruleRefusal = bookingRulesRefusal(parsed, item);
    if (ruleRefusal) {
      return res.status(400).json({ error: ruleRefusal });
    }
  }

  const result = await callBookingFunction('place_rental_booking', {
    p_item_id: itemId,
    p_requested_by_user_id: req.user.user_id,
    // Exactly one of the two borrower shapes, matching the CHECK from
    // migration 022. The nulls are sent explicitly so the row states which
    // path it took.
    p_resident_id: isGuest ? null : borrower.residentId,
    p_outside_borrower_name: isGuest ? borrower.name : null,
    p_outside_borrower_contact: isGuest ? borrower.contact : null,
    p_quantity: quantity,
    p_start: startIso,
    p_end: endIso,
    p_purpose: purpose,
    // Until the approval batches: every booking is general and confirmed at
    // once, exactly as create_rental_booking stored it.
    p_purpose_type: PURPOSE_TYPE.GENERAL,
    p_status: RENTAL_STATUS.CONFIRMED,
  });
  if (!result?.ok) {
    const refused = refusalOf(result ?? {}, item);
    return res.status(refused.status).json({ error: refused.error });
  }
  const created = result.request;
  if (!item) {
    throw new Error(`Booking ${created.request_id} was made for item ${itemId}, which could not be read`);
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

  // Re-read so the response carries the charge just created, in RENTAL_FIELDS'
  // shape.
  const { data: withCharge } = await supabase
    .from('rental_requests')
    .select(RENTAL_FIELDS)
    .eq('request_id', created.request_id)
    .maybeSingle();
  const answered = withCharge || {
    ...pick(created, RENTAL_COLUMNS),
    rental_items: pick(item, ['item_id', 'name', 'type', 'fee']),
    charges: [],
  };

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

  // A guest is recorded as a guest, never by name or contact number; the
  // purpose is free text and is left out too.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.CREATE,
    table: 'rental_requests',
    recordId: created.request_id,
    after: {
      item_id: itemId,
      resident_id: isGuest ? null : borrower.residentId,
      guest: isGuest,
      walk_in: !!borrower.walkIn,
      quantity_requested: quantity,
      start_datetime: startIso,
      end_datetime: endIso,
      status: RENTAL_STATUS.CONFIRMED,
    },
  });

  const when = `${item.name} on ${dateFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}`;
  res.status(201).json({
    message: borrower.walkIn
      ? `Walk-in booking recorded for ${isGuest ? borrower.name : `resident #${borrower.residentId}`}: ${when}.`
      : `Booking confirmed: ${when}.`,
    request: withDerived(answered),
  });
});

// The keys GET /availability passes on from rental_availability: numbers and
// the item's type. For a facility, `taken` too, each entry cut to its start
// and end. Nothing about who booked, or why.
const AVAILABILITY_KEYS = ['ok', 'item_type', 'total', 'used', 'booked', 'stuck', 'resting', 'left'];

// GET /api/rental-requests/availability?item_id=&date=&start_time=&end_time=
// — what is free for that item at that time, asked by the booking forms
// before a booking (the resident's, and the Secretary's walk-in form). Read
// only. The date and times are read as POST reads them (Manila), and the
// answer is rental_availability's, the same rule POST is decided by, so the
// page and the server cannot disagree; the page only advises, and POST
// decides again. A start already past may be asked about. Declared before
// GET /:id, which would otherwise catch "/availability" as an id.
//
// The Secretary's Edit panel adds exclude_request_id, the booking being
// edited, so it is not counted against its own new time (as
// update_rental_booking_time leaves it out). A resident sending it is refused
// with a 400, never quietly ignored: leaving a booking out would show units
// free that are not, so only the one role that edits bookings may ask it.
router.get('/availability', requireRole(...CREATE_ROLES), async (req, res) => {
  const itemId = Number(req.query?.item_id);
  if (!Number.isInteger(itemId)) {
    return res.status(400).json({ error: 'An item_id is required' });
  }
  let excludeId = null;
  if (req.query?.exclude_request_id !== undefined) {
    if (req.user.role !== 'secretary') {
      return res.status(400).json({ error: 'Only the Secretary can leave a booking out of the count.' });
    }
    const raw = String(req.query.exclude_request_id);
    excludeId = /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
    if (!Number.isSafeInteger(excludeId)) {
      return res.status(400).json({ error: 'exclude_request_id must be a whole number above 0' });
    }
  }
  const date = String(req.query?.date ?? '').trim();
  const startTime = String(req.query?.start_time ?? '').trim();
  const endTime = String(req.query?.end_time ?? '').trim();
  const formatError = slotFormatError(date, startTime, endTime);
  if (formatError) {
    return res.status(400).json({ error: formatError });
  }
  const times = slotTimes(date, startTime, endTime);
  if (times.error) {
    return res.status(400).json({ error: times.error });
  }

  // An unknown or inactive item is refused as POST refuses it, before the
  // function is asked: an inactive item cannot be booked, so there is
  // nothing to show. Except for an edit (an exclude id): an existing booking
  // of a since-deactivated item may still be moved, as PUT /:id allows.
  const { data: item, error: itemError } = await supabase
    .from('rental_items')
    .select('item_id, is_active')
    .eq('item_id', itemId)
    .maybeSingle();
  if (itemError) {
    throw new Error(`Failed to load rental item: ${itemError.message}`);
  }
  if (!item) {
    return res.status(404).json({ error: ITEM_NOT_FOUND });
  }
  if (!item.is_active && excludeId === null) {
    return res.status(400).json({ error: ITEM_INACTIVE });
  }

  const result = await callBookingFunction('rental_availability', {
    p_item_id: itemId,
    p_start: times.start.toISOString(),
    p_end: times.end.toISOString(),
    ...(excludeId === null ? {} : { p_exclude_request_id: excludeId }),
  });
  if (!result?.ok) {
    if (result?.code === 'TIME_INVALID') {
      return res.status(400).json({ error: refusalOf(result, null).error, code: result.code });
    }
    const refused = refusalOf(result ?? {}, null);
    return res.status(refused.status).json({ error: refused.error });
  }

  const answer = pick(result, AVAILABILITY_KEYS);
  if (result.item_type === ITEM_TYPE.FACILITY && Array.isArray(result.taken)) {
    answer.taken = result.taken.map((slot) => ({ start: slot.start, end: slot.end }));
  }
  res.json(answer);
});

// POST /api/rental-requests/mine/:id/pay — the resident declares that they
// will pay for their booking in cash at the barangay hall ('onsite', the only
// method accepted), exactly like the document flow: stored as declared_* on
// the charge, verified later by the Treasurer/Secretary in the shared
// payments queue. Re-declarable while the charge stays UNPAID. A GCash
// reference ('gcash') could be declared until 10 Oct 2026; it is now refused
// with a 400, and an onsite declaration still clears one left from then.
router.post('/mine/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  const method = String(req.body?.method ?? '').toLowerCase();
  if (method === PAYMENT_METHOD.GCASH) {
    return res.status(400).json({
      error: 'Submitting a GCash reference is no longer available. Choose Pay online via GCash, or pay at the Barangay Office.',
    });
  }
  if (method !== PAYMENT_METHOD.ONSITE) {
    return res.status(400).json({ error: "method must be 'onsite'" });
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
      declared_reference: null, // also clears a GCash reference declared before 10 Oct 2026
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

  // The method only — never the GCash reference number.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.DECLARE_PAYMENT,
    table: 'charges',
    recordId: charge.charge_id,
    after: { method },
  });

  res.json({
    message: "Noted — please pay in cash at the barangay hall treasurer's desk.",
    charge: updated,
  });
});

// POST /api/rental-requests/mine/:id/cancel — a resident cancels their OWN
// online booking, at least 24 hours before it starts, while nothing has been
// paid for it (a PHP 0 booking, or one with no charge, counts as unpaid).
// "Their own online booking" is both columns: resident_id is their linked
// record (the /mine scoping — anyone else's booking is a 404, never a hint
// that it exists) AND requested_by_user_id is their own account. A walk-in
// the Secretary filed for them, or a booking with money paid, is refused and
// sent to the barangay hall: a paid booking needs a person to arrange the
// refund. A reason is optional. No notification: they have just done it.
const RESIDENT_CANCEL_HOURS = 24;

// Why the resident may NOT cancel this booking online, as the sentence the
// route answers with, or null when they may. ONE function behind the route
// and behind the can_cancel_online / cancel_online_note GET /mine sends, so
// the button My rentals draws and the answer it gets cannot disagree. Checked
// in this order: made at the hall, under 24 hours, paid. Whether the booking
// has started at all is cancelBooking()'s isCancellable(), which the route
// reaches next and the list reads first. The booking needs status,
// requested_by_user_id, start_datetime and its charge.
//
// The 24 hours apply to a CONFIRMED booking only (migration 027): a pending
// request holds nothing and has no charge, so withdrawing it frees nothing
// and voids nothing, and it may be cancelled any time before it starts.
function onlineCancelRefusal(booking, userId) {
  if (booking.requested_by_user_id !== userId) {
    return 'This booking was made at the barangay hall, so it can only be changed there.';
  }
  if (booking.status !== RENTAL_STATUS.PENDING
    && new Date(booking.start_datetime) - Date.now() < RESIDENT_CANCEL_HOURS * 3600 * 1000) {
    return 'A booking can be cancelled online only until 24 hours before it starts. Please go to the barangay hall.';
  }
  const charge = chargeOf(booking);
  if (charge?.status === CHARGE_STATUS.PAID && Number(charge.amount) > 0) {
    return 'A paid booking can only be cancelled at the barangay hall, so your refund can be arranged.';
  }
  return null;
}

// What My rentals is told about cancelling a booking online. A booking that
// has started, or is neither confirmed nor pending (cancelled, declined,
// returned), needs no button and no note: both are false and null. Otherwise
// the button shows exactly when the route would accept, and the note is the
// route's sentence.
function onlineCancelView(booking, userId) {
  if (!isCancellable(booking)) return { can_cancel_online: false, cancel_online_note: null };
  const refusal = onlineCancelRefusal(booking, userId);
  return { can_cancel_online: refusal === null, cancel_online_note: refusal };
}

router.post('/mine/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const parsed = parseReason(req.body?.reason, { required: false });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(CANCEL_FIELDS)
    .eq('request_id', id)
    .eq('resident_id', residentId) // own bookings only
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  const refusal = onlineCancelRefusal(booking, req.user.user_id);
  if (refusal) {
    return res.status(409).json({ error: refusal });
  }

  const result = await cancelBooking(booking, {
    user: req.user,
    processedBy: null, // nobody at the barangay processed it
    reason: parsed.reason,
    notifyBorrower: false,
    responseFields: RENTAL_FIELDS,
    message: 'Your booking has been cancelled.',
  });
  res.status(result.status).json(result.body);
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
//
// Each booking also says whether the resident may cancel it online
// (can_cancel_online) and, where not, why (cancel_online_note), from
// onlineCancelView(), so My rentals never guesses. requested_by_user_id is
// read for that and NOT sent: on a walk-in it is the Secretary's account.
router.get('/mine', async (req, res) => {
  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.json({ requests: [] });
  }

  const { data, error } = await supabase
    .from('rental_requests')
    .select(`${RENTAL_FIELDS}, requested_by_user_id`)
    .eq('resident_id', residentId)
    .order('request_id', { ascending: false });
  if (error) {
    throw new Error(`Failed to load bookings: ${error.message}`);
  }
  res.json({
    requests: data.map(({ requested_by_user_id: filedBy, ...row }) => ({
      ...withDerived(row),
      ...onlineCancelView({ ...row, requested_by_user_id: filedBy }, req.user.user_id),
    })),
  });
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
// three VIRTUAL filters are derived: 'overdue' (physical items awaiting
// return) and 'completed' (facilities that auto-completed), from confirmed +
// past-end bookings, and 'expired' (migration 027), from pending + past-start
// requests. A stored filter stays a stored filter: ?status=pending lists
// every booking stored pending, expired ones included, as ?status=confirmed
// lists overdue ones. 'all' or omitted = everything.
const VIRTUAL_FILTERS = [RENTAL_STATUS.OVERDUE, RENTAL_STATUS.COMPLETED, RENTAL_STATUS.EXPIRED];
// The stored status each virtual filter is derived from.
const VIRTUAL_SOURCE = {
  [RENTAL_STATUS.OVERDUE]: RENTAL_STATUS.CONFIRMED,
  [RENTAL_STATUS.COMPLETED]: RENTAL_STATUS.CONFIRMED,
  [RENTAL_STATUS.EXPIRED]: RENTAL_STATUS.PENDING,
};

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
        error: `Unknown status '${status}' (expected one of: ${STORED_RENTAL_STATUSES.join(', ')}, ${VIRTUAL_FILTERS.join(', ')}, or 'all')`,
      });
    }
    query = query.eq('status', status);
  } else if (isVirtual) {
    // overdue/completed are derived from confirmed bookings past their end,
    // expired from pending requests past their start — fetch the stored
    // status, then keep the ones whose derived status matches.
    query = query.eq('status', VIRTUAL_SOURCE[status]);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load bookings: ${error.message}`);
  }

  let rows = data.map(withManaged);
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
  res.json({ request: withManaged(data) });
});

// A booking that has NOT STARTED: stored as confirmed and its start still
// ahead. The one rule behind both Secretary actions, Edit and Cancel — an
// Overdue or Completed booking was used, so neither applies to it. Read from
// the STORED start, never from the new values an edit asks for.
//
// Since migration 027 it is ONE of three rules, because a pending request
// (the approval step) has not started either but is not a booking yet:
//   hasNotStarted   confirmed, start ahead: the Secretary's Cancel, Mark
//                   returned's "not yet", and the lists' not_started flag
//   isEditable      confirmed OR pending, start ahead: Edit (the Secretary
//                   may move a request before deciding it)
//   isCancellable   confirmed OR pending, start ahead: what cancelBooking()
//                   re-checks, so a resident can withdraw a pending request;
//                   the Secretary's Cancel refuses a pending one before it
//                   gets there (a request is declined, not cancelled)
const startAhead = (booking) => new Date(booking.start_datetime) > new Date();
const hasNotStarted = (booking) => booking.status === RENTAL_STATUS.CONFIRMED && startAhead(booking);
const EDITABLE_STATUSES = [RENTAL_STATUS.CONFIRMED, RENTAL_STATUS.PENDING];
const isEditable = (booking) => EDITABLE_STATUSES.includes(booking.status) && startAhead(booking);
const isCancellable = isEditable;

// The Secretary's reads (GET / and GET /:id) carry not_started, the same
// hasNotStarted() Edit and Cancel apply, so Rental bookings draws those two
// buttons from the server's answer rather than from the PC's clock. The
// server still decides again on every Edit and Cancel.
//
// A request still waiting for the Secretary (derived 'pending': stored
// pending, its start ahead) also carries fee_if_approved, what approving it
// would charge, from the approve route's own feeIfApproved() (batch R2b). Every
// other row leaves the key OUT, never null: it has nothing to approve
// (CLAUDE.md, a derived value with nothing to derive from is absent).
const withManaged = (row) => {
  if (!row) return row;
  const out = { ...withDerived(row), not_started: hasNotStarted(row) };
  if (out.derived_status === RENTAL_STATUS.PENDING) out.fee_if_approved = feeIfApproved(row);
  return out;
};

// "Oct 30, 2026, 8:00 AM to 10:00 AM" — a booking's slot in a notification,
// the same words the CONFIRMED message uses.
const scheduleText = (start, end) =>
  `${dateFmt.format(new Date(start))}, ${timeFmt.format(new Date(start))} to ${timeFmt.format(new Date(end))}`;

// ---------------------------------------------------------------------------
// Cancelling — ONE implementation behind both cancel routes, the Secretary's
// and the resident's own, so the steps and their failure handling cannot
// drift apart. Each route decides WHETHER its caller may cancel this booking;
// cancelBooking() re-checks the rule they share and does the cancel.
// ---------------------------------------------------------------------------

const REASON_MIN = 3;
const REASON_MAX = 300;

// A cancellation reason: trimmed, and counted as Postgres counts characters
// (code points, not UTF-16 units) so it can never fail the CHECK migration 023
// put on rental_requests.cancellation_reason (or, with the decline limits,
// the one migration 027 put on decline_reason). Returns { reason } — null when
// none was given and none is required — or { error }.
function parseReason(raw, { required, min = REASON_MIN, max = REASON_MAX }) {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { error: 'The reason must be text.' };
  }
  const reason = String(raw ?? '').trim();
  if (!reason) {
    return required ? { error: `A reason is required (${min} to ${max} characters).` } : { reason: null };
  }
  const length = [...reason].length;
  if (length < min || length > max) {
    return { error: `The reason must be ${min} to ${max} characters.` };
  }
  return { reason };
}

// What cancelBooking() needs to know about a booking. paymongo_session_id is
// read to expire an open checkout and is never sent back to the caller: the
// response is re-read with the route's own projection.
const CANCEL_FIELDS =
  'request_id, status, requested_by_user_id, processed_by_user_id, resident_id, outside_borrower_name, outside_borrower_contact, start_datetime, rental_items ( name ), resident_records ( contact_number ), charges ( charge_id, amount, status, paymongo_session_id )';

// What became of the charge, for the activity log.
const CHARGE_OUTCOME = {
  VOID: 'VOID', // was UNPAID; nothing is owed any more
  PAID_REFUND_DUE: 'PAID_REFUND_DUE', // stays PAID; the barangay refunds by hand
  NONE: 'NONE', // no charge, a PHP 0 one, or one already void
};

const asSentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// "HTTP 400: Checkout session is already paid", short enough for a log row.
const failureReason = (err) => `${err?.status ? `HTTP ${err.status}: ` : ''}${err?.message || 'unknown error'}`.slice(0, 120);

// Puts a just-cancelled booking back to the status it had (confirmed, or
// pending since migration 027), for when its charge could not be voided.
// Guarded on cancelled so it can only undo this cancel. True when the booking
// has its old status again.
async function revertCancel(booking) {
  try {
    const { data, error } = await supabase
      .from('rental_requests')
      .update({
        status: booking.status,
        processed_by_user_id: booking.processed_by_user_id ?? null,
        cancellation_reason: null,
      })
      .eq('request_id', booking.request_id)
      .eq('status', RENTAL_STATUS.CANCELLED)
      .select('request_id')
      .maybeSingle();
    return !error && !!data;
  } catch {
    return false;
  }
}

// Cancels a booking loaded with CANCEL_FIELDS. Returns { status, body } for
// the route to send. A booking stored confirmed, or since migration 027
// pending (a request has no charge, so step 2 finds nothing to void), and
// not started (isCancellable). supabase-js has no transactions, so the steps
// run in an order that can be undone:
//   1. the booking -> cancelled, guarded on the status it was read with (so
//      a request approved meanwhile is not cancelled behind the approval);
//   2. an UNPAID charge -> VOID. A PAID charge above PHP 0 STAYS PAID — it
//      records money actually received, and the system never rewrites money
//      or refunds; the borrower is told a refund is due. No charge, or a PHP 0
//      one: nothing;
//   3. if 2 failed, the booking goes back to confirmed — and if THAT fails it
//      is said loudly, never left silent;
//   4. an open GCash checkout on the voided charge is expired, best effort:
//      it never blocks or undoes the cancel, and its outcome is logged;
//   5. the borrower is notified (the Secretary's cancel only — a resident who
//      cancels their own booking has just done it);
//   6. one CANCEL row in the activity log. The reason is free text, so the
//      log says only whether one was given; the text stays on the booking and
//      in the notification.
async function cancelBooking(booking, { user, processedBy, reason, notifyBorrower, responseFields, message }) {
  const id = booking.request_id;
  if (!isCancellable(booking)) {
    return { status: 409, body: { error: 'Only a booking that has not started can be cancelled.' } };
  }
  const charge = chargeOf(booking);

  const { data: cancelled, error } = await supabase
    .from('rental_requests')
    .update({ status: RENTAL_STATUS.CANCELLED, processed_by_user_id: processedBy, cancellation_reason: reason })
    .eq('request_id', id)
    .eq('status', booking.status)
    .select('request_id')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to cancel booking: ${error.message}`);
  }
  if (!cancelled) {
    return { status: 409, body: { error: 'Booking status just changed — refresh and try again' } };
  }

  let chargeOutcome = CHARGE_OUTCOME.NONE;
  let refundDue = null;
  if (charge?.status === CHARGE_STATUS.UNPAID) {
    const { data: voided, error: voidError } = await supabase
      .from('charges')
      .update({ status: CHARGE_STATUS.VOID })
      .eq('charge_id', charge.charge_id)
      .eq('status', CHARGE_STATUS.UNPAID) // guard: not if just paid
      .select('charge_id')
      .maybeSingle();
    if (voidError || !voided) {
      if (!(await revertCancel(booking))) {
        console.error(
          `[rentals] booking ${id} was cancelled but its charge ${charge.charge_id} was not voided, and putting the booking back to confirmed failed too — fix both by hand`
        );
        return { status: 500, body: { error: 'Cancel was interrupted; tell the developer.' } };
      }
      // No row changed: the charge left UNPAID between the read and the
      // update — most likely just paid. Not a server fault.
      if (!voidError) {
        return {
          status: 409,
          body: { error: "This booking's charge just changed (it may have been paid). Refresh and try again; nothing was changed." },
        };
      }
      return { status: 500, body: { error: 'Could not cancel this booking; nothing was changed.' } };
    }
    chargeOutcome = CHARGE_OUTCOME.VOID;
  } else if (charge?.status === CHARGE_STATUS.PAID && Number(charge.amount) > 0) {
    chargeOutcome = CHARGE_OUTCOME.PAID_REFUND_DUE;
    refundDue = Number(charge.amount);
  }

  // A checkout page left open on a voided charge could still be paid. The
  // webhook would then find the charge VOID and log the money for the
  // Secretary instead of applying it, so this is a courtesy, not a guard.
  let sessionExpired = 'not_needed';
  let expireFailure = null;
  if (chargeOutcome === CHARGE_OUTCOME.VOID && charge.paymongo_session_id) {
    try {
      await paymongo.expireCheckoutSession(charge.paymongo_session_id);
      sessionExpired = true;
    } catch (err) {
      sessionExpired = false;
      expireFailure = failureReason(err);
      console.warn(`[rentals] booking ${id} cancelled, but its GCash checkout could not be expired: ${expireFailure}`);
    }
  }

  const { data: fresh } = await supabase
    .from('rental_requests')
    .select(responseFields)
    .eq('request_id', id)
    .maybeSingle();

  // To the BORROWER — not requested_by_user_id, which for a walk-in is the
  // Secretary who filed it.
  if (notifyBorrower) {
    const target = await borrowerNotifyTarget(booking);
    const refund = refundDue === null ? '' : ` You paid PHP ${refundDue.toFixed(2)}. Please contact the barangay about your refund.`;
    await notify({
      userId: target.userId,
      destination: target.destination,
      relatedType: RELATED_TYPE.RENTAL_REQUEST,
      relatedTo: id,
      message: `BrgyServe: your booking of ${booking.rental_items?.name || 'a rental item'} on ${dateFmt.format(new Date(booking.start_datetime))} was cancelled by the barangay. Reason: ${asSentence(reason)}${refund}`,
    });
  }

  await logActivity({
    userId: user.user_id,
    action: ACTIONS.CANCEL,
    table: 'rental_requests',
    recordId: id,
    before: { status: booking.status },
    after: {
      status: RENTAL_STATUS.CANCELLED,
      charge_outcome: chargeOutcome,
      ...(refundDue === null ? {} : { refund_due: refundDue }),
      session_expired: sessionExpired,
      ...(expireFailure ? { session_expire_failure: expireFailure } : {}),
      reason_given: reason !== null,
    },
  });

  return { status: 200, body: { message, request: withDerived(fresh) } };
}

// The columns an edit may change. The diff is taken on these only, so a
// guest's name and contact can never appear in it.
const EDITABLE_COLUMNS = ['start_datetime', 'end_datetime', 'purpose'];

// PUT /api/rental-requests/:id — Secretary changes the date, times or purpose
// of a booking that has not started, online or walk-in (a resident may ask at
// the hall to move it). The item, the quantity, the borrower and the status
// are fixed: to change the quantity or the item, cancel and book again. The
// fee is item fee x quantity once per booking, so a new date or time never
// changes what is owed, and the charge is never touched here. The new slot is
// checked and written in one call to update_rental_booking_time (migration
// 024), with THIS booking left out of the count — otherwise every edit would
// collide with its own current slot — so there is nothing to put back after a
// clash.
router.put('/:id', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  const parsed = parseBookingBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { start, end, startIso, endIso, purpose } = parsed;

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(
      'request_id, item_id, status, quantity_requested, start_datetime, end_datetime, purpose, resident_id, outside_borrower_name, outside_borrower_contact, resident_records ( contact_number )'
    )
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  // A confirmed booking or a pending request (migration 027), not started.
  if (!isEditable(booking)) {
    return res.status(409).json({ error: NOT_STARTED_EDIT });
  }
  // The Edit panel still sends the quantity it shows; the same number is
  // accepted, any other is refused rather than silently ignored.
  if (req.body?.quantity_requested !== undefined && parsed.quantity !== booking.quantity_requested) {
    return res.status(400).json({ error: 'The quantity cannot be changed. Cancel this booking and book again.' });
  }
  // The item's name, for the sentences and the notice. Loaded even if since
  // deactivated: deactivation only blocks NEW bookings, not managing existing
  // ones (the function does not refuse an inactive item on an edit either).
  const { data: item, error: itemError } = await supabase
    .from('rental_items')
    .select('item_id, name, type, booking_opens_at, booking_closes_at')
    .eq('item_id', booking.item_id)
    .maybeSingle();
  if (itemError || !item) {
    throw new Error(`Failed to load rental item: ${itemError?.message || 'not found'}`);
  }
  // The new time obeys the booking rules, as a new booking does (the item's
  // hours as they are today, even for an item since deactivated). The
  // booking's stored time is not checked: only what this edit asks for.
  const ruleRefusal = bookingRulesRefusal(parsed, item);
  if (ruleRefusal) {
    return res.status(400).json({ error: ruleRefusal });
  }

  // The check and the update in one locked call. A booking that started or
  // was cancelled since the read above comes back as BOOKING_STARTED.
  const result = await callBookingFunction('update_rental_booking_time', {
    p_request_id: id,
    p_start: startIso,
    p_end: endIso,
    p_purpose: purpose,
  });
  if (!result?.ok) {
    const refused = refusalOf(result ?? {}, item);
    return res.status(refused.status).json({ error: refused.error });
  }

  // `before` is the row as it was under the function's lock, so the diff and
  // the notice describe what this edit really changed.
  const diff = diffFields(pick(result.before, EDITABLE_COLUMNS), pick(result.request, EDITABLE_COLUMNS));
  const changed = Object.keys(diff.after).length > 0;

  // The borrower hears of every change the barangay makes to their booking —
  // a Save that changed nothing is not one. To the borrower, as on cancel.
  if (changed) {
    const target = await borrowerNotifyTarget(booking);
    await notify({
      userId: target.userId,
      destination: target.destination,
      relatedType: RELATED_TYPE.RENTAL_REQUEST,
      relatedTo: id,
      message: `BrgyServe: your booking of ${item.name} was changed by the barangay. It is now ${scheduleText(start, end)}.`,
    });
  }

  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.UPDATE,
    table: 'rental_requests',
    recordId: id,
    before: diff.before,
    after: diff.after,
  });

  // Re-read in the Secretary's projection, never the function's row as it is.
  const { data: updated } = await supabase
    .from('rental_requests')
    .select(MANAGE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  res.json({ message: 'Booking updated', request: withDerived(updated) });
});

// POST /api/rental-requests/:id/cancel — Secretary cancels a booking that has
// not started, and says why: the reason is stored on the booking and sent to
// the borrower, since this is done TO them. The work itself is
// cancelBooking(), shared with the resident's own cancel.
router.post('/:id/cancel', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const parsed = parseReason(req.body?.reason, { required: true });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(CANCEL_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  // A pending request is the Secretary's to decline, with a reason the
  // resident is sent, never to cancel: cancelBooking() would accept it,
  // because the resident's own cancel may withdraw one.
  if (booking.status === RENTAL_STATUS.PENDING) {
    return res.status(409).json({ error: 'A pending request is declined, not cancelled.' });
  }

  const result = await cancelBooking(booking, {
    user: req.user,
    processedBy: req.user.user_id,
    reason: parsed.reason,
    notifyBorrower: true,
    responseFields: MANAGE_FIELDS,
    message: 'Booking cancelled — the slot has been freed',
  });
  res.status(result.status).json(result.body);
});

// ---------------------------------------------------------------------------
// Approval (migration 027) — the Secretary approves or declines a PENDING
// request. Built in batch R2a and dormant until a later batch makes
// residents' bookings pending: today POST / stores every booking confirmed,
// so nothing reaches these routes from a screen. Staff and the Punong
// Barangay stay read-only.
// ---------------------------------------------------------------------------

// What both decisions read about the request: who it is for (to reach them),
// its slot and item (for the notice, the fee and the sentences).
const DECIDE_FIELDS =
  'request_id, status, item_id, quantity_requested, start_datetime, end_datetime, purpose_type, resident_id, outside_borrower_name, outside_borrower_contact, rental_items ( name, fee ), resident_records ( contact_number )';

// approve_rental_booking's refusals, as the Secretary is told them. The slot
// refusals are worded for the one deciding, not for a booker ("please pick a
// different time" is not hers to do); the rest go through refusalOf(), and
// anything it does not know is thrown, never answered with a made-up
// sentence.
function approvalRefusal(result, item) {
  const name = item?.name ?? 'item';
  switch (result.code) {
    case 'BOOKING_NOT_PENDING':
      return { status: 409, error: `Only a pending request can be approved — this booking is already '${result.status}'.` };
    case 'BOOKING_EXPIRED':
      return { status: 409, error: "This request's start time has passed, so it can no longer be approved." };
    case 'ITEM_INACTIVE':
      return { status: 409, error: `The ${name} has been deactivated, so this request cannot be approved.` };
    case 'RESIDENT_ARCHIVED':
      return { status: 409, error: "The resident's record has been archived, so this request cannot be approved." };
    // The funeral waiver's two rules (design C), checked by the function
    // under the item lock only when the Secretary waives.
    case 'FUNERAL_NOT_ALLOWED':
      return { status: 409, error: `The ${name} is not marked for funeral use, so its fee cannot be waived.` };
    case 'FUNERAL_RESIDENTS_ONLY':
      return { status: 409, error: 'A funeral fee can be waived only for a barangay resident, so this request cannot be waived.' };
    case 'FACILITY_TAKEN': {
      const first = Array.isArray(result.clashes) ? result.clashes[0] : null;
      if (first) {
        return {
          status: 409,
          error: `The ${name} is already booked from ${timeFmt.format(new Date(first.start))} to ${timeFmt.format(new Date(first.end))} on that date, so this request cannot be approved.`,
        };
      }
      break;
    }
    case 'NOT_ENOUGH_LEFT': {
      const { left, stuck, resting } = result;
      const parts = [
        `Only ${left} of ${result.quantity_available} ${name} ${isOrAre(left)} free for that time; this request asks for ${result.requested}, so it cannot be approved.`,
      ];
      if (stuck > 0) parts.push(`${stuck} ${isOrAre(stuck)} overdue and not yet returned.`);
      if (resting > 0) parts.push(`${resting} ${isOrAre(resting)} resting for 24 hours after an earlier booking.`);
      return { status: 409, error: parts.join(' ') };
    }
    default:
      return refusalOf(result, item);
  }
  throw new Error(`Unrecognised approval refusal: ${result.code}`);
}

// "2x Tent on Oct 30, 2026, 8:00 AM to 10:00 AM" — a request in a notice.
const requestText = (booking) =>
  `${booking.quantity_requested > 1 ? `${booking.quantity_requested}x ` : ''}${booking.rental_items?.name || 'a rental item'} on ${scheduleText(booking.start_datetime, booking.end_datetime)}`;

// POST /api/rental-requests/:id/approve — the Secretary approves a pending
// request. The amount is worked out HERE, by feeIfApproved() (fee x quantity,
// as POST / bills a booking today; batch R3's pricing rules will change that
// one function), the same function the list's fee_if_approved comes from, and
// approve_rental_booking (migration 027) does the rest in ONE transaction:
// under the item's row lock it re-checks the request (still pending, start
// still ahead, item active, resident not archived, slot still free), sets it
// confirmed and inserts its RENTAL charge, PAID when the amount is 0. A
// refused approval changed nothing. The charge goes on the BORROWER's
// account, as on POST /: never the Secretary's.
//
// The funeral waiver (design C, 29 Oct 2026): `waive_for_funeral: true` in
// the body is the Secretary deciding, from the purpose the resident wrote,
// that the fee is waived for a funeral. The amount is then 0 and the
// function refuses an item not marked funeral_eligible and a guest's
// request; it stores purpose_type 'funeral'. Absent means false; any other
// value is a 400. The notice never names the reason.
router.post('/:id/approve', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const waive = req.body?.waive_for_funeral;
  if (waive !== undefined && typeof waive !== 'boolean') {
    return res.status(400).json({ error: 'waive_for_funeral must be true or false' });
  }
  const waiveForFuneral = waive === true;

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(DECIDE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const isGuest = Boolean(booking.outside_borrower_name);
  // The list's fee_if_approved is this same function's answer.
  const amount = waiveForFuneral ? 0 : feeIfApproved(booking);
  const chargeUserId = isGuest ? null : await accountOfResident(booking.resident_id);

  const result = await callBookingFunction('approve_rental_booking', {
    p_request_id: id,
    p_processed_by: req.user.user_id,
    p_amount: amount,
    p_charge_user_id: chargeUserId,
    p_waive_for_funeral: waiveForFuneral,
  });
  if (!result?.ok) {
    const refused = approvalRefusal(result ?? {}, booking.rental_items);
    return res.status(refused.status).json({ error: refused.error });
  }
  const charged = Number(result.charge?.amount ?? amount);

  // Recorded, not sent; after the approval and its charge are committed, and
  // notify() never throws. "PHP", "-" and "x": inside the GSM alphabet.
  const target = await borrowerNotifyTarget(booking);
  await notify({
    userId: target.userId,
    destination: target.destination,
    relatedType: RELATED_TYPE.RENTAL_REQUEST,
    relatedTo: id,
    message: charged > 0
      ? `BrgyServe: your booking of ${requestText(booking)} has been APPROVED. Please pay PHP ${charged.toFixed(2)} under My rentals or at the barangay hall.`
      : `BrgyServe: your booking of ${requestText(booking)} has been APPROVED. No fee is required.`,
  });

  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.APPROVE,
    table: 'rental_requests',
    recordId: id,
    before: { status: RENTAL_STATUS.PENDING },
    // fee_waived is a code, never the purpose's words.
    after: {
      status: RENTAL_STATUS.CONFIRMED,
      charge_id: result.charge?.charge_id ?? null,
      ...(result.waived === true ? { fee_waived: PURPOSE_TYPE.FUNERAL } : {}),
    },
  });

  // Re-read in the Secretary's projection, never the function's row as it is.
  const { data: fresh } = await supabase
    .from('rental_requests')
    .select(MANAGE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  res.json({ message: 'Booking approved', request: withManaged(fresh) });
});

// POST /api/rental-requests/:id/decline — the Secretary declines a pending
// request, with a reason (3 to 300 characters, the CHECK migration 027 put on
// decline_reason), which the borrower is sent. A request has no charge and
// holds nothing, so there is nothing to void or free: one guarded UPDATE,
// WHERE status = 'pending' AND the start still ahead, as document requests
// decide (documentRequests.js), so a request approved, cancelled or expired
// meanwhile is not declined behind it. The reason's text is never logged,
// only that one was given.
router.post('/:id/decline', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const parsed = parseReason(req.body?.reason, { required: true, min: DECLINE_REASON_MIN, max: DECLINE_REASON_MAX });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { data: booking, error: loadError } = await supabase
    .from('rental_requests')
    .select(DECIDE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load booking: ${loadError.message}`);
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (booking.status !== RENTAL_STATUS.PENDING) {
    return res.status(409).json({ error: `Only a pending request can be declined — this booking is already '${booking.status}'.` });
  }
  if (!startAhead(booking)) {
    return res.status(409).json({ error: "This request's start time has passed, so it has expired and cannot be declined." });
  }

  const { data: declined, error } = await supabase
    .from('rental_requests')
    .update({
      status: RENTAL_STATUS.DECLINED,
      decline_reason: parsed.reason,
      processed_by_user_id: req.user.user_id,
    })
    .eq('request_id', id)
    .eq('status', RENTAL_STATUS.PENDING)
    .gt('start_datetime', new Date().toISOString())
    .select('request_id')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to decline booking: ${error.message}`);
  }
  if (!declined) {
    return res.status(409).json({ error: 'Booking status just changed — refresh and try again' });
  }

  const target = await borrowerNotifyTarget(booking);
  await notify({
    userId: target.userId,
    destination: target.destination,
    relatedType: RELATED_TYPE.RENTAL_REQUEST,
    relatedTo: id,
    message: `BrgyServe: your booking request for ${booking.rental_items?.name || 'a rental item'} on ${dateFmt.format(new Date(booking.start_datetime))} was declined. Reason: ${asSentence(parsed.reason)}`,
  });

  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.DECLINE,
    table: 'rental_requests',
    recordId: id,
    before: { status: RENTAL_STATUS.PENDING },
    after: { status: RENTAL_STATUS.DECLINED, reason_given: true },
  });

  const { data: fresh } = await supabase
    .from('rental_requests')
    .select(MANAGE_FIELDS)
    .eq('request_id', id)
    .maybeSingle();
  res.json({ message: 'Request declined', request: withManaged(fresh) });
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
      'request_id, status, start_datetime, resident_id, outside_borrower_name, outside_borrower_contact, rental_items ( name, type ), resident_records ( contact_number )'
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
  // Nothing has been taken out yet, so nothing can come back (step C3): the
  // same hasNotStarted() rule Edit and Cancel use, from the stored start.
  if (hasNotStarted(booking)) {
    return res.status(409).json({ error: 'This booking has not started yet.' });
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

  // The outcome only; the return note is free text and stays on the booking.
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.RETURN,
    table: 'rental_requests',
    recordId: id,
    before: { status: RENTAL_STATUS.CONFIRMED },
    after: { status: outcome },
  });

  res.json({ message: 'Return recorded', request: withDerived(updated) });
});

module.exports = router;
