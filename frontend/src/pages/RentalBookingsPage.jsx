import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import DashHeader from "../components/DashHeader";
import ResidentPicker from "../components/ResidentPicker";
import { formatDate } from "../constants/requestStatus";
import {
  ITEM_TYPE_LABELS,
  RETURN_OUTCOMES,
  displayStatus,
  formatSchedule,
  isReturnable,
  rentalMeta,
} from "../constants/rentals";

// All-bookings view, shared by three roles: the Secretary manages
// (canManage — edit/cancel), Barangay Staff mark physical items returned
// (canReturn), the Punong Barangay is read-only. Pass the role's title and
// nav like PaymentsPage.

const FILTERS = [
  "confirmed",
  "overdue",
  "completed",
  "returned",
  "returned_late",
  "returned_with_issue",
  "cancelled",
  "all",
];
const FILTER_LABELS = {
  confirmed: "Confirmed / upcoming",
  overdue: "Overdue (awaiting return)",
  completed: "Completed (facilities)",
  returned: "Returned",
  returned_late: "Returned late",
  returned_with_issue: "Returned with issue",
  cancelled: "Cancelled",
  all: "All bookings",
};

const fullName = (p) => {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name]
    .filter(Boolean)
    .join(" ");
  if (!name) return null;
  return p.suffix ? `${name}, ${p.suffix}` : name;
};

const isGuest = (booking) => Boolean(booking.outside_borrower_name);

// WHO THE BOOKING IS FOR — the borrower, not the requester. Since migration
// 022 a row names its borrower directly (resident_records for a resident,
// outside_borrower_name for a guest) and the requester is only who FILED it;
// for a walk-in that is the Secretary. The requester's profile is kept as a
// last fallback for rows the server did not embed a borrower on.
function residentName(booking) {
  return (
    fullName(booking.resident_records) ||
    booking.outside_borrower_name ||
    fullName(booking.requester?.profiles) ||
    (booking.requester?.username ? `@${booking.requester.username}` : "—")
  );
}

const pad = (n) => String(n).padStart(2, "0");
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await authFetch(`/rental-requests/${booking.request_id}`, {
        method: "PUT",
        body: {
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          quantity_requested: isCountable ? Number(form.quantity) : 1,
          purpose: form.purpose,
        },
      });
      onDone({ type: "success", text: data.message });
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
            {residentName(booking)} · {item?.name} (
            {ITEM_TYPE_LABELS[item?.type] || item?.type})
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
            <input
              name="date"
              type="date"
              min={today}
              value={form.date}
              onChange={handleChange}
              required
            />
          </label>
          {isCountable && (
            <label>
              Quantity{" "}
              <span className="hint">(up to {item.quantity_total})</span>
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
            <input
              name="start_time"
              type="time"
              value={form.start_time}
              onChange={handleChange}
              required
            />
          </label>
          <label>
            End time
            <input
              name="end_time"
              type="time"
              value={form.end_time}
              onChange={handleChange}
              required
            />
          </label>
        </div>
        <label>
          Purpose
          <textarea
            name="purpose"
            value={form.purpose}
            onChange={handleChange}
            rows={3}
            maxLength={1000}
            required
          />
        </label>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Checking availability…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Staff record a physical item's return: an outcome + optional note.
function ReturnPanel({ booking, onDone }) {
  const { authFetch } = useAuth();
  const item = booking.rental_items;
  const [outcome, setOutcome] = useState(RETURN_OUTCOMES[0].value);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await authFetch(
        `/rental-requests/${booking.request_id}/return`,
        {
          method: "POST",
          body: { outcome, note: note.trim() || undefined },
        },
      );
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Mark returned — booking #{booking.request_id}</h3>
          <p className="muted">
            {residentName(booking)} · {item?.name} (
            {ITEM_TYPE_LABELS[item?.type] || item?.type}) ·{" "}
            {booking.quantity_requested} unit
            {booking.quantity_requested === 1 ? "" : "s"}
          </p>
          <p className="muted">
            {formatSchedule(booking.start_datetime, booking.end_datetime)}
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {RETURN_OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note{" "}
          <span className="hint">
            (optional — e.g. what was damaged or missing)
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
          />
        </label>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Recording…" : "Record return"}
          </button>
        </div>
      </form>
    </div>
  );
}

const EMPTY_WALK_IN = {
  item_id: "",
  date: "",
  start_time: "",
  end_time: "",
  quantity: "1",
  purpose: "",
};

// The Secretary encodes a booking for someone at the hall: a registered
// resident picked from the master list, or a guest from another barangay
// typed in by name and contact number — a real, current practice (outsiders
// rent select items, mostly costumes). Exactly one of the two, matching the
// CHECK constraint from migration 022; the server validates the same rule.
//
// Standalone rather than sharing BookRentalPage's fields: EditPanel above
// already duplicates that grid the same way, and extracting it would refactor
// a resident-facing page this feature does not otherwise touch. The fields
// are the same ones that form collects; only who-it-is-for is new.
//
// THE CONFLICT CHECK IS THE SERVER'S. This posts to the same
// POST /rental-requests handler BookRentalPage does, and that handler runs
// findConflict() before and after the insert for every caller — there is no
// second code path a walk-in could take around it. Refusals surface here in
// `error` exactly as they do on the resident form.
function WalkInBookingPanel({ onDone }) {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState("resident"); // 'resident' | 'guest'
  const [resident, setResident] = useState(null);
  const [guest, setGuest] = useState({ name: "", contact: "" });
  const [form, setForm] = useState({ ...EMPTY_WALK_IN });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch("/rental-items");
        if (!cancelled) setItems(data.rental_items);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          setItems([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const selectedItem = items?.find(
    (i) => String(i.item_id) === String(form.item_id),
  );
  const isCountable = selectedItem && selectedItem.quantity_total > 1;
  const quantity = isCountable ? Number(form.quantity) || 0 : 1;
  const estimatedFee = selectedItem ? Number(selectedItem.fee) * quantity : 0;

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === "item_id") next.quantity = "1"; // reset when switching items
      return next;
    });
  }

  function switchMode(next) {
    setMode(next);
    setError("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (mode === "resident" && !resident) {
      setError("Pick the resident this booking is for.");
      return;
    }
    if (mode === "guest" && (!guest.name.trim() || !guest.contact.trim())) {
      setError("A guest booking needs both a name and a contact number.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const data = await authFetch("/rental-requests", {
        method: "POST",
        body: {
          item_id: Number(form.item_id),
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          quantity_requested: quantity,
          purpose: form.purpose,
          ...(mode === "guest"
            ? {
                outside_borrower_name: guest.name.trim(),
                outside_borrower_contact: guest.contact.trim(),
              }
            : { resident_id: resident.resident_id }),
        },
      });
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message); // conflict reasons surface here — pick another slot
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Encode walk-in booking</h3>
          <p className="muted">
            For someone at the barangay hall. Filed under your account and
            recorded for the borrower you name.
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {loadError && <div className="alert error">{loadError}</div>}
      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="tab-container">
          <button
            type="button"
            className={`tab ${mode === "resident" ? "active-tab" : ""}`}
            onClick={() => switchMode("resident")}
          >
            Existing resident
          </button>
          <button
            type="button"
            className={`tab ${mode === "guest" ? "active-tab" : ""}`}
            onClick={() => switchMode("guest")}
          >
            Guest from another barangay
          </button>
        </div>

        {mode === "resident" ? (
          <>
            <label>Resident</label>
            <ResidentPicker
              value={resident}
              onPick={(r) => {
                setResident(r);
                setError("");
              }}
              onClear={() => setResident(null)}
              placeholder="Search the resident master list…"
            />
          </>
        ) : (
          <div className="grid-2">
            <label>
              Full name
              <input
                value={guest.name}
                onChange={(e) =>
                  setGuest((g) => ({ ...g, name: e.target.value }))
                }
                maxLength={200}
                placeholder="As given at the counter"
                required
              />
            </label>
            <label>
              Contact number
              <input
                value={guest.contact}
                onChange={(e) =>
                  setGuest((g) => ({ ...g, contact: e.target.value }))
                }
                maxLength={50}
                placeholder="Where the booking notices go"
                required
              />
            </label>
          </div>
        )}

        {items === null ? (
          <p className="muted">Loading rental items…</p>
        ) : items.length === 0 ? (
          <p className="muted">Nothing is currently available for rental.</p>
        ) : (
          <>
            <label>
              Facility / item
              <select
                name="item_id"
                value={form.item_id}
                onChange={handleChange}
                required
              >
                <option value="" disabled>
                  Select an item…
                </option>
                {items.map((i) => (
                  <option key={i.item_id} value={i.item_id}>
                    {i.name} ({ITEM_TYPE_LABELS[i.type] || i.type}) — ₱
                    {Number(i.fee).toFixed(2)}
                    {i.quantity_total > 1
                      ? ` per unit · ${i.quantity_total} units`
                      : " per booking"}
                  </option>
                ))}
              </select>
            </label>
            {selectedItem?.description && (
              <p className="muted type-description">
                {selectedItem.description}
              </p>
            )}

            <div className="grid-2">
              <label>
                Date
                <input
                  name="date"
                  type="date"
                  min={today}
                  value={form.date}
                  onChange={handleChange}
                  required
                />
              </label>
              {isCountable && (
                <label>
                  Quantity{" "}
                  <span className="hint">
                    (up to {selectedItem.quantity_total})
                  </span>
                  <input
                    name="quantity"
                    type="number"
                    min="1"
                    max={selectedItem.quantity_total}
                    step="1"
                    value={form.quantity}
                    onChange={handleChange}
                    required
                  />
                </label>
              )}
              <label>
                Start time
                <input
                  name="start_time"
                  type="time"
                  value={form.start_time}
                  onChange={handleChange}
                  required
                />
              </label>
              <label>
                End time
                <input
                  name="end_time"
                  type="time"
                  value={form.end_time}
                  onChange={handleChange}
                  required
                />
              </label>
            </div>

            <label>
              Purpose
              <textarea
                name="purpose"
                value={form.purpose}
                onChange={handleChange}
                rows={3}
                maxLength={1000}
                placeholder="e.g. Birthday party, basketball league practice, family reunion…"
                required
              />
            </label>

            {selectedItem && (
              <p className="muted">
                Estimated fee: <strong>₱{estimatedFee.toFixed(2)}</strong>
                {isCountable && quantity > 0 && (
                  <>
                    {" "}
                    ({quantity} × ₱{Number(selectedItem.fee).toFixed(2)})
                  </>
                )}
              </p>
            )}

            <div className="actions">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Checking availability…" : "Record booking"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

export default function RentalBookingsPage({
  title,
  nav,
  canManage = false,
  canReturn = false,
}) {
  const { authFetch } = useAuth();
  const [filter, setFilter] = useState(canReturn ? "overdue" : "confirmed");
  const [requests, setRequests] = useState(null); // null = loading
  const [listError, setListError] = useState("");
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // booking being edited
  const [returning, setReturning] = useState(null); // booking being returned
  const [encoding, setEncoding] = useState(false); // walk-in panel open

  const load = useCallback(async () => {
    setListError("");
    try {
      const query = filter === "all" ? "" : `?status=${filter}`;
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
    if (
      !window.confirm(
        `Cancel ${residentName(r)}'s booking of ${r.rental_items?.name} (${when})? The slot will be freed for others.`,
      )
    ) {
      return;
    }
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(`/rental-requests/${r.request_id}/cancel`, {
        method: "POST",
      });
      setFlash({ type: "success", text: data.message });
      await load();
    } catch (err) {
      setFlash({ type: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  // const subtitle = canManage
  //   ? "Manage facility and item bookings"
  //   : canReturn
  //     ? "Track what is out and record returns"
  //     : "Facility and item bookings (view only)";

  return (
    <>
      {/* <DashHeader title={title} subtitle={subtitle} nav={nav} /> */}

      {encoding ? (
        <WalkInBookingPanel
          onDone={(result) => {
            setEncoding(false);
            if (result) {
              setFlash(result);
              load();
            }
          }}
        />
      ) : editing ? (
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
      ) : returning ? (
        <ReturnPanel
          booking={returning}
          onDone={(result) => {
            setReturning(null);
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
                ? "Bookings"
                : `${requests.length} booking${requests.length === 1 ? "" : "s"}`}
            </h2>
            <div className="head-actions">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                {FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {FILTER_LABELS[f]}
                  </option>
                ))}
              </select>
              <button className="btn secondary" onClick={load}>
                Refresh
              </button>
              {/* Secretary only. canManage is passed by App.jsx on the
                  /secretary route alone — Staff get canReturn, the Punong
                  Barangay neither — so this is the role gate, in the same
                  prop Edit and Cancel already key on. */}
              {canManage && (
                <button
                  className="btn"
                  onClick={() => {
                    setFlash(null);
                    setEncoding(true);
                  }}
                >
                  Encode walk-in
                </button>
              )}
            </div>
          </div>

          {requests === null ? (
            <p className="muted">Loading bookings…</p>
          ) : requests.length === 0 ? (
            <div className="empty">
              <p>
                No{" "}
                {filter === "all"
                  ? ""
                  : `${FILTER_LABELS[filter].toLowerCase()} `}
                bookings.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table stack-narrow">
                <thead>
                  <tr>
                    <th>Booked for</th>
                    <th>Item</th>
                    <th>Schedule</th>
                    <th className="num">Qty</th>
                    <th>Purpose</th>
                    <th>Status</th>
                    {(canManage || canReturn) && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const shown = displayStatus(r);
                    const meta = rentalMeta(shown);
                    const returnable = isReturnable(r.rental_items?.type);
                    return (
                      <tr key={r.request_id}>
                        <td>
                          <strong>{residentName(r)}</strong>
                          {isGuest(r) ? (
                            <div className="muted small-note">
                              Guest · {r.outside_borrower_contact}
                            </div>
                          ) : (
                            r.requester?.username && (
                              <div className="muted small-note">
                                @{r.requester.username}
                              </div>
                            )
                          )}
                        </td>
                        <td data-label="Item">{r.rental_items?.name || "—"}</td>
                        <td data-label="Schedule">
                          {formatSchedule(r.start_datetime, r.end_datetime)}
                        </td>
                        <td className="num" data-label="Qty">
                          {r.quantity_requested}
                        </td>
                        <td className="muted truncate" data-label="Purpose">
                          {r.purpose}
                        </td>
                        <td>
                          <span className={`badge ${meta.className}`}>
                            {meta.label}
                          </span>
                          {r.return_note && (
                            <div className="muted reason-note">
                              Note: {r.return_note}
                            </div>
                          )}
                          {r.returned_at && r.returned_by?.username && (
                            <div className="muted small-note">
                              by @{r.returned_by.username} on{" "}
                              {formatDate(r.returned_at)}
                            </div>
                          )}
                        </td>
                        {(canManage || canReturn) && (
                          <td className="row-actions">
                            {canManage && r.status === "confirmed" && (
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
                                  {busyId === r.request_id
                                    ? "Cancelling…"
                                    : "Cancel"}
                                </button>
                              </>
                            )}
                            {canReturn &&
                              r.status === "confirmed" &&
                              returnable && (
                                <button
                                  className="btn secondary"
                                  disabled={busyId === r.request_id}
                                  onClick={() => setReturning(r)}
                                >
                                  Mark returned
                                </button>
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
    </>
  );
}
