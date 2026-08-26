import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import ErrorBoundary from '../components/ErrorBoundary';
import { defaultRange, reportsForRole } from '../constants/reports';
import { RENDERERS, isEmpty } from '../components/ReportRenderers';
import { exportReportPdf } from '../utils/exportPdf';
// The CSV export below calls fetch directly rather than going through
// authFetch, so it needs the base URL itself — imported, never redeclared.
import { API_BASE_URL } from '../api/config';

// Reporting: read-only aggregation. The Secretary sees administrative reports,
// the Treasurer financial ones, and the Punong Barangay sees both (oversight).
// The API enforces the same split — this page only decides what is offered.

export default function ReportsPage({ title, nav }) {
  const { authFetch, token, user } = useAuth();
  const available = reportsForRole(user?.role);
  const [selected, setSelected] = useState(available[0]?.key ?? null);
  const [range, setRange] = useState(defaultRange);
  const [draft, setDraft] = useState(defaultRange);
  // The payload is tagged with the report it belongs to. Switching reports
  // re-renders with the NEW renderer before the effect can refetch, so an
  // untagged payload would briefly hand one report's data to another's
  // renderer — each report has a different shape, so that throws.
  const [result, setResult] = useState(null); // { key, data } | null
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const printRef = useRef(null);

  const report = available.find((r) => r.key === selected) || null;

  const load = useCallback(async () => {
    if (!selected) return;
    setResult(null);
    setError('');
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      const payload = await authFetch(`/reports/${selected}?${params}`);
      setResult({ key: selected, data: payload });
    } catch (err) {
      setError(err.message);
      setResult({ key: selected, data: null });
    }
  }, [authFetch, selected, range]);

  useEffect(() => {
    load();
  }, [load]);

  function applyRange(e) {
    e.preventDefault();
    if (draft.from > draft.to) {
      setError('The "from" date must not be after the "to" date.');
      return;
    }
    setRange({ ...draft });
  }

  // CSV comes straight from the API with ?format=csv, so the same role checks
  // and the same date range apply. Fetched with the auth header, then handed
  // to the browser as a download.
  async function exportCsv() {
    setExporting(true);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, format: 'csv' });
      const res = await fetch(`${API_BASE_URL}/reports/${selected}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selected}-${range.from}-to-${range.to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  async function exportPdf() {
    if (!printRef.current) return;
    setExporting(true);
    try {
      await exportReportPdf(printRef.current, {
        title: report.title,
        range,
        filenameBase: selected,
      });
    } catch (err) {
      setError(`PDF export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }

  // Only ever render data that belongs to the selected report.
  const data = result && result.key === selected ? result.data : null;
  const loading = !error && (!result || result.key !== selected);
  const Renderer = selected ? RENDERERS[selected] : null;
  const empty = !!data && isEmpty(selected, data);
  const canExport = !!data && !empty && !exporting;

  return (
    <div className="dash">


      <main className="dash-main">
        {available.length === 0 ? (
          <div className="empty">
            <p>No reports are available for your role.</p>
          </div>
        ) : (
          <>
            <div className="list-head">
              <h2>{report?.title ?? 'Reports'}</h2>
              <form className="head-actions" onSubmit={applyRange}>
                <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                  {['Administrative', 'Financial'].map((group) => {
                    const inGroup = available.filter((r) => r.group === group);
                    if (inGroup.length === 0) return null;
                    return (
                      <optgroup key={group} label={group}>
                        {inGroup.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.title}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
                <label className="inline-label">
                  From
                  <input
                    type="date"
                    value={draft.from}
                    max={draft.to}
                    onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                  />
                </label>
                <label className="inline-label">
                  To
                  <input
                    type="date"
                    value={draft.to}
                    min={draft.from}
                    onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                  />
                </label>
                <button className="btn secondary" type="submit">
                  Apply
                </button>
                <button className="btn secondary" type="button" disabled={!canExport} onClick={exportCsv}>
                  Export CSV
                </button>
                <button className="btn" type="button" disabled={!canExport} onClick={exportPdf}>
                  {exporting ? 'Exporting…' : 'Export PDF'}
                </button>
              </form>
            </div>

            {report && <p className="muted">{report.description}</p>}
            {error && <div className="alert error">{error}</div>}

            {loading ? (
              <p className="muted">Loading report…</p>
            ) : !data ? null : empty ? (
              <div className="empty">
                <p>No data for this period ({range.from} to {range.to}).</p>
                <p className="muted">Try widening the date range.</p>
              </div>
            ) : (
              // A failing report must never blank the screen — an official
              // needs to see WHY it did not render.
              <ErrorBoundary resetKey={`${selected}-${range.from}-${range.to}`}>
                <div className="report-sheet" ref={printRef}>
                  {/* Visible only inside the exported PDF/print capture. */}
                  <div className="report-print-head">
                    <strong>Barangay Ubujan, Tagbilaran City</strong>
                    <div>{report.title}</div>
                    <div className="muted">
                      {range.from} to {range.to}
                    </div>
                  </div>
                  {Renderer && <Renderer data={data} />}
                </div>
              </ErrorBoundary>
            )}
          </>
        )}
      </main>
    </div>
  );
}
