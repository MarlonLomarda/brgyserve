import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  ITEM_TYPE_LABELS,
  formatSchedule,
  rentalMeta,
} from "../constants/rentals";
import { bookingTimeError, earliestBookingDate } from "../utils/bookingTimes";
import { clock } from "../utils/chargeFilters";

const EMPTY_FORM = {
  item_id: "",
  date: "",
  start_time: "",
  end_time: "",
  quantity: "1",
  purpose: "",
};

// Why a load failed, for "Could not load the rental items: …". The server's
// own message when it sent one (the API's errors are plain sentences, never a
// stack). Anything else, a server that could not be reached or an answer with
// no message in it, gets a plain fallback rather than the client's own text.
// A copy of the Rental bookings page's function, which the Document requests
// and Payments pages and My rentals each copy too.
function loadFailure(err) {
  const sent = err?.data?.error;
  return typeof sent === "string" && sent.trim()
    ? sent.trim()
    : "the server did not respond";
}

export default function BookRentalPage() {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading, or a failed load
  const [loadError, setLoadError] = useState(null); // why the last load failed
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [error, setError] = useState("");
  // The form's own check of the times, shown under the time fields.
  const [timeError, setTimeError] = useState("");
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState(null); // confirmed booking
  // Numbers each load, so only the newest one may change the items.
  const loadSeq = useRef(0);

  // A FAILED LOAD IS NOT AN EMPTY LIST. This used to store [] beside the
  // error, so the server's bare message sat over "Nothing is currently
  // available for rental." while the page knew nothing. items now stays null
  // and the error, with Try again, takes the place of the form (CLAUDE.md: a
  // list that failed to load), as on Rental bookings. Every load starts from
  // the loading state, and an older answer that arrives late is dropped.
  const loadItems = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    setItems(null);
    try {
      const data = await authFetch("/rental-items");
      if (seq === loadSeq.current) setItems(data.rental_items);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(loadFailure(err));
    }
  }, [authFetch]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const selectedItem = items?.find(
    (i) => String(i.item_id) === String(form.item_id),
  );
  const isCountable = selectedItem && selectedItem.quantity_total > 1;
  const quantity = isCountable ? Number(form.quantity) || 0 : 1;
  const estimatedFee = selectedItem ? Number(selectedItem.fee) * quantity : 0;

  function handleChange(e) {
    const { name, value } = e.target;
    // A changed date or time may answer the check; it runs again on Book now.
    if (name === "date" || name === "start_time" || name === "end_time") {
      setTimeError("");
    }
    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === "item_id") next.quantity = "1"; // reset when switching items
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    // CHECKED ON BOOK NOW, NOT AS YOU TYPE. A start already past, or an end
    // not after the start, is refused here in the server's words and nothing
    // is sent; the button stays pressable, so the press is what shows why. A
    // time field changes as each part of it is typed, so checking as you
    // type would flash a refusal at half-typed times. The server checks again.
    const refused = bookingTimeError(form, clock.now());
    setTimeError(refused || "");
    if (refused) return;
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
        },
      });
      setBooked(data.request);
      setForm({ ...EMPTY_FORM });
    } catch (err) {
      setError(err.message); // conflict reasons surface here — pick another slot
    } finally {
      setBusy(false);
    }
  }

  // Today in Manila, whatever clock this computer keeps: the date field's
  // earliest day. In UTC, until 8 AM in Manila, it would still be yesterday.
  const today = earliestBookingDate(clock.now());
  const meta = booked ? rentalMeta(booked.status) : null;

  return (
    <>
      {booked ? (
        <div className="pending-card section-card">
          <h3>Booking confirmed</h3>
          <div className="alert success">
            Your slot is reserved — no further approval is needed. Please settle
            the fee with the barangay.
          </div>
          <dl className="info-grid">
            <div>
              <dt>Item</dt>
              <dd>{booked.rental_items?.name}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`badge ${meta.className}`}>{meta.label}</span>
              </dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>
                {formatSchedule(booked.start_datetime, booked.end_datetime)}
              </dd>
            </div>
            <div>
              <dt>Quantity</dt>
              <dd>{booked.quantity_requested}</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd>
                ₱
                {(
                  Number(booked.rental_items?.fee ?? 0) *
                  booked.quantity_requested
                ).toFixed(2)}
              </dd>
            </div>
            <div className="span-2">
              <dt>Purpose</dt>
              <dd>{booked.purpose}</dd>
            </div>
          </dl>
          <div className="actions">
            <Link className="button-link inline" to="/resident/rentals">
              View my rentals
            </Link>
            <button className="btn secondary" onClick={() => setBooked(null)}>
              Book another
            </button>
          </div>
        </div>
      ) : (
        <form className="pending-card section-card" onSubmit={handleSubmit}>
          <h3>Book a facility or item</h3>
          {error && <div className="alert error">{error}</div>}

          {/* The error first, then loading, then empty, then the form's
              fields: a load that failed shows neither the empty text nor the
              form. Try again is a plain button, so pressing it inside this
              form loads the items again and submits nothing; it sits in the
              card's actions row, as Book now does. */}
          {loadError ? (
            <>
              <div className="alert error" role="alert">
                Could not load the rental items: {loadError}
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={loadItems}
                >
                  Try again
                </button>
              </div>
            </>
          ) : items === null ? (
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
              {/* The times' own check, by the fields it is about, read out as
                  the load error is (role="alert"). */}
              {timeError && (
                <div className="alert error" role="alert">
                  {timeError}
                </div>
              )}

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
                  {busy ? "Checking availability…" : "Book now"}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </>
  );
}
