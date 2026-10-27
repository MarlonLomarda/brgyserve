import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import PageLayout from "../components/PageLayout";
import RentalAvailability from "../components/RentalAvailability";
import { RESIDENT_NAV } from "../constants/nav";
import {
  ITEM_TYPE_LABELS,
  formatSchedule,
  rentalMeta,
} from "../constants/rentals";
import useRentalAvailability from "../hooks/useRentalAvailability";
import {
  FACILITY,
  ITEM,
  KIND_TEXT,
  NOT_ASKED,
  ofKind,
} from "../utils/bookingKinds";
import { bookingTimeError, earliestBookingDate } from "../utils/bookingTimes";
import { clock } from "../utils/chargeFilters";
import { bookingBlock, quantityCap } from "../utils/rentalAvailability";

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

// FACILITIES | ITEMS (step C2, 27 Oct 2026). One page, two tabs: Facilities
// lists the facilities, booked and used in place with no quantity; Items
// lists equipment and furniture, with a Quantity and "Pick-up time" and
// "Return time" for the times (utils/bookingKinds.js). The page heading
// follows the tab, "Book a Facility" or "Rent an Item", so the tab is kept
// here, above PageLayout, and the form below is told it. Every visit opens on
// Facilities, and the tab is kept nowhere in the browser. Both tabs are the
// one form with the one availability check, and send the same body.
export default function BookRentalPage() {
  const [kind, setKind] = useState(FACILITY);
  const words = KIND_TEXT[kind];
  return (
    <PageLayout
      dashTitle={words.title}
      dashSubtitle={words.subtitle}
      navItems={RESIDENT_NAV}
    >
      <BookRentalForm kind={kind} onKind={setKind} />
    </PageLayout>
  );
}

function BookRentalForm({ kind, onKind }) {
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

  // The tab's own items: an item the page loads of the other kind is simply
  // not shown, and cannot be the one chosen.
  const words = KIND_TEXT[kind];
  const shownItems = items === null ? null : ofKind(items, kind);
  const selectedItem = shownItems?.find(
    (i) => String(i.item_id) === String(form.item_id),
  );
  // Items always have a Quantity box (capped at what is left), facilities
  // never: a facility is booked one at a time, and 1 is sent as before.
  const withQuantity = kind === ITEM;
  const quantity = withQuantity ? Number(form.quantity) || 0 : 1;
  const estimatedFee = selectedItem ? Number(selectedItem.fee) * quantity : 0;

  // What is free for the chosen time, asked of the server once the item, the
  // date and both times are set. ADVICE ONLY: the server decides at Book now.
  // An answer caps the quantity and can block Book now, with the reason
  // beside it; no answer (none yet, one out, or a check that failed) leaves
  // the form as it was.
  const availability = useRentalAvailability(
    selectedItem?.item_id,
    form.date,
    form.start_time,
    form.end_time,
  );
  // With no item chosen nothing is shown or counted: after a tab switch the
  // hook still holds the other item's answer for one render.
  const check = selectedItem ? availability : NOT_ASKED;
  const answer = check.status === "ready" ? check.data : null;
  const cap = selectedItem ? quantityCap(selectedItem, answer) : null;
  const blocked = bookingBlock({ answer, quantity, countable: withQuantity });
  const blockedId = useId();

  // A new tab clears what belonged to the old one: the item, the quantity, a
  // time message and the server's last refusal (the availability answer goes
  // with the item). The date, the times and the purpose apply to both and
  // stay. Nothing is sent.
  function switchKind(next) {
    if (next === kind) return;
    setForm((f) => ({ ...f, item_id: "", quantity: "1" }));
    setTimeError("");
    setError("");
    onKind(next);
  }

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
    // Book now is disabled then; this stops the Enter key too.
    if (blocked) return;
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
      // The slot was taken after the page last asked: ask again, so the
      // display matches what the server just said.
      if (err.status === 409) availability.reload();
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
          {/* The tabs: two toggles, one pressed, as the walk-in form's are.
              Plain buttons, so a press submits nothing. Drawn whatever the
              load did: a failed load is the same error on both. */}
          <div
            className="tab-container"
            role="group"
            aria-label="What to book"
          >
            {[FACILITY, ITEM].map((k) => (
              <button
                key={k}
                type="button"
                className={`tab ${kind === k ? "active-tab" : ""}`}
                aria-pressed={kind === k}
                onClick={() => switchKind(k)}
              >
                {KIND_TEXT[k].tab}
              </button>
            ))}
          </div>
          {/* The server's refusal, read out as the load error and the time
              message are (role="alert"). */}
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}

          {/* The error first, then loading, then empty, then the form's
              fields: a load that failed shows neither the empty text nor the
              form. Try again is a plain button, so pressing it inside this
              form loads the items again and submits nothing; it sits in the
              card's actions row, as Book now does, 16px under the error
              (index.css; the card's shared margins leave 4px). */}
          {loadError ? (
            <>
              <div className="alert error" role="alert">
                Could not load the rental items: {loadError}
              </div>
              <div className="actions book-rental-retry">
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
          ) : shownItems.length === 0 ? (
            <p className="muted">{words.none}</p>
          ) : (
            <>
              <label>
                {words.field}
                <select
                  name="item_id"
                  value={form.item_id}
                  onChange={handleChange}
                  required
                >
                  <option value="" disabled>
                    {words.choose}
                  </option>
                  {shownItems.map((i) => (
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

              {/* Facilities: Date takes the whole row, so Start and End time
                  sit side by side under it. Items: Date | Quantity, then
                  Pick-up | Return time. */}
              <div className="grid-2">
                <label className={withQuantity ? undefined : "rental-date-full"}>
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
                {withQuantity && (
                  <label>
                    Quantity{" "}
                    {selectedItem && (
                      <span className="hint">
                        {cap > 0 ? `(up to ${cap})` : "(none left)"}
                      </span>
                    )}
                    <input
                      name="quantity"
                      type="number"
                      min="1"
                      max={selectedItem ? Math.max(1, cap) : undefined}
                      step="1"
                      value={form.quantity}
                      onChange={handleChange}
                      required
                    />
                  </label>
                )}
                <label>
                  {words.start}
                  <input
                    name="start_time"
                    type="time"
                    value={form.start_time}
                    onChange={handleChange}
                    required
                  />
                </label>
                <label>
                  {words.end}
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
              <RentalAvailability check={check} />

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
                  {withQuantity && quantity > 0 && (
                    <>
                      {" "}
                      ({quantity} × ₱{Number(selectedItem.fee).toFixed(2)})
                    </>
                  )}
                </p>
              )}

              <div className="actions">
                <button
                  className="btn"
                  type="submit"
                  disabled={busy || Boolean(blocked)}
                  aria-describedby={blocked ? blockedId : undefined}
                >
                  {busy ? "Checking availability…" : "Book now"}
                </button>
                {blocked && (
                  <span id={blockedId} className="rental-block-reason">
                    {blocked}
                  </span>
                )}
              </div>
            </>
          )}
        </form>
      )}
    </>
  );
}
