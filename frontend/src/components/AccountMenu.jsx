import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaUserCircle } from "react-icons/fa";

// The account menu: one icon button in the top bar that opens Profile and
// Log out, with Staff accounts between them for the Secretary only. ONE
// component used by BOTH headers, PageLayout's wide one and DashHeader's
// narrow one, which swap at 1045px, so the two cannot drift.
// Exactly one of the two is visible at any width, as with the two Log out
// buttons it replaced.
//
// A menu, not a dialog: no focus trap and no scroll lock, so it does not
// follow the /login overlay pattern. It closes on Escape (focus goes back to
// the button), on a click outside it, when Tab moves focus out of it, and
// after an item is chosen.
export default function AccountMenu({ user, onLogout }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const itemRefs = useRef([]);
  // Which item takes focus when the menu opens: the first, or the last when
  // it is opened with ArrowUp.
  const startAt = useRef(0);
  const menuId = useId();
  const labelId = useId();

  const focusItem = (index) => {
    const items = itemRefs.current.filter(Boolean);
    if (items.length) items[(index + items.length) % items.length].focus();
  };

  // Focus moves into the menu whenever it opens, however it was opened.
  useEffect(() => {
    if (!open) return;
    const items = itemRefs.current.filter(Boolean);
    if (items.length) items[(startAt.current + items.length) % items.length].focus();
  }, [open]);

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
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
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
  // last item ends. A blur with no relatedTarget is ignored: Safari does not
  // focus a clicked button, so a click on an item would otherwise blur the
  // menu shut before the click landed. Real outside clicks are caught by the
  // mousedown listener above.
  function onBlur(event) {
    if (open && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget)) {
      setOpen(false);
    }
  }

  const choose = (action) => {
    setOpen(false);
    action();
  };

  // ONE list, filtered by role before it is rendered, so each item's ref slot
  // is its position on screen. The Secretary's item written inline behind a
  // role check would leave an empty slot in itemRefs for every other role,
  // and since onMenuKeyDown counts positions in that array, ArrowDown on
  // Log out would stop wrapping round to Profile.
  const items = [
    { label: "Profile", action: () => navigate("/profile") },
    // A link only: the route admits the Secretary alone, and the server
    // refuses every other role regardless.
    {
      label: "Staff accounts",
      action: () => navigate("/secretary/staff-accounts"),
      onlyFor: "secretary",
    },
    { label: "Log out", action: onLogout },
  ].filter((item) => !item.onlyFor || item.onlyFor === user?.role);

  return (
    <div className="account-menu" ref={rootRef} onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        className="account-menu-btn"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Account menu"
        onClick={() => (open ? setOpen(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
      >
        <FaUserCircle size={26} aria-hidden="true" focusable="false" />
      </button>

      {open && (
        <div className="account-menu-panel">
          <p className="account-menu-user muted" id={labelId}>
            @{user?.username}
          </p>
          <div role="menu" id={menuId} aria-labelledby={labelId} onKeyDown={onMenuKeyDown}>
            {items.map((item, index) => (
              <button
                key={item.label}
                ref={(el) => { itemRefs.current[index] = el; }}
                type="button"
                role="menuitem"
                className="account-menu-item"
                onClick={() => choose(item.action)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
