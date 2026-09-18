const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  NOTIFICATION_STATUSES,
  RELATED_TYPE,
  RELATED_TYPES,
  NOTIFICATION_STATUS,
  NOTIFICATION_TYPE,
} = require('../constants/notifications');
const { searchWords, parsePaging, pageResponse } = require('../utils/listQuery');
const { currentMode } = require('../services/notifications');

const router = express.Router();

// ===========================================================================
// NOTIFICATIONS — read-only log of every message the system generated.
//
// Secretary-only: it exposes residents' contact numbers and the content of
// every notice sent to them, which is not something Staff, the Treasurer, the
// Punong Barangay or residents have any reason to browse.
//
// READ-ONLY BY DESIGN. There is no POST here and there must not be: rows are
// written only by services/notifications.js as a side effect of a real
// action, so a notification can never exist without something having caused
// it. Nothing here re-sends, edits or deletes.
// ===========================================================================

router.use(authenticate, requireRole('secretary'));

const FIELDS = `
  notification_id, type, destination, subject, message, status, provider_response,
  related_type, related_to, created_at, sent_at, user_id, household_id,
  users ( username, profiles ( first_name, middle_name, last_name, suffix ) ),
  household_records ( household_id, address )
`;

const embedded = (v) => (Array.isArray(v) ? v[0] : v) || null;

const personName = (p) => {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
  return p.suffix ? `${name}, ${p.suffix}` : name || null;
};

// A row addressed to someone with NO ACCOUNT — user_id null — gets no name
// from the users embed above, so the screen showed only the number. Since
// migration 022 that is every notice to a GUEST from another barangay (a
// guest cannot have an account) and every notice to a walk-in RESIDENT who
// never registered online. The name exists on the record the row points at:
// rental_requests.outside_borrower_name for a guest, the linked resident
// record for a resident. related_to is a polymorphic pointer PostgREST cannot
// embed, so it is resolved here — at most one query per pointer type over the
// page's account-less rows — and merged below in payerName()'s order
// (PaymentsPage): the record's resident first, the guest's typed name second,
// the account's profile last. Rows with an account never reach the lookup,
// so nothing they showed before changes.
//
// TWO pointer types are resolved, and they are one hop apart:
//   RENTAL_REQUEST -> related_to IS a rental_requests.request_id.
//   CHARGE         -> related_to is a charges.charge_id, and the charge stems
//                     from EITHER a document request OR a rental request
//                     (charges.document_request_id / rental_request_id are
//                     mutually exclusive by design), so the lookup embeds
//                     both and keeps whichever side is present. A FINE charge
//                     has neither — it is owed by a household — and resolves
//                     to nothing here, exactly as before.
// The two lookups are kept in SEPARATE maps keyed by the row's own type:
// related_to is a bare integer, and a charge id can equal a booking id.
//
// DOCUMENT_REQUEST rows with no account — a walk-in resident's approval or
// rejection notice — have the same gap and are NOT resolved here.
const BORROWER_TYPES = [RELATED_TYPE.RENTAL_REQUEST, RELATED_TYPE.CHARGE];
const needsBorrower = (n) =>
  n.user_id === null && n.related_to !== null && BORROWER_TYPES.includes(n.related_type);

const idsOf = (rows, type) =>
  [...new Set(rows.filter((n) => needsBorrower(n) && n.related_type === type).map((n) => n.related_to))];

const RECORD_NAME = 'first_name, middle_name, last_name, suffix';

// { bookings: Map<request_id, source>, charges: Map<charge_id, source> }.
// A source is whatever names the person — a rental_requests row
// ({ outside_borrower_name, resident_records }) or, for a document charge,
// its document_requests row ({ resident_records }) — so both shapes feed the
// same fallback chain below.
async function borrowersFor(rows) {
  const lookups = { bookings: new Map(), charges: new Map() };

  const bookingIds = idsOf(rows, RELATED_TYPE.RENTAL_REQUEST);
  if (bookingIds.length) {
    const { data, error } = await supabase
      .from('rental_requests')
      .select(`request_id, outside_borrower_name, resident_records ( ${RECORD_NAME} )`)
      .in('request_id', bookingIds);
    if (error) throw new Error(`Failed to load booking borrowers: ${error.message}`);
    for (const b of data || []) lookups.bookings.set(b.request_id, b);
  }

  const chargeIds = idsOf(rows, RELATED_TYPE.CHARGE);
  if (chargeIds.length) {
    const { data, error } = await supabase
      .from('charges')
      .select(`charge_id,
        document_requests ( resident_records ( ${RECORD_NAME} ) ),
        rental_requests ( outside_borrower_name, resident_records ( ${RECORD_NAME} ) )`)
      .in('charge_id', chargeIds);
    if (error) throw new Error(`Failed to load charge payers: ${error.message}`);
    for (const c of data || []) {
      const source = embedded(c.rental_requests) || embedded(c.document_requests);
      if (source) lookups.charges.set(c.charge_id, source);
    }
  }

  return lookups;
}

// The record that names an account-less recipient, or null. Picks the map by
// the row's own type, so a CHARGE row can only ever hit the charge lookup and
// a RENTAL_REQUEST row only the booking lookup; every other row — including
// every row with an account — gets null and resolves exactly as before.
function borrowerOf(n, lookups) {
  if (!needsBorrower(n)) return null;
  const map = n.related_type === RELATED_TYPE.CHARGE ? lookups.charges : lookups.bookings;
  return map.get(n.related_to) || null;
}

// GET /api/notifications?status=&type=&search=&page=&per_page=
router.get('/', async (req, res) => {
  const { page, perPage, from, to } = parsePaging(req.query);

  let query = supabase
    .from('notifications')
    .select(FIELDS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .order('notification_id', { ascending: false });

  const status = req.query.status ? String(req.query.status).toUpperCase() : '';
  if (status && status !== 'ALL') {
    if (!NOTIFICATION_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Unknown status '${status}' (expected ${NOTIFICATION_STATUSES.join(', ')}, or all)`,
      });
    }
    query = query.eq('status', status);
  }

  const relatedType = req.query.related_type ? String(req.query.related_type).toUpperCase() : '';
  if (relatedType && relatedType !== 'ALL') {
    if (!RELATED_TYPES.includes(relatedType)) {
      return res.status(400).json({ error: `Unknown related_type '${relatedType}'` });
    }
    query = query.eq('related_type', relatedType);
  }

  // Same multi-word AND-ed search the other lists use.
  for (const word of searchWords(req.query.search)) {
    query = query.or(`message.ilike.%${word}%,destination.ilike.%${word}%`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) {
    // An out-of-range page is an empty page, not an error (same as every
    // other paginated list in the app).
    if (error.code === 'PGRST103') {
      return res.json({
        ...pageResponse('notifications', [], count || 0, page, perPage),
        summary: await summarise(),
        ...deliveryModes(),
      });
    }
    throw new Error(`Failed to load notifications: ${error.message}`);
  }

  const lookups = await borrowersFor(data || []);
  const rows = (data || []).map((n) => {
    const user = embedded(n.users);
    const household = embedded(n.household_records);
    const borrower = borrowerOf(n, lookups);
    return {
      notification_id: n.notification_id,
      type: n.type,
      destination: n.destination || null,
      // Email only; SMS has no subject and stores null, which is what every
      // row written before email existed holds.
      subject: n.subject || null,
      message: n.message,
      status: n.status,
      provider_response: n.provider_response,
      related_type: n.related_type,
      related_to: n.related_to,
      created_at: n.created_at,
      sent_at: n.sent_at,
      // Who it was addressed to, in the form the screen shows it. The
      // related record's person first — resident record, then a guest's
      // typed name — and the account's profile after; `borrower` is null for
      // any row with an account, so those resolve exactly as they did before.
      recipient_name:
        personName(embedded(borrower?.resident_records)) ||
        borrower?.outside_borrower_name ||
        personName(embedded(user?.profiles)) ||
        null,
      recipient_username: user?.username || null,
      household_id: household?.household_id ?? n.household_id ?? null,
      household_address: household?.address || null,
    };
  });

  res.json({
    ...pageResponse('notifications', rows, count || 0, page, perPage),
    summary: await summarise(),
    // The screen states this plainly; it is not decoration.
    ...deliveryModes(),
  });
});

// BOTH modes, because they are independent and the screen's banner was
// asserting something false without the second one.
//
// `mode` is the SMS mode and keeps that name for compatibility — it is what
// the page has always read. `email_mode` is new. Until it existed the banner
// could only see SMS_MODE, so after the forgot-password work it went on
// saying "no provider is connected" directly above a row marked SENT by
// Resend. A screen cannot tell two independent settings apart from one value.
const deliveryModes = () => ({
  mode: currentMode(NOTIFICATION_TYPE.SMS),
  email_mode: currentMode(NOTIFICATION_TYPE.EMAIL),
});

// Counts per status over the WHOLE log, not the current page — the useful
// number is how many could not be delivered at all, which paging would hide.
async function summarise() {
  const summary = { total: 0 };
  const { count: total } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true });
  summary.total = total || 0;
  for (const status of NOTIFICATION_STATUSES) {
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);
    summary[status] = count || 0;
  }
  // Residents the barangay has no way to reach — the reason to collect
  // contact numbers, and the number worth acting on.
  summary.unreachable = summary[NOTIFICATION_STATUS.SKIPPED] || 0;
  return summary;
}

module.exports = router;
