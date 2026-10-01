const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { NATURES, PARTY_ROLE, PARTY_ROLES } = require('../constants/disputes');
const { logActivity, diffFields, pick } = require('../services/activityLog');
const { ACTIONS } = require('../constants/activityLog');

const router = express.Router();

// Blotter records are sensitive: the Secretary manages and the Punong Barangay
// views. GET / and GET /:id are Secretary + PB; all writes are Secretary-only
// (per-route). Staff and the Treasurer get 403 on every route.
//
// RESIDENTS: A DELIBERATE REVERSAL. This comment used to say residents must
// never see blotter cases, not even their own party entries. They now get ONE
// read-only route, GET /mine, returning only the cases where a dispute_parties
// row carries THEIR OWN linked resident_id — resolved from the session, never
// from anything the client sends — with a minimal field list and no other
// party's name or details. Every other route still refuses them with 403.
router.use(authenticate);
const VIEW_ROLES = ['secretary', 'punong_barangay'];

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Parties are embedded so each case can show who is involved. dispute_parties
// links to resident_records for registered parties (name comes from the
// record); walk-in / non-resident parties carry a typed first/last name.
const PARTY_EMBED = `
  dispute_parties ( dispute_party_id, resident_id, first_name, last_name, role,
    resident_records ( resident_id, first_name, middle_name, last_name, suffix, birthdate, address, contact_number ) )
`;
const CASE_FIELDS = 'dispute_id, barangay_case_no, date_filed, time_filed, filed_for, nature_of_case, is_settled';
const CASE_KEYS = CASE_FIELDS.split(',').map((k) => k.trim());

// Parties as the activity log records them: role and resident_id only, sorted
// so the same set always compares equal. Never a name — a non-resident party
// is just { role, resident_id: null }.
const partyShape = (parties) => (parties || [])
  .map((p) => ({ role: p.role, resident_id: p.resident_id ?? null }))
  .sort((a, b) => a.role.localeCompare(b.role) || (a.resident_id ?? 0) - (b.resident_id ?? 0));

// How many typed (non-resident) party names an edit corrected — the log's
// only trace of one, since partyShape keeps no names and a corrected name
// would otherwise diff to nothing. Per role, names that match before and
// after cancel out; what is left over on BOTH sides pairs up as corrections.
// A party added or removed leaves one side longer and is not counted: it
// already shows in partyShape. Returns a number, never a name.
function typedNamesCorrected(oldParties, newParties) {
  const typedByRole = (parties) => {
    const byRole = new Map();
    for (const p of parties || []) {
      if (p.resident_id !== null && p.resident_id !== undefined) continue;
      const names = byRole.get(p.role) || [];
      names.push(`${p.first_name ?? ''}\u0000${p.last_name ?? ''}`);
      byRole.set(p.role, names);
    }
    return byRole;
  };
  const before = typedByRole(oldParties);
  const after = typedByRole(newParties);
  let corrected = 0;
  for (const role of new Set([...before.keys(), ...after.keys()])) {
    const unmatched = [...(before.get(role) || [])];
    let added = 0;
    for (const name of after.get(role) || []) {
      const i = unmatched.indexOf(name);
      if (i === -1) added += 1;
      else unmatched.splice(i, 1);
    }
    corrected += Math.min(unmatched.length, added);
  }
  return corrected;
}
const DETAIL_FIELDS = `${CASE_FIELDS}, ${PARTY_EMBED}`;

// Strip PostgREST .or() syntax chars and LIKE wildcards from a search term.
const sanitize = (term) => term.replace(/[,()%_*\\]/g, ' ').trim();

// Current Manila wall-clock time as HH:MM (default when time_filed is blank —
// the column is NOT NULL and a filing time of "now" is the sensible default).
const nowManilaHM = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
const todayManila = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

// --- display helpers (party summary is computed server-side for list rows) --
function displayPartyName(p) {
  const r = p.resident_records;
  if (r) {
    const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
    return r.suffix ? `${name}, ${r.suffix}` : name;
  }
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown';
}
function partySummary(parties) {
  const names = (role) => (parties || []).filter((p) => p.role === role).map(displayPartyName);
  const left = names(PARTY_ROLE.COMPLAINANT).join(' & ') || '—';
  const right = names(PARTY_ROLE.RESPONDENT).join(' & ') || '—';
  return `${left} vs. ${right}`;
}

// --- validation ------------------------------------------------------------
function validateCase(body) {
  const barangay_case_no = String(body?.barangay_case_no ?? '').trim();
  if (!barangay_case_no) return { error: 'barangay_case_no is required' };
  if (barangay_case_no.length > 50) return { error: 'barangay_case_no must be 50 characters or fewer' };

  const date_filed = String(body?.date_filed ?? '').trim();
  if (!DATE_RE.test(date_filed)) return { error: 'date_filed must be in YYYY-MM-DD format' };
  if (date_filed > todayManila()) return { error: 'date_filed cannot be in the future' };

  let time_filed = String(body?.time_filed ?? '').trim();
  if (time_filed && !TIME_RE.test(time_filed)) return { error: 'time_filed must be in HH:MM (24-hour) format' };
  if (!time_filed) time_filed = nowManilaHM();

  const filed_for = String(body?.filed_for ?? '').trim();
  if (!filed_for) return { error: 'filed_for is required' };
  if (filed_for.length > 255) return { error: 'filed_for must be 255 characters or fewer' };

  const nature_of_case = String(body?.nature_of_case ?? '').trim();
  if (!NATURES.includes(nature_of_case)) {
    return { error: `nature_of_case must be one of: ${NATURES.join(', ')}` };
  }

  return { value: { barangay_case_no, date_filed, time_filed, filed_for, nature_of_case } };
}

// A party is EITHER a linked resident (resident_id) OR a typed non-resident
// name — never both, always a role.
function normalizeParty(raw) {
  const role = String(raw?.role ?? '').trim();
  if (!PARTY_ROLES.includes(role)) {
    return { error: `party role must be one of: ${PARTY_ROLES.join(', ')}` };
  }
  const hasResident =
    raw?.resident_id !== undefined && raw?.resident_id !== null && raw?.resident_id !== '';
  if (hasResident) {
    const rid = Number(raw.resident_id);
    if (!Number.isInteger(rid)) return { error: 'resident_id must be a whole number' };
    return { value: { resident_id: rid, first_name: null, last_name: null, role } };
  }
  const first = String(raw?.first_name ?? '').trim();
  const last = String(raw?.last_name ?? '').trim();
  if (!first || !last) {
    return { error: 'each non-resident party needs a first and last name (or pick a registered resident)' };
  }
  if (first.length > 100 || last.length > 100) {
    return { error: 'party names must be 100 characters or fewer' };
  }
  return { value: { resident_id: null, first_name: first, last_name: last, role } };
}

function validateParties(rawParties) {
  if (!Array.isArray(rawParties) || rawParties.length === 0) {
    return { error: 'at least one complainant and one respondent are required' };
  }
  const parties = [];
  for (const raw of rawParties) {
    const { error, value } = normalizeParty(raw);
    if (error) return { error };
    parties.push(value);
  }
  if (!parties.some((p) => p.role === PARTY_ROLE.COMPLAINANT)) {
    return { error: 'at least one Complainant is required' };
  }
  if (!parties.some((p) => p.role === PARTY_ROLE.RESPONDENT)) {
    return { error: 'at least one Respondent is required' };
  }
  return { value: parties };
}

// Every referenced resident_id must exist (friendly error vs. a raw FK 23503).
async function findMissingResidents(parties) {
  const ids = [...new Set(parties.filter((p) => p.resident_id).map((p) => p.resident_id))];
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from('resident_records').select('resident_id').in('resident_id', ids);
  if (error) throw new Error(`Failed to verify residents: ${error.message}`);
  const found = new Set(data.map((r) => r.resident_id));
  return ids.filter((id) => !found.has(id));
}

// Exact-match uniqueness on barangay_case_no (aligns with the optional UNIQUE
// index in migration 012; also works before that migration is applied).
async function caseNoTaken(caseNo, excludeId = null) {
  let query = supabase.from('dispute_records').select('dispute_id').eq('barangay_case_no', caseNo);
  if (excludeId !== null) query = query.neq('dispute_id', excludeId);
  const { data, error } = await query;
  if (error) throw new Error(`Case-number check failed: ${error.message}`);
  return data.length > 0;
}

// The caller's own linked resident record, or null when their account has none.
// Copied from routes/documentRequests.js (rentalRequests.js holds the same
// copy); deliberately not shared, so this change touches no other route file.
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

async function loadDetail(id) {
  const { data, error } = await supabase
    .from('dispute_records')
    .select(DETAIL_FIELDS)
    .eq('dispute_id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load case: ${error.message}`);
  return data;
}

// Dispute ids whose parties match a name search: typed party names OR the
// name of a linked resident (a two-hop, since linked parties store no name).
async function disputeIdsMatchingParty(term) {
  const { data: residents, error: rErr } = await supabase
    .from('resident_records')
    .select('resident_id')
    .or(`first_name.ilike.*${term}*,middle_name.ilike.*${term}*,last_name.ilike.*${term}*`);
  if (rErr) throw new Error(`Party search failed: ${rErr.message}`);
  const residentIds = residents.map((r) => r.resident_id);

  const orParts = [`first_name.ilike.*${term}*`, `last_name.ilike.*${term}*`];
  if (residentIds.length) orParts.push(`resident_id.in.(${residentIds.join(',')})`);
  const { data: parties, error: pErr } = await supabase
    .from('dispute_parties')
    .select('dispute_id')
    .or(orParts.join(','));
  if (pErr) throw new Error(`Party search failed: ${pErr.message}`);
  return [...new Set(parties.map((p) => p.dispute_id))];
}

// ---------------------------------------------------------------------------
// GET /api/disputes — paginated list (Secretary + Punong Barangay).
// ?search= across case no / filed_for / party name; ?settled=open|settled|all;
// ?nature=Criminal|Civil|Others|all. Newest filed first.
// ---------------------------------------------------------------------------
router.get('/', requireRole(...VIEW_ROLES), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query.per_page) || DEFAULT_PER_PAGE));
  const from = (page - 1) * perPage;

  const settled = String(req.query.settled ?? 'all').toLowerCase();
  if (!['open', 'settled', 'all'].includes(settled)) {
    return res.status(400).json({ error: "settled must be 'open', 'settled', or 'all'" });
  }
  const nature = req.query.nature;
  if (nature && nature !== 'all' && !NATURES.includes(nature)) {
    return res.status(400).json({ error: `nature must be one of: ${NATURES.join(', ')}, or 'all'` });
  }

  let query = supabase
    .from('dispute_records')
    .select(DETAIL_FIELDS, { count: 'exact' })
    .order('date_filed', { ascending: false })
    .order('time_filed', { ascending: false })
    .range(from, from + perPage - 1);

  if (settled !== 'all') query = query.eq('is_settled', settled === 'settled');
  if (nature && nature !== 'all') query = query.eq('nature_of_case', nature);

  const term = sanitize(String(req.query.search ?? ''));
  if (term) {
    const partyIds = await disputeIdsMatchingParty(term);
    const ors = [`barangay_case_no.ilike.*${term}*`, `filed_for.ilike.*${term}*`];
    if (partyIds.length) ors.push(`dispute_id.in.(${partyIds.join(',')})`);
    query = query.or(ors.join(','));
  }

  const { data, count, error } = await query;
  if (error) {
    if (error.code === 'PGRST103') {
      return res.json({ disputes: [], total: 0, page, per_page: perPage, total_pages: 0 });
    }
    throw new Error(`Failed to load cases: ${error.message}`);
  }

  // list rows stay light: keep the case fields + a computed party summary,
  // drop the raw parties array (the detail route carries the full parties).
  const disputes = data.map(({ dispute_parties, ...row }) => ({
    ...row,
    party_summary: partySummary(dispute_parties),
    party_count: (dispute_parties || []).length,
  }));

  res.json({ disputes, total: count, page, per_page: perPage, total_pages: Math.ceil((count || 0) / perPage) });
});

// ---------------------------------------------------------------------------
// GET /api/disputes/mine — a RESIDENT's own cases, read-only.
//
// MUST STAY DECLARED BEFORE GET /:id. Express matches in declaration order, so
// below it "/mine" would be caught by /:id: its VIEW_ROLES guard answers a
// resident with 403 and the Secretary with 400 "Invalid case id". roles:test
// asserts the order, because its guard probe cannot see route order at all.
//
// Scoped by the caller's own resident_id and nothing else. The handler never
// reads req.params, req.query or req.body — there is no id a resident could
// pass to see a case that is not theirs.
//
// The response is an ALLOW-LIST, not the party embed above: the case's own
// label fields plus the caller's role(s). It shows a resident their own
// involvement, not a roster of the case — so no other party's name or details,
// and no birthdate, contact_number, time_filed or dispute_id. A person
// recorded only as a typed name is never linked, so the empty state must not
// read as "you are in no cases".
// ---------------------------------------------------------------------------
const MY_CASE_FIELDS = 'dispute_id, role, dispute_records ( barangay_case_no, date_filed, filed_for, nature_of_case, is_settled )';

// Every "nothing to list" outcome that is not simply zero cases. Answered with
// a 200 and a reason, like routes/myHousehold.js, never a bare [] — [] is the
// claim "we looked and there are none".
const MY_CASES_REASON = {
  NO_RECORD: 'no_resident_record',
};

router.get('/mine', requireRole('resident'), async (req, res) => {
  const residentId = await ownResidentId(req.user.user_id);
  if (!residentId) {
    return res.json({ reason: MY_CASES_REASON.NO_RECORD, cases: [] });
  }

  const { data, error } = await supabase
    .from('dispute_parties')
    .select(MY_CASE_FIELDS)
    .eq('resident_id', residentId);
  if (error) throw new Error(`Failed to load your cases: ${error.message}`);

  // One entry per case. validateParties allows the same resident twice in a
  // case, even as both Complainant and Respondent, so roles are collected and
  // de-duplicated rather than taken from a single row.
  const byCase = new Map();
  for (const row of data) {
    const c = row.dispute_records;
    if (!c) continue;
    if (!byCase.has(row.dispute_id)) byCase.set(row.dispute_id, { id: row.dispute_id, c, roles: new Set() });
    byCase.get(row.dispute_id).roles.add(row.role);
  }

  const cases = [...byCase.values()]
    // Newest filed first; the internal id breaks a same-day tie, newest first.
    .sort((a, b) => b.c.date_filed.localeCompare(a.c.date_filed) || b.id - a.id)
    .map(({ c, roles }) => ({
      barangay_case_no: c.barangay_case_no,
      date_filed: c.date_filed,
      filed_for: c.filed_for,
      nature_of_case: c.nature_of_case,
      is_settled: c.is_settled,
      // Canonical order; a stored role outside PARTY_ROLES (the column has no
      // CHECK) is kept after them rather than silently dropped.
      my_roles: [...PARTY_ROLES.filter((r) => roles.has(r)), ...[...roles].filter((r) => !PARTY_ROLES.includes(r))],
    }));

  res.json({ cases });
});

// GET /api/disputes/:id — full case detail with all parties (Secretary + PB).
router.get('/:id', requireRole(...VIEW_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid case id' });

  const dispute = await loadDetail(id);
  if (!dispute) return res.status(404).json({ error: 'Case not found' });
  res.json({ dispute });
});

// POST /api/disputes — create a case WITH its parties, atomically (Secretary).
router.post('/', requireRole('secretary'), async (req, res) => {
  const { error: caseError, value: caseValue } = validateCase(req.body);
  if (caseError) return res.status(400).json({ error: caseError });
  const { error: partyError, value: parties } = validateParties(req.body?.parties);
  if (partyError) return res.status(400).json({ error: partyError });

  if (await caseNoTaken(caseValue.barangay_case_no)) {
    return res.status(409).json({ error: `Case number "${caseValue.barangay_case_no}" is already in use` });
  }
  const missing = await findMissingResidents(parties);
  if (missing.length) {
    return res.status(400).json({ error: `resident record(s) not found: ${missing.join(', ')}` });
  }

  const { data: dispute, error } = await supabase
    .from('dispute_records')
    .insert({ ...caseValue, is_settled: false })
    .select('dispute_id')
    .single();
  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `Case number "${caseValue.barangay_case_no}" is already in use` });
    }
    throw new Error(`Failed to create case: ${error.message}`);
  }

  // No transactions in supabase-js: insert the parties, and if that fails
  // delete the case so a party-less dispute is never left behind.
  const { error: partyInsertError } = await supabase
    .from('dispute_parties')
    .insert(parties.map((p) => ({ ...p, dispute_id: dispute.dispute_id })));
  if (partyInsertError) {
    await supabase.from('dispute_records').delete().eq('dispute_id', dispute.dispute_id);
    throw new Error(`Case reverted — failed to add parties: ${partyInsertError.message}`);
  }

  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.CREATE,
    table: 'dispute_records',
    recordId: dispute.dispute_id,
    after: { ...caseValue, is_settled: false, parties: partyShape(parties) },
  });

  res.status(201).json({ message: 'Dispute case recorded', dispute: await loadDetail(dispute.dispute_id) });
});

// PUT /api/disputes/:id — edit case fields and replace its parties (Secretary).
router.put('/:id', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid case id' });

  const { error: caseError, value: caseValue } = validateCase(req.body);
  if (caseError) return res.status(400).json({ error: caseError });
  const { error: partyError, value: parties } = validateParties(req.body?.parties);
  if (partyError) return res.status(400).json({ error: partyError });

  const { data: existing, error: loadError } = await supabase
    .from('dispute_records')
    .select(CASE_FIELDS)
    .eq('dispute_id', id)
    .maybeSingle();
  if (loadError) throw new Error(`Failed to load case: ${loadError.message}`);
  if (!existing) return res.status(404).json({ error: 'Case not found' });

  if (await caseNoTaken(caseValue.barangay_case_no, id)) {
    return res.status(409).json({ error: `Case number "${caseValue.barangay_case_no}" is already in use` });
  }
  const missing = await findMissingResidents(parties);
  if (missing.length) {
    return res.status(400).json({ error: `resident record(s) not found: ${missing.join(', ')}` });
  }

  // Snapshot the old parties so we can restore them if the replacement fails.
  const { data: oldParties, error: oldError } = await supabase
    .from('dispute_parties')
    .select('dispute_id, resident_id, first_name, last_name, role')
    .eq('dispute_id', id);
  if (oldError) throw new Error(`Failed to load parties: ${oldError.message}`);
  const oldPartyIds = (await supabase.from('dispute_parties').select('dispute_party_id').eq('dispute_id', id)).data.map((p) => p.dispute_party_id);

  // 1) update case fields
  const { error: updateError } = await supabase.from('dispute_records').update(caseValue).eq('dispute_id', id);
  if (updateError) {
    if (updateError.code === '23505') {
      return res.status(409).json({ error: `Case number "${caseValue.barangay_case_no}" is already in use` });
    }
    throw new Error(`Failed to update case: ${updateError.message}`);
  }

  // 2) insert new parties, then 3) delete the old ones (by their captured ids,
  // so the just-inserted rows survive). Compensate on any failure so the case
  // and its parties never drift: revert case fields, and restore the original
  // parties. No transactions in supabase-js, so this is the closest to atomic.
  const revertCase = async () => supabase.from('dispute_records').update(existing).eq('dispute_id', id);

  const { error: insertError } = await supabase
    .from('dispute_parties')
    .insert(parties.map((p) => ({ ...p, dispute_id: id })));
  if (insertError) {
    await revertCase();
    throw new Error(`Update reverted — failed to add parties: ${insertError.message}`);
  }

  if (oldPartyIds.length) {
    const { error: deleteError } = await supabase.from('dispute_parties').delete().in('dispute_party_id', oldPartyIds);
    if (deleteError) {
      // roll back: drop the new parties we just added, restore the old case
      await supabase.from('dispute_parties').delete().eq('dispute_id', id).not('dispute_party_id', 'in', `(${oldPartyIds.join(',')})`);
      await revertCase();
      throw new Error(`Update reverted — failed to replace parties: ${deleteError.message}`);
    }
  }
  // The ids drive the restore path above; oldParties feeds the activity log.
  const detail = await loadDetail(id);

  // Case fields re-read from the database on both sides, so a time stored as
  // 14:26:00 does not read as changed from the 14:26 that was sent. Parties
  // compare by role and resident_id; a corrected typed name shows only as the
  // count parties_renamed, which diffFields drops again when it is 0.
  const diff = diffFields(
    { ...pick(existing, CASE_KEYS), parties: partyShape(oldParties), parties_renamed: 0 },
    {
      ...pick(detail, CASE_KEYS),
      parties: partyShape(parties),
      parties_renamed: typedNamesCorrected(oldParties, parties),
    },
  );
  await logActivity({
    userId: req.user.user_id,
    action: ACTIONS.UPDATE,
    table: 'dispute_records',
    recordId: id,
    before: diff.before,
    after: diff.after,
  });

  res.json({ message: 'Dispute case updated', dispute: detail });
});

// PATCH /api/disputes/:id/settle — set is_settled true/false (Secretary).
router.patch('/:id/settle', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid case id' });
  if (typeof req.body?.is_settled !== 'boolean') {
    return res.status(400).json({ error: 'is_settled (boolean) is required' });
  }

  const { data, error } = await supabase
    .from('dispute_records')
    .update({ is_settled: req.body.is_settled })
    .eq('dispute_id', id)
    .select('dispute_id')
    .maybeSingle();
  if (error) throw new Error(`Failed to update case: ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Case not found' });

  // The new state only: the update is not guarded on the old one, so this
  // route cannot say what it was before.
  await logActivity({
    userId: req.user.user_id,
    action: req.body.is_settled ? ACTIONS.SETTLE : ACTIONS.REOPEN,
    table: 'dispute_records',
    recordId: id,
    after: { is_settled: req.body.is_settled },
  });

  res.json({
    message: req.body.is_settled ? 'Case marked settled' : 'Case reopened',
    dispute: await loadDetail(id),
  });
});

module.exports = router;
