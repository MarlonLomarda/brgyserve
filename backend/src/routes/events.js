const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { EVENT_TYPE, EVENT_TYPES, EVENT_STATUS, EVENT_VIEW, EVENT_VIEWS } = require('../constants/events');
const { HOUSEHOLD_ROLE } = require('../constants/households');
const { CHARGE_STATUS, CHARGE_TYPE } = require('../constants/charges');
const { logSmsNotification } = require('../services/smsNotification');
const { searchWords, parsePaging, pageResponse } = require('../utils/listQuery');

const router = express.Router();

// Everyone here is authenticated; the role split comes below. Stage 2's
// read-only viewer routes (/public, residents + Punong Barangay) are declared
// FIRST, then a role gate makes everything after it Secretary/Staff-only
// management — the same layering document types and rental items use.
router.use(authenticate);

// attendance_required / fine_amount arrive with migration 016 — these selects
// fail until it is applied.
const EVENT_FIELDS =
  'event_id, type, title, description, start_datetime, end_datetime, location, date_created, is_archived, attendance_required, fine_amount';

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

  // Attendance is opt-in and applies to activities only: an announcement has
  // no schedule, so "who attended" is meaningless for one. Migration 016 has a
  // CHECK backstop for the same rule.
  const attendanceRequired = body?.attendance_required === true;
  if (attendanceRequired && type !== EVENT_TYPE.ACTIVITY) {
    return { error: 'only an activity can require attendance — an announcement has no schedule to attend' };
  }

  // NULL fine_amount is meaningful: attendance is tracked but nothing is
  // chargeable for missing it. Zero is not a fine, so it is rejected rather
  // than silently stored as "free".
  let fineAmount = null;
  const rawFine = body?.fine_amount;
  if (rawFine !== null && rawFine !== undefined && String(rawFine).trim() !== '') {
    const amount = Number(rawFine);
    if (!Number.isFinite(amount)) return { error: 'fine_amount must be a number' };
    if (amount <= 0) return { error: 'fine_amount must be greater than zero, or left blank for no fine' };
    if (Math.round(amount * 100) !== amount * 100) {
      return { error: 'fine_amount must have at most 2 decimal places' };
    }
    if (amount > 99999999.99) return { error: 'fine_amount is too large' };
    fineAmount = amount;
  }

  return {
    value: {
      type,
      title,
      description,
      location: location || null,
      start_datetime: start,
      end_datetime: end,
      attendance_required: attendanceRequired,
      fine_amount: fineAmount,
    },
  };
}

// Paginated list, shared by the management list and the read-only viewer list
// so both always return the same shape and the same derived statuses.
//   ?type=announcement|activity|all
//   ?view=active (default) | past | archived | all
//     active   = not archived AND (announcement OR activity not yet finished)
//     past     = not archived AND activity whose end_datetime has passed
//     archived = is_archived true (manual archive only) — management only
//   ?search= across title, description, location
// Ordering: 'active' puts the soonest activity first (start_datetime asc) with
// announcements — which have no start — after them, newest first; 'past' is
// most-recently-finished first; 'archived'/'all' are newest-created first.
// `publicOnly` (the viewer) restricts the allowed views to active/past and
// forces archived records out of reach entirely.
async function listEvents(req, res, { publicOnly }) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query.per_page) || DEFAULT_PER_PAGE));
  const from = (page - 1) * perPage;

  const allowedViews = publicOnly ? [EVENT_VIEW.ACTIVE, EVENT_VIEW.PAST] : EVENT_VIEWS;
  const view = String(req.query.view ?? EVENT_VIEW.ACTIVE).toLowerCase();
  if (!allowedViews.includes(view)) {
    return res.status(400).json({ error: `view must be one of: ${allowedViews.join(', ')}` });
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

  // Safety net: viewers never see archived records, whatever the view. The
  // active/past branches already filter them, so this only matters if a new
  // view is ever added — the invariant then still holds.
  if (publicOnly) query = query.eq('is_archived', false);

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
}

// Shared detail loader. For viewers (`publicOnly`) an archived record is
// simply not found — archived events must be invisible, not merely hidden
// from the list.
async function getEvent(req, res, { publicOnly }) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id' });

  let query = supabase.from('events').select(EVENT_FIELDS).eq('event_id', id);
  if (publicOnly) query = query.eq('is_archived', false);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to load event: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Event not found' });

  res.json({ event: withStatus(data) });
}

// ---------------------------------------------------------------------------
// Stage 2 — READ-ONLY viewer (residents + Punong Barangay). Declared before
// the management gate below, so these are the only event routes those roles
// can reach: there is no create/edit/archive path for them at all. Archived
// records are unreachable here by construction.
// ---------------------------------------------------------------------------
const VIEWER_ROLES = ['resident', 'punong_barangay'];

// GET /api/events/public — same shape as the management list; views are
// limited to 'active' (current + upcoming activities and announcements) and
// 'past' (finished activities).
router.get('/public', requireRole(...VIEWER_ROLES), (req, res) => listEvents(req, res, { publicOnly: true }));

// GET /api/events/public/:id — 404 for archived or missing.
router.get('/public/:id', requireRole(...VIEWER_ROLES), (req, res) => getEvent(req, res, { publicOnly: true }));

// ---------------------------------------------------------------------------
// Everything below is Secretary/Staff management (stage 1).
// ---------------------------------------------------------------------------
router.use(requireRole('secretary', 'staff'));

// GET /api/events — management list (all views incl. archived).
router.get('/', (req, res) => listEvents(req, res, { publicOnly: false }));

// GET /api/events/:id — full detail (archived records stay readable).
router.get('/:id', (req, res) => getEvent(req, res, { publicOnly: false }));

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

  // Turning attendance off KEEPS whatever was already recorded — the roster is
  // evidence, and stage 3b may still need it. Count it so the caller can warn
  // rather than discovering it later.
  let attendanceKept = 0;
  if (!value.attendance_required) {
    const { count, error: countErr } = await supabase
      .from('event_attendees')
      .select('event_attendee_id', { count: 'exact', head: true })
      .eq('event_id', id);
    if (countErr) throw new Error(`Failed to count attendance: ${countErr.message}`);
    attendanceKept = count || 0;
  }

  const { data, error } = await supabase
    .from('events')
    .update(value)
    .eq('event_id', id)
    .select(EVENT_FIELDS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update event: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Event not found' });

  res.json({
    message:
      attendanceKept > 0
        ? `Event updated. Attendance is no longer required, but ${attendanceKept} recorded household${attendanceKept === 1 ? '' : 's'} ${attendanceKept === 1 ? 'was' : 'were'} kept.`
        : 'Event updated',
    event: withStatus(data),
    attendance_kept: attendanceKept,
  });
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

// ===========================================================================
// STAGE 3a — HOUSEHOLD ATTENDANCE
//
// Attendance is recorded per HOUSEHOLD, never per resident: at an assembly one
// household signs the sheet once. There is deliberately no "which member
// represented them" and no present/absent status column — ABSENCE IS DERIVED
// as "no row for this household at this event". That derivation is only
// trustworthy because UNIQUE (event_id, household_id) from migration 015
// guarantees at most one row per pair; an explicit absent row would be a
// second representation of the same fact, free to disagree with the first.
//
// Both Secretary and Staff record attendance, matching the rest of the Events
// module. Residents and the Punong Barangay never reach these routes: they are
// declared after the management gate above.
// ===========================================================================

// The event must be an activity that actually takes attendance. Returns the
// event, or sends the 400 and returns null.
async function requireAttendanceEvent(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid event id' });
    return null;
  }
  const { data: event, error } = await supabase
    .from('events')
    .select('event_id, title, type, attendance_required, fine_amount, start_datetime, end_datetime, is_archived')
    .eq('event_id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load event: ${error.message}`);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  if (event.type !== EVENT_TYPE.ACTIVITY) {
    res.status(400).json({ error: 'Attendance applies to activities only, not announcements' });
    return null;
  }
  if (!event.attendance_required) {
    res.status(400).json({
      error: 'This activity does not take attendance. Enable “attendance required” on the event first.',
    });
    return null;
  }
  return event;
}

const residentSurname = (r) => (r?.last_name || '').toLowerCase();
const fullName = (r) => {
  if (!r) return null;
  const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return r.suffix ? `${name}, ${r.suffix}` : name;
};

// ---------------------------------------------------------------------------
// GET /api/events/:id/attendance — the roster.
//
// Every ACTIVE household, each either recorded or not. Sorted by the head's
// surname, then household number; households with NO head sort LAST rather
// than being hidden — a headless household is a data problem the Secretary
// should see.
//
// Sorting and paging happen in Node because the head's name lives behind two
// joins (household_members -> resident_records) and cannot be ordered on in
// the query. The summary counts cover ALL active households, not just the
// current page or search — that ratio is what gets worked down at an assembly.
// ---------------------------------------------------------------------------
router.get('/:id/attendance', async (req, res) => {
  const event = await requireAttendanceEvent(req, res);
  if (!event) return undefined;

  const { page, perPage, from } = parsePaging(req.query);

  const { data: households, error: hErr } = await supabase
    .from('household_records')
    .select('household_id, address')
    .eq('is_active', true);
  if (hErr) throw new Error(`Failed to load households: ${hErr.message}`);

  const ids = households.map((h) => h.household_id);
  let membersByHousehold = {};
  if (ids.length) {
    const { data: members, error: mErr } = await supabase
      .from('household_members')
      .select('household_id, role, resident_records ( first_name, middle_name, last_name, suffix )')
      .is('date_ended', null)
      .in('household_id', ids);
    if (mErr) throw new Error(`Failed to load household members: ${mErr.message}`);
    for (const m of members) (membersByHousehold[m.household_id] ||= []).push(m);
  }

  const { data: recorded, error: aErr } = await supabase
    .from('event_attendees')
    .select('household_id, recorded_at, recorded_by:users ( username )')
    .eq('event_id', event.event_id);
  if (aErr) throw new Error(`Failed to load attendance: ${aErr.message}`);
  const recordedBy = new Map(
    (recorded || []).map((r) => [
      r.household_id,
      {
        recorded_at: r.recorded_at,
        recorded_by_username: (Array.isArray(r.recorded_by) ? r.recorded_by[0] : r.recorded_by)?.username ?? null,
      },
    ])
  );

  const rows = households.map((h) => {
    const members = membersByHousehold[h.household_id] || [];
    const head = members.find((m) => m.role === HOUSEHOLD_ROLE.HEAD) || null;
    const headResident = head
      ? Array.isArray(head.resident_records)
        ? head.resident_records[0]
        : head.resident_records
      : null;
    return {
      household_id: h.household_id,
      address: h.address,
      head_name: fullName(headResident),
      member_count: members.length,
      attendance: recordedBy.get(h.household_id) || null,
      _sortKey: headResident ? residentSurname(headResident) : '￿', // no head -> last
    };
  });

  // Summary is over every active household, independent of search and paging.
  const summary = {
    total_households: rows.length,
    recorded: rows.filter((r) => r.attendance).length,
    missing: rows.filter((r) => !r.attendance).length,
  };

  let filtered = rows;
  for (const word of searchWords(req.query.search)) {
    const needle = word.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        (r.head_name || '').toLowerCase().includes(needle) ||
        (r.address || '').toLowerCase().includes(needle) ||
        String(r.household_id) === needle
    );
  }

  filtered.sort(
    (a, b) => a._sortKey.localeCompare(b._sortKey) || a.household_id - b.household_id
  );

  const pageRows = filtered.slice(from, from + perPage).map(({ _sortKey, ...row }) => row);

  res.json({
    ...pageResponse('households', pageRows, filtered.length, page, perPage),
    summary,
    event: {
      event_id: event.event_id,
      title: event.title,
      start_datetime: event.start_datetime,
      end_datetime: event.end_datetime,
      fine_amount: event.fine_amount,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/attendance — record one household present.
//
// Recording twice is HARMLESS by design: the unique constraint turns the
// second attempt into a no-op that reports when it was first recorded and by
// whom. Stage 3d adds camera scanning to this screen, where a household's QR
// will be scanned repeatedly — that must never look like an error.
// ---------------------------------------------------------------------------
router.post('/:id/attendance', async (req, res) => {
  const event = await requireAttendanceEvent(req, res);
  if (!event) return undefined;

  const householdId = Number(req.body?.household_id);
  if (!Number.isInteger(householdId)) {
    return res.status(400).json({ error: 'A valid household_id is required' });
  }

  const { data: household, error: hErr } = await supabase
    .from('household_records')
    .select('household_id, address, is_active')
    .eq('household_id', householdId)
    .maybeSingle();
  if (hErr) throw new Error(`Failed to load household: ${hErr.message}`);
  if (!household) return res.status(404).json({ error: 'Household not found' });
  if (!household.is_active) {
    return res.status(409).json({
      error: `Household #${householdId} is inactive and cannot be marked present.`,
    });
  }

  const { data: inserted, error } = await supabase
    .from('event_attendees')
    .insert({
      event_id: event.event_id,
      household_id: householdId,
      recorded_by_user_id: req.user.user_id,
    })
    .select('event_attendee_id, household_id, recorded_at, recorded_by:users ( username )')
    .single();

  if (error) {
    // 23505 = the UNIQUE (event_id, household_id) guard. Already present is
    // the desired end state, so report it as success, not failure.
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('event_attendees')
        .select('recorded_at, recorded_by:users ( username )')
        .eq('event_id', event.event_id)
        .eq('household_id', householdId)
        .maybeSingle();
      const by = (Array.isArray(existing?.recorded_by) ? existing.recorded_by[0] : existing?.recorded_by)?.username;
      return res.json({
        message:
          `Household #${householdId} was already recorded present` +
          (existing?.recorded_at ? ` at ${new Date(existing.recorded_at).toLocaleString('en-PH')}` : '') +
          (by ? ` by ${by}` : '') +
          '.',
        already_recorded: true,
        attendance: existing
          ? { recorded_at: existing.recorded_at, recorded_by_username: by ?? null }
          : null,
        household_id: householdId,
      });
    }
    throw new Error(`Failed to record attendance: ${error.message}`);
  }

  // RECORDING ATTENDANCE NEVER TOUCHES A CHARGE. Money must not move as a side
  // effect of an attendance edit. If this household already has a live fine
  // for this event the two now disagree, and that MISMATCH is surfaced on the
  // roster (see GET /:id/fines) for the Secretary to resolve deliberately —
  // voiding is manual, and permanent for the event once done.
  const by = (Array.isArray(inserted.recorded_by) ? inserted.recorded_by[0] : inserted.recorded_by)?.username;
  res.status(201).json({
    message: `Household #${householdId} recorded present.`,
    already_recorded: false,
    attendance: { recorded_at: inserted.recorded_at, recorded_by_username: by ?? null },
    household_id: householdId,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/events/:id/attendance/:householdId — undo a mis-recording.
//
// HARD DELETE, unlike household memberships which are only ever ended. The
// difference is what the row MEANS: absence is defined as the absence of a
// row, so a soft-deleted attendance row would still make the household look
// present to every reader that does not know about the flag — and would make
// stage 3b fine the wrong households. Removing the row restores exactly the
// state that existed before it was recorded.
// ---------------------------------------------------------------------------
router.delete('/:id/attendance/:householdId', async (req, res) => {
  const event = await requireAttendanceEvent(req, res);
  if (!event) return undefined;

  const householdId = Number(req.params.householdId);
  if (!Number.isInteger(householdId)) {
    return res.status(400).json({ error: 'Invalid household id' });
  }

  const { data: removed, error } = await supabase
    .from('event_attendees')
    .delete()
    .eq('event_id', event.event_id)
    .eq('household_id', householdId)
    .select('event_attendee_id');
  if (error) throw new Error(`Failed to remove the attendance record: ${error.message}`);
  if (!removed || removed.length === 0) {
    return res.status(404).json({ error: 'That household is not recorded present at this event' });
  }

  res.json({
    message: `Household #${householdId} is no longer marked present.`,
    household_id: householdId,
  });
});

// ===========================================================================
// STAGE 3b — FINES FOR ABSENT HOUSEHOLDS
//
// A fine is an ordinary row in the EXISTING charges table (charge_type FINE,
// linked by event_id + household_id), so the Treasurer settles it on the same
// Payments screen as document and rental fees. There is no parallel payment
// path and nothing about the charges/payments model changed.
//
// GENERATION IS AN EXPLICIT SECRETARY ACTION. It is never triggered by a
// timer, by the event ending, or by recording attendance. Money must not
// appear on a household's record because a clock ticked over — somebody
// decides to raise the fines, and the roster they are deciding from is
// visible on screen at that moment.
//
// SAFE TO RE-RUN. The partial unique index charges_event_household_unique
// (migration 016) means at most one charge can exist per (event, household),
// so a second run cannot double-charge. The route pre-filters against the
// charges already on file so it can REPORT accurately, and treats a 23505
// from a concurrent run as "already fined" rather than an error.
//
// VOIDING IS MANUAL, ALWAYS. Recording attendance never voids a fine, and
// nothing else changes a charge as a side effect. The reason is the index
// above: because it covers (event_id, household_id) whatever the status, a
// void is PERMANENT for that event — no replacement charge can ever be raised
// for that pair. Anything automatic would let a mis-tapped "Mark present"
// destroy a chargeable fine for good, and undoing the attendance would not
// bring it back. So when attendance and a live fine disagree, the roster
// reports the MISMATCH (state 'mismatch') and the Secretary decides.
//
// Fines are Secretary-only, unlike attendance recording which Staff also do.
// Staff mark the roster; raising a charge against a household is a different
// kind of act.
// ===========================================================================

// Why generation is not possible right now, or null if it is. Kept separate
// from the routes so the preview can EXPLAIN the block instead of just
// refusing — the Secretary needs to know what to fix.
function fineBlocker(event) {
  if (event.is_archived) {
    return 'This activity is archived. Unarchive it before raising fines.';
  }
  const amount = event.fine_amount === null || event.fine_amount === undefined
    ? null
    : Number(event.fine_amount);
  if (!(amount > 0)) {
    return 'No fine amount is set for this activity. Attendance is being tracked, but there is nothing to charge.';
  }
  if (!event.end_datetime) {
    return 'This activity has no end time, so it is not possible to say who missed it.';
  }
  if (new Date(event.end_datetime).getTime() > Date.now()) {
    return 'This activity has not finished yet. Fines can only be raised once it has ended.';
  }
  return null;
}

// Everything the fine routes need about who should be fined, computed from
// live attendance. Absence is DERIVED here exactly as it is everywhere else:
// a household is absent iff it has no event_attendees row for this event.
//
// Neither query uses .in() on a household id list. At barangay scale that
// list runs to four figures, which does not survive being serialised into a
// PostgREST query string — the same reason GET /unassigned-residents computes
// its difference in Node.
async function collectFineTargets(event) {
  const { data: households, error: hErr } = await supabase
    .from('household_records')
    .select('household_id, address, registered_at')
    .eq('is_active', true);
  if (hErr) throw new Error(`Failed to load households: ${hErr.message}`);

  const { data: present, error: pErr } = await supabase
    .from('event_attendees')
    .select('household_id')
    .eq('event_id', event.event_id);
  if (pErr) throw new Error(`Failed to load attendance: ${pErr.message}`);
  const presentIds = new Set((present || []).map((p) => p.household_id));

  // Any charge already raised for this event, whatever its status. A VOID one
  // still counts as handled: the unique index would refuse a replacement, and
  // a voided fine is a decision not to charge, not an omission to fix.
  const { data: existing, error: cErr } = await supabase
    .from('charges')
    .select('charge_id, household_id, status, amount')
    .eq('event_id', event.event_id)
    .not('household_id', 'is', null);
  if (cErr) throw new Error(`Failed to load existing fines: ${cErr.message}`);
  const chargeByHousehold = new Map((existing || []).map((c) => [c.household_id, c]));

  // Heads (for the payer link and the name/contact) — fetched whole rather
  // than filtered by id, since there is at most one head per household.
  const { data: heads, error: mErr } = await supabase
    .from('household_members')
    .select('household_id, resident_id, resident_records ( first_name, middle_name, last_name, suffix, contact_number )')
    .eq('role', HOUSEHOLD_ROLE.HEAD)
    .is('date_ended', null);
  if (mErr) throw new Error(`Failed to load household heads: ${mErr.message}`);
  const headByHousehold = new Map((heads || []).map((h) => [h.household_id, h]));

  const { data: profiles, error: prErr } = await supabase
    .from('profiles')
    .select('user_id, resident_id')
    .not('resident_id', 'is', null);
  if (prErr) throw new Error(`Failed to load accounts: ${prErr.message}`);
  const userByResident = new Map((profiles || []).map((p) => [p.resident_id, p.user_id]));

  const endedAt = event.end_datetime ? new Date(event.end_datetime).getTime() : null;

  const rows = (households || []).map((h) => {
    const head = headByHousehold.get(h.household_id) || null;
    const headResident = head
      ? Array.isArray(head.resident_records) ? head.resident_records[0] : head.resident_records
      : null;
    // A household registered AFTER the assembly finished cannot have attended
    // it, so it must never be fined for missing it.
    const registeredAfter =
      endedAt !== null && h.registered_at && new Date(h.registered_at).getTime() > endedAt;
    const charge = chargeByHousehold.get(h.household_id) || null;
    const present = presentIds.has(h.household_id);
    // The household is marked present AND still owes (or has paid) a fine for
    // this event. Nothing resolves this automatically — see the attendance
    // route: an attendance edit never changes money. A VOID charge is not a
    // mismatch, since nothing is owed.
    const mismatch = !!charge && present && charge.status !== CHARGE_STATUS.VOID;

    let state;
    if (mismatch) state = 'mismatch';
    else if (charge) state = 'already_charged';
    else if (present) state = 'present';
    else if (registeredAfter) state = 'registered_after';
    else state = 'to_charge';

    return {
      household_id: h.household_id,
      address: h.address,
      head_name: fullName(headResident),
      head_contact: headResident?.contact_number || null,
      user_id: head ? userByResident.get(head.resident_id) ?? null : null,
      present,
      state,
      charge: charge
        ? { charge_id: charge.charge_id, status: charge.status, amount: charge.amount }
        : null,
    };
  });

  return rows;
}

const fineSummary = (rows, amount) => {
  const toCharge = rows.filter((r) => r.state === 'to_charge');
  return {
    fine_amount: amount,
    active_households: rows.length,
    present: rows.filter((r) => r.state === 'present').length,
    registered_after: rows.filter((r) => r.state === 'registered_after').length,
    already_charged: rows.filter((r) => r.state === 'already_charged').length,
    // Present, yet holding a live fine. Needs a human decision, so it is
    // counted separately and never folded into any other bucket.
    mismatch: rows.filter((r) => r.state === 'mismatch').length,
    to_charge: toCharge.length,
    total_amount: amount === null ? null : Number((toCharge.length * amount).toFixed(2)),
  };
};

// ---------------------------------------------------------------------------
// GET /api/events/:id/fines — what would happen, without changing anything.
//
// Deliberately does NOT refuse when fines cannot be raised: it reports
// can_generate + blocked_reason so the screen can say why. Refusing with a 400
// would leave the Secretary staring at an error with no idea what to fix.
// ---------------------------------------------------------------------------
router.get('/:id/fines', requireRole('secretary'), async (req, res) => {
  const event = await requireAttendanceEvent(req, res);
  if (!event) return undefined;

  const rows = await collectFineTargets(event);
  const blocked = fineBlocker(event);
  const amount = event.fine_amount === null ? null : Number(event.fine_amount);

  res.json({
    event: {
      event_id: event.event_id,
      title: event.title,
      start_datetime: event.start_datetime,
      end_datetime: event.end_datetime,
      fine_amount: amount,
      is_archived: event.is_archived,
    },
    can_generate: !blocked && rows.some((r) => r.state === 'to_charge'),
    blocked_reason: blocked,
    summary: fineSummary(rows, amount),
    households: rows,
  });
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/fines — raise the fines. Secretary-only, explicit.
// ---------------------------------------------------------------------------
router.post('/:id/fines', requireRole('secretary'), async (req, res) => {
  const event = await requireAttendanceEvent(req, res);
  if (!event) return undefined;

  const blocked = fineBlocker(event);
  if (blocked) return res.status(409).json({ error: blocked });

  const amount = Number(event.fine_amount);
  const rows = await collectFineTargets(event);
  const targets = rows.filter((r) => r.state === 'to_charge');

  if (!targets.length) {
    return res.status(409).json({
      error: 'There is nobody to fine — every active household is either recorded present or already has a charge for this activity.',
      summary: fineSummary(rows, amount),
    });
  }

  const now = new Date().toISOString();
  const toInsert = targets.map((t) => ({
    charge_type: CHARGE_TYPE.FINE,
    amount,
    status: CHARGE_STATUS.UNPAID,
    event_id: event.event_id,
    household_id: t.household_id,
    // The head's account when they have one, so the fine shows up in their own
    // view and can be paid online. Most households have no account at all
    // (8 of 47 residents did at last count) — hence charges.user_id being
    // nullable, and hence fines keying off the household, not the user.
    user_id: t.user_id,
    created_at: now,
  }));

  // Chunked so one oversized request cannot be built. A 23505 can only come
  // from a concurrent second run, since the set was just filtered against the
  // charges on file; that chunk falls back to one insert per household so the
  // rest still lands and the collision is reported as "already fined".
  const CHUNK = 200;
  const created = [];
  const collided = [];
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { data, error } = await supabase.from('charges').insert(chunk).select('charge_id, household_id');
    if (!error) {
      created.push(...data);
      continue;
    }
    if (error.code !== '23505') throw new Error(`Failed to raise fines: ${error.message}`);
    for (const row of chunk) {
      const one = await supabase.from('charges').insert(row).select('charge_id, household_id').single();
      if (!one.error) created.push(one.data);
      else if (one.error.code === '23505') collided.push(row.household_id);
      else throw new Error(`Failed to raise fines: ${one.error.message}`);
    }
  }

  // SMS hook — stub only (see services/smsNotification.js), one per household
  // actually fined, which is what a real provider call would be.
  const byHousehold = new Map(targets.map((t) => [t.household_id, t]));
  for (const c of created) {
    const t = byHousehold.get(c.household_id);
    logSmsNotification(
      t?.head_contact,
      `BrgyServe: your household was not recorded at "${event.title}". A fine of ₱${amount.toFixed(2)} is now due. Please settle it at the Barangay Office.`
    );
  }

  const after = await collectFineTargets(event);
  res.status(201).json({
    message:
      `Raised ${created.length} fine${created.length === 1 ? '' : 's'} of ₱${amount.toFixed(2)} ` +
      `(₱${(created.length * amount).toFixed(2)} total)` +
      (collided.length ? `. ${collided.length} were already fined by someone else just now.` : '.'),
    created: created.length,
    already_fined: collided.length,
    total_amount: Number((created.length * amount).toFixed(2)),
    summary: fineSummary(after, amount),
  });
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/fines/:householdId/void — cancel one fine.
//
// VOID, never delete: the charge is a financial record and the rest of the
// system voids rather than removes (a cancelled rental booking does the same).
// A PAID fine is refused — money that has been received is a fact, and refunds
// are handled offline, exactly as with rentals.
//
// This is the ONLY way a fine is ever voided — nothing does it automatically.
//
// A voided fine is FINAL for that event. The unique index is on
// (event_id, household_id) regardless of status, so no replacement charge can
// be raised for that pair afterwards. That permanence is exactly why the
// action is manual: it is a decision not to fine this household for this
// assembly, and it cannot be walked back.
// ---------------------------------------------------------------------------
router.post('/:id/fines/:householdId/void', requireRole('secretary'), async (req, res) => {
  const event = await requireAttendanceEvent(req, res);
  if (!event) return undefined;

  const householdId = Number(req.params.householdId);
  if (!Number.isInteger(householdId)) {
    return res.status(400).json({ error: 'Invalid household id' });
  }

  const { data: charge, error: loadErr } = await supabase
    .from('charges')
    .select('charge_id, status, amount')
    .eq('event_id', event.event_id)
    .eq('household_id', householdId)
    .maybeSingle();
  if (loadErr) throw new Error(`Failed to load the fine: ${loadErr.message}`);
  if (!charge) {
    return res.status(404).json({ error: 'That household has no fine for this activity' });
  }
  if (charge.status === CHARGE_STATUS.PAID) {
    return res.status(409).json({
      error: 'This fine has already been paid and cannot be voided. Refunds are handled at the Barangay Office.',
    });
  }
  if (charge.status === CHARGE_STATUS.VOID) {
    return res.json({ message: 'That fine was already void.', charge_id: charge.charge_id, already_void: true });
  }

  const { data: voided, error } = await supabase
    .from('charges')
    .update({ status: CHARGE_STATUS.VOID })
    .eq('charge_id', charge.charge_id)
    .eq('status', CHARGE_STATUS.UNPAID)
    .select('charge_id')
    .maybeSingle();
  if (error) throw new Error(`Failed to void the fine: ${error.message}`);
  if (!voided) {
    return res.status(409).json({ error: 'That fine was just changed by someone else — reload and try again.' });
  }

  res.json({
    message: `Fine of ₱${Number(charge.amount).toFixed(2)} for household #${householdId} is now void.`,
    charge_id: charge.charge_id,
    household_id: householdId,
    already_void: false,
  });
});

module.exports = router;
