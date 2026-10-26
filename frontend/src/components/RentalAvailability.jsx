import {
  AVAILABILITY_FAILED,
  CHECKING,
  availabilityText,
} from "../utils/rentalAvailability";

// What is free for the chosen time, under the booking form's time fields:
// `check` is useRentalAvailability()'s answer. Times and numbers only, never a
// name, account, purpose or contact. While a new answer is out the last one
// stays, dimmed; a check that failed says so and blocks nothing.
//
// The wrapper is always drawn, so the status region exists before its first
// words (a live region that appears with its text is often not read out), and
// so the time fields' own message, when there is one, stays the element right
// after their grid.
export default function RentalAvailability({ check }) {
  const { status, data, slot } = check;
  const stale = status === "loading";
  const shown =
    data && slot && (status === "ready" || stale)
      ? availabilityText(data, slot)
      : null;
  return (
    <div className="rental-availability">
      <div role="status" aria-live="polite">
        {shown ? (
          <div
            className={`alert ${shown.tone === "free" ? "success" : "error"} rental-availability-result${stale ? " is-stale" : ""}`}
          >
            {shown.lines.map((line) => (
              <span key={line} className="rental-availability-line">
                {line}
              </span>
            ))}
          </div>
        ) : stale ? (
          <p className="muted">{CHECKING}</p>
        ) : null}
      </div>
      {status === "error" && (
        <div className="alert info" role="alert">
          {AVAILABILITY_FAILED}
        </div>
      )}
    </div>
  );
}
