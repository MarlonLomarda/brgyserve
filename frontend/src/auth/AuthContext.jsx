import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client';
import { isTokenExpired } from './session';

const STORAGE_KEY = 'brgyserve.auth';
const AuthContext = createContext(null);

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) : null;
    if (!stored) return null;
    // An expired session must never come back as a logged-in one. Without
    // this the stored user looks valid, the app renders a dashboard, and the
    // first request it makes 401s — so the failure surfaces as a screen that
    // breaks on use rather than as a login prompt.
    if (isTokenExpired(stored.token)) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  // { token, user } or null; initialized from localStorage so a page
  // refresh keeps the session
  const [auth, setAuth] = useState(readStored);

  // authFetch is a dependency of every loader effect in the app. If it changed
  // identity whenever `auth` changed, dropping the session would re-run all of
  // them — each firing a request with no token. It is kept stable by reading
  // the token from a ref rather than closing over state.
  const tokenRef = useRef(auth?.token ?? null);
  // A session is torn down exactly once. One screen can have several requests
  // in flight at the same time (the Secretary review screen fetches match
  // suggestions per pending account); without this, every one of them that
  // came back 401 would call logout() again.
  const sessionEndedRef = useRef(false);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    const next = { token: data.token, user: data.user };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    tokenRef.current = data.token;
    sessionEndedRef.current = false; // a fresh session may be ended again
    setAuth(next);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    sessionEndedRef.current = true;
    tokenRef.current = null;
    localStorage.removeItem(STORAGE_KEY);
    setAuth(null);
  }, []);

  // Ends the session unless it has already ended. Requests that fail after the
  // teardown has started must not start another one.
  const endSessionOnce = useCallback(() => {
    if (sessionEndedRef.current) return;
    logout();
  }, [logout]);

  // Merge changes into the stored user (e.g. clearing must_change_password
  // after a successful password change).
  const updateUser = useCallback((patch) => {
    setAuth((prev) => {
      if (!prev) return prev;
      const next = { ...prev, user: { ...prev.user, ...patch } };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // apiFetch with the session token attached. A 401 means the token is
  // expired or revoked, so drop the session — once, however many requests
  // fail together.
  const authFetch = useCallback(
    async (path, options = {}) => {
      const token = tokenRef.current;
      // Never send a request that cannot succeed. This keeps a straggler
      // effect from firing token-less while a logout is in progress, and
      // catches a session that expires mid-use rather than waiting for the
      // server to say so.
      if (!token || isTokenExpired(token)) {
        endSessionOnce();
        throw new ApiError('Your session has ended. Please log in again.', 401);
      }
      try {
        return await apiFetch(path, { ...options, token });
      } catch (err) {
        if (err.status === 401) endSessionOnce();
        throw err;
      }
    },
    [endSessionOnce]
  );

  const value = useMemo(
    () => ({
      user: auth?.user ?? null,
      token: auth?.token ?? null,
      login,
      logout,
      updateUser,
      authFetch,
    }),
    [auth, login, logout, updateUser, authFetch]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
