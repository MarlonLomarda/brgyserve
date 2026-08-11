import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { SECRETARY_NAV } from '../constants/nav';
import { formatDate } from '../constants/requestStatus';
import {
  NOTIFICATION_STATUS_FILTERS,
  RELATED_TYPE_FILTERS,
  notificationStatusMeta,
  relatedLabel,
} from '../constants/notifications';

// Secretary-only log of every notification the system generated.
//
// Read-only: there is no re-send and no delete. Rows appear only as a side
// effect of a real action, so this is a record of what happened rather than
// a console for making things happen.
//
// The simulated-mode banner is not decoration. Sending is off, and the screen
// has to say so plainly rather than letting a reader assume messages went out.
export default function NotificationsPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('all');
  const [relatedType, setRelatedType] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status !== 'all') params.set('status', status);
      if (relatedType !== 'all') params.set('related_type', relatedType);
      if (search) params.set('search', search);
      setData(await authFetch(`/notifications?${params}`));
    } catch (err) {
      setError(err.message);
      setData(null);
    }
  }, [authFetch, page, status, relatedType, search]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary;

  return (
    <div className="dash">
      <DashHeader title="BrgyServe — Secretary" subtitle="Notifications" nav={SECRETARY_NAV} />
      <main className="dash-main">
        <div className="pending-card">
          <div className="pending-head">
            <div>
              <h3>Notifications</h3>
              <p className="muted">
                Every message the system generated, who it was for, and what happened to it.
              </p>
            </div>
          </div>

          {/* Stated plainly and permanently — not a dismissible notice. */}
          {data?.mode !== 'SEMAPHORE' && (
            <div className="alert info notif-mode">
              <strong>Sending is simulated.</strong> Messages are composed, addressed and recorded
              here, but no SMS is transmitted and no provider is connected. Rows are marked{' '}
              <em>Simulated</em> rather than Sent for that reason.
            </div>
          )}

          {error && <div className="alert error">{error}</div>}

          {summary && (
            <div className="roster-summary">
              <div className="roster-stat">
                <span className="roster-value muted">{summary.total}</span>
                <span className="roster-label">Total generated</span>
              </div>
              <div className="roster-stat">
                <span className="roster-value">{summary.SIMULATED ?? 0}</span>
                <span className="roster-label">Composed &amp; addressed</span>
              </div>
              <div className="roster-stat">
                <span className="roster-value warn">{summary.unreachable ?? 0}</span>
                <span className="roster-label">No contact number</span>
              </div>
              {(summary.FAILED ?? 0) > 0 && (
                <div className="roster-stat">
                  <span className="roster-value warn">{summary.FAILED}</span>
                  <span className="roster-label">Failed</span>
                </div>
              )}
            </div>
          )}

          <form
            className="head-actions notif-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(searchInput.trim());
            }}
          >
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              {NOTIFICATION_STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              value={relatedType}
              onChange={(e) => {
                setRelatedType(e.target.value);
                setPage(1);
              }}
            >
              {RELATED_TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search message or number"
            />
            <button className="btn secondary" type="submit">
              Search
            </button>
            {search && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                  setPage(1);
                }}
              >
                Clear
              </button>
            )}
          </form>

          {!data ? (
            <p className="muted">Loading notifications…</p>
          ) : data.notifications.length === 0 ? (
            <div className="empty">
              <p>
                <strong>No notifications yet.</strong>
              </p>
              <p className="muted">
                A row appears here whenever the system would send a message — a request approved or
                rejected, a payment verified, a booking confirmed or cancelled, a return recorded,
                or a fine raised.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th className="col-message">Message</th>
                    <th>About</th>
                    <th>Status</th>
                    <th>Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.notifications.map((n) => {
                    const meta = notificationStatusMeta(n.status);
                    const open = expanded === n.notification_id;
                    return (
                      <tr key={n.notification_id}>
                        <td className="col-resident">
                          <span className="cell-clamp">
                            {n.recipient_name || n.recipient_username ? (
                              <>
                                <strong>{n.recipient_name || `@${n.recipient_username}`}</strong>
                                <br />
                              </>
                            ) : n.household_id ? (
                              <>
                                <strong>Household #{n.household_id}</strong>
                                <br />
                              </>
                            ) : null}
                            <span className="muted small-note">
                              {n.destination || 'No contact number on record'}
                            </span>
                          </span>
                        </td>
                        <td className="col-message">
                          <span className="cell-clamp">
                            {open || n.message.length <= 90
                              ? n.message
                              : `${n.message.slice(0, 90)}…`}
                            {n.message.length > 90 && (
                              <>
                                {' '}
                                <button
                                  className="btn secondary notif-more"
                                  type="button"
                                  onClick={() => setExpanded(open ? null : n.notification_id)}
                                >
                                  {open ? 'Less' : 'More'}
                                </button>
                              </>
                            )}
                          </span>
                        </td>
                        <td className="muted">{relatedLabel(n)}</td>
                        <td>
                          <span className={`badge ${meta.className}`}>{meta.label}</span>
                        </td>
                        <td className="muted small-note">{formatDate(n.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data && data.total_pages > 1 && (
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
      </main>
    </div>
  );
}
