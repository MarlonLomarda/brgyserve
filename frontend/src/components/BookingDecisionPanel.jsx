import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IoIosClose } from "react-icons/io";
import { ITEM_TYPE_LABELS, formatSchedule } from "../constants/rentals";
import {
  accountHandle,
  bookedForName,
  bookingNumber,
  feeLine,
  funeralWaivable,
  isGuest,
  requestedText,
  statusBadge,
} from "../utils/rentalList";

// The Secretary's two decisions on a pending rental request (batch R2b), on
// Rental bookings: Approve and Decline, each a panel over the list. They are
// the Payments View panel (ChargePanel in PaymentsPage.jsx), copied: its
// .modal-overlay at z-index 50 and its .pay-panel classes, reused by name, so
// a change to those rules changes both pages. The reason box is the Cancel
// panel's (components/CancelBookingPanel.jsx).
//
// - Escape, the corner Close (a full-width Close at the foot on a phone) and
//   a press on the backdrop all close it, and every one is refused while the
//   request is being sent. The body's scroll is locked while it is open, the
//   value it had captured and put back. Focus goes into the panel when it
//   opens (Decline: into the reason box); the page puts it back on the row's
//   button when it closes, or on the success message after a decision. No
//   focus trap, as on every other panel in the app.
// - THE ANSWER. onApprove(waive) / onDecline(reason) send the request and
//   throw on a refusal; the server's own sentence is shown here with
//   role="alert" and the panel stays open, the request still pending.
//   onClose(refused) tells the page whether a refusal was shown, so it can
//   load the list again: a refusal usually means the request changed
//   underneath, as after a refused cancel.
// - What the panel shows of the request is the row's, as it was when the
//   button was pressed: who, the item, when, how many, the purpose in full,
//   when it was requested (nothing at all when the request carries no time)
//   and the overlap note the row shows (utils/rentalList.js).

const REASON_MAX = 300;
const REASON_MIN = 3;

// Escape and the scroll lock while the panel is open, and focus into it, as
// the Payments page's effects do; undone when the panel goes.
function useOverlay(focusRef, close) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [focusRef]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);
}

// The line under the borrower's name, as the row's: a guest's typed number,
// the resident's @account, or "No online account".
function borrowerLine(booking) {
  if (isGuest(booking)) return `Guest · ${booking.outside_borrower_contact}`;
  const record = booking.resident_records;
  if (!record || !("account" in record)) return null;
  return accountHandle(record) || "No online account";
}

// The header, the request's details and the phone's Close: what the two
// panels share. `children` is the panel's own action.
function DecisionShell({
  booking,
  overlap,
  actionId,
  panelRef,
  busy,
  close,
  children,
}) {
  const titleId = useId();
  const numberId = useId();
  const badge = statusBadge(booking);
  const item = booking.rental_items;
  const line = borrowerLine(booking);
  const requested = requestedText(booking);
  return (
    <div className="modal-overlay pay-panel-overlay" onClick={close}>
      <div
        className="pay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${actionId} ${numberId} ${titleId}`}
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pay-panel-head">
          <div className="pay-panel-heading">
            <p className="pay-panel-meta">
              <span id={numberId}>Booking {bookingNumber(booking)}</span>
              <span className={`badge ${badge.className}`}>{badge.label}</span>
            </p>
            <h2 id={titleId}>{bookedForName(booking) || "—"}</h2>
            {line && <p className="pay-panel-user">{line}</p>}
          </div>
          <button
            type="button"
            className="pay-panel-x"
            aria-label="Close"
            onClick={close}
            disabled={busy}
          >
            <IoIosClose size={26} aria-hidden="true" />
          </button>
        </div>

        <div className="pay-panel-main">
          <div className="pay-panel-details">
            {overlap && <p className="pay-panel-note">{overlap}</p>}
            <dl className="pay-panel-list">
              <dt>Item</dt>
              <dd>
                {item?.name || "—"}
                {item?.type && ` (${ITEM_TYPE_LABELS[item.type] || item.type})`}
              </dd>
              <dt>Schedule</dt>
              <dd>
                {formatSchedule(booking.start_datetime, booking.end_datetime)}
              </dd>
              <dt>Quantity</dt>
              <dd>{booking.quantity_requested}</dd>
              <dt>Purpose</dt>
              <dd>{booking.purpose}</dd>
              {requested && (
                <>
                  <dt>{requested.label}</dt>
                  <dd>{requested.at}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="pay-panel-actions">{children}</div>
        </div>

        {/* A phone has no corner Close: this full-width one, pinned at the
            foot, takes its place (index.css shows it at 640px and below). */}
        <div className="pay-panel-footer">
          <button
            type="button"
            className="btn secondary"
            onClick={close}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// APPROVE. "Fee if approved" is the server's fee_if_approved, the number the
// approve route charges (feeLine); "Free for funeral" is offered only where
// the waiver can be given (funeralWaivable: a waiting request, an item marked
// funeral_eligible, a resident's booking, never a guest's), and ticking it
// reads "PHP 0.00, free for funeral" and sends waive_for_funeral: true.
export function ApproveBookingPanel({ booking, overlap, onApprove, onClose }) {
  const panelRef = useRef(null);
  const actionId = useId();
  const [waive, setWaive] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const waivable = funeralWaivable(booking);
  const fee = feeLine(booking, waivable && waive);

  const close = useCallback(() => {
    if (!busy) onClose(refused);
  }, [busy, refused, onClose]);
  useOverlay(panelRef, close);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await onApprove(waivable && waive);
    } catch (err) {
      setError(err.message);
      setRefused(true);
      setBusy(false);
    }
  }

  return (
    <DecisionShell
      booking={booking}
      overlap={overlap}
      actionId={actionId}
      panelRef={panelRef}
      busy={busy}
      close={close}
    >
      <section className="pay-panel-section">
        <h3 id={actionId}>Approve this request</h3>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          {fee && (
            <dl className="pay-panel-list">
              <dt>Fee if approved</dt>
              <dd className="pay-amount">{fee}</dd>
            </dl>
          )}
          {waivable && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={waive}
                onChange={(e) => setWaive(e.target.checked)}
                disabled={busy}
              />
              <span>Free for funeral</span>
            </label>
          )}
          <button className="btn pay-record" type="submit" disabled={busy}>
            {busy ? "Approving…" : "Approve"}
          </button>
        </form>
      </section>
    </DecisionShell>
  );
}

// DECLINE. The reason as the Cancel panel asks it: required, 3 to 300
// characters after trimming, counted as the server counts them (code points),
// maxLength 300, a live count, the focus in the box. The resident is sent it.
export function DeclineBookingPanel({ booking, overlap, onDecline, onClose }) {
  const panelRef = useRef(null);
  const boxRef = useRef(null);
  const actionId = useId();
  const helpId = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const trimmed = reason.trim();
  const ready = [...trimmed].length >= REASON_MIN;

  const close = useCallback(() => {
    if (!busy) onClose(refused);
  }, [busy, refused, onClose]);
  useOverlay(boxRef, close);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !ready) return;
    setError("");
    setBusy(true);
    try {
      await onDecline(trimmed);
    } catch (err) {
      setError(err.message);
      setRefused(true);
      setBusy(false);
    }
  }

  return (
    <DecisionShell
      booking={booking}
      overlap={overlap}
      actionId={actionId}
      panelRef={panelRef}
      busy={busy}
      close={close}
    >
      <section className="pay-panel-section">
        <h3 id={actionId}>Decline this request</h3>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <label>
            Reason for declining
            <textarea
              ref={boxRef}
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={REASON_MAX}
              required
              aria-describedby={helpId}
            />
          </label>
          <div
            className={`char-counter muted${reason.length >= REASON_MAX ? " at-limit" : ""}`}
          >
            {reason.length}/{REASON_MAX}
          </div>
          <p id={helpId} className="muted">
            The resident receives this reason by text message. Keep it short
            and use plain letters.
          </p>
          <button
            className="btn secondary danger pay-record"
            type="submit"
            disabled={busy || !ready}
          >
            {busy ? "Declining…" : "Decline"}
          </button>
        </form>
      </section>
    </DecisionShell>
  );
}
