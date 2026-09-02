import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api/client';
import PasswordInput from '../components/PasswordInput';

// Public, and reached only from a link in an email. Like ForgotPasswordPage it
// uses apiFetch rather than authFetch: the token in the URL is the authority
// here, not a session.
//
// THE DEAD-LINK PANEL MUST SAY WHAT TO DO NEXT. The commonest way to land on
// it is opening an older email — the link expired, or a newer one has already
// been used — and "invalid or expired" on its own leaves that person on a page
// with nowhere to go. It is the same rule the registration rejection reasons
// follow: state the verdict, then the next step.
function DeadLink({ message }) {
  return (
    <div className="auth-page">
      <div className="card">
        <h1>This link no longer works</h1>
        <div className="alert error">{message}</div>
        <p className="muted">
          Reset links last 60 minutes and can only be used once. If you have several BrgyServe
          emails in your inbox, only the newest one works — the older ones stop working as soon as
          a newer link is requested.
        </p>
        <Link className="button-link" to="/forgot-password">
          Send me a new link
        </Link>
        <p className="alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

const NO_TOKEN_MESSAGE =
  'This address has no reset code in it. Open the link from your email directly, or request a new one below.';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  // Set only for the errors that mean the LINK is finished, which get the
  // dedicated panel above rather than an inline message on a form the resident
  // can no longer submit successfully.
  const [dead, setDead] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  // A link pasted without its query string, or truncated by a mail client.
  if (!token) return <DeadLink message={NO_TOKEN_MESSAGE} />;
  if (dead) return <DeadLink message={dead} />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: { token, new_password: password },
      });
      setDone(data.message);
    } catch (err) {
      // The server tags the two link-is-finished cases with a code, so the
      // screen does not have to match on wording. Everything else (a password
      // that is too short, an unreachable server) stays inline on the form.
      if (err.data?.code === 'RESET_TOKEN_INVALID') setDead(err.message);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth-page">
        <div className="card">
          <h1>Password changed</h1>
          <div className="alert success">{done}</div>
          <Link className="button-link" to="/login">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Choose a new password</h1>
        <p className="subtitle">
          BrgyServe — Barangay Ubujan, Tagbilaran City. This link works once, and only for the next
          60 minutes.
        </p>

        {error && <div className="alert error">{error}</div>}

        <label>
          New password
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            autoFocus
          />
        </label>
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
          {busy ? 'Saving…' : 'Set new password'}
        </button>

        <p className="alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
