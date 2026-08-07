import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import AttendanceScanner from '../components/AttendanceScanner';
import DashHeader from '../components/DashHeader';
import { chargeMeta, formatDate } from '../constants/requestStatus';
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

// --- fines panel (stage 3b) ------------------------------------------------
// Secretary-only. Raising fines is an explicit decision, so the panel always
// states exactly who would be charged and how much BEFORE the button is
// pressed, and explains itself when it cannot proceed instead of hiding.
function FinesPanel({ fines, busyId, onGenerate, onVoid }) {
  const s = fines.summary;
  const raised = fines.households.filter((h) => h.charge);
  const mismatched = fines.households.filter((h) => h.state === 'mismatch');
  const peso = (n) => `₱${Number(n).toFixed(2)}`;

  return (
    <div className="fines-panel">
      <div className="list-head">
        <h4>
          Fines{' '}
          {s.fine_amount != null && (
            <span className="muted">· {peso(s.fine_amount)} per absent household</span>
          )}
        </h4>
        {s.to_charge > 0 && !fines.blocked_reason && (
          <button className="btn" disabled={busyId === 'fines'} onClick={onGenerate}>
            {busyId === 'fines'
              ? 'Raising…'
              : `Generate ${s.to_charge} fine${s.to_charge === 1 ? '' : 's'} · ${peso(s.total_amount)}`}
          </button>
        )}
      </div>

      {/* Attendance and the charge disagree. Nothing resolves this on its own:
          voiding is permanent for the event, so it takes a deliberate click. */}
      {mismatched.length > 0 && (
        <div className="alert error fines-mismatch">
          <strong>
            {mismatched.length} household{mismatched.length === 1 ? '' : 's'} marked present but still
            {mismatched.length === 1 ? ' has' : ' have'} a fine for this activity.
          </strong>
          <p>
            Recording attendance does not change a fine. Review each one and void it if the fine is
            wrong — voiding is permanent for this activity and cannot be undone.
          </p>
          <ul className="mismatch-list">
            {mismatched.map((h) => (
              <li key={h.household_id}>
                <span>
                  <strong>#{h.household_id}</strong>{' '}
                  {h.head_name || <span className="muted">no head assigned</span>} ·{' '}
                  {peso(h.charge.amount)} {chargeMeta(h.charge.status).label.toLowerCase()}
                </span>
                {h.charge.status === 'UNPAID' ? (
                  <button
                    className="btn secondary danger"
                    disabled={busyId === h.household_id}
                    onClick={() => onVoid(h)}
                  >
                    {busyId === h.household_id ? 'Voiding…' : 'Void this fine'}
                  </button>
                ) : (
                  <span className="muted small-note">
                    Already paid — it cannot be voided here. Refunds are handled at the Barangay
                    Office.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fines.blocked_reason ? (
        <p className="muted">{fines.blocked_reason}</p>
      ) : (
        <p className="muted">
          {s.to_charge > 0 ? (
            <>
              <strong>{s.to_charge}</strong> household{s.to_charge === 1 ? '' : 's'} would be charged{' '}
              {peso(s.total_amount)} in total.
            </>
          ) : (
            <>Nothing to raise — every active household is recorded present or already has a fine.</>
          )}
          {s.registered_after > 0 && (
            <>
              {' '}
              {s.registered_after} household{s.registered_after === 1 ? '' : 's'} registered after this
              activity ended and {s.registered_after === 1 ? 'is' : 'are'} not counted.
            </>
          )}
        </p>
      )}

      {raised.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Household</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {raised.map((h) => {
                const meta = chargeMeta(h.charge.status);
                return (
                  <tr key={h.household_id}>
                    <td>
                      <strong>#{h.household_id}</strong>{' '}
                      {h.head_name || <span className="muted">no head assigned</span>}
                    </td>
                    <td className="num">{peso(h.charge.amount)}</td>
                    <td>
                      <span className={`badge ${meta.className}`}>{meta.label}</span>
                    </td>
                    <td className="roster-action">
                      {h.charge.status === 'UNPAID' && (
                        <button
                          className="btn secondary danger"
                          disabled={busyId === h.household_id}
                          onClick={() => onVoid(h)}
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- attendance roster (stages 3a + 3d) ------------------------------------
// Used on a phone during an assembly, so the counts are large, the rows stay
// readable at narrow width, and the tap targets are big. Stage 3d adds the QR
// scanner to this same screen: scanning and tapping "Mark present" are two
// ways to name a household, and both post to the one attendance route.
function AttendanceRoster({ eventId, onBack }) {
  const { authFetch, user } = useAuth();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [scanning, setScanning] = useState(false);
  // Fines are Secretary-only (stage 3b). Staff still record attendance here,
  // they just never see the money side; the server refuses them regardless.
  const canFine = user?.role === 'secretary';
  const [fines, setFines] = useState(null);

  const loadFines = useCallback(async () => {
    if (!canFine) return;
    try {
      setFines(await authFetch(`/events/${eventId}/fines`));
    } catch {
      // A roster that works matters more than the fines panel; failing here
      // must not blank the screen the assembly is being run from.
      setFines(null);
    }
  }, [authFetch, eventId, canFine]);

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

  useEffect(() => {
    loadFines();
  }, [loadFines]);

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
      await loadFines();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  // The scanner's one link to the API. Stable identity on purpose: it feeds
  // the scanner's decode loop, which would otherwise be torn down and rebuilt
  // on every render of this page.
  const submitToken = useCallback(
    async (token) => {
      try {
        const result = await authFetch(`/events/${eventId}/attendance`, {
          method: 'POST',
          body: { qr_token: token },
        });
        // Not awaited — the roster catching up must not hold up the next scan.
        load();
        loadFines();
        return {
          type: result.already_recorded ? 'info' : 'success',
          text: result.message,
        };
      } catch (err) {
        return { type: 'error', text: err.message };
      }
    },
    [authFetch, eventId, load, loadFines]
  );

  async function generateFines() {
    const s = fines?.summary;
    const ok = window.confirm(
      `Raise ${s.to_charge} fine${s.to_charge === 1 ? '' : 's'} of ₱${Number(s.fine_amount).toFixed(2)} ` +
        `(₱${Number(s.total_amount).toFixed(2)} total)?\n\n` +
        'Each absent household will owe this at the Barangay Office. ' +
        'Households already recorded present are not charged.'
    );
    if (!ok) return;
    setFlash(null);
    setBusyId('fines');
    try {
      const result = await authFetch(`/events/${eventId}/fines`, { method: 'POST' });
      setFlash({ type: 'success', text: result.message });
      await loadFines();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  async function voidFine(row) {
    if (
      !window.confirm(
        `Void the ₱${Number(row.charge.amount).toFixed(2)} fine for household #${row.household_id}?\n\n` +
          'This cannot be undone — no replacement fine can be raised for this activity afterwards.'
      )
    )
      return;
    setFlash(null);
    setBusyId(row.household_id);
    try {
      const result = await authFetch(`/events/${eventId}/fines/${row.household_id}/void`, {
        method: 'POST',
      });
      setFlash({ type: 'success', text: result.message });
      await loadFines();
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
      await loadFines();
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
  // Households marked present that still carry a live fine. Flagged on the row
  // too, so the clash is visible where the attendance edit was made and not
  // only in the panel above.
  const mismatchIds = new Set(
    (fines?.households || []).filter((h) => h.state === 'mismatch').map((h) => h.household_id)
  );

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

          {/* Stage 3d. The primary action at an assembly, so it sits directly
              under the counts and above the fines panel, which is a job for
              after the event rather than during it. */}
          {scanning ? (
            <AttendanceScanner onScan={submitToken} onClose={() => setScanning(false)} />
          ) : (
            <button className="btn scan-open" type="button" onClick={() => setScanning(true)}>
              Scan QR code
            </button>
          )}

          {canFine && fines && <FinesPanel fines={fines} busyId={busyId} onGenerate={generateFines} onVoid={voidFine} />}

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
                            {mismatchIds.has(h.household_id) && (
                              <span className="badge status-rejected" title="Marked present but still has a fine for this activity">
                                Fine outstanding
                              </span>
                            )}{' '}
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
