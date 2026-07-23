const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// The resident master list is Secretary-only end to end: Staff, the Punong
// Barangay, and residents must not browse it (residents see their own record
// via GET /api/residents/me).
router.use(authenticate, requireRole('secretary'));

const LIST_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, contact_number, date_registered';

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;

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

module.exports = router;
