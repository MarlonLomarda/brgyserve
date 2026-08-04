// Entry bundled by scripts/test-auth-session.cjs. Kept separate so the test can
// mount the REAL AuthProvider, ProtectedRoute and App against a stubbed fetch
// and localStorage — the two defects under test are both about what happens
// between the stored session and the first request, which no API-level test
// can see.
import { createRoot } from 'react-dom/client';
import { act, useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import { AuthProvider, useAuth } from '../src/auth/AuthContext.jsx';
import { decodeJwtPayload, isTokenExpired } from '../src/auth/session.js';

globalThis.isTokenExpired = isTokenExpired;
globalThis.decodeJwtPayload = decodeJwtPayload;

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
