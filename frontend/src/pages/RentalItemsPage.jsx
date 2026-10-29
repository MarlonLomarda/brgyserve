import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ITEM_TYPE_LABELS as TYPE_LABELS } from "../constants/rentals";
import { clockMinutes, hoursText } from "../utils/bookingTimes";

// Facilities are whole venues booked as one unit, so quantity locks to 1.

// The lower-stock warning in words (step C3): the server's 409
// STOCK_BELOW_BOOKED carries counts only (bookings, units, largest,
// new_total), never who booked or why. `name` is the item's current name.
function stockWarningText({ bookings, units, largest, new_total }, name) {
  const one = bookings === 1;
  return [
    `${bookings} upcoming or overdue booking${one ? " holds" : "s hold"} ${units} unit${units === 1 ? "" : "s"} of ${name}.`,
    one ? null : `The largest asks for ${largest}.`,
    `If you lower the total to ${new_total}, ${one ? "that booking stays" : "those bookings stay"}, but new bookings will be refused until enough units are free.`,
    "Lower it anyway?",
  ]
    .filter(Boolean)
    .join(" ");
}

// Why a load failed, for "Could not load the rental items: …". The server's
// own message when it sent one (the API's errors are plain sentences, never a
// stack). Anything else, a server that could not be reached or an answer with
// no message in it, gets a plain fallback rather than the client's own text.
// One more copy of the Rental bookings page's function.
function loadFailure(err) {
  const sent = err?.data?.error;
  return typeof sent === "string" && sent.trim()
    ? sent.trim()
    : "the server did not respond";
}

// An item's stored hours ("07:00:00", or "24:00:00" for midnight) as a time
// field's "HH:MM". A time field cannot hold 24:00, so midnight is 00:00,
// which the server reads back as midnight for a closing time (migration 025).
function timeField(stored, fallback) {
  const minutes = clockMinutes(stored);
  if (minutes === null) return fallback;
  if (minutes === 24 * 60) return "00:00";
  return String(stored).slice(0, 5);
}

const EMPTY_FORM = {
  item_id: null,
  name: "",
  type: "facility",
  description: "",
  quantity_total: "1",
  fee: "",
  // The database's own defaults for a new item (migration 025).
  booking_opens_at: "07:00",
  booking_closes_at: "17:00",
};

export default function RentalItemsPage() {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading, or a failed load
  const [listError, setListError] = useState(null); // why the last load failed
  // Numbers each load, so only the newest one may change the list.
  const loadSeq = useRef(0);
  const [flash, setFlash] = useState(null);
  const [form, setForm] = useState(null); // null = closed; object = create/edit form
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  // The server's STOCK_BELOW_BOOKED answer while its warning is shown.
  const [stockWarning, setStockWarning] = useState(null);
  const quantityRef = useRef(null);

  // A FAILED LOAD IS NOT AN EMPTY LIST (CLAUDE.md: a list that failed to
  // load). This used to store [] beside the error, so the server's bare
  // message sat over "0 rental items" and "No rental items yet." while the
  // page knew nothing. items now stays null and the error, with Try again,
  // takes the place of the table. Every load starts from the loading state
  // (the first open, Refresh, Try again and the reload after a save), and an
  // older answer that arrives late is dropped.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setListError(null);
    setItems(null);
    try {
      const data = await authFetch("/rental-items/all");
      if (seq === loadSeq.current) setItems(data.rental_items);
    } catch (err) {
      if (seq === loadSeq.current) setListError(loadFailure(err));
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setFormError("");
    setStockWarning(null);
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(item) {
    setFormError("");
    setStockWarning(null);
    setForm({
      item_id: item.item_id,
      name: item.name,
      type: item.type,
      description: item.description || "",
      quantity_total: String(item.quantity_total),
      fee: String(item.fee),
      booking_opens_at: timeField(item.booking_opens_at, EMPTY_FORM.booking_opens_at),
      booking_closes_at: timeField(item.booking_closes_at, EMPTY_FORM.booking_closes_at),
    });
  }

  function handleChange(e) {
    const { name, value } = e.target;
    // A new number is a new question: the warning was about the old one.
    if (name === "quantity_total" || name === "type") setStockWarning(null);
    setForm((f) => {
      const next = { ...f, [name]: value };
      // facilities are single-unit — lock the quantity
      if (name === "type" && value === "facility") next.quantity_total = "1";
      return next;
    });
  }

  function handleSubmit(e) {
    e.preventDefault();
    save(false);
  }

  // Saves the form. `confirmLower` is "Lower anyway": the same request, with
  // confirm_lower_stock, after the server warned that bookings hold more
  // units than the new total. WARN, THEN ALLOW: those bookings stay.
  async function save(confirmLower) {
    setFormError("");
    setStockWarning(null);
    setBusy(true);
    try {
      const body = {
        name: form.name,
        type: form.type,
        description: form.description,
        quantity_total: Number(form.quantity_total),
        fee: form.fee,
        booking_opens_at: form.booking_opens_at,
        booking_closes_at: form.booking_closes_at,
        ...(confirmLower ? { confirm_lower_stock: true } : {}),
      };
      const data = form.item_id
        ? await authFetch(`/rental-items/${form.item_id}`, {
            method: "PUT",
            body,
          })
        : await authFetch("/rental-items", { method: "POST", body });
      setFlash({ type: "success", text: data.message });
      setForm(null);
      await load();
    } catch (err) {
      if (err.status === 409 && err.data?.code === "STOCK_BELOW_BOOKED") {
        setStockWarning(err.data);
      } else {
        setFormError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  // "Keep the current number": the total goes back to what is saved, and
  // nothing is sent; any other change in the form is kept.
  function keepNumber() {
    const saved = items?.find((i) => i.item_id === form.item_id);
    setStockWarning(null);
    if (saved) {
      setForm((f) => ({ ...f, quantity_total: String(saved.quantity_total) }));
    }
    quantityRef.current?.focus();
  }

  async function toggleActive(item) {
    setFlash(null);
    setBusy(true);
    try {
      const action = item.is_active ? "deactivate" : "activate";
      const data = await authFetch(`/rental-items/${item.item_id}/${action}`, {
        method: "POST",
      });
      setFlash({ type: "success", text: data.message });
      await load();
    } catch (err) {
      setFlash({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}

      <div className="list-head">
        <h2>
          {items === null
            ? "Rental items"
            : `${items.length} rental item${items.length === 1 ? "" : "s"}`}
        </h2>
        <div className="head-actions">
          <button className="btn secondary" onClick={load}>
            Refresh
          </button>
          <button className="btn" onClick={openCreate}>
            New rental item
          </button>
        </div>
      </div>

      {form && (
        <form className="pending-card section-card" onSubmit={handleSubmit}>
          <h3>{form.item_id ? "Edit rental item" : "New rental item"}</h3>
          {formError && <div className="alert error">{formError}</div>}
          <div className="grid-2">
            <label>
              Name
              <input
                name="name"
                value={form.name}
                onChange={handleChange}
                maxLength={100}
                required
              />
            </label>
            <label>
              Type
              <select name="type" value={form.type} onChange={handleChange}>
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantity{" "}
              {form.type === "facility" && (
                <span className="hint">(facilities are single-unit)</span>
              )}
              <input
                ref={quantityRef}
                name="quantity_total"
                type="number"
                min="1"
                step="1"
                value={form.quantity_total}
                onChange={handleChange}
                disabled={form.type === "facility"}
                required
              />
            </label>
            <label>
              Fee (PHP) <span className="hint">(per unit per booking)</span>
              <input
                name="fee"
                type="number"
                min="0"
                step="0.01"
                value={form.fee}
                onChange={handleChange}
                required
              />
            </label>
            {/* The hours this item can be booked in, every day. */}
            <label>
              Opens
              <input
                name="booking_opens_at"
                type="time"
                value={form.booking_opens_at}
                onChange={handleChange}
                required
              />
            </label>
            <label>
              Closes <span className="hint">(12:00 AM means midnight)</span>
              <input
                name="booking_closes_at"
                type="time"
                value={form.booking_closes_at}
                onChange={handleChange}
                required
              />
            </label>
          </div>
          <label>
            Description <span className="hint">(optional)</span>
            <textarea
              name="description"
              value={form.description}
              onChange={handleChange}
              rows={3}
            />
          </label>
          {stockWarning && (
            <div className="alert info stock-warning" role="alert">
              <p>
                {stockWarningText(
                  stockWarning,
                  items?.find((i) => i.item_id === form.item_id)?.name ||
                    form.name,
                )}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn secondary danger"
                  disabled={busy}
                  onClick={() => save(true)}
                >
                  Lower anyway
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={keepNumber}
                >
                  Keep the current number
                </button>
              </div>
            </div>
          )}
          <div className="actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : form.item_id ? "Save changes" : "Create"}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setForm(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* The error first, then loading, then empty, then rows: a load that
          failed shows neither a count nor the empty text. Try again repeats
          the same load, as Refresh does. */}
      {listError ? (
        <>
          <div className="alert error" role="alert">
            Could not load the rental items: {listError}
          </div>
          <button type="button" className="btn secondary" onClick={load}>
            Try again
          </button>
        </>
      ) : items === null ? (
        <p className="muted">Loading rental items…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <p>
            No rental items yet. Create one above, or run
            backend/seeds/sample_rental_items.sql for starter items.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Description</th>
                <th className="num">Quantity</th>
                <th className="num">Fee</th>
                <th>Booking hours</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.item_id}
                  className={item.is_active ? "" : "inactive-row"}
                >
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>{TYPE_LABELS[item.type] || item.type}</td>
                  <td className="muted">{item.description || "—"}</td>
                  <td className="num">{item.quantity_total}</td>
                  <td className="num">₱{Number(item.fee).toFixed(2)}</td>
                  <td>{hoursText(item) ?? "—"}</td>
                  <td>
                    {item.is_active ? (
                      <span className="badge">Active</span>
                    ) : (
                      <span className="badge gray">Inactive</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => openEdit(item)}
                    >
                      Edit
                    </button>
                    <button
                      className={`btn secondary${item.is_active ? " danger" : ""}`}
                      disabled={busy}
                      onClick={() => toggleActive(item)}
                    >
                      {item.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
