import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS } from "../auth/roles";
import { IoCloseSharp } from "react-icons/io5";

// Shared dashboard header: title, section nav tabs, current user, logout.
// nav = [{ to, label, end? }]
//
// Below 900px the horizontal tab row is replaced by a slide-in drawer. The
// Secretary nav is 12 items and simply cannot sit in a row on a phone.
//
// The desktop markup is deliberately untouched: the drawer, its backdrop and
// the hamburger are ADDITIONAL elements that default to display:none, and
// .dash-nav is hidden only inside the max-width:900px media query. Nothing
// above the breakpoint changes.
//
// Both navs map over the SAME `nav` prop — the item definitions live in
// constants/nav.js and are not forked here.
const DRAWER_BREAKPOINT = 900;

export default function DashHeader({ title, subtitle, nav = [] }) {
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

  // Close on ANY route change, whatever caused it — a nav tap, a redirect, or
  // the browser's back button.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Escape, body-scroll lock and focus, all only while the drawer is open.
  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key === "Escape") closeAndRefocus();
    };
    // Resizing past the breakpoint while open would leave the drawer hidden
    // by CSS but the body still locked, so close it rather than strand the page.
    const onResize = () => {
      if (window.innerWidth > DRAWER_BREAKPOINT) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);

    // Captured, not assumed to be '': restoring a value the page did not have
    // would be its own bug.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // One definition, rendered in both places. The drawer passes a close
  // handler so tapping the CURRENT route still dismisses it — a route change
  // alone would not fire in that case.
  const navLinks = (onNavigate) =>
    nav.map((item) => (
      <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate}>
        {item.label}
      </NavLink>
    ));

  return (
    <>
      <header className="dash-header">
        {nav.length > 0 && (
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
        )}

        <div>
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
          {nav.length > 0 && <nav className="dash-nav">{navLinks()}</nav>}
        </div>

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
              {/* The role, not the product name: below 900px the nav row and
                  the username are both hidden, so this is the only place left
                  that can say which account you are signed in as. */}
              <button
                type="button"
                className="btn secondary dash-drawer-close"
                onClick={closeAndRefocus}
                aria-label="Close menu"
              >
                <IoCloseSharp size={20}/>
              </button>
              <span className="dash-drawer-title">
                {ROLE_LABELS[user.role] || "BrgyServe"}
              </span>
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
