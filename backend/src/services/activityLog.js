const supabase = require('../config/supabase');
const { isSensitiveKey, isPersonalKey } = require('../constants/activityLog');

// ===========================================================================
// ACTIVITY LOG — who changed what, and when (activity_logs, Table 18).
//
// Modelled on notify() in services/notifications.js, for the same reason:
// supabase-js has no transactions, so a log row cannot commit together with
// the change it describes. Every call site runs AFTER its business write has
// succeeded, and these functions NEVER THROW — a failed log insert is one
// console line, never a rolled-back approval, payment or fine.
//
// user_id is NOT NULL and references users, so only actions with a person
// behind them are logged. System actions — the PayMongo webhook settling a
// charge — are not: the payment row already marks them, with
// received_by_user_id left NULL.
//
// timestamp has NO default in the schema, so it is set here.
// ===========================================================================

// A string carrying a reset link is refused whatever its key is called — the
// same backstop services/notifications.js applies to message text.
const LINK_WITH_TOKEN = /[?&]token=/i;

// Removes every sensitive key, at every depth, and every value that carries a
// reset link. Returns a new value; the caller's object is never modified.
function scrub(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => !(typeof v === 'string' && LINK_WITH_TOKEN.test(v))).map(scrub);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      if (typeof v === 'string' && LINK_WITH_TOKEN.test(v)) continue;
      out[key] = scrub(v);
    }
    return out;
  }
  return value;
}

const isPositiveInteger = (n) => Number.isInteger(Number(n)) && Number(n) > 0;
const isLabel = (s) => typeof s === 'string' && s.length > 0 && s.length <= 100;

// One row, or null with a warning when it cannot be written honestly.
function buildRow({ userId, action, table, recordId = null, before = null, after = null } = {}) {
  if (userId === undefined || userId === null || userId === '') {
    console.warn(`[activity_logs] skipped ${action || '?'} on ${table || '?'}: no user_id`);
    return null;
  }
  if (!isPositiveInteger(userId) || !isLabel(action) || !isLabel(table)
    || (recordId !== null && recordId !== undefined && !isPositiveInteger(recordId))) {
    console.warn(`[activity_logs] skipped ${action || '?'} on ${table || '?'}: invalid user_id, action, table or record_id`);
    return null;
  }
  return {
    user_id: Number(userId),
    action,
    table_name: table,
    record_id: recordId === null || recordId === undefined ? null : Number(recordId),
    old_value: before === null || before === undefined ? null : scrub(before),
    new_value: after === null || after === undefined ? null : scrub(after),
    timestamp: new Date().toISOString(),
  };
}

async function logActivity(entry) {
  try {
    const row = buildRow(entry);
    if (!row) return;
    const { error } = await supabase.from('activity_logs').insert(row);
    if (error) console.error(`[activity_logs] suppressed failure (${row.action} ${row.table_name}): ${error.message}`);
  } catch (err) {
    console.error(`[activity_logs] suppressed failure: ${err.message}`);
  }
}

// Batch variant, one insert, same guarantees.
async function logActivityMany(entries = []) {
  try {
    const rows = (Array.isArray(entries) ? entries : []).map(buildRow).filter(Boolean);
    if (rows.length === 0) return;
    const { error } = await supabase.from('activity_logs').insert(rows);
    if (error) console.error(`[activity_logs] suppressed batch failure (${rows.length} rows): ${error.message}`);
  } catch (err) {
    console.error(`[activity_logs] suppressed batch failure: ${err.message}`);
  }
}

const sameValue = (a, b) => (a === b) || JSON.stringify(a) === JSON.stringify(b);

// For UPDATE calls: only the keys whose values changed. A key present on only
// one side is IGNORED — a column one query did not select is not a change —
// so pass two rows read the same way (both from the database, ideally).
// Returns { before: {}, after: {} } when nothing changed: an honest "compared,
// no difference", which is not the same claim as no values at all.
function diffFields(before, after) {
  const out = { before: {}, after: {} };
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return out;
  for (const key of Object.keys(after)) {
    if (!(key in before)) continue;
    if (!sameValue(before[key], after[key])) {
      out.before[key] = before[key];
      out.after[key] = after[key];
    }
  }
  return out;
}

// The listed fields of a row, for CREATE and status logs that should carry an
// identifying summary rather than the whole record.
function pick(row, fields) {
  const out = {};
  if (!row) return out;
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}

// READ side, for the Activity Log page: removes every PERSONAL_FIELDS key, at
// every depth, the same walk scrub() makes. The value is dropped — the key is
// ABSENT from what comes back, never null — and the key's name is reported in
// `withheld` (lowercase, first-seen order, no repeats) so the page can say
// "Contact number changed" without ever receiving the number. Returns
// { value, withheld }; the caller's object is never modified.
function withholdPersonal(value) {
  const withheld = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out = {};
      for (const [key, x] of Object.entries(v)) {
        if (isPersonalKey(key)) {
          const name = String(key).toLowerCase();
          if (!withheld.includes(name)) withheld.push(name);
          continue;
        }
        out[key] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), withheld };
}

module.exports = { logActivity, logActivityMany, diffFields, pick, scrub, withholdPersonal };
