import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { roleHome } from '../auth/roles';
import PasswordInput from '../components/PasswordInput';
import PasswordChecklist from '../components/PasswordChecklist';

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
      // A forced change goes on to the role home, exactly as before. A
      // voluntary one was opened from the Profile page, so it goes back there
      // with a one-line notice. `forced` is this render's value, read before
      // updateUser above clears the flag.
      if (forced) {
        navigate(roleHome(user.role), { replace: true });
      } else {
        navigate('/profile', { replace: true, state: { notice: 'Password changed.' } });
      }
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
          <PasswordInput
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        <label>
          New password
          <PasswordInput
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <PasswordChecklist value={newPassword} />
        <label>
          Confirm new password
          <PasswordInput
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

        {/* Only for a voluntary change. A forced one has nowhere to go back
            to: every other page refuses the account until this is done. */}
        {!forced && (
          <p className="alt">
            <Link to="/profile">Back to profile</Link>
          </p>
        )}
        <p className="alt">
          <button type="button" className="link-button" onClick={handleLogout}>
            Sign out instead
          </button>
        </p>
      </form>
    </div>
  );
}
