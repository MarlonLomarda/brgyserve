// Entry bundled by scripts/test-auth-session.cjs. Kept separate so the test can
// mount the REAL AuthProvider, ProtectedRoute and App against a stubbed fetch
// and localStorage — the two defects under test are both about what happens
// between the stored session and the first request, which no API-level test
// can see.
import { createRoot } from 'react-dom/client';
import { act, StrictMode, useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import { AuthProvider, useAuth } from '../src/auth/AuthContext.jsx';
import { decodeJwtPayload, isTokenExpired } from '../src/auth/session.js';
import * as activityLog from '../src/constants/activityLog.js';
import * as bookingTimes from '../src/utils/bookingTimes.js';
import * as chargeMethod from '../src/utils/chargeMethod.js';
import * as chargeFilters from '../src/utils/chargeFilters.js';
import * as chargeSearch from '../src/utils/chargeSearch.js';
import * as chargeTotals from '../src/utils/chargeTotals.js';
import * as paging from '../src/utils/paging.js';
import * as rentalAvailability from '../src/utils/rentalAvailability.js';
import * as rentalList from '../src/utils/rentalList.js';
import * as requestList from '../src/utils/requestList.js';

globalThis.isTokenExpired = isTokenExpired;
globalThis.decodeJwtPayload = decodeJwtPayload;
// The Payments page's Method label, checked on its own in section N.
globalThis.methodOf = chargeMethod.methodOf;
// The "No fee" test of My requests, My rentals and the request detail,
// checked on its own in section T.
globalThis.isNoFeeCharge = chargeMethod.isNoFeeCharge;
// The Payments page's search, totals and paging helpers, checked on their
// own in section O.
globalThis.chargeSearch = chargeSearch;
globalThis.chargeTotals = chargeTotals;
globalThis.paging = paging;
// The Payments page's Method and date filters, and the clock "today" comes
// from, checked on their own in section Q.
globalThis.chargeFilters = chargeFilters;
// The Document requests list's status tabs, counts and heading, checked on
// their own in section W.
globalThis.requestList = requestList;
// The Rental bookings list's status tabs, counts, heading, empty text and
// opening tab, checked on their own in section AD.
globalThis.rentalList = rentalList;
// The booking form's earliest date and time checks, checked on their own in
// section AJ.
globalThis.bookingTimes = bookingTimes;
// The booking forms' availability words, cap and block, checked on their own
// in section AN.
globalThis.rentalAvailability = rentalAvailability;
// The Activity Log page's labels and one-line summaries, checked on their own
// in section AM.
globalThis.activityLog = activityLog;

// Mount the whole app at a protected route with whatever is in localStorage.
// Returns the rendered HTML so the test can assert which view came up.
globalThis.mountApp = async (container, route) => {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthProvider>
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    );
  });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
};

// Mount the whole app at `route` and KEEP it mounted, so the test can fill in
// a form and submit it the way a person would, then read what is on screen.
// `strict` wraps it in StrictMode, which runs every effect twice on mount, as
// the dev server does (main.jsx).
globalThis.mountInteractive = async (container, route, { strict = false } = {}) => {
  const win = container.ownerDocument.defaultView;
  const root = createRoot(container);
  const app = (
    <AuthProvider>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </AuthProvider>
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{app}</StrictMode> : app);
  });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    html: () => container.innerHTML,
    // React tracks an input's value through its own setter, so assigning
    // .value directly never reaches onChange. The native setter plus a
    // bubbling input event is what a keystroke produces.
    fill: async (selector, value, index = 0) => {
      const input = container.querySelectorAll(selector)[index];
      if (!input) throw new Error(`no ${selector} at index ${index}`);
      await act(async () => {
        Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
      });
    },
    // Dispatched on the form itself, the way a submit button would, so the
    // request and whatever follows it (a logout, a redirect) have settled
    // before this returns.
    submit: async () => {
      const form = container.querySelector('form');
      if (!form) throw new Error('no form on screen');
      await act(async () => {
        form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle();
      await settle();
    },
    // A selector or an element. Settles like submit, because a click can
    // navigate, fetch, or end the session.
    click: async (target) => {
      const el = typeof target === 'string' ? container.querySelector(target) : target;
      if (!el) throw new Error(`nothing to click: ${target}`);
      await act(async () => {
        el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
      await settle();
    },
    // A press somewhere that is not the account menu.
    pressOutside: async () => {
      await act(async () => {
        container.ownerDocument.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
      });
    },
    // keydown on the focused element, or on `target` when given.
    key: async (key, target) => {
      const el = target
        ? (typeof target === 'string' ? container.querySelector(target) : target)
        : container.ownerDocument.activeElement;
      await act(async () => {
        el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    },
    // For a page whose own fetch resolves after the mount.
    settle: async () => {
      await settle();
      await settle();
    },
    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => [...container.querySelectorAll(selector)],
    active: () => container.ownerDocument.activeElement,
    unmount: async () => { await act(async () => root.unmount()); },
  };
};

// Fires `count` authFetch calls concurrently, the way a screen with several
// loaders in flight does, and reports what each one threw.
function Burst({ count, onDone }) {
  const { authFetch } = useAuth();
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled(
      Array.from({ length: count }, (_, i) => authFetch(`/burst-${i}`))
    ).then((results) => {
      if (!cancelled) onDone(results.map((r) => r.reason?.status ?? 'resolved'));
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, count, onDone]);
  return null;
}

globalThis.mountBurst = async (container, count) => {
  let statuses = null;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthProvider>
        <Burst count={count} onDone={(s) => { statuses = s; }} />
      </AuthProvider>
    );
  });
  // let the settled promises flush
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => root.unmount());
  return statuses;
};

// Exposes authFetch itself so the test can drive it directly (sequential
// calls, calls after a logout) without a component in the way.
globalThis.mountProbe = async (container) => {
  let api = null;
  function Probe() {
    api = useAuth();
    return null;
  }
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
  });
  return {
    call: async (path) => {
      let out;
      await act(async () => {
        out = await api.authFetch(path).then(
          (data) => ({ ok: true, data }),
          (err) => ({ ok: false, status: err.status, message: err.message })
        );
      });
      return out;
    },
    // authFetch's identity is what ~27 loader effects depend on; if it changes
    // they all re-run. The test reads it before and after a session change.
    authFetchRef: () => api.authFetch,
    logout: async () => { await act(async () => api.logout()); },
    user: () => api.user,
    unmount: async () => { await act(async () => root.unmount()); },
  };
};
