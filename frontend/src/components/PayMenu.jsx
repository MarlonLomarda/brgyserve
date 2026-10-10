import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// The resident's "Pay ▾" button on an unpaid row of My rentals and My
// requests. It replaced three side-by-side buttons that made the actions
// column the widest in both tables and still wrapped onto two lines, and
// since 10 Oct 2026 it holds two items, "Pay online via GCash" and "Pay
// onsite": "I already paid via GCash" was removed, and the declare routes now
// refuse a GCash reference.
// PRESENTATION ONLY: each page keeps its own pay logic (the two flows are
// duplicated on purpose; see the back-button comment in each page) and passes
// in the two handlers and its busy flag. The gateway option leads, set in
// bold blue.
//
// A menu, not a dialog, so it follows AccountMenu: no focus trap and no
// scroll lock. It closes on Escape (focus goes back to the button), on a press
// outside it, when Tab moves focus out of it, and after an item is chosen.
//
// WHERE THE LIST OPENS IS DECIDED BY index.css, NOT BY A SECOND BREAKPOINT
// HERE. Above 640px the list is position: fixed, so the table card's
// overflow-x: auto cannot clip it, and this component places it from the
// button's rectangle: right-aligned to the button, below it, or above it when
// the viewport has no room below. A fixed list does not follow its button, so
// it closes on any scroll (the page or the card) and on resize. At 640px and
// below the CSS puts the list in flow under the button, full width, and it
// stays open while the page scrolls: a phone's address bar resizes the
// window during an ordinary scroll.

const GAP = 4; // between the button and the list
const EDGE = 8; // the closest the list comes to the viewport's edge

const isFloating = (list) =>
  !!list && getComputedStyle(list).position === "fixed";

export default function PayMenu({ busy, onPayOnline, onPayOnsite }) {
  const [open, setOpen] = useState(false);
  // Where the list sits: null until measured, {} in flow, { top, left } floating.
  const [place, setPlace] = useState(null);
  // Which item started the busy state, so the button reads "Opening GCash…"
  // only while that is what is happening.
  const [chosen, setChosen] = useState(null);
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
  // first, since on a phone the last row's list opens below the fold.
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

  // A payment in flight disables the button; the list never shows over it.
  const showList = open && !busy;

  const openAt = (index) => {
    startAt.current = index;
    setOpen(true);
  };

  // Enter and Space reach onClick through the native button.
  function onButtonKeyDown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = event.key === "ArrowDown" ? 0 : -1;
    if (showList) focusItem(index);
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

  const choose = (which, action) => {
    setChosen(which);
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
    action();
  };

  return (
    <div className="pay-menu" ref={rootRef} onBlur={onBlur}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={showList}
        aria-controls={showList ? menuId : undefined}
        disabled={busy}
        onClick={() => (open ? setOpen(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
      >
        {busy && chosen === "online" ? (
          "Opening GCash…"
        ) : (
          <>
            Pay<span aria-hidden="true"> ▾</span>
          </>
        )}
      </button>

      {showList && (
        <div
          ref={listRef}
          role="menu"
          id={menuId}
          aria-labelledby={buttonId}
          className="pay-menu-list"
          style={place || { visibility: "hidden" }}
          onKeyDown={onMenuKeyDown}
        >
          <button
            ref={(el) => { itemRefs.current[0] = el; }}
            type="button"
            role="menuitem"
            className="pay-menu-item pay-menu-online"
            onClick={() => choose("online", onPayOnline)}
          >
            Pay online via GCash
          </button>
          <button
            ref={(el) => { itemRefs.current[1] = el; }}
            type="button"
            role="menuitem"
            className="pay-menu-item"
            onClick={() => choose("onsite", onPayOnsite)}
          >
            Pay onsite
          </button>
        </div>
      )}
    </div>
  );
}
