const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { REQUEST_STATUSES } = require('../constants/requestStatus');
const { CHARGE_STATUS, CHARGE_TYPE, PAYMENT_METHOD } = require('../constants/charges');
const { RENTAL_STATUS } = require('../constants/rentals');

const router = express.Router();

// Reporting is READ-ONLY aggregation over existing data — no writes anywhere in
// this file. Administrative reports are Secretary + Punong Barangay; financial
// reports are Treasurer + Punong Barangay. The PB sees everything (oversight);
// Staff and residents get 403.
router.use(authenticate);
const ADMIN_ROLES = ['secretary', 'punong_barangay'];
const FINANCE_ROLES = ['treasurer', 'punong_barangay'];

// ---------------------------------------------------------------------------
// Aggregation strategy
//
// PostgREST exposes no GROUP BY / SUM without a database function, and this
// module was scoped as "no new schema, no migration". So:
//   * plain totals that need no grouping use count: 'exact', head: true —
//     computed in the database, zero rows transferred;
//   * grouped aggregates (per month, per type, per item, monetary sums) run ONE
//     query per report with a NARROW column projection and are bucketed here.
//     One round trip beats dozens, and the projection keeps the payload small.
// If volume ever outgrows this, the fix is a set of SQL aggregate functions in
// a migration (the pattern migration 003 already uses for the matcher).
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Longest reportable span. Bounded so the monthly series can never grow
// unreasonably — and the range is REJECTED rather than silently truncated,
// which would leave the chart disagreeing with the headline totals.
const MAX_MONTHS = 120; // 10 years

// Default window: the last 12 months, i.e. the first day of the month 11
// months ago through today (so the series always shows 12 labelled buckets).
function defaultRange() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return { from: start.toISOString().slice(0, 10), to };
}

function parseRange(req) {
  const fallback = defaultRange();
  const from = String(req.query.from ?? '').trim() || fallback.from;
  const to = String(req.query.to ?? '').trim() || fallback.to;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { error: 'from and to must be in YYYY-MM-DD format' };
  }
  if (from > to) return { error: 'from must not be after to' };
  const span =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
  if (span > MAX_MONTHS) {
    return { error: `date range must not exceed ${MAX_MONTHS / 12} years` };
  }
  // Half-open [fromIso, toIso): everything on the "to" day is included.
  const fromIso = new Date(`${from}T00:00:00+08:00`).toISOString();
  const toDate = new Date(`${to}T00:00:00+08:00`);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  return { from, to, fromIso, toIso: toDate.toISOString() };
}

// Every month label between from and to, so a quiet month shows as 0 rather
// than vanishing from the chart.
function monthBuckets(from, to) {
  const out = [];
  const cur = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  // parseRange bounds the span, so this loop is already limited.
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

const monthOf = (value) => (value ? String(value).slice(0, 7) : null);

function tallyByMonth(rows, dateKey, months) {
  const counts = Object.fromEntries(months.map((m) => [m, 0]));
  for (const row of rows) {
    const m = monthOf(row[dateKey]);
    if (m in counts) counts[m] += 1;
  }
  return months.map((month) => ({ month, count: counts[month] }));
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

// --- CSV ------------------------------------------------------------------
// One convention across every report: ?format=csv on the same endpoint, so the
// role checks and the date range apply identically to JSON and CSV.
function toCsv(sections) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  for (const { title, columns, rows } of sections) {
    lines.push(esc(title));
    lines.push(columns.map(esc).join(','));
    for (const row of rows) lines.push(row.map(esc).join(','));
    lines.push('');
  }
  return lines.join('\r\n');
}

function sendCsv(res, filenameBase, range, sections) {
  const csv = toCsv([
    {
      title: 'Barangay Ubujan, Tagbilaran City — BrgyServe report',
      columns: ['Period from', 'Period to', 'Generated'],
      rows: [[range.from, range.to, new Date().toISOString()]],
    },
    ...sections,
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}-${range.from}-to-${range.to}.csv"`);
  res.send('﻿' + csv); // BOM so Excel reads the peso sign and accents correctly
}

const wantsCsv = (req) => String(req.query.format ?? '').toLowerCase() === 'csv';

// ---------------------------------------------------------------------------
// Administrative — document request summary (Secretary + Punong Barangay)
// ---------------------------------------------------------------------------
router.get('/document-requests', requireRole(...ADMIN_ROLES), async (req, res) => {
  const range = parseRange(req);
  if (range.error) return res.status(400).json({ error: range.error });

  const { data: types, error: typeError } = await supabase
    .from('document_types')
    .select('document_type_id, name, fee');
  if (typeError) throw new Error(`Failed to load document types: ${typeError.message}`);

  const { data: rows, error } = await supabase
    .from('document_requests')
    .select('status, document_type_id, requested_at')
    .gte('requested_at', range.fromIso)
    .lt('requested_at', range.toIso);
  if (error) throw new Error(`Failed to load document requests: ${error.message}`);

  const byStatus = REQUEST_STATUSES.map((status) => ({
    status,
    count: rows.filter((r) => r.status === status).length,
  }));

  const typeName = Object.fromEntries(types.map((t) => [t.document_type_id, t.name]));
  const byType = types
    .map((t) => ({
      document_type_id: t.document_type_id,
      name: t.name,
      count: rows.filter((r) => r.document_type_id === t.document_type_id).length,
    }))
    .sort((a, b) => b.count - a.count);
  // Requests whose type was since removed still deserve a line.
  const orphaned = rows.filter((r) => !(r.document_type_id in typeName)).length;
  if (orphaned) byType.push({ document_type_id: null, name: '(deleted type)', count: orphaned });

  const months = monthBuckets(range.from, range.to);
  const report = {
    range: { from: range.from, to: range.to },
    generated_at: new Date().toISOString(),
    totals: {
      total_requests: rows.length,
      claimed: rows.filter((r) => r.status === 'claimed').length,
      in_progress: rows.filter((r) => ['pending', 'approved', 'ready_for_release'].includes(r.status)).length,
      rejected_or_cancelled: rows.filter((r) => ['rejected', 'cancelled'].includes(r.status)).length,
    },
    by_status: byStatus,
    by_type: byType,
    monthly: tallyByMonth(rows, 'requested_at', months),
  };

  if (wantsCsv(req)) {
    return sendCsv(res, 'document-requests', range, [
      { title: 'Totals', columns: ['Metric', 'Value'], rows: Object.entries(report.totals).map(([k, v]) => [k, v]) },
      { title: 'By status', columns: ['Status', 'Requests'], rows: byStatus.map((r) => [r.status, r.count]) },
      { title: 'By document type', columns: ['Document type', 'Requests'], rows: byType.map((r) => [r.name, r.count]) },
      { title: 'Monthly', columns: ['Month', 'Requests'], rows: report.monthly.map((r) => [r.month, r.count]) },
    ]);
  }
  res.json(report);
});

// ---------------------------------------------------------------------------
// Administrative — resident statistics (Secretary + Punong Barangay)
//
// Note: the population totals (active / archived / with accounts) are
// point-in-time facts about the master list, so they are NOT date-filtered.
// Only "new registrations" respects the range.
// ---------------------------------------------------------------------------
router.get('/residents', requireRole(...ADMIN_ROLES), async (req, res) => {
  const range = parseRange(req);
  if (range.error) return res.status(400).json({ error: range.error });

  const { data: residents, error } = await supabase
    .from('resident_records')
    .select('resident_id, sex, civil_status, date_registered, is_archived');
  if (error) throw new Error(`Failed to load resident records: ${error.message}`);

  const { count: linkedAccounts, error: linkError } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .not('resident_id', 'is', null);
  if (linkError) throw new Error(`Failed to count linked accounts: ${linkError.message}`);

  const active = residents.filter((r) => !r.is_archived);
  const label = (v) => (v === null || String(v).trim() === '' ? 'Not specified' : String(v));
  const groupBy = (rows, key) => {
    const counts = {};
    for (const r of rows) {
      const k = label(r[key]);
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
  };

  const months = monthBuckets(range.from, range.to);
  const registered = residents.filter(
    (r) => r.date_registered && r.date_registered >= range.fromIso && r.date_registered < range.toIso
  );

  const report = {
    range: { from: range.from, to: range.to },
    generated_at: new Date().toISOString(),
    totals: {
      active_residents: active.length,
      archived_residents: residents.length - active.length,
      with_user_account: linkedAccounts || 0,
      without_user_account: active.length - (linkedAccounts || 0),
      new_registrations_in_range: registered.length,
    },
    by_sex: groupBy(active, 'sex'),
    by_civil_status: groupBy(active, 'civil_status'),
    monthly_registrations: tallyByMonth(registered, 'date_registered', months),
  };

  if (wantsCsv(req)) {
    return sendCsv(res, 'resident-statistics', range, [
      { title: 'Totals', columns: ['Metric', 'Value'], rows: Object.entries(report.totals).map(([k, v]) => [k, v]) },
      { title: 'By sex (active residents)', columns: ['Sex', 'Residents'], rows: report.by_sex.map((r) => [r.value, r.count]) },
      { title: 'By civil status (active residents)', columns: ['Civil status', 'Residents'], rows: report.by_civil_status.map((r) => [r.value, r.count]) },
      { title: 'New registrations per month', columns: ['Month', 'Registrations'], rows: report.monthly_registrations.map((r) => [r.month, r.count]) },
    ]);
  }
  res.json(report);
});

// ---------------------------------------------------------------------------
// Administrative — facility utilization (Secretary + Punong Barangay)
//
// rental_requests has no created-at column, so the series is keyed on
// start_datetime — the date the facility was actually used, which is the
// meaningful axis for utilization anyway.
// ---------------------------------------------------------------------------
router.get('/facility-utilization', requireRole(...ADMIN_ROLES), async (req, res) => {
  const range = parseRange(req);
  if (range.error) return res.status(400).json({ error: range.error });

  const { data: items, error: itemError } = await supabase
    .from('rental_items')
    .select('item_id, name, type, is_active');
  if (itemError) throw new Error(`Failed to load rental items: ${itemError.message}`);

  const { data: rows, error } = await supabase
    .from('rental_requests')
    .select('item_id, status, quantity_requested, start_datetime')
    .gte('start_datetime', range.fromIso)
    .lt('start_datetime', range.toIso);
  if (error) throw new Error(`Failed to load rental bookings: ${error.message}`);

  const STORED_STATUSES = [
    RENTAL_STATUS.CONFIRMED,
    RENTAL_STATUS.CANCELLED,
    RENTAL_STATUS.RETURNED,
    RENTAL_STATUS.RETURNED_LATE,
    RENTAL_STATUS.RETURNED_WITH_ISSUE,
  ];
  const byStatus = STORED_STATUSES.map((status) => ({
    status,
    count: rows.filter((r) => r.status === status).length,
  }));

  // Cancelled bookings are excluded from "usage" — the slot was never taken.
  const used = rows.filter((r) => r.status !== RENTAL_STATUS.CANCELLED);
  const byItem = items
    .map((it) => {
      const itemRows = used.filter((r) => r.item_id === it.item_id);
      return {
        item_id: it.item_id,
        name: it.name,
        type: it.type,
        is_active: it.is_active,
        bookings: itemRows.length,
        units_booked: itemRows.reduce((sum, r) => sum + (r.quantity_requested || 0), 0),
      };
    })
    .sort((a, b) => b.bookings - a.bookings);

  const withBookings = byItem.filter((i) => i.bookings > 0);
  const months = monthBuckets(range.from, range.to);

  const report = {
    range: { from: range.from, to: range.to },
    generated_at: new Date().toISOString(),
    totals: {
      total_bookings: rows.length,
      bookings_excluding_cancelled: used.length,
      cancelled: rows.filter((r) => r.status === RENTAL_STATUS.CANCELLED).length,
      items_used: withBookings.length,
      items_never_used: byItem.length - withBookings.length,
    },
    by_status: byStatus,
    by_item: byItem,
    most_used: withBookings[0] || null,
    least_used: withBookings.length ? withBookings[withBookings.length - 1] : null,
    never_used: byItem.filter((i) => i.bookings === 0).map((i) => i.name),
    monthly: tallyByMonth(used, 'start_datetime', months),
  };

  if (wantsCsv(req)) {
    return sendCsv(res, 'facility-utilization', range, [
      { title: 'Totals', columns: ['Metric', 'Value'], rows: Object.entries(report.totals).map(([k, v]) => [k, v]) },
      { title: 'By status', columns: ['Status', 'Bookings'], rows: byStatus.map((r) => [r.status, r.count]) },
      { title: 'By item (cancelled excluded)', columns: ['Item', 'Type', 'Bookings', 'Units booked'], rows: byItem.map((r) => [r.name, r.type, r.bookings, r.units_booked]) },
      { title: 'Monthly bookings', columns: ['Month', 'Bookings'], rows: report.monthly.map((r) => [r.month, r.count]) },
    ]);
  }
  res.json(report);
});

// ---------------------------------------------------------------------------
// Financial — collections summary (Treasurer + Punong Barangay)
//
// Charges are the billing record; payments are the verified money received.
// "Collected" is measured from PAID charges in the range; the payment-method
// split comes from the payments table, which only ever holds verified rows.
// ---------------------------------------------------------------------------
router.get('/collections', requireRole(...FINANCE_ROLES), async (req, res) => {
  const range = parseRange(req);
  if (range.error) return res.status(400).json({ error: range.error });

  const { data: charges, error } = await supabase
    .from('charges')
    .select('charge_type, amount, status, created_at')
    .gte('created_at', range.fromIso)
    .lt('created_at', range.toIso);
  if (error) throw new Error(`Failed to load charges: ${error.message}`);

  const { data: payments, error: payError } = await supabase
    .from('payments')
    .select('amount, payment_method, created_at')
    .gte('created_at', range.fromIso)
    .lt('created_at', range.toIso);
  if (payError) throw new Error(`Failed to load payments: ${payError.message}`);

  const sum = (rows) => money(rows.reduce((t, r) => t + Number(r.amount || 0), 0));
  const paid = charges.filter((c) => c.status === CHARGE_STATUS.PAID);
  const unpaid = charges.filter((c) => c.status === CHARGE_STATUS.UNPAID);
  const voided = charges.filter((c) => c.status === CHARGE_STATUS.VOID);

  const byType = Object.values(CHARGE_TYPE).map((type) => {
    const ofType = charges.filter((c) => c.charge_type === type);
    return {
      charge_type: type,
      charges: ofType.length,
      collected: sum(ofType.filter((c) => c.status === CHARGE_STATUS.PAID)),
      outstanding: sum(ofType.filter((c) => c.status === CHARGE_STATUS.UNPAID)),
    };
  });

  const byMethod = Object.values(PAYMENT_METHOD).map((method) => {
    const ofMethod = payments.filter((p) => p.payment_method === method);
    return { payment_method: method, payments: ofMethod.length, amount: sum(ofMethod) };
  });
  const unrecorded = payments.filter((p) => !Object.values(PAYMENT_METHOD).includes(p.payment_method));
  if (unrecorded.length) {
    byMethod.push({ payment_method: 'other/unrecorded', payments: unrecorded.length, amount: sum(unrecorded) });
  }

  const months = monthBuckets(range.from, range.to);
  const monthly = months.map((month) => ({
    month,
    collected: sum(paid.filter((c) => monthOf(c.created_at) === month)),
    billed: sum(charges.filter((c) => monthOf(c.created_at) === month && c.status !== CHARGE_STATUS.VOID)),
  }));

  const report = {
    range: { from: range.from, to: range.to },
    generated_at: new Date().toISOString(),
    totals: {
      total_collected: sum(paid),
      total_outstanding: sum(unpaid),
      total_billed: money(sum(paid) + sum(unpaid)),
      voided_amount: sum(voided),
      paid_charges: paid.length,
      unpaid_charges: unpaid.length,
      payments_recorded: payments.length,
    },
    by_type: byType,
    by_payment_method: byMethod,
    monthly,
  };

  if (wantsCsv(req)) {
    return sendCsv(res, 'collections', range, [
      { title: 'Totals', columns: ['Metric', 'Value'], rows: Object.entries(report.totals).map(([k, v]) => [k, v]) },
      { title: 'By charge type', columns: ['Charge type', 'Charges', 'Collected', 'Outstanding'], rows: byType.map((r) => [r.charge_type, r.charges, r.collected, r.outstanding]) },
      { title: 'By payment method', columns: ['Method', 'Payments', 'Amount'], rows: byMethod.map((r) => [r.payment_method, r.payments, r.amount]) },
      { title: 'Monthly', columns: ['Month', 'Collected', 'Billed'], rows: monthly.map((r) => [r.month, r.collected, r.billed]) },
    ]);
  }
  res.json(report);
});

module.exports = router;
