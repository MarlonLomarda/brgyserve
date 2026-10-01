import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS } from "../auth/roles";
import {
  ACTION_FILTERS,
  ROLE_FILTERS,
  TABLE_FILTERS,
  actionMeta,
  formatLogTime,
  recordLabel,
  summarize,
} from "../constants/activityLog";

// The activity log, read-only, for the Secretary and the Punong Barangay —
// one component on both routes. Who changed what, and when.
//
// Nothing here writes: the only controls are filters and the pager. A
// personal value never reaches this screen — the server removes it and
// sends the field's name in withheld_fields — and there is deliberately no
// search box, because matching a phone number would reveal which rows hold
// it.
//
// States render error, then loading, then empty, then rows. A failed load
// stores null and its error, and the error replaces the table — it never
// sits above a "Loading…" that cannot finish.
const SUMMARY_CLAMP = 90;

export default function ActivityLogPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("all");
  const [table, setTable] = useState("all");
  const [role, setRole] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Set by clicking a name or a record label; each shows a chip to clear it.
  const [actor, setActor] = useState(null); // { user_id, name }
  const [record, setRecord] = useState(null); // { table, record_id, label }
  const [expanded, setExpanded] = useState(null);

  const actorId = actor?.user_id;
  const recordId = record?.record_id;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (action !== "all") params.set("action", action);
    if (table !== "all") params.set("table", table);
    if (role !== "all") params.set("role", role);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (actorId) params.set("user_id", String(actorId));
    if (recordId) params.set("record_id", String(recordId));
    setError("");
    setData(null);
    authFetch(`/activity-logs?${params}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [authFetch, page, action, table, role, from, to, actorId, recordId]);

  // A page past the end comes back empty WITH the true total, so step back to
  // the last page rather than showing an empty state that is not true.
  useEffect(() => {
    if (data && data.logs.length === 0 && data.total_pages > 0 && page > data.total_pages) {
      setPage(data.total_pages);
    }
  }, [data, page]);

  const filtered =
    action !== "all" || table !== "all" || role !== "all" || from || to || actor || record;
  // The TRUE total from the server, also on a page past the end, where the
  // rows are empty but the total is not.
  const showTotal = !error && data && data.total > 0;

  const change = (setter) => (e) => {
    setter(e.target.value);
    setPage(1);
  };

  // log-card: index.css keeps this card the same width in every state —
  // without it the form cap narrows it whenever no table is showing.
  return (
    <div className="pending-card log-card">
      <div className="head-actions log-filters">
        <select value={action} onChange={change(setAction)} aria-label="Action">
          {ACTION_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={table}
          onChange={(e) => {
            setTable(e.target.value);
            setRecord(null); // a record belongs to one type
            setPage(1);
          }}
          aria-label="Record type"
        >
          {TABLE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select value={role} onChange={change(setRole)} aria-label="Done by">
          {ROLE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="inline-label">
          From
          <input type="date" value={from} max={to || undefined} onChange={change(setFrom)} />
        </label>
        <label className="inline-label">
          To
          <input type="date" value={to} min={from || undefined} onChange={change(setTo)} />
        </label>
      </div>

      {(showTotal || actor || record) && (
        <div className="log-chips">
          {showTotal && (
            <span className="muted">
              {data.total === 1 ? "1 entry" : `${data.total.toLocaleString("en-PH")} entries`}
            </span>
          )}
          {actor && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setActor(null);
                setPage(1);
              }}
              aria-label={`Stop showing only actions by ${actor.name}`}
            >
              By {actor.name} ✕
            </button>
          )}
          {record && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setRecord(null);
                setTable("all");
                setPage(1);
              }}
              aria-label={`Stop showing only the history of ${record.label}`}
            >
              History of {record.label} ✕
            </button>
          )}
        </div>
      )}

      {error ? (
        <div className="alert error">{error}</div>
      ) : !data ? (
        <p className="muted">Loading the activity log…</p>
      ) : data.logs.length === 0 ? (
        data.total > 0 ? (
          <p className="muted">Going back to the last page…</p>
        ) : (
          <div className="empty">
            <p>
              <strong>
                {filtered ? "No entries match these filters." : "No activity recorded yet."}
              </strong>
            </p>
            <p className="muted">
              A row appears here whenever an official, a staff member or a
              resident changes a record — adding or editing it, deciding a
              request, recording a payment, attendance or a blotter case.
            </p>
          </div>
        )
      ) : (
        <div className="table-wrap">
          <table className="data-table stack-narrow log-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Record</th>
                <th>By</th>
                <th className="col-message">Change</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((row) => {
                const meta = actionMeta(row.action);
                const label = recordLabel(row);
                const summary = summarize(row);
                const open = expanded === row.log_id;
                const long = summary.length > SUMMARY_CLAMP;
                const roleLabel = ROLE_LABELS[row.actor.role] || row.actor.role;
                const showUsername =
                  row.actor.username && row.actor.name !== `@${row.actor.username}`;
                return (
                  <tr key={row.log_id}>
                    <td>
                      <span className={`badge ${meta.className}`}>{meta.label}</span>
                    </td>
                    <td data-label="Record">
                      {row.record_id != null ? (
                        <button
                          type="button"
                          className="link-button"
                          title="Show this record's history"
                          onClick={() => {
                            setRecord({ table: row.table_name, record_id: row.record_id, label });
                            setTable(row.table_name);
                            setPage(1);
                          }}
                        >
                          {label}
                        </button>
                      ) : (
                        label
                      )}
                    </td>
                    <td data-label="By">
                      <button
                        type="button"
                        className="link-button"
                        title="Show only this person's actions"
                        onClick={() => {
                          setActor({ user_id: row.actor.user_id, name: row.actor.name });
                          setPage(1);
                        }}
                      >
                        {row.actor.name}
                      </button>
                      <br />
                      <span className="muted small-note">
                        {showUsername ? `@${row.actor.username} · ` : ""}
                        {roleLabel}
                      </span>
                    </td>
                    <td className="col-message" data-label="Change">
                      <span className="cell-clamp">
                        {open || !long ? summary : `${summary.slice(0, SUMMARY_CLAMP)}…`}
                        {long && (
                          <>
                            {" "}
                            <button
                              className="btn secondary notif-more"
                              type="button"
                              onClick={() => setExpanded(open ? null : row.log_id)}
                            >
                              {open ? "Less" : "More"}
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                    <td className="muted small-note" data-label="When">
                      {formatLogTime(row.timestamp)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!error && data && data.total_pages > 1 && (
        <div className="list-head">
          <span className="muted">
            Page {data.page} of {data.total_pages}
          </span>
          <div className="head-actions">
            <button
              className="btn secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Previous
            </button>
            <button
              className="btn secondary"
              disabled={page >= data.total_pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
