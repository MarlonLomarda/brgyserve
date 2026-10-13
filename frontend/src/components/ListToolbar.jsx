import { useRef } from "react";
import { IoClose, IoSearch } from "react-icons/io5";

// A list's search box, and a place beside it for the list's other controls:
// the Payments page's search (PaymentsPage.jsx), lifted out so that other
// lists can use it. The Document requests list is the first; Rental bookings
// is next. The markup, the classes and the behaviour are the Payments box's,
// and so is the look: index.css's .pay-search rules are scoped to these
// classes, not to a page.
//
// - It filters as you type, so it is not a <form>: nothing is submitted.
//   type="search" brings a phone's search key; index.css hides the
//   browser's own clear button, so there is one, not two.
// - The Clear (x) button shows while the box has text. It and Escape empty
//   the box and leave focus in it. Escape works only while the box has
//   focus and holds text, and goes no further, so an overlay open behind the
//   box is left alone.
// - No browser autocomplete and no spellcheck.
// - `children`, when given, sit beside the box in a .head-actions group, as
//   the Payments status, Filters and Refresh do. The row is a .list-head, so
//   on a phone the box takes a line of its own and they wrap under it.
//
// `label` names the box, `placeholder` says what it finds, `value` is its
// text and `onChange(text)` is called with each new text. `inputRef`, when
// given, is the box itself, so the page can put focus back in it (its own
// "Clear search", say). `className` scopes the row to its page.
export default function ListToolbar({
  className,
  label,
  placeholder,
  value,
  onChange,
  inputRef,
  children,
}) {
  const ownRef = useRef(null);
  const boxRef = inputRef ?? ownRef;

  // The Clear (x) button and Escape. Focus stays in the box: the button that
  // was pressed is gone once the box is empty.
  function clear() {
    onChange("");
    boxRef.current?.focus();
  }

  return (
    <div className={className ? `list-head ${className}` : "list-head"}>
      <div className="pay-search" role="search">
        <IoSearch className="pay-search-icon" aria-hidden="true" />
        <input
          ref={boxRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.stopPropagation();
              clear();
            }
          }}
          aria-label={label}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        {value && (
          <button
            type="button"
            className="pay-search-clear"
            aria-label="Clear search"
            onClick={clear}
          >
            <IoClose aria-hidden="true" />
          </button>
        )}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </div>
  );
}
