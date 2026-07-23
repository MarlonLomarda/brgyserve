const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { findMatches } = require('../services/nameMatching');

const router = express.Router();

// The resident master list is Secretary-only end to end: Staff, the Punong
// Barangay, and residents must not browse it (residents see their own record
// via GET /api/residents/me).
router.use(authenticate, requireRole('secretary'));

const LIST_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, contact_number, date_registered';

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;

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

// Search terms go into PostgREST .or() filter strings, where commas and
// parentheses are syntax and %/_ are LIKE wildcards — neutralize all of them
// so user input can't break (or game) the filter.
const sanitizeTerm = (term) => term.replace(/[,()%_\\]/g, ' ').trim();

// GET /api/resident-records?search=&page=&per_page= — paginated master list,
// non-archived records only, ordered by surname. Search is case-insensitive
// partial match: every word must match at least one of first/middle/last
// name or address (so "juan dela" finds Juan Dela Cruz, and "purok 2" works
// as an address/purok filter). Each row carries the linked account (via
// profiles.resident_id) so the list can show who is registered.
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPageRaw = Number(req.query.per_page) || DEFAULT_PER_PAGE;
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, perPageRaw));
  const from = (page - 1) * perPage;

  let query = supabase
    .from('resident_records')
    .select(LIST_FIELDS, { count: 'exact' })
    .eq('is_archived', false)
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true })
    .range(from, from + perPage - 1);

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

module.exports = router;
