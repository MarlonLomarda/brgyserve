import { useEffect, useState } from "react";

// The panel that cancels a rental booking, on Rental bookings (the
// Secretary) and on My rentals (the resident). It takes the list's place, as
// the Edit and Mark returned panels do, and asks for the reason the way the
// Document requests reject form does: a textarea with the focus in it and a
// live count under it.
//
// THE REASON. maxLength 300, the server's limit (parseReason() in
// routes/rentalRequests.js). When `required`, the submit stays disabled until
// the reason has 3 characters after trimming, counted as the server counts
// them; the server checks again and its refusal shows here.
//
// KEYBOARD. Escape closes it (not while a cancel is being sent), and so does
// the second button; the page puts the focus back on the Cancel button that
// opened it. No focus trap, as on every other panel in the app.
//
// THE ANSWER. onSubmit(reason) sends the cancel and throws on a refusal; the
// server's sentence is shown with role="alert" and the panel stays open.
// onClose(refused) tells the page whether a refusal was shown, so it can load
// the list again: a refusal usually means the booking changed underneath.
const REASON_MAX = 300;
const REASON_MIN = 3;

export default function CancelBookingPanel({
  title,
  lines = [],
  warning = null,
  note = null,
  reasonLabel,
  required = false,
  helper = null,
  onSubmit,
  onClose,
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const trimmed = reason.trim();
  const long = [...trimmed].length;
  const ready = required ? long >= REASON_MIN : long === 0 || long >= REASON_MIN;

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose(refused);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, refused, onClose]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !ready) return;
    setError("");
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err.message);
      setRefused(true);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card cancel-booking-panel">
      <div className="pending-head">
        <div>
          <h3>{title}</h3>
          {lines.map((line) => (
            <p className="muted" key={line}>
              {line}
            </p>
          ))}
        </div>
      </div>

      {warning && <div className="alert info">{warning}</div>}
      {note && <p>{note}</p>}
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <label>
          {reasonLabel}
          <textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={REASON_MAX}
            required={required}
            aria-describedby={helper ? "cancel-reason-help" : undefined}
            autoFocus
          />
        </label>
        <div
          className={`char-counter muted${reason.length >= REASON_MAX ? " at-limit" : ""}`}
        >
          {reason.length}/{REASON_MAX}
        </div>
        {helper && (
          <p id="cancel-reason-help" className="muted">
            {helper}
          </p>
        )}
        <div className="actions">
          <button
            className="btn secondary danger"
            type="submit"
            disabled={busy || !ready}
          >
            {busy ? "Cancelling…" : "Cancel this booking"}
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={busy}
            onClick={() => onClose(refused)}
          >
            Keep booking
          </button>
        </div>
      </form>
    </div>
  );
}
