const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { HOUSEHOLD_ROLE, ROLE_ORDER } = require('../constants/households');
const { searchWords, parsePaging, isRangeError, pageResponse } = require('../utils/listQuery');

const router = express.Router();

// Households stage 1 is Secretary-only, exactly like the resident master list
// it mirrors. Staff, the Punong Barangay, the Treasurer and residents get 403;
// widening access is a later stage, not an oversight.
router.use(authenticate, requireRole('secretary'));

// address is varchar(255) NOT NULL (Table 1).
const MAX_ADDRESS = 255;

// Members joined to the resident they refer to. Household membership carries
// no name of its own — the name always comes from resident_records.
const MEMBER_FIELDS = `
  membership_id, household_id, resident_id, role, date_started, date_ended,
  resident_records ( resident_id, first_name, middle_name, last_name, suffix,
    sex, birthdate, is_archived )
`;

const embedded = (value) => (Array.isArray(value) ? value[0] : value);

function residentName(r) {
  if (!r) return null;
  const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return r.suffix ? `${name}, ${r.suffix}` : name;
}

// Barangay Ubujan is UTC+8; date_started is a plain `date`, so derive today in
// Manila rather than from the server's own timezone.
const todayInManila = () =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Two addresses are "the same" for the duplicate NOTICE if they differ only by
// case or spacing. Deliberately conservative: this only raises a warning, and
// shared addresses are legitimate, so over-matching would be worse than
// under-matching.
const normalizeAddress = (address) => String(address ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const isActiveMembership = (m) => m.date_ended === null;

// Head of a household = the member whose role is 'Head' and whose membership
// has not ended. There is no head column; this derivation is the definition.
const headOf = (members) =>
  (members || []).find((m) => m.role === HOUSEHOLD_ROLE.HEAD && isActiveMembership(m)) || null;

// Head first, then household seniority, then surname — the order the members
// table is read in.
function sortMembers(members) {
  return [...(members || [])].sort((a, b) => {
    const roleDiff = (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99);
    if (roleDiff !== 0) return roleDiff;
    const aLast = embedded(a.resident_records)?.last_name || '';
    const bLast = embedded(b.resident_records)?.last_name || '';
    return aLast.localeCompare(bLast);
  });
}

const shapeMember = (m) => {
  const resident = embedded(m.resident_records);
  return {
    membership_id: m.membership_id,
    resident_id: m.resident_id,
    role: m.role,
    date_started: m.date_started,
    date_ended: m.date_ended,
    is_active: isActiveMembership(m),
    name: residentName(resident),
    sex: resident?.sex ?? null,
    birthdate: resident?.birthdate ?? null,
    // Surfaced so the detail screen can warn when a household's head is an
    // archived resident — the record still exists, but the person is no longer
    // on the active master list.
    resident_is_archived: resident?.is_archived ?? null,
  };
};

// Household ids whose ACTIVE members match a name term. A two-hop, because
// household_members stores no name of its own (same shape as the blotter's
// party-name search).
async function householdIdsMatchingMember(term) {
  const { data: residents, error: rErr } = await supabase
    .from('resident_records')
    .select('resident_id')
    .or(`first_name.ilike.*${term}*,middle_name.ilike.*${term}*,last_name.ilike.*${term}*`);
  if (rErr) throw new Error(`Household member search failed: ${rErr.message}`);
  if (!residents.length) return [];

  const { data: members, error: mErr } = await supabase
    .from('household_members')
    .select('household_id')
    .is('date_ended', null)
    .in('resident_id', residents.map((r) => r.resident_id));
  if (mErr) throw new Error(`Household member search failed: ${mErr.message}`);
  return [...new Set(members.map((m) => m.household_id))];
}

// ---------------------------------------------------------------------------
// GET /api/households?search=&page=&per_page=&active=
//
// Mirrors the resident master list: 25 per page (max 100), and a multi-word
// case-insensitive search where EVERY word must match something — address,
// household number, or the name of any current member (which includes the
// head, since the head is a member). `active` selects which households to
// show: omitted/'true' = active only (the default), 'false' = inactive only,
// 'all' = both.
//
// Ordered by household number ascending: the head's name is the natural
// heading, but it lives behind a join and cannot be sorted on here, so the
// stable household number is used instead.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { page, perPage, from, to } = parsePaging(req.query);

  const active = String(req.query.active ?? 'true').toLowerCase();
  if (!['true', 'false', 'all'].includes(active)) {
    return res.status(400).json({ error: "active must be 'true', 'false', or 'all'" });
  }

  let query = supabase
    .from('household_records')
    .select('household_id, address, registered_at, is_active', { count: 'exact' })
    .order('household_id', { ascending: true })
    .range(from, to);

  if (active !== 'all') query = query.eq('is_active', active === 'true');

  for (const word of searchWords(req.query.search)) {
    const ors = [`address.ilike.*${word}*`];
    // A bare number is most likely the household number being looked up.
    if (/^\d+$/.test(word)) ors.push(`household_id.eq.${word}`);
    const memberHouseholds = await householdIdsMatchingMember(word);
    if (memberHouseholds.length) ors.push(`household_id.in.(${memberHouseholds.join(',')})`);
    query = query.or(ors.join(','));
  }

  // How many households exist at all, ignoring both the filter and the search.
  // The empty state needs this to tell "nothing registered yet" apart from
  // "nothing matches this filter" — otherwise an empty Inactive view claims no
  // household has ever been registered. head:true counts in the database and
  // transfers no rows.
  const { count: totalAll, error: totalErr } = await supabase
    .from('household_records')
    .select('household_id', { count: 'exact', head: true });
  if (totalErr) throw new Error(`Failed to count households: ${totalErr.message}`);

  const { data, count, error } = await query;
  if (error) {
    if (isRangeError(error)) {
      return res.json({ ...pageResponse('households', [], 0, page, perPage), total_all: totalAll || 0 });
    }
    throw new Error(`Failed to load households: ${error.message}`);
  }

  // One membership lookup for the whole page, rather than per row.
  let membersByHousehold = {};
  if (data.length > 0) {
    const { data: members, error: mErr } = await supabase
      .from('household_members')
      .select(MEMBER_FIELDS)
      .is('date_ended', null)
      .in('household_id', data.map((h) => h.household_id));
    if (mErr) throw new Error(`Failed to load household members: ${mErr.message}`);
    for (const m of members) {
      (membersByHousehold[m.household_id] ||= []).push(m);
    }
  }

  const households = data.map((h) => {
    const members = membersByHousehold[h.household_id] || [];
    const head = headOf(members);
    return {
      household_id: h.household_id,
      address: h.address,
      registered_at: h.registered_at,
      is_active: h.is_active,
      head_name: head ? residentName(embedded(head.resident_records)) : null,
      head_resident_id: head ? head.resident_id : null,
      member_count: members.length,
    };
  });

  res.json({ ...pageResponse('households', households, count, page, perPage), total_all: totalAll || 0 });
});

// ---------------------------------------------------------------------------
// GET /api/households/:id — the household with its members, head first.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid household id' });
  }

  const { data: household, error } = await supabase
    .from('household_records')
    .select('household_id, address, registered_at, is_active')
    .eq('household_id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load household: ${error.message}`);
  if (!household) return res.status(404).json({ error: 'Household not found' });

  const { data: members, error: mErr } = await supabase
    .from('household_members')
    .select(MEMBER_FIELDS)
    .eq('household_id', id);
  if (mErr) throw new Error(`Failed to load household members: ${mErr.message}`);

  const ordered = sortMembers(members).map(shapeMember);
  const head = ordered.find((m) => m.role === HOUSEHOLD_ROLE.HEAD && m.is_active) || null;

  res.json({
    household: {
      ...household,
      head_name: head?.name ?? null,
      head_resident_id: head?.resident_id ?? null,
      head_is_archived: head?.resident_is_archived ?? null,
      member_count: ordered.filter((m) => m.is_active).length,
      members: ordered,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/households — create a household and install its head.
//
// ATOMICITY: supabase-js has no transactions, so this uses the compensation
// pattern the rest of the codebase uses — insert in order, and unwind anything
// already written if a later step fails. A household must never exist without
// its head, and a head must never exist without a QR row.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const address = String(req.body?.address ?? '').trim();
  const headResidentId = Number(req.body?.head_resident_id);

  if (!address) return res.status(400).json({ error: 'Address is required' });
  if (address.length > MAX_ADDRESS) {
    return res.status(400).json({ error: `Address must be ${MAX_ADDRESS} characters or fewer` });
  }
  if (!Number.isInteger(headResidentId)) {
    return res.status(400).json({ error: 'A valid head_resident_id is required' });
  }

  // The head must be a real, non-archived resident.
  const { data: head, error: headErr } = await supabase
    .from('resident_records')
    .select('resident_id, first_name, middle_name, last_name, suffix, address, is_archived')
    .eq('resident_id', headResidentId)
    .maybeSingle();
  if (headErr) throw new Error(`Failed to load the head resident: ${headErr.message}`);
  if (!head) return res.status(404).json({ error: 'That resident record does not exist' });
  if (head.is_archived) {
    return res.status(400).json({
      error: `${residentName(head)} is an archived resident record and cannot be made a household head`,
    });
  }

  // A resident belongs to at most one household at a time.
  const { data: existing, error: existingErr } = await supabase
    .from('household_members')
    .select('household_id, role')
    .eq('resident_id', headResidentId)
    .is('date_ended', null)
    .maybeSingle();
  if (existingErr) throw new Error(`Failed to check existing membership: ${existingErr.message}`);
  if (existing) {
    // Name that household by its head, so the Secretary can go straight to it.
    const { data: theirMembers } = await supabase
      .from('household_members')
      .select(MEMBER_FIELDS)
      .eq('household_id', existing.household_id)
      .is('date_ended', null);
    const theirHead = headOf(theirMembers);
    // Name that household by its head so the Secretary can go straight to it —
    // but not when the blocked resident IS that head, where "Juan is already a
    // member of household #1 (household of Juan)" just repeats itself.
    const headIsSelf = !!theirHead && theirHead.resident_id === headResidentId;
    const theirHeadName = theirHead ? residentName(embedded(theirHead.resident_records)) : null;
    return res.status(409).json({
      error:
        `${residentName(head)} is already an active member of household #${existing.household_id}` +
        `${theirHeadName && !headIsSelf ? ` (household of ${theirHeadName})` : ''}. ` +
        'A resident can belong to only one household at a time.',
      household_id: existing.household_id,
      head_name: theirHeadName,
      // Lets the UI drop the "(household of …)" hint rather than echo the name
      // it just showed. head_name stays truthful so it never reads as "this
      // household has no head".
      head_is_self: headIsSelf,
    });
  }

  // Shared addresses are legitimate (two households at one address), so this
  // only produces a NOTICE. Compared in Node because the normalisation is not
  // expressible as a PostgREST filter; households are few enough for this to
  // be cheap, and creates are rare.
  const { data: activeHouseholds, error: dupErr } = await supabase
    .from('household_records')
    .select('household_id, address')
    .eq('is_active', true);
  if (dupErr) throw new Error(`Failed to check existing addresses: ${dupErr.message}`);
  const wanted = normalizeAddress(address);
  const sameAddress = (activeHouseholds || []).filter((h) => normalizeAddress(h.address) === wanted);

  // --- write: household -> head membership -> QR ---------------------------
  const { data: created, error: createErr } = await supabase
    .from('household_records')
    .insert({ address, registered_at: new Date().toISOString(), is_active: true })
    .select('household_id, address, registered_at, is_active')
    .single();
  if (createErr) throw new Error(`Failed to create the household: ${createErr.message}`);

  const { data: membership, error: memberErr } = await supabase
    .from('household_members')
    .insert({
      household_id: created.household_id,
      resident_id: headResidentId,
      role: HOUSEHOLD_ROLE.HEAD,
      date_started: todayInManila(),
      date_ended: null,
    })
    .select('membership_id')
    .single();
  if (memberErr) {
    // A household with no head is meaningless — undo it.
    await supabase.from('household_records').delete().eq('household_id', created.household_id);
    throw new Error(`Household not created — failed to assign the head: ${memberErr.message}`);
  }

  const { error: qrErr } = await supabase.from('household_qr').insert({
    household_id: created.household_id,
    qr_token: crypto.randomUUID(),
    is_active: true,
  });
  if (qrErr) {
    await supabase.from('household_members').delete().eq('membership_id', membership.membership_id);
    await supabase.from('household_records').delete().eq('household_id', created.household_id);
    throw new Error(`Household not created — failed to issue its QR code: ${qrErr.message}`);
  }

  res.status(201).json({
    message: `Household #${created.household_id} created with ${residentName(head)} as head.`,
    household: {
      ...created,
      head_name: residentName(head),
      head_resident_id: head.resident_id,
      member_count: 1,
    },
    // Non-blocking: the UI surfaces this, it does not treat it as a failure.
    notice: sameAddress.length
      ? `Note: ${sameAddress.length} other active household${sameAddress.length === 1 ? ' is' : 's are'} ` +
        `already registered at this address (#${sameAddress.map((h) => h.household_id).join(', #')}). ` +
        'This is allowed — households are identified by their head, not their address.'
      : null,
  });
});

module.exports = router;
