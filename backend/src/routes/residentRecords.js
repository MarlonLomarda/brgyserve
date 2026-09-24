const express = require('express');
const jaroWinkler = require('jaro-winkler');
const { parse: parseCsv } = require('csv-parse/sync');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { findMatches, DEFAULTS, normalize } = require('../services/nameMatching');
const { REQUEST_STATUS } = require('../constants/requestStatus');
const { RENTAL_STATUS, RETURNABLE_TYPES } = require('../constants/rentals');
const { DEFAULT_PER_PAGE, MAX_PER_PAGE, sanitizeTerm } = require('../utils/listQuery');
const { toCsvTable } = require('../utils/csv');

const router = express.Router();

// PER-ROUTE GUARDS, NOT A ROUTER-LEVEL ONE. This file used to open with
// `router.use(authenticate, requireRole('secretary'))`, which made every route
// Secretary-only by default. The Punong Barangay and Staff now READ the master
// list, so the gate moved onto each route individually — the same migration
// Households made at its stage 2.
//
// THE COST OF THAT MOVE: this file no longer fails closed. A route added below
// without an explicit requireRole(...) is readable by ANY authenticated user,
// residents included. `npm run roles:test` asserts every route in this file
// declares a guard, so that mistake fails a test instead of shipping.
//
// Residents are excluded from all of it and keep GET /api/residents/me.
router.use(authenticate);

// Roles that may READ. Writes stay requireRole('secretary') and must never be
// widened to this list.
const VIEW_ROLES = ['secretary', 'punong_barangay', 'staff'];

// ---------------------------------------------------------------------------
// DATA MINIMIZATION — the first role-varying response body in this codebase.
//
// Every other role check in the system is all-or-nothing: requireRole() either
// admits you to a handler or 403s you, and no route reads req.user.role to
// shape what it returns. This one does, deliberately.
//
// WHY: the use-case diagram gives Staff read access to resident records, but a
// resident's religion, birthplace, sex, civil status, contact number and
// linked account are not needed to do any Staff task. Staff process rental
// returns, events and attendance; none of that requires knowing someone's
// religion. The Punong Barangay is an approving authority and sees the full
// record, as the Secretary does.
//
// WHY ON THE SERVER: hiding these columns in the frontend would still ship
// them to the browser, where anyone can read them out of the network tab. The
// only narrowing that means anything happens before the response is written.
//
// The eight columns below are the WHOLE of what Staff may see of a resident.
// This constant is the single source of truth for that rule; the document
// requests module imports the same list conceptually (see STAFF_DETAIL_FIELDS
// there) because the resident record reaches Staff through that module too.
// ---------------------------------------------------------------------------
const STAFF_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, is_archived';

// masterlist_registered_on is in LIST_FIELDS but deliberately NOT in
// STAFF_FIELDS. The argument is the one written above: Staff read records to
// confirm a resident is registered, an identity task, and the six-month
// residency judgement belongs to the Secretary — the whole rejection module is
// Secretary-only. date_registered is already withheld from Staff, so exposing
// a second and more meaningful registration date while hiding the first would
// be incoherent. `roles:test` sweeps for this column by name, so the omission
// is guarded rather than incidental.
const LIST_FIELDS =
  'resident_id, first_name, middle_name, last_name, suffix, birthdate, address, contact_number, date_registered, masterlist_registered_on, is_archived';

// Staff get STAFF_FIELDS; everyone admitted by VIEW_ROLES gets the full
// projection. Non-staff behaviour is byte-identical to before this change.
const isStaff = (req) => req.user?.role === 'staff';
const listFieldsFor = (req) => (isStaff(req) ? STAFF_FIELDS : LIST_FIELDS);

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

// Validates one optional YYYY-MM-DD column. Returns { error } or { value }.
//
// TWO date columns now share these rules, so there is ONE implementation:
//   birthdate                — when the resident was born
//   masterlist_registered_on — when the barangay registered them (migration
//                              018), which the six-month residency rule counts
//                              from
// They validate identically: shape first (the regex catches 2026-13-45 before
// Date can quietly accept it), then validity, then not-in-the-future. The
// +08:00 composition matters — comparing a bare date against `new Date()` in
// UTC would call today's date "future" for the first eight hours of every
// Manila day. Keeping this in one function is what stops the two columns
// drifting apart on that detail.
//
// A BLANK VALUE CLEARS THE COLUMN (null, not ''), so an edit can remove a
// date entered by mistake.
const DATE_RE_MSG = 'must be in YYYY-MM-DD format';
function validateOptionalDate(body, field, label) {
  const raw = String(body?.[field] ?? '').trim();
  if (!raw) return { value: null };

  if (!DATE_RE.test(raw)) return { error: `${label} ${DATE_RE_MSG}` };
  const parsed = new Date(`${raw}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return { error: `${label} is not a valid date` };
  if (parsed > new Date()) return { error: `${label} cannot be in the future` };
  return { value: raw };
}

// Validates the writable columns; returns { error } or { value }, the same
// shape document types and rental items use.
//
// WHAT IS NEVER CLIENT-WRITABLE: resident_id, date_registered and is_archived.
// This is not a denylist — `value` is built key by key from the lists below,
// so a column that is not named here simply cannot enter an insert or update.
// Note that this is about those three columns specifically and NOT about dates
// in general: birthdate and masterlist_registered_on are both writable on add
// and edit. date_registered is locked because it records when the row entered
// BrgyServe, which only the server can know; masterlist_registered_on records
// something only the barangay knows, so the Secretary supplies it.
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

  for (const [field, label] of [
    ['birthdate', 'birthdate'],
    ['masterlist_registered_on', 'masterlist registration date'],
  ]) {
    const result = validateOptionalDate(body, field, label);
    if (result.error) return { error: result.error };
    value[field] = result.value;
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

// ?archived= on the list and on the export: omitted/'false' = active only,
// 'true' = archived only, 'all' = both. Returns null for anything else, which
// both routes answer with a 400 rather than silently showing the default.
const ARCHIVED_FILTERS = ['false', 'true', 'all'];
const ARCHIVED_FILTER_ERROR = "archived must be 'false', 'true', or 'all'";
function archivedFilterOf(req) {
  const archived = String(req.query.archived ?? 'false').toLowerCase();
  return ARCHIVED_FILTERS.includes(archived) ? archived : null;
}

// GET /api/resident-records?search=&page=&per_page=&archived= — paginated
// master list, ordered by surname. `archived` selects which records to show:
// omitted/'false' = active only (the default), 'true' = archived only, 'all'
// = both. Search is case-insensitive partial match: every word must match at
// least one of first/middle/last name or address (so "juan dela" finds Juan
// Dela Cruz, and "purok 2" works as an address/purok filter). Each row
// carries the linked account (via profiles.resident_id) so the list can show
// who is registered.
router.get('/', requireRole(...VIEW_ROLES), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPageRaw = Number(req.query.per_page) || DEFAULT_PER_PAGE;
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, perPageRaw));
  const from = (page - 1) * perPage;

  const archived = archivedFilterOf(req);
  if (!archived) {
    return res.status(400).json({ error: ARCHIVED_FILTER_ERROR });
  }

  let query = supabase
    .from('resident_records')
    .select(listFieldsFor(req), { count: 'exact' })
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
  //
  // SKIPPED ENTIRELY FOR STAFF: the linked account is one of the things Staff
  // may not see, so the lookup is not merely stripped from the response — it is
  // never run.
  let accountsByResident = {};
  if (data.length > 0 && !isStaff(req)) {
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

  // WITHHELD MEANS ABSENT, NOT NULL. Every other field Staff may not see is
  // simply missing from the row, and the client drops a column when
  // `key in row` is false. `account: null` was the one exception, and it read
  // as a POSITIVE claim — an Account column of em dashes says "none of these
  // residents has registered online", which is false and unfalsifiable from
  // the payload: a genuine absence and a withheld value looked identical.
  // Omitting the key makes withholding detectable, so the column disappears
  // instead of lying. Note this is only the response SHAPE — the lookup above
  // is still skipped, so nothing extra is read either.
  const withAccount = (r) => (isStaff(req) ? r : { ...r, account: accountsByResident[r.resident_id] || null });

  res.json({
    records: data.map(withAccount),
    total: count,
    page,
    per_page: perPage,
    total_pages: Math.ceil((count || 0) / perPage),
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — the masterlist as CSV: an export, and a two-step bulk import.
//
// DECLARED ABOVE GET /:id ON PURPOSE. Express matches routes in declaration
// order, so below it GET /export would be read as a record id and answer 400.
//
// The import ADDS NEW RESIDENTS ONLY. It never updates a record — correcting a
// person stays the edit form's job — and it reuses the single-add route's own
// pieces rather than a parallel set: validateBody on every row, findMatches
// with DEFAULTS against the master list, asSuggestion for the match shape. The
// duplicate check stays SOFT, as it is for one record: a flagged row goes in
// only when the Secretary says so, row by row.
//
// It is TWO requests over the SAME file text, and the server keeps nothing in
// between. /import/preview analyses the file and writes nothing;
// /import/commit analyses it again from scratch and inserts. Nothing from the
// preview is trusted — the master list may have changed in the meantime — and
// the Secretary's decisions are checked against the fresh analysis.
// ---------------------------------------------------------------------------

// The template: every column validateBody writes (REQUIRED_FIELDS,
// OPTIONAL_TEXT_FIELDS and the two dates), in table order. It is both the
// export's leading columns and the set of headers an import accepts, so a
// writable column added to validateBody's lists belongs here too — otherwise
// the export leaves it out and the import rejects it as an unknown header.
const TEMPLATE_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'suffix', 'birthdate', 'birthplace',
  'address', 'sex', 'civil_status', 'religion', 'educational_attainment',
  'contact_number', 'masterlist_registered_on',
];
// Trailing export columns, for reference only. An import accepts them as
// headers so an exported file can be read back, and ignores their values —
// except a filled resident_id, which marks a row already on the master list
// (see checkImportRow).
const REFERENCE_COLUMNS = ['resident_id', 'date_registered', 'is_archived'];
const EXPORT_COLUMNS = [...TEMPLATE_COLUMNS, ...REFERENCE_COLUMNS];
const KNOWN_HEADERS = new Set(EXPORT_COLUMNS);

const IMPORT_MAX_ROWS = 1000;
const IMPORT_MAX_SIZE = '2mb';
// findMatches is one database round trip per row. Measured from a development
// machine: about 186 ms each in sequence, and 20 in parallel in 762 ms. Eight
// at a time keeps a 1,000-row file to seconds without a connection per row.
const MATCH_CONCURRENCY = 8;

// express.text, scoped to the two import routes and called from INSIDE their
// handlers rather than listed beside requireRole. That way the body is read
// only after the role check has passed, so nobody but the Secretary gets 2 MB
// read on their behalf — and `npm run roles:test` runs every function in a
// route's stack except the last as a role guard, which a body parser is not.
// The global express.json() in server.js ignores text/csv, so its 100 KB
// default never applies to these routes.
const csvBodyParser = express.text({ type: 'text/csv', limit: IMPORT_MAX_SIZE });

// Reads the uploaded file for either import route. Returns the text, or sends
// the error response itself and returns null. Body-parser errors are answered
// here because server.js's error handler would turn a 413 into a 500.
async function readImportText(req, res) {
  try {
    await new Promise((resolve, reject) => {
      csvBodyParser(req, res, (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'The file is larger than 2 MB. Split it into smaller files and import each one.' });
      return null;
    }
    if (err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: `The file could not be read: ${err.message}` });
      return null;
    }
    throw err;
  }
  if (typeof req.body !== 'string') {
    res.status(415).json({ error: 'Send the file itself as the request body, with Content-Type: text/csv.' });
    return null;
  }
  return req.body;
}

// Header row problems that make the whole file unusable, or null. Headers are
// compared trimmed and lowercased, so "First_Name " is accepted.
function headerError(headers) {
  const blank = headers.findIndex((h) => !h);
  if (blank !== -1) return `Column ${blank + 1} has no header.`;

  const repeated = headers.find((h, i) => headers.indexOf(h) !== i);
  if (repeated) return `The column "${repeated}" appears more than once.`;

  const unknown = headers.filter((h) => !KNOWN_HEADERS.has(h));
  if (unknown.length) {
    return `Unrecognised column${unknown.length === 1 ? '' : 's'}: ${unknown.map((h) => `"${h}"`).join(', ')}. ` +
      `The columns an import accepts are: ${EXPORT_COLUMNS.join(', ')}.`;
  }

  const missing = REQUIRED_FIELDS.filter((f) => !headers.includes(f));
  if (missing.length) {
    return `The file is missing the required column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`;
  }
  return null;
}

// One row's verdict before any matching: { value } exactly as validateBody
// builds it, or { error }.
function checkImportRow(raw) {
  // The import only ADDS residents. A filled resident_id is a row copied from
  // an export, i.e. someone already on the master list. Ignoring the column
  // instead would be worse than it looks: the matcher skips archived records,
  // so an exported ARCHIVED resident would come back as a clean row and be
  // added again as a new, active person with nothing flagging it.
  const existingId = String(raw.resident_id ?? '').trim();
  if (existingId) {
    return {
      error: `This row is already on the master list as record #${existingId}. The import only adds new residents, so remove this row from the file.`,
    };
  }
  // A quoted cell can hold a line break. The add form cannot produce one, and a
  // name or address carrying it would break every screen that shows it.
  const broken = TEMPLATE_COLUMNS.find((c) => /[\r\n]/.test(raw[c] ?? ''));
  if (broken) return { error: `${broken.replace('_', ' ')} contains a line break` };

  const { error, value } = validateBody(raw);
  return error ? { error } : { value };
}

// fn over items with at most `limit` calls in flight; results keep item order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// A match against ANOTHER ROW of the same file: asSuggestion's shape, with the
// file's row number where a stored record would have its resident_id.
const asFileMatch = (row, score) => ({
  index: row.index,
  first_name: row.value.first_name,
  middle_name: row.value.middle_name,
  last_name: row.value.last_name,
  suffix: row.value.suffix,
  birthdate: row.value.birthdate,
  address: row.value.address,
  score,
});

// Everything both import routes need to know about a file, from its text plus
// read-only matching. Returns { fileError } when the file as a whole cannot be
// used, otherwise { rows, summary }.
//
// A row's `index` is the line where it ends in the file, counting the header
// as line 1 — the row number Excel shows, unless a cell above it contains a
// line break. It is stable for the same text, which is what lets /commit match
// the Secretary's decisions to rows it re-derives itself.
async function analyseImport(text) {
  // body-parser decodes as UTF-8 and replaces invalid bytes with U+FFFD. A
  // file saved in Excel's plain "CSV" format is Windows-1252, not UTF-8, and
  // would store ñ as garbage — which also breaks matching on exactly the
  // names (Niño/Nino) the evaluation set plants.
  if (text.includes('�')) {
    return {
      fileError: 'The file is not saved as UTF-8, so letters like ñ would be garbled. ' +
        'In Excel, use Save As → "CSV UTF-8 (Comma delimited)", then choose the file again.',
    };
  }

  let records;
  try {
    records = parseCsv(text, {
      bom: true,
      skip_empty_lines: true,
      skip_records_with_empty_values: true, // ",,,," rows Excel leaves behind
      info: true,
    });
  } catch (err) {
    return { fileError: `The file could not be read as CSV. ${err.message}` };
  }

  if (records.length === 0) return { fileError: 'The file is empty.' };

  const headers = records[0].record.map((h) => h.trim().toLowerCase());
  const badHeader = headerError(headers);
  if (badHeader) return { fileError: badHeader };

  const data = records.slice(1);
  if (data.length === 0) return { fileError: 'The file has a header row but no residents under it.' };
  if (data.length > IMPORT_MAX_ROWS) {
    return {
      fileError: `The file has ${data.length} rows; one import takes at most ${IMPORT_MAX_ROWS}. Split it into smaller files.`,
    };
  }

  const rows = data.map(({ record, info }) => {
    const raw = Object.fromEntries(headers.map((h, i) => [h, record[i]]));
    return { index: info.lines, raw, ...checkImportRow(raw) };
  });

  // Against the master list: the same call the single-add route makes.
  const valid = rows.filter((r) => r.value);
  const stored = await mapLimit(valid, MATCH_CONCURRENCY, (r) =>
    findMatches(r.value.first_name, r.value.last_name));
  valid.forEach((r, i) => {
    r.dbMatches = stored[i].map(asSuggestion);
    r.fileMatches = [];
    r.nameKey = normalize(`${r.value.first_name} ${r.value.last_name}`);
  });

  // Against each other: rows not yet inserted are invisible to the matcher, so
  // two near-identical rows in one file are compared here, pairwise, with
  // Stage 2's own scorer and threshold. There is no trigram blocking in front
  // of it, so it can flag a pair Stage 1 would have dropped — acceptable for a
  // check that only asks the Secretary to look. 1,000 rows is ~500,000 pairs,
  // measured at well under two seconds.
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const score = jaroWinkler(valid[i].nameKey, valid[j].nameKey);
      if (score >= DEFAULTS.scoreThreshold) {
        valid[i].fileMatches.push(asFileMatch(valid[j], score));
        valid[j].fileMatches.push(asFileMatch(valid[i], score));
      }
    }
  }

  const summary = { clean: 0, flagged: 0, invalid: 0 };
  const out = rows.map((r) => {
    if (!r.value) {
      summary.invalid++;
      // What the file said, for the columns it has — nothing is invented for
      // the ones it does not.
      const said = Object.fromEntries(
        TEMPLATE_COLUMNS.filter((c) => c in r.raw).map((c) => [c, String(r.raw[c]).trim()])
      );
      return { index: r.index, status: 'invalid', data: said, errors: [r.error] };
    }
    if (r.dbMatches.length || r.fileMatches.length) {
      summary.flagged++;
      r.fileMatches.sort((a, b) => b.score - a.score);
      return {
        index: r.index, status: 'flagged', data: r.value,
        db_matches: r.dbMatches, file_matches: r.fileMatches,
      };
    }
    summary.clean++;
    return { index: r.index, status: 'clean', data: r.value };
  });

  return { rows: out, summary };
}

// confirm_rows / skip_rows on /import/commit: comma-separated row numbers from
// the preview. They travel in the query string because the body is the file.
function parseRowList(raw, name) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: new Set() };
  const parts = text.split(',').map((p) => p.trim());
  if (parts.some((p) => !/^\d{1,7}$/.test(p))) {
    return { error: `${name} must be a comma-separated list of row numbers` };
  }
  return { value: new Set(parts.map(Number)) };
}

const rowWord = (n) => (n === 1 ? 'Row' : 'Rows');

// GET /api/resident-records/export?archived=false|true|all — the master list
// as a CSV download, in the import template's columns plus three reference
// columns. Secretary-only: it is the whole list with every contact detail.
router.get('/export', requireRole('secretary'), async (req, res) => {
  const archived = archivedFilterOf(req);
  if (!archived) {
    return res.status(400).json({ error: ARCHIVED_FILTER_ERROR });
  }

  // PostgREST caps each response (1,000 rows on Supabase unless configured
  // otherwise), so the export pages until it has the full count rather than
  // trusting one select to return everything. Advancing by what actually came
  // back keeps it correct under a lower cap too.
  const records = [];
  let total = Infinity;
  while (records.length < total) {
    let query = supabase
      .from('resident_records')
      .select(EXPORT_COLUMNS.join(', '), { count: 'exact' })
      .order('last_name', { ascending: true })
      .order('first_name', { ascending: true })
      .order('resident_id', { ascending: true })
      .range(records.length, records.length + 999);
    if (archived !== 'all') {
      query = query.eq('is_archived', archived === 'true');
    }
    const { data, count, error } = await query;
    if (error) {
      if (error.code === 'PGRST103') break; // past the end: nothing more
      throw new Error(`Failed to load resident records for export: ${error.message}`);
    }
    total = count ?? 0;
    if (data.length === 0) break;
    records.push(...data);
  }

  const scope = { false: 'active', true: 'archived', all: 'all' }[archived];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="resident-masterlist-${scope}-${today}.csv"`);
  // BOM so Excel reads ñ and other accents correctly, as the reports do.
  res.send('﻿' + toCsvTable(EXPORT_COLUMNS, records.map((r) => EXPORT_COLUMNS.map((c) => r[c]))));
});

// POST /api/resident-records/import/preview — body: the CSV file, as
// Content-Type text/csv. Analyses every row and WRITES NOTHING.
//   200 { rows: [{ index, status: clean|flagged|invalid, data, errors?,
//                  db_matches?, file_matches? }], summary: { clean, flagged, invalid } }
//   400 the file as a whole is unusable (empty, not CSV, not UTF-8, headers,
//       more than 1,000 rows); 413 larger than 2 MB; 415 not sent as text/csv
router.post('/import/preview', requireRole('secretary'), async (req, res) => {
  const text = await readImportText(req, res);
  if (text === null) return;

  const analysis = await analyseImport(text);
  if (analysis.fileError) {
    return res.status(400).json({ error: analysis.fileError });
  }
  res.json(analysis);
});

// POST /api/resident-records/import/commit?confirm_rows=3,17&skip_rows=9
// Body: the SAME CSV text the preview was given.
//
// Every flagged row needs a decision, and a decision is one of two things:
// confirm_rows (import it anyway) or skip_rows (leave it out). A flagged row in
// neither list is undecided and refuses the whole commit, exactly as the
// single-add route refuses a match without confirm_duplicate — so "not yet
// looked at" can never turn into "imported" or "dropped" by default.
//
//   201 { message, imported_count, resident_ids }
//   400 file errors, or any invalid row (named, with the preview shape)
//   409 the decisions do not cover the fresh analysis's flagged rows exactly,
//       with the preview shape so the screen can re-render it
router.post('/import/commit', requireRole('secretary'), async (req, res) => {
  const confirm = parseRowList(req.query.confirm_rows, 'confirm_rows');
  const skip = parseRowList(req.query.skip_rows, 'skip_rows');
  if (confirm.error || skip.error) {
    return res.status(400).json({ error: confirm.error || skip.error });
  }
  const both = [...confirm.value].filter((i) => skip.value.has(i));
  if (both.length) {
    return res.status(400).json({
      error: `${rowWord(both.length)} ${both.join(', ')} cannot be both imported and left out.`,
    });
  }

  const text = await readImportText(req, res);
  if (text === null) return;

  const analysis = await analyseImport(text);
  if (analysis.fileError) {
    return res.status(400).json({ error: analysis.fileError });
  }
  const { rows, summary } = analysis;

  const invalid = rows.filter((r) => r.status === 'invalid').map((r) => r.index);
  if (invalid.length) {
    return res.status(400).json({
      error: `${rowWord(invalid.length)} ${invalid.join(', ')} ${invalid.length === 1 ? 'has an error' : 'have errors'}. ` +
        'Fix the file and choose it again. Nothing was imported.',
      rows,
      summary,
    });
  }

  // The decisions must cover the flagged rows EXACTLY. An undecided row is the
  // single-add 409; a decision naming a row that is not flagged now means the
  // analysis changed since the preview — usually a matching record added or
  // archived in between — so the Secretary reviews again rather than having an
  // old answer applied to a new question.
  const flagged = new Set(rows.filter((r) => r.status === 'flagged').map((r) => r.index));
  const undecided = [...flagged].filter((i) => !confirm.value.has(i) && !skip.value.has(i));
  const stale = [...confirm.value, ...skip.value].filter((i) => !flagged.has(i));
  if (undecided.length || stale.length) {
    const parts = [];
    if (undecided.length) {
      parts.push(`${rowWord(undecided.length)} ${undecided.join(', ')} may duplicate an existing record or another row, and ${undecided.length === 1 ? 'needs' : 'need'} a decision.`);
    }
    if (stale.length) {
      parts.push(`${rowWord(stale.length)} ${stale.join(', ')} no longer ${stale.length === 1 ? 'needs' : 'need'} a decision, so the master list changed after the preview.`);
    }
    return res.status(409).json({
      error: `${parts.join(' ')} Review the preview again. Nothing was imported.`,
      rows,
      summary,
    });
  }

  const toInsert = rows.filter((r) => r.status === 'clean' || confirm.value.has(r.index));
  if (toInsert.length === 0) {
    return res.status(400).json({ error: 'Nothing to import: every row was left out.' });
  }

  // ONE insert for the whole file: PostgREST runs it as a single statement, so
  // either every row goes in or none does. Server-set columns exactly as the
  // single-add route sets them.
  const now = new Date().toISOString();
  const { data: inserted, error } = await supabase
    .from('resident_records')
    .insert(toInsert.map((r) => ({ ...r.data, date_registered: now, is_archived: false })))
    .select('resident_id');
  if (error) {
    throw new Error(`Failed to import resident records: ${error.message}`);
  }

  const ids = inserted.map((r) => r.resident_id).sort((a, b) => a - b);
  res.status(201).json({
    message: `${ids.length} resident record${ids.length === 1 ? '' : 's'} imported`,
    imported_count: ids.length,
    resident_ids: ids,
  });
});

// GET /api/resident-records/:id — one record's full detail, including any
// linked user account(s). Archived records stay viewable here (history).
router.get('/:id', requireRole(...VIEW_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid resident record id' });
  }

  // Staff get the eight-column projection; everyone else keeps '*', so the
  // Secretary and Punong Barangay responses are exactly what they were.
  const { data: record, error } = await supabase
    .from('resident_records')
    .select(isStaff(req) ? STAFF_FIELDS : '*')
    .eq('resident_id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load resident record: ${error.message}`);
  }
  if (!record) {
    return res.status(404).json({ error: 'Resident record not found' });
  }

  // The linked account is withheld from Staff, so the lookup is skipped rather
  // than filtered, and the KEY IS OMITTED — not returned as an empty array.
  //
  // An earlier version returned [] to keep the response shape constant across
  // roles. That was wrong for exactly the reason `account: null` was wrong on
  // the list route: [] is not "nothing to say", it is the positive claim THIS
  // RESIDENT HAS NO ACCOUNT, and the client cannot tell it apart from a real
  // empty result. It rendered as "Not linked to any account — this resident
  // has not registered online" on records that demonstrably have one.
  //
  // A stable shape that asserts something false is worse than a shape that
  // varies honestly. Absence is the only representation of "withheld" that a
  // client can detect, and `'linked_accounts' in data` is how it does so.
  if (isStaff(req)) {
    return res.json({ record });
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
// Secretary-only despite creating nothing: it is a matching-engine probe that
// exists to support adding a record, and it returns ranked candidates for
// arbitrary names. No read-only viewer has a use for it.
router.post('/check-duplicates', requireRole('secretary'), async (req, res) => {
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
router.post('/', requireRole('secretary'), async (req, res) => {
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
router.put('/:id', requireRole('secretary'), async (req, res) => {
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
router.post('/:id/archive', requireRole('secretary'), async (req, res) => {
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
router.post('/:id/unarchive', requireRole('secretary'), async (req, res) => {
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
