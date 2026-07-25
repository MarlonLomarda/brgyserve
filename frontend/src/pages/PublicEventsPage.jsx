import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { formatDate } from '../constants/requestStatus';
import { EVENT_TYPE_LABELS, eventStatusMeta, formatWindow } from '../constants/events';

// Events & Activities stage 2: the READ-ONLY view for residents and the
// Punong Barangay. Reuses the stage 1 display constants and the same API
// shape (/api/events/public), which never exposes archived records. There are
// deliberately no create / edit / archive actions anywhere on this screen.

const VIEWS = [
  { value: 'active', label: 'Current & upcoming' },
  { value: 'past', label: 'Past activities' },
];

function EventDetail({ id, onBack }) {
  const { authFetch } = useAuth();
  const [event, setEvent] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch(`/events/public/${id}`);
        if (!cancelled) setEvent(data.event);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, id]);

  const e = event;
  const meta = e ? eventStatusMeta(e.status) : null;

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>
            {e ? e.title : `Event #${id}`}{' '}
            {e && <span className={`badge ${meta.className}`}>{meta.label}</span>}
          </h3>
          {e && (
            <p className="muted">
              {EVENT_TYPE_LABELS[e.type]} · posted {formatDate(e.date_created)}
            </p>
          )}
        </div>
        <button className="btn secondary" onClick={onBack}>
          ← Back
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {!e ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <dl className="info-grid">
          <div>
            <dt>Type</dt>
            <dd>{EVENT_TYPE_LABELS[e.type]}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{meta.label}</dd>
          </div>
          <div className="span-2">
            <dt>Schedule</dt>
            <dd>{formatWindow(e.start_datetime, e.end_datetime)}</dd>
          </div>
          <div className="span-2">
            <dt>Location</dt>
            <dd>{e.location || '—'}</dd>
          </div>
          <div className="span-2">
            <dt>Details</dt>
            <dd>{e.description || '—'}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export default function PublicEventsPage({ title, nav }) {
  const { authFetch } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('active');
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), view, type });
      if (search) params.set('search', search);
      setData(await authFetch(`/events/public?${params}`));
    } catch (err) {
      setError(err.message);
      setData({ events: [], total: 0, total_pages: 0 });
    }
  }, [authFetch, page, view, type, search]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  const events = data?.events;
  const announcements = (events || []).filter((e) => e.type === 'announcement');
  const activities = (events || []).filter((e) => e.type === 'activity');

  const section = (heading, rows, emptyText) => (
    <>
      <div className="list-head">
        <h3>
          {heading} <span className="muted">({rows.length})</span>
        </h3>
      </div>
      {rows.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Schedule</th>
                <th>Location</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const meta = eventStatusMeta(e.status);
                return (
                  <tr key={e.event_id}>
                    <td>
                      <strong>{e.title}</strong>
                    </td>
                    <td>{formatWindow(e.start_datetime, e.end_datetime)}</td>
                    <td className="muted">{e.location || '—'}</td>
                    <td>
                      <span className={`badge ${meta.className}`}>{meta.label}</span>
                    </td>
                    <td className="row-actions">
                      <button className="btn secondary" onClick={() => setSelectedId(e.event_id)}>
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  return (
    <div className="dash">
      <DashHeader title={title} subtitle="Barangay events and announcements" nav={nav} />

      <main className="dash-main">
        {selectedId ? (
          <EventDetail id={selectedId} onBack={() => setSelectedId(null)} />
        ) : (
          <>
            {error && <div className="alert error">{error}</div>}

            <div className="list-head">
              <h2>
                {data === null
                  ? 'Events'
                  : `${data.total} ${view === 'past' ? 'past activity' : 'event'}${data.total === 1 ? '' : view === 'past' ? ' records' : 's'}`}
              </h2>
              <form className="head-actions" onSubmit={handleSearch}>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search events…"
                  maxLength={100}
                />
                <button className="btn secondary" type="submit">
                  Search
                </button>
                {search && (
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setSearchInput('');
                      setPage(1);
                    }}
                  >
                    Clear
                  </button>
                )}
                <select
                  value={view}
                  onChange={(e) => {
                    setView(e.target.value);
                    setPage(1);
                  }}
                >
                  {VIEWS.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <select
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">All types</option>
                  <option value="activity">Activities</option>
                  <option value="announcement">Announcements</option>
                </select>
              </form>
            </div>

            {data === null ? (
              <p className="muted">Loading events…</p>
            ) : events.length === 0 ? (
              <div className="empty">
                <p>
                  {view === 'past'
                    ? 'No past activities'
                    : 'Nothing posted by the barangay right now'}
                  {search ? ` matching "${search}"` : ''}.
                </p>
              </div>
            ) : (
              <>
                {type !== 'announcement' &&
                  section(
                    view === 'past' ? 'Past activities' : 'Activities',
                    activities,
                    'No activities to show.'
                  )}
                {type !== 'activity' &&
                  view !== 'past' &&
                  section('Announcements', announcements, 'No announcements to show.')}

                {data.total_pages > 1 && (
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
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
