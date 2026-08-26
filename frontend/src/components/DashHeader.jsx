import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS } from "../auth/roles";
import { IoCloseSharp } from "react-icons/io5";
import { FaRegUserCircle } from "react-icons/fa";

// Shared dashboard header: title, current user, logout, and the slide-in
// navigation drawer.
// nav = [{ to, label, icon?, end? }]
//
// THE DRAWER IS THE ONLY NAVIGATION, AT EVERY WIDTH. There is no horizontal
// tab row any more: the .dash-nav element was removed in 07cc26d and the
// @media (max-width: 900px) block that used to hide it went with it, so the
// hamburger, the backdrop and the drawer are what a 1920px desktop gets as
// well as a phone. Nothing in this component is width-conditional — there is
// no breakpoint constant here because there is no breakpoint to mirror.
//
// The item definitions live in constants/nav.js and are not forked here.

// The product name alone, matching the static <title> in index.html. That is
// what the tab reads before React mounts, and on the pages that do not render
// this header (landing, login, register, change-password).
const BASE_TITLE = "BrgyServe";

export default function DashHeader({ title, subtitle, nav }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef(null);
  const drawerRef = useRef(null);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  const close = () => setOpen(false);
  const closeAndRefocus = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  // The browser tab label. PAGE NAME FIRST, because tabs truncate from the
  // right: "BrgyServe — Pay…" would leave every tab looking alike, which is the
  // problem this exists to fix.
  //
  // The cleanup matters most on logout, which unmounts this header onto
  // /login — without it the tab would keep the last dashboard screen's name on
  // a page that is not it. Moving between two dashboard routes is safe because
  // React flushes every cleanup in a commit before any new effect, so the
  // incoming page's title is always written last.
  useEffect(() => {
    document.title = `${title} — ${BASE_TITLE}`;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [title]);

  // Close on ANY route change, whatever caused it — a nav tap, a redirect, or
  // the browser's back button.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Escape, body-scroll lock and focus, all only while the drawer is open.
  //
  // There is deliberately NO resize handler. One used to close the drawer above
  // 900px, and that was right while the horizontal tab row took over at that
  // width — closing the drawer simply handed navigation back to the row. With
  // the drawer as the ONLY navigation, the same close would take away the
  // user's only way to move around the app, mid-drag and with nothing
  // replacing it. A window crossing any width now changes nothing here.
  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key === "Escape") closeAndRefocus();
    };

    document.addEventListener("keydown", onKey);

    // Captured, not assumed to be '': restoring a value the page did not have
    // would be its own bug.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Rendered in one place now — the drawer — but kept as a function because it
  // takes the close handler: tapping the CURRENT route must still dismiss the
  // drawer, and a route change alone would not fire in that case.
  const navLinks = (onNavigate) =>
    nav.map((item) => {
      // Rendered CONDITIONALLY. Every item in constants/nav.js carries an icon
      // today, but an unconditional <Icon /> on an item without one throws
      // "Element type is invalid" for undefined — and because this header is on
      // all 19 dashboard screens, that one missing property would blank the
      // whole app rather than one row. A missing icon now degrades to the plain
      // label instead.
      const Icon = item.icon;

      return (
        <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate}>
          {Icon && <Icon size={18} />}
          {item.label}
        </NavLink>
      );
    });

  return (
    <>
      <header className="dash-header">
        {nav.length > 0 && (
          <section className="dash-header-section">
            <button
              ref={toggleRef}
              type="button"
              className="dash-menu-btn"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="dash-drawer"
              onClick={() => setOpen((wasOpen) => !wasOpen)}
            >
              <span className="dash-menu-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </button>

            <div id="header-label-container">
              <div id="header-role-label">
                <FaRegUserCircle size={18} color="#64748b" />
                <h1 className="header-label">
                  {ROLE_LABELS[user.role] || "BrgyServe"}
                </h1>
              </div>

              <span id="header-label-divider">/</span>

              <div>
                <h1 className="header-label">{title}</h1>
                <p className="header-label">{subtitle}</p>
              </div>
            </div>
          </section>
        )}

        <div className="dash-user">
          <span className="muted dash-username">@{user.username}</span>
          <button className="btn secondary" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      {open && (
        <>
          <div className="dash-backdrop" onClick={close} aria-hidden="true" />
          <div
            id="dash-drawer"
            className="dash-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Main menu"
            ref={drawerRef}
            tabIndex={-1}
          >
            <div className="dash-drawer-head">
              <button
                type="button"
                className="btn secondary dash-drawer-close"
                onClick={closeAndRefocus}
                aria-label="Close menu"
              >
                <IoCloseSharp size={20} />
              </button>
              {/* <span className="dash-drawer-title">
                {ROLE_LABELS[user.role] || "BrgyServe"}
              </span> */}
            </div>

            <nav className="dash-drawer-nav">{navLinks(close)}</nav>

            <div className="dash-drawer-foot">
              <span className="muted">@{user.username}</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
