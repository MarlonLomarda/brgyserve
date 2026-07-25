const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { EVENT_TYPE, EVENT_TYPES, EVENT_STATUS, EVENT_VIEW, EVENT_VIEWS } = require('../constants/events');

const router = express.Router();

// Stage 1 is management only: the Secretary AND Barangay Staff both maintain
// events and announcements (there is no Punong Barangay approval gate — per
// the activity diagram the PB and residents only VIEW, which is stage 2).
router.use(authenticate, requireRole('secretary', 'staff'));

const EVENT_FIELDS =
  'event_id, type, title, description, start_datetime, end_datetime, location, date_created, is_archived';

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;

// Accepts the datetime-local format the form sends ("YYYY-MM-DDTHH:MM",
// Philippine wall-clock, composed with an explicit +08:00 like rentals) and
// also a full ISO string. Returns null for blank, or undefined if unparseable.
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
function parseDateTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const d = LOCAL_DT_RE.test(raw) ? new Date(`${raw}:00+08:00`) : new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const sanitize = (term) => term.replace(/[,()%_*\\]/g, ' ').trim();

// Derived display status — never stored. Announcements are always 'posted';
// an activity is upcoming / ongoing / past by the clock.
function deriveStatus(row) {
  if (row.type === EVENT_TYPE.ANNOUNCEMENT) return EVENT_STATUS.POSTED;
  const now = new Date();
  if (row.end_datetime && new Date(row.end_datetime) < now) return EVENT_STATUS.PAST;
  if (row.start_datetime && new Date(row.start_datetime) <= now) return EVENT_STATUS.ONGOING;
  return EVENT_STATUS.UPCOMING;
}
const withStatus = (row) => (row ? { ...row, status: deriveStatus(row) } : row);

// Per-type validation: an activity is a real timed event and must carry its
// schedule; an announcement is a notice and may carry none.
function validateBody(body) {
  const type = String(body?.type ?? '').trim().toLowerCase();
  if (!EVENT_TYPES.includes(type)) {
    return { error: `type must be one of: ${EVENT_TYPES.join(', ')}` };
  }

  const title = String(body?.title ?? '').trim();
  if (!title) return { error: 'title is required' };
  if (title.length > 255) return { error: 'title must be 255 characters or fewer' };

  const description = String(body?.description ?? '').trim() || null;

  const location = String(body?.location ?? '').trim();
  if (location.length > 255) return { error: 'location must be 255 characters or fewer' };

  const start = parseDateTime(body?.start_datetime);
  const end = parseDateTime(body?.end_datetime);
  if (start === undefined) return { error: 'start_datetime is not a valid date and time' };
  if (end === undefined) return { error: 'end_datetime is not a valid date and time' };

  if (type === EVENT_TYPE.ACTIVITY) {
    if (!start || !end) {
      return { error: 'an activity needs both a start and an end date/time' };
    }
  }
  // Whenever both ends are present (either type), the window must be sane.
  if (start && end && new Date(end) <= new Date(start)) {
    return { error: 'end_datetime must be after start_datetime' };
  }

  return {
    value: {
      type,
      title,
      description,
      location: location || null,
      start_datetime: start,
      end_datetime: end,
    },
  };
}

// GET /api/events — paginated list.
//   ?type=announcement|activity|all
//   ?view=active (default) | past | archived | all
//     active   = not archived AND (announcement OR activity not yet finished)
//     past     = not archived AND activity whose end_datetime has passed
//     archived = is_archived true (manual archive only)
//   ?search= across title, description, location
// Ordering: 'active' puts the soonest activity first (start_datetime asc) with
// announcements — which have no start — after them, newest first; 'past' is
// most-recently-finished first; 'archived'/'all' are newest-created first.
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query.per_page) || DEFAULT_PER_PAGE));
  const from = (page - 1) * perPage;

  const view = String(req.query.view ?? EVENT_VIEW.ACTIVE).toLowerCase();
  if (!EVENT_VIEWS.includes(view)) {
    return res.status(400).json({ error: `view must be one of: ${EVENT_VIEWS.join(', ')}` });
  }
  const type = req.query.type;
  if (type && type !== 'all' && !EVENT_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${EVENT_TYPES.join(', ')}, or 'all'` });
  }

  const nowIso = new Date().toISOString();
  let query = supabase.from('events').select(EVENT_FIELDS, { count: 'exact' });

  if (view === EVENT_VIEW.ACTIVE) {
    // Finished activities drop out here automatically — no stored flag, no job.
    query = query
      .eq('is_archived', false)
      .or(`type.eq.${EVENT_TYPE.ANNOUNCEMENT},end_datetime.gte.${nowIso}`)
      .order('start_datetime', { ascending: true, nullsFirst: false })
      .order('date_created', { ascending: false });
  } else if (view === EVENT_VIEW.PAST) {
    query = query
      .eq('is_archived', false)
      .eq('type', EVENT_TYPE.ACTIVITY)
      .lt('end_datetime', nowIso)
      .order('end_datetime', { ascending: false });
  } else if (view === EVENT_VIEW.ARCHIVED) {
    query = query.eq('is_archived', true).order('date_created', { ascending: false });
  } else {
    query = query.order('date_created', { ascending: false });
  }

  if (type && type !== 'all') query = query.eq('type', type);

  const term = sanitize(String(req.query.search ?? ''));
  if (term) {
    query = query.or(`title.ilike.*${term}*,description.ilike.*${term}*,location.ilike.*${term}*`);
  }

  const { data, count, error } = await query.range(from, from + perPage - 1);
  if (error) {
    if (error.code === 'PGRST103') {
      return res.json({ events: [], total: 0, page, per_page: perPage, total_pages: 0 });
    }
    throw new Error(`Failed to load events: ${error.message}`);
  }

  res.json({
    events: data.map(withStatus),
    total: count,
    page,
    per_page: perPage,
    total_pages: Math.ceil((count || 0) / perPage),
  });
});

// GET /api/events/:id — full detail (archived records stay readable).
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id' });

  const { data, error } = await supabase.from('events').select(EVENT_FIELDS).eq('event_id', id).maybeSingle();
  if (error) throw new Error(`Failed to load event: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Event not found' });

  res.json({ event: withStatus(data) });
});

// POST /api/events — create (date_created server-set, is_archived false).
router.post('/', async (req, res) => {
  const { error: validationError, value } = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await supabase
    .from('events')
    .insert({ ...value, date_created: new Date().toISOString(), is_archived: false })
    .select(EVENT_FIELDS)
    .single();
  if (error) throw new Error(`Failed to create event: ${error.message}`);

  res.status(201).json({
    message: value.type === EVENT_TYPE.ANNOUNCEMENT ? 'Announcement posted' : 'Activity created',
    event: withStatus(data),
  });
});

// PUT /api/events/:id — edit (same per-type validation; the type may change).
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id' });

  const { error: validationError, value } = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await supabase
    .from('events')
    .update(value)
    .eq('event_id', id)
    .select(EVENT_FIELDS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update event: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Event not found' });

  res.json({ message: 'Event updated', event: withStatus(data) });
});

// PATCH /api/events/:id/archive | /unarchive — the MANUAL soft delete, kept
// deliberately separate from the automatic hiding of finished activities.
// Records are never hard-deleted and stay readable in the detail route.
async function setArchived(req, res, isArchived) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id' });

  const { data: existing, error: loadError } = await supabase
    .from('events')
    .select('event_id, is_archived')
    .eq('event_id', id)
    .maybeSingle();
  if (loadError) throw new Error(`Failed to load event: ${loadError.message}`);
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  if (existing.is_archived === isArchived) {
    return res.status(409).json({ error: `Event is already ${isArchived ? 'archived' : 'active'}` });
  }

  const { data, error } = await supabase
    .from('events')
    .update({ is_archived: isArchived })
    .eq('event_id', id)
    .select(EVENT_FIELDS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update event: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Event not found' });

  res.json({ message: isArchived ? 'Event archived' : 'Event restored', event: withStatus(data) });
}

router.patch('/:id/archive', (req, res) => setArchived(req, res, true));
router.patch('/:id/unarchive', (req, res) => setArchived(req, res, false));

module.exports = router;
