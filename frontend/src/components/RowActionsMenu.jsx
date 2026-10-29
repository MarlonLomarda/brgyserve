import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IoEllipsisHorizontal } from "react-icons/io5";

// A row's actions behind one three-dot button: the Secretary's Approve,
// Decline and Edit on a pending request in Rental bookings (29 Oct 2026),
// where the three buttons stood on three lines and made every pending row
// twice as tall as the others. PRESENTATION ONLY: the page passes the items,
// each with what it does, and the words that name the button ("Actions for
// booking #125"), which its title shows on hover.
//
// THE RESIDENT'S PAY MENU, COPIED, NOT SHARED (components/PayMenu.jsx, left
// exactly as it is): a menu, not a dialog, so no focus trap and no scroll
// lock. It closes on Escape (focus goes back to the button), on a press
// outside it, when Tab moves focus out of it, and when an item is chosen:
// the focus goes back to the button and the item is handed the button, so
// the panel it opens can give the focus back to it when it closes.
//
// WHERE THE LIST OPENS IS DECIDED BY index.css, NOT BY A SECOND BREAKPOINT
// HERE, as for the Pay menu. Above 640px the list is position: fixed, so the
// table card's overflow-x: auto cannot clip it, and this component places it
// from the button's rectangle: right-aligned to the button, below it, or above
// it when the viewport has no room below. A fixed list does not follow its
// button, so it closes on any scroll (the page or the card) and on resize. At
// 640px and below the CSS puts the list in flow under the button, in the phone
// card, and it stays open while the page scrolls: a phone's address bar
// resizes the window during an ordinary scroll.
//
// ONE LIST OPEN AT A TIME, with nothing more than the above: a list that
// opens takes the focus, so the one open before loses it and closes as on
// Tab out, and a mouse has already pressed outside it. That holds for a click
// alone too, as a screen reader may send one.

const GAP = 4; // between the button and the list
const EDGE = 8; // the closest the list comes to the viewport's edge

const isFloating = (list) =>
  !!list && getComputedStyle(list).position === "fixed";

export default function RowActionsMenu({ label, items, actionsFor }) {
  const [open, setOpen] = useState(false);
  // Where the list sits: null until measured, {} in flow, { top, left } floating.
  const [place, setPlace] = useState(null);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const floatingRef = useRef(false);
  // Which item takes focus when the menu opens: the first, or the last when
  // it is opened with ArrowUp.
  const startAt = useRef(0);
  const buttonId = useId();
  const menuId = useId();

  const focusItem = (index) => {
    const items = itemRefs.current.filter(Boolean);
    if (items.length) {
      items[(index + items.length) % items.length].focus({
        preventScroll: floatingRef.current,
      });
    }
  };

  // Placed before the browser paints, so the list never shows at the wrong
  // spot first.
  useLayoutEffect(() => {
    if (!open) {
      floatingRef.current = false;
      setPlace(null);
      return;
    }
    if (!isFloating(listRef.current)) {
      floatingRef.current = false;
      setPlace({});
      return;
    }
    const button = buttonRef.current.getBoundingClientRect();
    const { width, height } = listRef.current.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const left = Math.max(EDGE, Math.min(button.right, clientWidth - EDGE) - width);
    let top = button.bottom + GAP;
    // No room below: open above the button instead.
    if (top + height > clientHeight - EDGE) {
      top = Math.max(EDGE, button.top - GAP - height);
    }
    floatingRef.current = true;
    setPlace({ top, left });
  }, [open]);

  // Focus moves into the list once it is placed, however it was opened. A
  // floating list is already in view, so focusing it must not scroll the
  // page: a scroll would close it. A list in flow is brought into view whole
  // first, since on a phone the last card's list opens below the fold.
  useEffect(() => {
    if (!open || !place) return;
    if (!("top" in place)) listRef.current?.scrollIntoView({ block: "nearest" });
    const items = itemRefs.current.filter(Boolean);
    if (items.length) {
      items[(startAt.current + items.length) % items.length].focus({
        preventScroll: true,
      });
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    // A floating list stays where it was placed, so anything that moves its
    // button closes it. In flow it moves with the card and stays open, unless
    // a resize has just made it a floating list.
    const onMove = () => {
      if (floatingRef.current || isFloating(listRef.current)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Capture, because a scroll of the table card does not bubble.
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const openAt = (index) => {
    startAt.current = index;
    setOpen(true);
  };

  // Enter and Space reach onClick through the native button.
  function onButtonKeyDown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = event.key === "ArrowDown" ? 0 : -1;
    if (open) focusItem(index);
    else openAt(index);
  }

  // Tab and Shift+Tab move between the items as ordinary buttons do.
  function onMenuKeyDown(event) {
    const current = itemRefs.current.indexOf(event.target);
    const moves = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: -1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    focusItem(moves[event.key]);
  }

  // Closes when focus leaves for another element, which is how Tab past the
  // last item ends. A blur with no relatedTarget is ignored, as in
  // AccountMenu: Safari does not focus a clicked button.
  function onBlur(event) {
    if (open && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget)) {
      setOpen(false);
    }
  }

  const choose = (item) => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
    item.onSelect(buttonRef.current);
  };

  return (
    <div className="row-menu" ref={rootRef} onBlur={onBlur}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="btn secondary row-menu-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-actions-for={actionsFor}
        onClick={() => (open ? setOpen(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
      >
        <IoEllipsisHorizontal size={18} aria-hidden="true" focusable="false" />
      </button>

      {open && (
        <div
          ref={listRef}
          role="menu"
          id={menuId}
          aria-labelledby={buttonId}
          className="row-menu-list"
          style={place || { visibility: "hidden" }}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => { itemRefs.current[index] = el; }}
              type="button"
              role="menuitem"
              className={`row-menu-item${item.danger ? " row-menu-danger" : ""}`}
              onClick={() => choose(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
