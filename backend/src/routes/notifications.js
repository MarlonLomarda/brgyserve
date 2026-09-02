const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  NOTIFICATION_STATUSES,
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

  const rows = (data || []).map((n) => {
    const user = embedded(n.users);
    const household = embedded(n.household_records);
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
      // Who it was addressed to, in the form the screen shows it.
      recipient_name: personName(embedded(user?.profiles)) || null,
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
