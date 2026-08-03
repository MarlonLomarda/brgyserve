const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { HOUSEHOLD_ROLE, HOUSEHOLD_ROLES, ROLE_ORDER } = require('../constants/households');
const { searchWords, parsePaging, isRangeError, pageResponse } = require('../utils/listQuery');

const router = express.Router();

// Stage 1 was Secretary-only at the router level. Stage 2 opens READ access to
// Staff, so the gate moved to per-route guards: every GET allows both roles,
// every write stays Secretary-only. The Punong Barangay, the Treasurer and
// residents still get 403 on everything here.
router.use(authenticate);
const VIEW_ROLES = ['secretary', 'staff'];

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

// --- stage 2 shared helpers -------------------------------------------------

// Roles a member may hold through the member endpoints. 'Head' is excluded on
// purpose: headship changes only through POST /:id/head, so a household can
// never acquire a second head by a role edit.
const assignableRole = (role) => {
  const value = String(role ?? '').trim();
  if (!value) return { error: 'A role is required' };
  if (!HOUSEHOLD_ROLES.includes(value)) {
    return { error: `role must be one of: ${HOUSEHOLD_ROLES.join(', ')}` };
  }
  if (value === HOUSEHOLD_ROLE.HEAD) {
    return { error: "Use the 'make head' action to change a household's head, not the role field" };
  }
  return { value };
};

const loadHousehold = async (id) => {
  const { data, error } = await supabase
    .from('household_records')
    .select('household_id, address, registered_at, is_active')
    .eq('household_id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load household: ${error.message}`);
  return data;
};

const loadResident = async (id) => {
  const { data, error } = await supabase
    .from('resident_records')
    .select('resident_id, first_name, middle_name, last_name, suffix, address, is_archived')
    .eq('resident_id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load resident: ${error.message}`);
  return data;
};

// The one active membership a resident may hold, if any.
const activeMembershipOf = async (residentId) => {
  const { data, error } = await supabase
    .from('household_members')
    .select('membership_id, household_id, resident_id, role, date_started')
    .eq('resident_id', residentId)
    .is('date_ended', null)
    .maybeSingle();
  if (error) throw new Error(`Failed to check existing membership: ${error.message}`);
  return data;
};

// The 409 body used whenever a resident is already placed elsewhere — same
// shape and same self-reference rule as the stage 1 create conflict, so the UI
// handles both with one code path.
async function membershipConflict(resident, existing) {
  const { data: theirMembers } = await supabase
    .from('household_members')
    .select(MEMBER_FIELDS)
    .eq('household_id', existing.household_id)
    .is('date_ended', null);
  const theirHead = headOf(theirMembers);
  const headIsSelf = !!theirHead && theirHead.resident_id === resident.resident_id;
  const theirHeadName = theirHead ? residentName(embedded(theirHead.resident_records)) : null;
  return {
    error:
      `${residentName(resident)} is already an active member of household #${existing.household_id}` +
      `${theirHeadName && !headIsSelf ? ` (household of ${theirHeadName})` : ''}. ` +
      'A resident can belong to only one household at a time.',
    household_id: existing.household_id,
    head_name: theirHeadName,
    head_is_self: headIsSelf,
  };
}

// Memberships are NEVER hard-deleted: the history is the audit trail, so
// leaving a household is recorded as an end date.
const endMembership = async (membershipId, when) => {
  const { error } = await supabase
    .from('household_members')
    .update({ date_ended: when })
    .eq('membership_id', membershipId);
  if (error) throw new Error(`Failed to end the membership: ${error.message}`);
};

// A membership row that belongs to this household, with its resident joined.
const loadMembership = async (householdId, membershipId) => {
  const { data, error } = await supabase
    .from('household_members')
    .select(MEMBER_FIELDS)
    .eq('membership_id', membershipId)
    .eq('household_id', householdId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the membership: ${error.message}`);
  return data;
};

// Households sharing a normalized address — a NOTICE, never an error.
async function sameAddressNotice(address, exceptHouseholdId = null) {
  const { data, error } = await supabase
    .from('household_records')
    .select('household_id, address')
    .eq('is_active', true);
  if (error) throw new Error(`Failed to check existing addresses: ${error.message}`);
  const wanted = normalizeAddress(address);
  const matches = (data || []).filter(
    (h) => normalizeAddress(h.address) === wanted && h.household_id !== exceptHouseholdId
  );
  if (!matches.length) return null;
  return (
    `Note: ${matches.length} other active household${matches.length === 1 ? ' is' : 's are'} ` +
    `already registered at this address (#${matches.map((h) => h.household_id).join(', #')}). ` +
    'This is allowed — households are identified by their head, not their address.'
  );
}

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
router.get('/', requireRole(...VIEW_ROLES), async (req, res) => {
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
// GET /api/households/unassigned-residents?search=&page=&per_page=
//
// Active residents who belong to no household — the gap the Secretary works
// down. DECLARED BEFORE '/:id', otherwise the param route would swallow
// "unassigned-residents" and reject it as a non-numeric id.
//
// Computed by subtracting the placed residents from the candidates rather than
// with a NOT IN filter: the placed set can run to thousands of ids, which would
// not survive being serialised into a PostgREST query string. Both halves
// select only resident_id, so the payload stays small, and the subtraction is
// exact — so the count and paging are exact too.
// ---------------------------------------------------------------------------
router.get('/unassigned-residents', requireRole(...VIEW_ROLES), async (req, res) => {
  const { page, perPage, from } = parsePaging(req.query);

  let candidates = supabase
    .from('resident_records')
    .select('resident_id')
    .eq('is_archived', false)
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true });

  for (const word of searchWords(req.query.search)) {
    candidates = candidates.or(
      `first_name.ilike.*${word}*,middle_name.ilike.*${word}*,last_name.ilike.*${word}*,address.ilike.*${word}*`
    );
  }

  const { data: candidateRows, error: cErr } = await candidates;
  if (cErr) throw new Error(`Failed to load residents: ${cErr.message}`);

  const { data: placed, error: pErr } = await supabase
    .from('household_members')
    .select('resident_id')
    .is('date_ended', null);
  if (pErr) throw new Error(`Failed to load memberships: ${pErr.message}`);
  const placedIds = new Set((placed || []).map((m) => m.resident_id));

  const unassignedIds = (candidateRows || [])
    .map((r) => r.resident_id)
    .filter((id) => !placedIds.has(id));
  const pageIds = unassignedIds.slice(from, from + perPage);

  let residents = [];
  if (pageIds.length) {
    const { data: rows, error: rErr } = await supabase
      .from('resident_records')
      .select('resident_id, first_name, middle_name, last_name, suffix, birthdate, sex, address, contact_number')
      .in('resident_id', pageIds);
    if (rErr) throw new Error(`Failed to load residents: ${rErr.message}`);
    // .in() does not preserve the ordered slice, so restore it.
    const order = new Map(pageIds.map((id, i) => [id, i]));
    residents = (rows || [])
      .sort((a, b) => order.get(a.resident_id) - order.get(b.resident_id))
      .map((r) => ({ ...r, name: residentName(r) }));
  }

  res.json(pageResponse('residents', residents, unassignedIds.length, page, perPage));
});

// ---------------------------------------------------------------------------
// GET /api/households/:id — the household with its members, head first.
// ---------------------------------------------------------------------------
router.get('/:id', requireRole(...VIEW_ROLES), async (req, res) => {
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
router.post('/', requireRole('secretary'), async (req, res) => {
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

// ===========================================================================
// STAGE 2 — member management, headship, household edit/deactivate.
// All Secretary-only; Staff reaches the GETs above but never these.
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/households/:id/members — add a member.
//
// `transfer: true` moves a resident who is already placed: their old
// membership is ENDED (never deleted) and a new one starts today. If the new
// insert fails the old membership is un-ended, so a resident can never be left
// belonging to nothing.
// ---------------------------------------------------------------------------
router.post('/:id/members', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid household id' });

  const residentId = Number(req.body?.resident_id);
  if (!Number.isInteger(residentId)) {
    return res.status(400).json({ error: 'A valid resident_id is required' });
  }
  const roleCheck = assignableRole(req.body?.role);
  if (roleCheck.error) return res.status(400).json({ error: roleCheck.error });
  const transfer = req.body?.transfer === true;

  const household = await loadHousehold(id);
  if (!household) return res.status(404).json({ error: 'Household not found' });
  if (!household.is_active) {
    return res.status(409).json({
      error: `Household #${id} is inactive. Reactivate it before adding members.`,
    });
  }

  const resident = await loadResident(residentId);
  if (!resident) return res.status(404).json({ error: 'That resident record does not exist' });
  if (resident.is_archived) {
    return res.status(400).json({
      error: `${residentName(resident)} is an archived resident record and cannot be added to a household`,
    });
  }

  const existing = await activeMembershipOf(residentId);
  if (existing && existing.household_id === id) {
    return res.status(409).json({
      error: `${residentName(resident)} is already an active member of this household.`,
      household_id: id,
    });
  }
  if (existing && !transfer) {
    return res.status(409).json(await membershipConflict(resident, existing));
  }

  const today = todayInManila();
  if (existing) await endMembership(existing.membership_id, today);

  const { data: inserted, error: insertErr } = await supabase
    .from('household_members')
    .insert({
      household_id: id,
      resident_id: residentId,
      role: roleCheck.value,
      date_started: today,
      date_ended: null,
    })
    .select(MEMBER_FIELDS)
    .single();
  if (insertErr) {
    // Put the resident back where they were rather than stranding them.
    if (existing) {
      await supabase
        .from('household_members')
        .update({ date_ended: null })
        .eq('membership_id', existing.membership_id);
    }
    throw new Error(`Failed to add the member: ${insertErr.message}`);
  }

  res.status(201).json({
    message: existing
      ? `${residentName(resident)} moved from household #${existing.household_id} and added as ${roleCheck.value}.`
      : `${residentName(resident)} added as ${roleCheck.value}.`,
    member: shapeMember(inserted),
    transferred_from: existing ? existing.household_id : null,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/households/:id/members/:membershipId — change a member's role.
// ---------------------------------------------------------------------------
router.patch('/:id/members/:membershipId', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  const membershipId = Number(req.params.membershipId);
  if (!Number.isInteger(id) || !Number.isInteger(membershipId)) {
    return res.status(400).json({ error: 'Invalid household or membership id' });
  }
  const roleCheck = assignableRole(req.body?.role);
  if (roleCheck.error) return res.status(400).json({ error: roleCheck.error });

  const membership = await loadMembership(id, membershipId);
  if (!membership) return res.status(404).json({ error: 'Membership not found in this household' });
  if (!isActiveMembership(membership)) {
    return res.status(409).json({
      error: 'That membership has already ended and can no longer be changed.',
    });
  }
  if (membership.role === HOUSEHOLD_ROLE.HEAD) {
    return res.status(409).json({
      error:
        "This member is the household head. Use 'make head' on another member to reassign headship, " +
        'which will set this member’s new role.',
    });
  }

  const { data: updated, error } = await supabase
    .from('household_members')
    .update({ role: roleCheck.value })
    .eq('membership_id', membershipId)
    .select(MEMBER_FIELDS)
    .single();
  if (error) throw new Error(`Failed to change the role: ${error.message}`);

  res.json({
    message: `${residentName(embedded(membership.resident_records))} is now ${roleCheck.value}.`,
    member: shapeMember(updated),
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/households/:id/members/:membershipId — end a membership.
// Ends it (date_ended = today); the row is never removed.
// ---------------------------------------------------------------------------
router.delete('/:id/members/:membershipId', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  const membershipId = Number(req.params.membershipId);
  if (!Number.isInteger(id) || !Number.isInteger(membershipId)) {
    return res.status(400).json({ error: 'Invalid household or membership id' });
  }

  const membership = await loadMembership(id, membershipId);
  if (!membership) return res.status(404).json({ error: 'Membership not found in this household' });
  if (!isActiveMembership(membership)) {
    return res.status(409).json({ error: 'That membership has already ended.' });
  }
  // A household is identified by its head, so it must never be left headless
  // by an ordinary remove.
  if (membership.role === HOUSEHOLD_ROLE.HEAD) {
    return res.status(409).json({
      error:
        'The household head cannot be removed directly. Reassign the head to another member first, ' +
        'or deactivate the household.',
    });
  }

  const today = todayInManila();
  await endMembership(membershipId, today);

  res.json({
    message: `${residentName(embedded(membership.resident_records))} is no longer a member of household #${id}.`,
    membership_id: membershipId,
    date_ended: today,
  });
});

// ---------------------------------------------------------------------------
// POST /api/households/:id/head — reassign headship.
//
// Demotes the sitting head, then promotes the new one. Done in that order
// deliberately: a failure between the two leaves the household briefly with NO
// head, which the detail screen already flags, rather than with TWO heads,
// where "the head" would be ambiguous. The demotion is restored if the
// promotion fails.
// ---------------------------------------------------------------------------
router.post('/:id/head', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  const membershipId = Number(req.body?.membership_id);
  if (!Number.isInteger(id) || !Number.isInteger(membershipId)) {
    return res.status(400).json({ error: 'A valid household id and membership_id are required' });
  }

  const household = await loadHousehold(id);
  if (!household) return res.status(404).json({ error: 'Household not found' });

  const membership = await loadMembership(id, membershipId);
  if (!membership) return res.status(404).json({ error: 'Membership not found in this household' });
  if (!isActiveMembership(membership)) {
    return res.status(409).json({ error: 'That membership has ended — an inactive member cannot become head.' });
  }
  if (membership.role === HOUSEHOLD_ROLE.HEAD) {
    return res.status(409).json({ error: 'That member is already the household head.' });
  }
  const newHeadResident = embedded(membership.resident_records);
  if (newHeadResident?.is_archived) {
    return res.status(400).json({
      error: `${residentName(newHeadResident)} is an archived resident record and cannot be made head`,
    });
  }

  const { data: allMembers, error: mErr } = await supabase
    .from('household_members')
    .select(MEMBER_FIELDS)
    .eq('household_id', id)
    .is('date_ended', null);
  if (mErr) throw new Error(`Failed to load household members: ${mErr.message}`);
  const currentHead = headOf(allMembers);

  // Only needed when there IS a sitting head to demote.
  let demoteRole = null;
  if (currentHead) {
    const demoteCheck = assignableRole(req.body?.demote_current_head_to);
    if (demoteCheck.error) {
      return res.status(400).json({
        error: `demote_current_head_to: ${demoteCheck.error}`,
      });
    }
    demoteRole = demoteCheck.value;

    const { error: demoteErr } = await supabase
      .from('household_members')
      .update({ role: demoteRole })
      .eq('membership_id', currentHead.membership_id);
    if (demoteErr) throw new Error(`Failed to demote the current head: ${demoteErr.message}`);
  }

  const { error: promoteErr } = await supabase
    .from('household_members')
    .update({ role: HOUSEHOLD_ROLE.HEAD })
    .eq('membership_id', membershipId);
  if (promoteErr) {
    if (currentHead) {
      await supabase
        .from('household_members')
        .update({ role: HOUSEHOLD_ROLE.HEAD })
        .eq('membership_id', currentHead.membership_id);
    }
    throw new Error(`Head unchanged — failed to promote the new head: ${promoteErr.message}`);
  }

  res.json({
    message: currentHead
      ? `${residentName(newHeadResident)} is now the head of household #${id}; ` +
        `${residentName(embedded(currentHead.resident_records))} is now ${demoteRole}.`
      : `${residentName(newHeadResident)} is now the head of household #${id}.`,
    head_resident_id: membership.resident_id,
    previous_head_resident_id: currentHead ? currentHead.resident_id : null,
    previous_head_role: demoteRole,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/households/:id — edit the address and/or activate-deactivate.
//
// Deactivating ENDS every active membership, which frees those residents to
// join other households. Reactivating does NOT restore them — see CLAUDE.md
// for why this is deliberately asymmetric with the resident archive cascade.
// ---------------------------------------------------------------------------
router.patch('/:id', requireRole('secretary'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid household id' });

  const hasAddress = req.body?.address !== undefined;
  const hasActive = req.body?.is_active !== undefined;
  if (!hasAddress && !hasActive) {
    return res.status(400).json({ error: 'Nothing to update — provide address and/or is_active' });
  }
  if (hasActive && typeof req.body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false' });
  }

  const updates = {};
  let address = null;
  if (hasAddress) {
    address = String(req.body.address ?? '').trim();
    if (!address) return res.status(400).json({ error: 'Address is required' });
    if (address.length > MAX_ADDRESS) {
      return res.status(400).json({ error: `Address must be ${MAX_ADDRESS} characters or fewer` });
    }
    updates.address = address;
  }
  if (hasActive) updates.is_active = req.body.is_active;

  const household = await loadHousehold(id);
  if (!household) return res.status(404).json({ error: 'Household not found' });

  const deactivating = hasActive && req.body.is_active === false && household.is_active;

  const { data: updated, error } = await supabase
    .from('household_records')
    .update(updates)
    .eq('household_id', id)
    .select('household_id, address, registered_at, is_active')
    .single();
  if (error) throw new Error(`Failed to update the household: ${error.message}`);

  // One bulk statement, so the memberships either all end or none do.
  let endedCount = 0;
  if (deactivating) {
    const { data: ended, error: endErr } = await supabase
      .from('household_members')
      .update({ date_ended: todayInManila() })
      .eq('household_id', id)
      .is('date_ended', null)
      .select('membership_id');
    if (endErr) {
      // Leave no inactive household with live memberships hanging off it.
      await supabase
        .from('household_records')
        .update({ is_active: household.is_active })
        .eq('household_id', id);
      throw new Error(`Household unchanged — failed to end its memberships: ${endErr.message}`);
    }
    endedCount = (ended || []).length;
  }

  const notice = hasAddress ? await sameAddressNotice(address, id) : null;
  const parts = [];
  if (hasAddress) parts.push('address updated');
  if (hasActive) parts.push(req.body.is_active ? 'household reactivated' : 'household deactivated');
  if (deactivating) {
    parts.push(`${endedCount} membership${endedCount === 1 ? '' : 's'} ended`);
  }

  res.json({
    message: `Household #${id}: ${parts.join(', ')}.`,
    household: updated,
    memberships_ended: endedCount,
    notice,
  });
});

module.exports = router;
