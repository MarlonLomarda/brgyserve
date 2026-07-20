import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { ITEM_TYPE_LABELS, formatSchedule, rentalMeta } from '../constants/rentals';

// All-bookings view, shared by three roles: the Secretary manages
// (canManage — edit/cancel), Barangay Staff and the Punong Barangay get the
// same list read-only. Pass the role's title and nav like PaymentsPage.

const FILTERS = ['confirmed', 'cancelled', 'completed', 'all'];
const FILTER_LABELS = {
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  all: 'All bookings',
};

function residentName(booking) {
  const p = booking.requester?.profiles;
  if (p) {
    const name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
    if (name) return p.suffix ? `${name}, ${p.suffix}` : name;
  }
  return booking.requester?.username ? `@${booking.requester.username}` : '—';
}

const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const toTimeInput = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function EditPanel({ booking, onDone }) {
  const { authFetch } = useAuth();
  const item = booking.rental_items;
  const isCountable = item?.quantity_total > 1;
  const [form, setForm] = useState({
    date: toDateInput(booking.start_datetime),
    start_time: toTimeInput(booking.start_datetime),
    end_time: toTimeInput(booking.end_datetime),
    quantity: String(booking.quantity_requested),
    purpose: booking.purpose,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await authFetch(`/rental-requests/${booking.request_id}`, {
        method: 'PUT',
        body: {
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          quantity_requested: isCountable ? Number(form.quantity) : 1,
          purpose: form.purpose,
        },
      });
      onDone({ type: 'success', text: data.message });
    } catch (err) {
      setError(err.message); // conflict messages land here
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Edit booking #{booking.request_id}</h3>
          <p className="muted">
            {residentName(booking)} · {item?.name} ({ITEM_TYPE_LABELS[item?.type] || item?.type})
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="grid-2">
          <label>
            Date
            <input name="date" type="date" min={today} value={form.date} onChange={handleChange} required />
          </label>
          {isCountable && (
            <label>
              Quantity <span className="hint">(up to {item.quantity_total})</span>
              <input
                name="quantity"
                type="number"
                min="1"
                max={item.quantity_total}
                step="1"
                value={form.quantity}
                onChange={handleChange}
                required
              />
            </label>
          )}
          <label>
            Start time
            <input name="start_time" type="time" value={form.start_time} onChange={handleChange} required />
          </label>
          <label>
            End time
            <input name="end_time" type="time" value={form.end_time} onChange={handleChange} required />
          </label>
        </div>
        <label>
          Purpose
          <textarea name="purpose" value={form.purpose} onChange={handleChange} rows={3} maxLength={1000} required />
        </label>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Checking availability…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function RentalBookingsPage({ title, nav, canManage = false }) {
  const { authFetch } = useAuth();
  const [filter, setFilter] = useState('confirmed');
  const [requests, setRequests] = useState(null); // null = loading
  const [listError, setListError] = useState('');
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // booking being edited

  const load = useCallback(async () => {
    setListError('');
    try {
      const query = filter === 'all' ? '' : `?status=${filter}`;
      const data = await authFetch(`/rental-requests${query}`);
      setRequests(data.requests);
    } catch (err) {
      setListError(err.message);
      setRequests([]);
    }
  }, [authFetch, filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCancel(r) {
    const when = formatSchedule(r.start_datetime, r.end_datetime);
    if (!window.confirm(`Cancel ${residentName(r)}'s booking of ${r.rental_items?.name} (${when})? The slot will be freed for others.`)) {
      return;
    }
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(`/rental-requests/${r.request_id}/cancel`, { method: 'POST' });
      setFlash({ type: 'success', text: data.message });
      await load();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dash">
      <DashHeader
        title={title}
        subtitle={canManage ? 'Manage facility and item bookings' : 'Facility and item bookings (view only)'}
        nav={nav}
      />

      <main className="dash-main">
        {editing ? (
          <EditPanel
            booking={editing}
            onDone={(result) => {
              setEditing(null);
              if (result) {
                setFlash(result);
                load();
              }
            }}
          />
        ) : (
          <>
            {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
            {listError && <div className="alert error">{listError}</div>}

            <div className="list-head">
              <h2>
                {requests === null
                  ? 'Bookings'
                  : `${requests.length} booking${requests.length === 1 ? '' : 's'}`}
              </h2>
              <div className="head-actions">
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {FILTER_LABELS[f]}
                    </option>
                  ))}
                </select>
                <button className="btn secondary" onClick={load}>
                  Refresh
                </button>
              </div>
            </div>

            {requests === null ? (
              <p className="muted">Loading bookings…</p>
            ) : requests.length === 0 ? (
              <div className="empty">
                <p>No {filter === 'all' ? '' : `${FILTER_LABELS[filter].toLowerCase()} `}bookings.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Resident</th>
                      <th>Item</th>
                      <th>Schedule</th>
                      <th className="num">Qty</th>
                      <th>Purpose</th>
                      <th>Status</th>
                      {canManage && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => {
                      const meta = rentalMeta(r.status);
                      return (
                        <tr key={r.request_id}>
                          <td>
                            <strong>{residentName(r)}</strong>
                            {r.requester?.username && (
                              <div className="muted small-note">@{r.requester.username}</div>
                            )}
                          </td>
                          <td>{r.rental_items?.name || '—'}</td>
                          <td>{formatSchedule(r.start_datetime, r.end_datetime)}</td>
                          <td className="num">{r.quantity_requested}</td>
                          <td className="muted truncate">{r.purpose}</td>
                          <td>
                            <span className={`badge ${meta.className}`}>{meta.label}</span>
                          </td>
                          {canManage && (
                            <td className="row-actions">
                              {r.status === 'confirmed' && (
                                <>
                                  <button
                                    className="btn secondary"
                                    disabled={busyId === r.request_id}
                                    onClick={() => setEditing(r)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="btn secondary danger"
                                    disabled={busyId === r.request_id}
                                    onClick={() => handleCancel(r)}
                                  >
                                    {busyId === r.request_id ? 'Cancelling…' : 'Cancel'}
                                  </button>
                                </>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
