const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { findMatches } = require('../services/nameMatching');
const { REQUEST_STATUS } = require('../constants/requestStatus');
const { RENTAL_STATUS, RETURNABLE_TYPES } = require('../constants/rentals');
const { DEFAULT_PER_PAGE, MAX_PER_PAGE, sanitizeTerm } = require('../utils/listQuery');

const router = express.Router();

// The resident master list is Secretary-only end to end: Staff, the Punong
// Barangay, and residents must not browse it (residents see their own record
// via GET /api/residents/me).
router.use(authenticate, requireRole('secretary'));

const LIST_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, contact_number, date_registered, is_archived';

// Column limits straight from the schema doc (Table 4).
const REQUIRED_FIELDS = ['first_name', 'last_name', 'address']; // address is NOT NULL in the DB
const OPTIONAL_TEXT_FIELDS = [
  'middle_name', 'suffix', 'birthplace', 'sex', 'civil_status',
  'religion', 'educational_attainment', 'contact_number',
];
const MAX_LENGTH = {
  first_name: 100, middle_name: 100, last_name: 100, suffix: 20,
  birthplace: 255, address: 255, sex: 20, civil_status: 50,
  religion: 100, educational_attainment: 100, contact_number: 20,
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates the writable columns; returns { error } or { value }, the same
// shape document types and rental items use. resident_id, date_registered and
// is_archived are never client-writable (date_registered is set server-side on
// create; archiving is stage 3).
function validateBody(body) {
  const value = {};

  for (const field of REQUIRED_FIELDS) {
    const v = String(body?.[field] ?? '').trim();
    if (!v) return { error: `${field.replace('_', ' ')} is required` };
    if (v.length > MAX_LENGTH[field]) {
      return { error: `${field.replace('_', ' ')} must be ${MAX_LENGTH[field]} characters or fewer` };
    }
    value[field] = v;
  }

  for (const field of OPTIONAL_TEXT_FIELDS) {
    const v = String(body?.[field] ?? '').trim();
    if (v.length > MAX_LENGTH[field]) {
      return { error: `${field.replace('_', ' ')} must be ${MAX_LENGTH[field]} characters or fewer` };
    }
    value[field] = v || null;
  }

  const birthdate = String(body?.birthdate ?? '').trim();
  if (birthdate) {
    if (!DATE_RE.test(birthdate)) {
      return { error: 'birthdate must be in YYYY-MM-DD format' };
    }
    const parsed = new Date(`${birthdate}T00:00:00+08:00`);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'birthdate is not a valid date' };
    }
    if (parsed > new Date()) {
      return { error: 'birthdate cannot be in the future' };
    }
    value.birthdate = birthdate;
  } else {
    value.birthdate = null;
  }

  return { value };
}

// The fields the Secretary needs to judge whether a ranked match is the same
// person. Mirrors the self-registration suggestion shape in routes/secretary.js.
const asSuggestion = (m) => ({
  resident_id: m.resident_id,
  first_name: m.first_name,
  middle_name: m.middle_name,
  last_name: m.last_name,
  suffix: m.suffix,
  birthdate: m.birthdate,
  address: m.address,
  score: m.score,
});

// GET /api/resident-records?search=&page=&per_page=&archived= — paginated
// master list, ordered by surname. `archived` selects which records to show:
// omitted/'false' = active only (the default), 'true' = archived only, 'all'
// = both. Search is case-insensitive partial match: every word must match at
// least one of first/middle/last name or address (so "juan dela" finds Juan
// Dela Cruz, and "purok 2" works as an address/purok filter). Each row
// carries the linked account (via profiles.resident_id) so the list can show
// who is registered.
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPageRaw = Number(req.query.per_page) || DEFAULT_PER_PAGE;
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, perPageRaw));
  const from = (page - 1) * perPage;

  const archived = String(req.query.archived ?? 'false').toLowerCase();
  if (!['false', 'true', 'all'].includes(archived)) {
    return res.status(400).json({ error: "archived must be 'false', 'true', or 'all'" });
  }

  let query = supabase
    .from('resident_records')
    .select(LIST_FIELDS, { count: 'exact' })
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true })
    .range(from, from + perPage - 1);

  if (archived !== 'all') {
    query = query.eq('is_archived', archived === 'true');
  }

  const words = String(req.query.search ?? '')
    .split(/\s+/)
    .map(sanitizeTerm)
    .filter(Boolean)
    .slice(0, 5); // cap the number of AND-ed terms
  for (const word of words) {
    // one .or() per word: the word must hit some field; chained .or() calls
    // AND together, so every word must match somewhere.
    query = query.or(
      `first_name.ilike.*${word}*,middle_name.ilike.*${word}*,last_name.ilike.*${word}*,address.ilike.*${word}*`
    );
  }

  const { data, count, error } = await query;
  if (error) {
    // PGRST103 = requested page is past the end of the result set — an empty
    // page, not a server error.
    if (error.code === 'PGRST103') {
      return res.json({ records: [], total: 0, page, per_page: perPage, total_pages: 0 });
    }
    throw new Error(`Failed to load resident records: ${error.message}`);
  }

  // Which of these records are linked to a user account? One lookup for the
  // whole page via profiles.resident_id.
  let accountsByResident = {};
  if (data.length > 0) {
    const { data: links, error: linkError } = await supabase
      .from('profiles')
      .select('resident_id, users ( username, is_active )')
      .in('resident_id', data.map((r) => r.resident_id));
    if (linkError) {
      throw new Error(`Failed to load account links: ${linkError.message}`);
    }
    accountsByResident = Object.fromEntries(
      links.map((l) => [l.resident_id, { username: l.users?.username, is_active: l.users?.is_active }])
    );
  }

  res.json({
    records: data.map((r) => ({ ...r, account: accountsByResident[r.resident_id] || null })),
    total: count,
    page,
    per_page: perPage,
    total_pages: Math.ceil((count || 0) / perPage),
  });
});

// GET /api/resident-records/:id — one record's full detail, including any
// linked user account(s). Archived records stay viewable here (history).
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid resident record id' });
  }

  const { data: record, error } = await supabase
    .from('resident_records')
    .select('*')
    .eq('resident_id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load resident record: ${error.message}`);
  }
  if (!record) {
    return res.status(404).json({ error: 'Resident record not found' });
  }

  // profiles.resident_id has no UNIQUE constraint, so tolerate (and surface)
  // more than one linked account rather than assuming exactly one.
  const { data: links, error: linkError } = await supabase
    .from('profiles')
    .select('user_id, users ( user_id, username, email, role, is_active )')
    .eq('resident_id', id);
  if (linkError) {
    throw new Error(`Failed to load account links: ${linkError.message}`);
  }

  res.json({
    record,
    linked_accounts: (links || []).map((l) => l.users).filter(Boolean),
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — add (with the duplicate check) + edit.
//
// The duplicate check REUSES the existing two-stage engine
// (services/nameMatching.js: pg_trgm blocking + Jaro-Winkler scoring) exactly
// as resident self-registration does — same call signature, same DEFAULTS
// (thresholds are never hardcoded here; the evaluation harness sweeps them),
// same ranked output. Duplicate detection now guards BOTH entry points into
// the master list.
//
// It is deliberately a SOFT check: real barangays do have two different people
// with the same name, so matches inform the Secretary and require an explicit
// confirmation — they never hard-block.
// ---------------------------------------------------------------------------

// POST /api/resident-records/check-duplicates — ranked candidates for a
// candidate name. Creates nothing; safe to call as often as the UI likes.
router.post('/check-duplicates', async (req, res) => {
  const firstName = String(req.body?.first_name ?? '').trim();
  const lastName = String(req.body?.last_name ?? '').trim();
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'first name and last name are required to check for duplicates' });
  }

  // No options passed => DEFAULTS, identical to the self-registration path.
  const matches = await findMatches(firstName, lastName);
  res.json({ matches: matches.map(asSuggestion) });
});

// POST /api/resident-records — create a record. The duplicate check re-runs
// HERE regardless of what the client checked earlier, so the server is the
// final authority: if there are matches and the client did not send
// confirm_duplicate, the record is NOT created and the ranked matches come
// back with a 409 for the Secretary to judge.
router.post('/', async (req, res) => {
  const { error: validationError, value } = validateBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const matches = (await findMatches(value.first_name, value.last_name)).map(asSuggestion);
  if (matches.length > 0 && req.body?.confirm_duplicate !== true) {
    return res.status(409).json({
      error: `${matches.length} existing record${matches.length === 1 ? '' : 's'} may be the same person — review the matches and confirm to add anyway`,
      matches,
    });
  }

  const { data: record, error } = await supabase
    .from('resident_records')
    .insert({ ...value, date_registered: new Date().toISOString(), is_archived: false })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to create resident record: ${error.message}`);
  }

  res.status(201).json({ message: 'Resident record created', record, matches });
});

// PUT /api/resident-records/:id — edit an existing record. No duplicate check:
// correcting an existing person's details is not creating a new identity, and
// re-running it here would flag the record against itself. (Reusing
// findMatches on edit would be a one-line change if that is ever wanted.)
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid resident record id' });
  }

  const { error: validationError, value } = validateBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { data: existing, error: loadError } = await supabase
    .from('resident_records')
    .select('resident_id, is_archived')
    .eq('resident_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load resident record: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Resident record not found' });
  }
  if (existing.is_archived) {
    return res.status(404).json({ error: 'Resident record is archived and cannot be edited' });
  }

  const { data: record, error } = await supabase
    .from('resident_records')
    .update(value)
    .eq('resident_id', id)
    .eq('is_archived', false) // guard: not if just archived
    .select()
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to update resident record: ${error.message}`);
  }
  if (!record) {
    return res.status(404).json({ error: 'Resident record not found' });
  }

  res.json({ message: 'Resident record updated', record });
});

// ---------------------------------------------------------------------------
// Stage 3 — archive (soft delete) + unarchive, with dependency handling and
// the linked-account cascade.
//
// Records are NEVER hard-deleted (same rule as document types and rental
// items): document_requests.resident_id is NOT NULL, so deleting a record
// would break referential integrity and erase history. Archiving hides the
// record from the active master list; existing requests and bookings keep
// pointing at it and stay intact.
//
// Archiving CASCADES to the linked user account (is_active = false) so an
// archived resident can no longer log in — there is deliberately no
// "archived but still logging in" state. Unarchive is symmetric.
// ---------------------------------------------------------------------------

// Document requests still in flight (constants/requestStatus.js). claimed,
// rejected and cancelled are finished and do not block anything.
const OPEN_DOCUMENT_STATUSES = [
  REQUEST_STATUS.PENDING,
  REQUEST_STATUS.APPROVED,
  REQUEST_STATUS.READY_FOR_RELEASE,
];

/**
 * Everything that hangs off this resident and is worth warning about before
 * archiving: the linked account, in-flight document requests, and rental
 * bookings that are upcoming or still out.
 *
 * Note on rentals: rental_requests has no resident_id — bookings belong to the
 * USER, so they are reached through the linked account (no account => no
 * bookings to check).
 */
async function collectDependencies(residentId) {
  const { data: links, error: linkError } = await supabase
    .from('profiles')
    .select('user_id, users ( user_id, username, email, is_active )')
    .eq('resident_id', residentId);
  if (linkError) {
    throw new Error(`Failed to load linked accounts: ${linkError.message}`);
  }
  // profiles.resident_id is UNIQUE (migration 002), so this is at most one
  // account today; handled as a list so the cascade stays correct either way.
  const accounts = (links || []).map((l) => l.users).filter(Boolean);

  const { data: documents, error: docError } = await supabase
    .from('document_requests')
    .select('request_id, status, document_types ( name )')
    .eq('resident_id', residentId)
    .in('status', OPEN_DOCUMENT_STATUSES);
  if (docError) {
    throw new Error(`Failed to load document requests: ${docError.message}`);
  }

  let rentals = [];
  if (accounts.length > 0) {
    const { data: bookings, error: rentalError } = await supabase
      .from('rental_requests')
      .select('request_id, start_datetime, end_datetime, status, rental_items ( name, type )')
      .in('requested_by_user_id', accounts.map((a) => a.user_id))
      .eq('status', RENTAL_STATUS.CONFIRMED);
    if (rentalError) {
      throw new Error(`Failed to load rental bookings: ${rentalError.message}`);
    }
    const now = new Date();
    // Upcoming bookings, plus physical items past their end that were never
    // returned (still out — see the stage 5 derived statuses). A facility past
    // its end has auto-completed and is not open work.
    rentals = (bookings || []).filter((b) => {
      if (new Date(b.end_datetime) >= now) return true;
      return RETURNABLE_TYPES.includes(b.rental_items?.type);
    });
  }

  return { accounts, documents: documents || [], rentals };
}

// Plain-language summary. The account-deactivation consequence is always
// spelled out when an account exists — the cascade is never silent.
function dependencySummary({ accounts, documents, rentals }) {
  const parts = [];
  if (documents.length) {
    parts.push(`${documents.length} open document request${documents.length === 1 ? '' : 's'}`);
  }
  if (rentals.length) {
    parts.push(`${rentals.length} active rental booking${rentals.length === 1 ? '' : 's'}`);
  }
  const work = parts.length ? `${parts.join(', ')}. ` : '';
  const cascade = accounts.length
    ? `This will also deactivate account${accounts.length === 1 ? '' : 's'} ${accounts
        .map((a) => `@${a.username}`)
        .join(', ')} (they can no longer log in).`
    : 'No user account is linked to this record.';
  return `${work}${cascade}`;
}

// POST /api/resident-records/:id/archive
router.post('/:id/archive', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid resident record id' });
  }

  const { data: existing, error: loadError } = await supabase
    .from('resident_records')
    .select('resident_id, first_name, last_name, is_archived')
    .eq('resident_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load resident record: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Resident record not found' });
  }
  if (existing.is_archived) {
    return res.status(404).json({ error: 'Resident record is already archived' });
  }

  const dependencies = await collectDependencies(id);
  const hasWarnings =
    dependencies.accounts.length > 0 ||
    dependencies.documents.length > 0 ||
    dependencies.rentals.length > 0;

  if (hasWarnings && req.body?.confirm_archive !== true) {
    return res.status(409).json({
      error: dependencySummary(dependencies),
      dependencies,
    });
  }

  // No transactions in supabase-js: archive first (status-guarded), then
  // cascade to the account(s); revert the archive if the cascade fails, so
  // record and account states can never drift apart.
  const { data: record, error } = await supabase
    .from('resident_records')
    .update({ is_archived: true })
    .eq('resident_id', id)
    .eq('is_archived', false)
    .select()
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to archive resident record: ${error.message}`);
  }
  if (!record) {
    return res.status(409).json({ error: 'Record was just archived by someone else' });
  }

  const accountIds = dependencies.accounts.map((a) => a.user_id);
  if (accountIds.length > 0) {
    const { error: cascadeError } = await supabase
      .from('users')
      .update({ is_active: false })
      .in('user_id', accountIds);
    if (cascadeError) {
      await supabase.from('resident_records').update({ is_archived: false }).eq('resident_id', id);
      throw new Error(`Archive reverted — failed to deactivate the linked account: ${cascadeError.message}`);
    }
  }

  res.json({
    message: accountIds.length
      ? `Resident record archived; account${accountIds.length === 1 ? '' : 's'} ${dependencies.accounts.map((a) => `@${a.username}`).join(', ')} deactivated`
      : 'Resident record archived',
    record,
    deactivated_accounts: dependencies.accounts.map((a) => a.username),
  });
});

// POST /api/resident-records/:id/unarchive — symmetric restore: the record
// comes back AND its linked account(s) are reactivated, so a mistaken archive
// is undone in one step.
router.post('/:id/unarchive', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid resident record id' });
  }

  const { data: existing, error: loadError } = await supabase
    .from('resident_records')
    .select('resident_id, is_archived')
    .eq('resident_id', id)
    .maybeSingle();
  if (loadError) {
    throw new Error(`Failed to load resident record: ${loadError.message}`);
  }
  if (!existing) {
    return res.status(404).json({ error: 'Resident record not found' });
  }
  if (!existing.is_archived) {
    return res.status(404).json({ error: 'Resident record is not archived' });
  }

  const { data: record, error } = await supabase
    .from('resident_records')
    .update({ is_archived: false })
    .eq('resident_id', id)
    .eq('is_archived', true)
    .select()
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to unarchive resident record: ${error.message}`);
  }
  if (!record) {
    return res.status(409).json({ error: 'Record was just restored by someone else' });
  }

  const { data: links } = await supabase
    .from('profiles')
    .select('users ( user_id, username )')
    .eq('resident_id', id);
  const accounts = (links || []).map((l) => l.users).filter(Boolean);

  if (accounts.length > 0) {
    const { error: cascadeError } = await supabase
      .from('users')
      .update({ is_active: true })
      .in('user_id', accounts.map((a) => a.user_id));
    if (cascadeError) {
      await supabase.from('resident_records').update({ is_archived: true }).eq('resident_id', id);
      throw new Error(`Restore reverted — failed to reactivate the linked account: ${cascadeError.message}`);
    }
  }

  res.json({
    message: accounts.length
      ? `Resident record restored; account${accounts.length === 1 ? '' : 's'} ${accounts.map((a) => `@${a.username}`).join(', ')} reactivated`
      : 'Resident record restored',
    record,
    reactivated_accounts: accounts.map((a) => a.username),
  });
});

module.exports = router;
