import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { apiFetch } from '../api/client';

const STORAGE_KEY = 'brgyserve.auth';
const AuthContext = createContext(null);

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  // { token, user } or null; initialized from localStorage so a page
  // refresh keeps the session
  const [auth, setAuth] = useState(readStored);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    const next = { token: data.token, user: data.user };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setAuth(next);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setAuth(null);
  }, []);

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
  // expired or revoked, so drop the session.
  const authFetch = useCallback(
    async (path, options = {}) => {
      try {
        return await apiFetch(path, { ...options, token: auth?.token });
      } catch (err) {
        if (err.status === 401) logout();
        throw err;
      }
    },
    [auth, logout]
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
