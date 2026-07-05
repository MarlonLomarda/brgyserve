import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { roleHome } from '../auth/roles';

export default function ChangePasswordPage() {
  const { user, authFetch, updateUser, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const forced = Boolean(user?.must_change_password);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await authFetch('/auth/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: newPassword },
      });
      updateUser({ must_change_password: false });
      navigate(roleHome(user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="auth-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Change password</h1>
        <p className="subtitle">@{user?.username}</p>

        {forced && (
          <div className="alert info">
            You are signed in with a temporary password. Set your own password
            to continue — other pages stay locked until you do.
          </div>
        )}
        {error && <div className="alert error">{error}</div>}

        <label>
          {forced ? 'Temporary password' : 'Current password'}
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>

        <p className="alt">
          <button type="button" className="link-button" onClick={handleLogout}>
            Sign out instead
          </button>
        </p>
      </form>
    </div>
  );
}
