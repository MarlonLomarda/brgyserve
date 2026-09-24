// CSV WRITING — one implementation, shared by the reports and the resident
// masterlist export.
//
// This moved out of routes/reports.js unchanged when the masterlist export
// needed it: a helper that only one route file could reach would have meant a
// second CSV writer, and two escapers drift. Reports keep their byte-identical
// output through toCsv(); the export uses toCsvTable(), which is the same
// escaping without the report's title line and section breaks — a title above
// the header row would stop the file from being imported back.

// A field is quoted when it holds a quote, a comma or a newline; quotes inside
// are doubled. null and undefined are written as an empty field.
function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (values) => values.map(esc).join(',');

// Titled sections separated by a blank line — the report layout.
function toCsv(sections) {
  const lines = [];
  for (const { title, columns, rows } of sections) {
    lines.push(esc(title));
    lines.push(csvLine(columns));
    for (const row of rows) lines.push(csvLine(row));
    lines.push('');
  }
  return lines.join('\r\n');
}

// One header row and its data rows, nothing else — a file that can be opened,
// edited and read back.
function toCsvTable(columns, rows) {
  return [columns, ...rows].map(csvLine).join('\r\n') + '\r\n';
}

module.exports = { toCsv, toCsvTable };
