// CSV WRITING — one implementation, shared by the reports and the resident
// masterlist export.
//
// This moved out of routes/reports.js unchanged when the masterlist export
// needed it: a helper that only one route file could reach would have meant a
// second CSV writer, and two escapers drift. Reports keep their byte-identical
// output through toCsv(); the export uses toCsvTable(), which is the same
// escaping without the report's title line and section breaks — a title above
// the header row would stop the file from being imported back.

// A field is quoted when it holds a quote, a comma or a line break (\n or \r);
// quotes inside are doubled. null and undefined are written as an empty field.
function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// FORMULA INJECTION. A spreadsheet opening this file reads a cell that begins
// with =, +, - or @ as a formula and runs it. Text in these files is not all
// ours: a resident's registered name reaches resident_records through
// create-and-link (routes/secretary.js copies the name the registrant typed),
// so anyone who registers could plant =HYPERLINK(...) or worse and have it run
// on the Secretary's machine when the masterlist export is opened in Excel. A
// leading ' makes the spreadsheet treat the cell as text.
//
// OPT-IN PER COLUMN, and the caller decides. This file has no way to know
// which columns legitimately begin with one of those characters — a contact
// number can begin with + — so each call site passes guard(column), and a
// column is guarded only when that returns true. Only STRING values are ever
// touched: a number cannot carry a formula, and quoting -5 would turn a real
// amount into text.
const FORMULA_START = /^[=+\-@]/;
const neutralise = (v) =>
  typeof v === 'string' && FORMULA_START.test(v.trim()) ? `'${v}` : v;

const NO_GUARD = () => false;

// `guarded[i]` says whether column i is neutralised; header rows pass none.
const csvLine = (values, guarded = []) =>
  values.map((v, i) => esc(guarded[i] ? neutralise(v) : v)).join(',');

// Titled sections separated by a blank line — the report layout. The guard
// applies to data rows; titles and column headers are written by the route.
function toCsv(sections, { guard = NO_GUARD } = {}) {
  const lines = [];
  for (const { title, columns, rows } of sections) {
    const guarded = columns.map((c) => guard(c));
    lines.push(esc(title));
    lines.push(csvLine(columns));
    for (const row of rows) lines.push(csvLine(row, guarded));
    lines.push('');
  }
  return lines.join('\r\n');
}

// One header row and its data rows, nothing else — a file that can be opened,
// edited and read back.
function toCsvTable(columns, rows, { guard = NO_GUARD } = {}) {
  const guarded = columns.map((c) => guard(c));
  return [csvLine(columns), ...rows.map((row) => csvLine(row, guarded))].join('\r\n') + '\r\n';
}

module.exports = { toCsv, toCsvTable };
