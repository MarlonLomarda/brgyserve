import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { formatDate } from '../constants/requestStatus';
import {
  EVENT_TYPE_LABELS,
  EVENT_VIEWS,
  eventStatusMeta,
  formatWindow,
  toDateTimeLocal,
} from '../constants/events';

// Events & Activities, stage 1: management (CRUD + manual archive) shared by
// the Secretary and Barangay Staff — both maintain the calendar, and there is
// no approval gate. The resident / Punong Barangay read-only view is stage 2.

const EMPTY_FORM = {
  type: 'activity',
  title: '',
  description: '',
  location: '',
  start_datetime: '',
  end_datetime: '',
  attendance_required: false,
  fine_amount: '',
};

// --- create / edit form ----------------------------------------------------
function EventForm({ event, onDone }) {
  const { authFetch } = useAuth();
  const isEdit = !!event;
  const [form, setForm] = useState(() =>
    event
      ? {
          type: event.type,
          title: event.title,
          description: event.description || '',
          location: event.location || '',
          start_datetime: toDateTimeLocal(event.start_datetime),
          end_datetime: toDateTimeLocal(event.end_datetime),
          attendance_required: !!event.attendance_required,
          fine_amount: event.fine_amount == null ? '' : String(event.fine_amount),
        }
      : { ...EMPTY_FORM }
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isActivity = form.type === 'activity';
  const handleChange = (e) => {
    const { name, type, value, checked } = e.target;
    setForm((f) => {
      const next = { ...f, [name]: type === 'checkbox' ? checked : value };
      // An announcement has no schedule, so it can never take attendance —
      // clear it rather than sending a value the server would reject.
      if (name === 'type' && value !== 'activity') {
        next.attendance_required = false;
        next.fine_amount = '';
      }
      return next;
    });
  };

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // client-side mirror of the per-type rules (the server is the real gate)
    if (isActivity && (!form.start_datetime || !form.end_datetime)) {
      setError('An activity needs both a start and an end date/time.');
      return;
    }
    if (form.start_datetime && form.end_datetime && form.end_datetime <= form.start_datetime) {
      setError('The end date/time must be after the start.');
      return;
    }

    setBusy(true);
    try {
      const data = isEdit
        ? await authFetch(`/events/${event.event_id}`, { method: 'PUT', body: form })
        : await authFetch('/events', { method: 'POST', body: form });
      onDone({ type: 'success', text: data.message }, data.event);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <h3>
          {isEdit ? `Edit ${EVENT_TYPE_LABELS[event.type].toLowerCase()}` : 'New event or announcement'}
        </h3>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <label>
          Type
          <select name="type" value={form.type} onChange={handleChange}>
            <option value="activity">Activity — a scheduled event with a start and end</option>
            <option value="announcement">Announcement — a notice, no schedule required</option>
          </select>
        </label>

        <label>
          Title
          <input name="title" value={form.title} onChange={handleChange} maxLength={255} required />
        </label>

        {isActivity ? (
          <>
            <div className="grid-2">
              <label>
                Starts
                <input
                  name="start_datetime"
                  type="datetime-local"
                  value={form.start_datetime}
                  onChange={handleChange}
                  required
                />
              </label>
              <label>
                Ends
                <input
                  name="end_datetime"
                  type="datetime-local"
                  value={form.end_datetime}
                  onChange={handleChange}
                  required
                />
              </label>
            </div>
            <label>
              Location
              <input name="location" value={form.location} onChange={handleChange} maxLength={255} />
            </label>

            {/* Attendance is opt-in and only offered for activities. */}
            <label className="check-row">
              <input
                type="checkbox"
                name="attendance_required"
                checked={form.attendance_required}
                onChange={handleChange}
              />
              <span>
                Attendance required
                <span className="hint"> — record which households attend this activity</span>
              </span>
            </label>

            {form.attendance_required && (
              <label>
                Fine per absent household <span className="hint">(optional)</span>
                <input
                  name="fine_amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.fine_amount}
                  onChange={handleChange}
                  placeholder="e.g. 100.00"
                />
                <span className="hint">
                  Leave blank to take attendance without any fine. Fines are generated later as an
                  explicit action — never automatically.
                </span>
              </label>
            )}
          </>
        ) : (
          <>
            <p className="muted">
              Announcements stay on the active list until you archive them. Add a schedule only if
              the notice refers to a specific time.
            </p>
            <div className="grid-2">
              <label>
                Starts <span className="hint">(optional)</span>
                <input
                  name="start_datetime"
                  type="datetime-local"
                  value={form.start_datetime}
                  onChange={handleChange}
                />
              </label>
              <label>
                Ends <span className="hint">(optional)</span>
                <input
                  name="end_datetime"
                  type="datetime-local"
                  value={form.end_datetime}
                  onChange={handleChange}
                />
              </label>
            </div>
            <label>
              Location <span className="hint">(optional)</span>
              <input name="location" value={form.location} onChange={handleChange} maxLength={255} />
            </label>
          </>
        )}

        <label>
          Description {isActivity && <span className="hint">(optional)</span>}
          <textarea name="description" value={form.description} onChange={handleChange} rows={4} />
        </label>

        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Publish'}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- detail ----------------------------------------------------------------
function EventDetail({ id, onBack, onEdit, onChanged, onOpenAttendance }) {
  const { authFetch } = useAuth();
  const [event, setEvent] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch(`/events/${id}`);
      setEvent(data.event);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch, id]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleArchive() {
    setBusy(true);
    try {
      const action = event.is_archived ? 'unarchive' : 'archive';
      const data = await authFetch(`/events/${id}/${action}`, { method: 'PATCH' });
      setEvent(data.event);
      onChanged(data.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const e = event;
  const meta = e ? eventStatusMeta(e.status) : null;

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>
            {e ? e.title : `Event #${id}`}{' '}
            {e && <span className={`badge ${meta.className}`}>{meta.label}</span>}{' '}
            {e?.is_archived && <span className="badge gray">Archived</span>}
          </h3>
          {e && <p className="muted">{EVENT_TYPE_LABELS[e.type]} · posted {formatDate(e.date_created)}</p>}
        </div>
        <div className="head-actions">
          {e && e.type === 'activity' && e.attendance_required && (
            <button className="btn" onClick={() => onOpenAttendance(e.event_id)}>
              Record attendance
            </button>
          )}
          {e && !e.is_archived && (
            <button className="btn secondary" disabled={busy} onClick={() => onEdit(e)}>
              Edit
            </button>
          )}
          {e && (
            <button
              className={`btn secondary${e.is_archived ? '' : ' danger'}`}
              disabled={busy}
              onClick={toggleArchive}
            >
              {busy ? 'Working…' : e.is_archived ? 'Unarchive' : 'Archive'}
            </button>
          )}
          <button className="btn secondary" onClick={onBack}>
            ← Back to list
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {e?.is_archived && (
        <div className="alert info">
          This record is archived: it is hidden from the active and past lists until restored.
        </div>
      )}

      {!e ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
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
            {e.type === 'activity' && (
              <div className="span-2">
                <dt>Attendance</dt>
                <dd>
                  {e.attendance_required ? (
                    <>
                      Required per household
                      {e.fine_amount != null
                        ? ` · ₱${Number(e.fine_amount).toFixed(2)} fine per absent household`
                        : ' · no fine'}
                    </>
                  ) : (
                    'Not tracked for this activity'
                  )}
                </dd>
              </div>
            )}
            <div className="span-2">
              <dt>Description</dt>
              <dd>{e.description || '—'}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

// --- attendance roster (stage 3a) ------------------------------------------
// Used on a phone during an assembly, so the counts are large, the rows stay
// readable at narrow width, and the tap targets are big. Stage 3d will add a
// camera scanner to this same screen.
function AttendanceRoster({ eventId, onBack }) {
  const { authFetch } = useAuth();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (search) params.set('search', search);
      setData(await authFetch(`/events/${eventId}/attendance?${params}`));
    } catch (err) {
      setError(err.message);
      setData(null);
    }
  }, [authFetch, eventId, page, search]);

  useEffect(() => {
    load();
  }, [load]);

  async function mark(h) {
    setFlash(null);
    setBusyId(h.household_id);
    try {
      const result = await authFetch(`/events/${eventId}/attendance`, {
        method: 'POST',
        body: { household_id: h.household_id },
      });
      // Recording an already-recorded household is a no-op, not an error.
      setFlash({ type: result.already_recorded ? 'info' : 'success', text: result.message });
      await load();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  async function undo(h) {
    if (!window.confirm(`Remove the attendance record for household #${h.household_id}?`)) return;
    setFlash(null);
    setBusyId(h.household_id);
    try {
      const result = await authFetch(`/events/${eventId}/attendance/${h.household_id}`, {
        method: 'DELETE',
      });
      setFlash({ type: 'success', text: result.message });
      await load();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return (
      <div className="pending-card">
        <div className="pending-head">
          <h3>Attendance</h3>
          <button className="btn secondary" onClick={onBack}>
            ← Back
          </button>
        </div>
        <div className="alert error">{error}</div>
      </div>
    );
  }
  if (!data) return <p className="muted">Loading attendance…</p>;

  const { summary } = data;

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Attendance — {data.event.title}</h3>
          <p className="muted">
            {formatWindow(data.event.start_datetime, data.event.end_datetime)}
            {data.event.fine_amount != null && (
              <> · ₱{Number(data.event.fine_amount).toFixed(2)} fine per absent household</>
            )}
          </p>
        </div>
        <button className="btn secondary" onClick={onBack}>
          ← Back
        </button>
      </div>

      {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}

      {summary.total_households === 0 ? (
        <div className="empty">
          <p>
            <strong>There are no active households yet.</strong>
          </p>
          <p className="muted">
            Attendance is recorded per household, so the Households module must have at least one
            active household before a roster can be taken.
          </p>
        </div>
      ) : (
        <>
          {/* The ratio being worked down during the assembly. */}
          <div className="roster-summary">
            <div className="roster-stat">
              <span className="roster-value">{summary.recorded}</span>
              <span className="roster-label">Recorded</span>
            </div>
            <div className="roster-stat">
              <span className="roster-value warn">{summary.missing}</span>
              <span className="roster-label">Still missing</span>
            </div>
            <div className="roster-stat">
              <span className="roster-value muted">{summary.total_households}</span>
              <span className="roster-label">Active households</span>
            </div>
          </div>

          <form
            className="head-actions"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(searchInput.trim());
            }}
          >
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search head name, address, or household #"
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

          {data.households.length === 0 ? (
            <p className="muted">No households match that search.</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table roster-table">
                <thead>
                  <tr>
                    <th>Household</th>
                    <th>Address</th>
                    <th className="num">Members</th>
                    <th>Attendance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.households.map((h) => (
                    <tr key={h.household_id} className={h.attendance ? 'row-recorded' : undefined}>
                      <td>
                        <strong>#{h.household_id}</strong>{' '}
                        {h.head_name || <span className="muted">no head assigned</span>}
                      </td>
                      <td className="muted">{h.address}</td>
                      <td className="num">{h.member_count}</td>
                      <td className="roster-action">
                        {h.attendance ? (
                          <>
                            <span className="badge status-claimed">Present</span>{' '}
                            <span className="muted small-note">
                              {formatDate(h.attendance.recorded_at)}
                              {h.attendance.recorded_by_username
                                ? ` · ${h.attendance.recorded_by_username}`
                                : ''}
                            </span>{' '}
                            <button
                              className="btn secondary danger"
                              disabled={busyId === h.household_id}
                              onClick={() => undo(h)}
                            >
                              Undo
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn roster-mark"
                            disabled={busyId === h.household_id}
                            onClick={() => mark(h)}
                          >
                            {busyId === h.household_id ? 'Recording…' : 'Mark present'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.total_pages > 1 && (
            <div className="list-head">
              <span className="muted">
                Page {data.page} of {data.total_pages}
              </span>
              <div className="head-actions">
                <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
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
    </div>
  );
}

// --- page ------------------------------------------------------------------
export default function EventsPage({ title, nav }) {
  const { authFetch } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('active');
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [formTarget, setFormTarget] = useState(null); // 'new' | event object
  const [attendanceId, setAttendanceId] = useState(null); // event whose roster is open

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), view, type });
      if (search) params.set('search', search);
      setData(await authFetch(`/events?${params}`));
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

  const renderRows = (rows) =>
    rows.map((e) => {
      const meta = eventStatusMeta(e.status);
      return (
        <tr key={e.event_id} className={e.is_archived ? 'inactive-row' : ''}>
          <td>
            <strong>{e.title}</strong>
            {e.is_archived && (
              <div>
                <span className="badge gray">Archived</span>
              </div>
            )}
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
    });

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
            <tbody>{renderRows(rows)}</tbody>
          </table>
        </div>
      )}
    </>
  );

  return (
    <div className="dash">
      <DashHeader title={title} subtitle="Barangay events and announcements" nav={nav} />

      <main className="dash-main">
        {attendanceId ? (
          <AttendanceRoster eventId={attendanceId} onBack={() => setAttendanceId(null)} />
        ) : formTarget ? (
          <EventForm
            event={formTarget === 'new' ? null : formTarget}
            onDone={(result, event) => {
              setFormTarget(null);
              if (!result) return;
              setFlash(result);
              if (event) setSelectedId(event.event_id);
              load();
            }}
          />
        ) : selectedId ? (
          <EventDetail
            id={selectedId}
            onBack={() => setSelectedId(null)}
            onEdit={(e) => setFormTarget(e)}
            onOpenAttendance={(id) => setAttendanceId(id)}
            onChanged={(message) => {
              setFlash({ type: 'success', text: message });
              load();
            }}
          />
        ) : (
          <>
            {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
            {error && <div className="alert error">{error}</div>}

            <div className="list-head">
              <h2>
                {data === null ? 'Events' : `${data.total} record${data.total === 1 ? '' : 's'}`}
              </h2>
              <form className="head-actions" onSubmit={handleSearch}>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search title, details, or location…"
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
                  {EVENT_VIEWS.map((v) => (
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
                <button className="btn" type="button" onClick={() => setFormTarget('new')}>
                  New
                </button>
              </form>
            </div>

            {data === null ? (
              <p className="muted">Loading events…</p>
            ) : events.length === 0 ? (
              <div className="empty">
                <p>
                  No {view === 'past' ? 'past activities' : view === 'archived' ? 'archived records' : 'events'}
                  {search ? ` matching "${search}"` : ''}.
                </p>
              </div>
            ) : (
              <>
                {/* The two record kinds are listed separately so the untimed
                    announcements never get lost among scheduled activities. */}
                {type !== 'announcement' &&
                  section(
                    view === 'past' ? 'Past activities' : 'Activities',
                    activities,
                    'No activities in this view.'
                  )}
                {type !== 'activity' &&
                  view !== 'past' &&
                  section('Announcements', announcements, 'No announcements in this view.')}

                {data.total_pages > 1 && (
                  <div className="list-head">
                    <span className="muted">
                      Page {data.page} of {data.total_pages}
                    </span>
                    <div className="head-actions">
                      <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
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
