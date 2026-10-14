import { useId, useRef } from "react";

// A list's filters row: the Payments page's second row (PaymentsPage.jsx),
// lifted out so that other lists can use it, each with its own controls. The
// Document requests list is the first; Rental bookings is next. The markup,
// the classes and the behaviour are the Payments row's, and so is the look:
// index.css's .pay-filters rules are scoped to these classes, not to a page.
//
// - Native selects, each with a visible label beside it (above it on a
//   phone). `selects` is [{ label, value, options, onChange, disabled }] in
//   order: `options` is [{ value, label }], and `onChange(value)` is called
//   with the value chosen.
// - `range`, for a list with a date filter: { shown, from, to, onFrom,
//   onTo, reversed }. While `shown` ("Choose dates"), From and To are date
//   inputs that wrap as one pair. Under the row, a hint says "The start date
//   is after the end date." while `reversed`; it is always in the page (a
//   polite status) so a screen reader hears it when its words appear, and
//   empty it takes no room. The page decides what a reversed range matches.
// - "Clear filters", a quiet button at the row's end, offered while `count`,
//   the number of filters on, is above 0. It calls `onClear()`, then moves
//   focus to the first select that can take it, because the button pressed
//   is hidden once nothing is on. With nothing on it keeps its place in the
//   row, so the first filter never makes the row taller, but it is disabled
//   and aria-hidden, and index.css hides it: nothing can reach it.
// - On a phone the row and its hint are a panel under a "Filters" button,
//   which opens and closes the panel in place and says how many filters are
//   on: "Filters", "Filters (2)". `open` is whether the panel is open, and
//   `onToggle()` is called when the button is pressed. The page keeps `open`,
//   as it keeps the values, because this row is not drawn while its list
//   loads. Above 640px the page's index.css rules hide the button, and the
//   row is shown, open or not.
// - It is never a form: nothing is submitted, and each change filters at
//   once. The page keeps every value and decides what a change does.
//
// `className` scopes the row to its page.
export default function ListFilters({
  className,
  selects,
  range,
  count,
  onClear,
  open,
  onToggle,
}) {
  const id = useId();
  const rowRef = useRef(null);
  const hintId = `${id}-hint`;
  const panelId = `${id}-panel`;
  const active = count > 0;

  function clear() {
    onClear();
    rowRef.current?.querySelector("select:not(:disabled)")?.focus();
  }

  return (
    <div className={className}>
      <button
        type="button"
        className="btn secondary pay-filters-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        {active ? `Filters (${count})` : "Filters"}
      </button>
      <div
        id={panelId}
        className={`pay-filters-panel${open ? " is-open" : ""}`}
      >
        <div className="pay-filters" ref={rowRef}>
          {selects.map((select, i) => (
            <div className="pay-filter" key={select.label}>
              <label htmlFor={`${id}-${i}`}>{select.label}</label>
              <select
                id={`${id}-${i}`}
                value={select.value}
                onChange={(e) => select.onChange(e.target.value)}
                disabled={select.disabled}
              >
                {select.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {range?.shown && (
            <div className="pay-filter-range">
              <div className="pay-filter">
                <label htmlFor={`${id}-from`}>From</label>
                <input
                  id={`${id}-from`}
                  type="date"
                  value={range.from}
                  onChange={(e) => range.onFrom(e.target.value)}
                  aria-describedby={hintId}
                />
              </div>
              <div className="pay-filter">
                <label htmlFor={`${id}-to`}>To</label>
                <input
                  id={`${id}-to`}
                  type="date"
                  value={range.to}
                  onChange={(e) => range.onTo(e.target.value)}
                  aria-describedby={hintId}
                />
              </div>
            </div>
          )}
          <button
            type="button"
            className="pay-filters-clear"
            onClick={clear}
            disabled={!active}
            aria-hidden={active ? undefined : true}
          >
            Clear filters
          </button>
        </div>
        {range && (
          <p id={hintId} className="pay-filters-hint" role="status">
            {range.reversed ? "The start date is after the end date." : ""}
          </p>
        )}
      </div>
    </div>
  );
}
