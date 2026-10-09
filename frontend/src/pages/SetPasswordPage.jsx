import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api/client';
import PasswordInput from '../components/PasswordInput';
import PasswordChecklist from '../components/PasswordChecklist';

// Public, and reached only from the link in a set-password email: the one the
// Barangay Secretary sends an official when creating their account, or later
// from the staff accounts list. A copy of ResetPasswordPage, with four
// differences:
//
//   * THE TOKEN IS TAKEN OUT OF THE ADDRESS BAR as soon as it has been read,
//     and kept only in state. The link can set an official's password for 72
//     hours, long enough for a URL left in an address bar, a screenshot or the
//     browser history to matter. A reload therefore loses it, and the page
//     says to open the email link again, which still works until it is used.
//   * THE LINK IS CHECKED BEFORE THE FORM IS SHOWN, through POST
//     /auth/set-password/check, which uses nothing up. A dead link gets the
//     panel below at once, not after a password has been typed. Only the
//     server's dead-link code means dead: a check that could not be made (no
//     network, a server still waking, a 429) gets "Try again" and never a
//     verdict. The submit still decides, and a link that dies between the
//     check and the submit lands on the same panel.
//   * A dead link sends the official to the Barangay Office, not to "Send me a
//     new link": /forgot-password is for residents, so an official cannot
//     request a link themselves.
//   * The wording is about setting a password, not resetting one.
function DeadLink({ message }) {
  return (
    <div className="auth-page">
      <div className="card">
        <h1>This link no longer works</h1>
        <div className="alert error">{message}</div>
        <p className="muted">
          Set-password links last 72 hours and can only be used once. If you
          have more than one of these emails, only the newest link works.
        </p>
        <p className="alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

// The two states before the form: the check is out, or it could not be made.
// They wear the form's heading and subtitle, so the form replaces only what
// is under them. Keep the two in step with the form's own, below.
function BeforeForm({ children }) {
  return (
    <div className="auth-page">
      <div className="card">
        <h1>Set your password</h1>
        <p className="subtitle">
          BrgyServe — Barangay Ubujan, Tagbilaran City. This link works once,
          and only for 72 hours after it was sent.
        </p>
        {children}
      </div>
    </div>
  );
}

const NO_TOKEN_MESSAGE =
  'This address has no set-password code in it. Open the link from your email again. It still works if you have not used it yet and it is less than 72 hours old.';

// When the check could not be made. Never a verdict on the link; a 429 shows
// the limiter's own message instead, which says how long to wait.
const CHECK_FAILED_MESSAGE =
  'We could not check this link just now. The system may still be starting up, which can take up to a minute. Checking does not use the link up.';

// Read once, by the useState initializer below, before the effect that cleans
// the address bar has run.
const tokenFromAddress = () =>
  new URLSearchParams(window.location.search).get('token') || '';

export default function SetPasswordPage() {
  const [token] = useState(tokenFromAddress);

  // The check of the link when the page opens: 'checking' until the server
  // answers, then 'usable' or 'failed'. A dead answer sets `dead` below
  // instead, exactly as a dead submit does. "Try again" bumps `attempt`.
  const [check, setCheck] = useState('checking');
  const [checkError, setCheckError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  // Set only for the answer that means the LINK is finished, which gets the
  // dedicated panel above rather than an inline message on a form that can
  // no longer succeed.
  const [dead, setDead] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('token')) {
      // history.state is handed back unchanged: React Router keeps its own
      // bookkeeping there, and replacing it with null would confuse Back.
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  // The check uses nothing up, so running twice (StrictMode, in development)
  // or again from "Try again" is harmless. apiFetch, never authFetch: the
  // link is the authority here, so no session header is sent and a signed-in
  // session is never touched. The token goes in the body only. An answer that
  // arrives after cleanup is ignored.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    apiFetch('/auth/set-password/check', { method: 'POST', body: { token } })
      .then(() => {
        if (!cancelled) setCheck('usable');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.data?.code === 'SET_PASSWORD_TOKEN_INVALID') {
          setDead(err.message);
        } else {
          setCheckError(err.status === 429 ? err.message : CHECK_FAILED_MESSAGE);
          setCheck('failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // A link pasted without its query string, truncated by a mail client, or a
  // reload after the address bar was cleaned.
  if (!token) return <DeadLink message={NO_TOKEN_MESSAGE} />;
  if (dead) return <DeadLink message={dead} />;

  function tryAgain() {
    setCheck('checking');
    setAttempt((n) => n + 1);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch('/auth/set-password', {
        method: 'POST',
        body: { token, new_password: password },
      });
      setDone(data.message);
    } catch (err) {
      // The server tags every link-is-finished answer with one code, so the
      // screen does not match on wording. Everything else (a password the
      // policy refuses, an unreachable server) stays inline on the form.
      if (err.data?.code === 'SET_PASSWORD_TOKEN_INVALID') setDead(err.message);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth-page">
        <div className="card">
          <h1>Password set</h1>
          <div className="alert success">{done}</div>
          <Link className="button-link" to="/login">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (check === 'checking') {
    return (
      <BeforeForm>
        <p className="muted" role="status">Checking your link…</p>
      </BeforeForm>
    );
  }

  if (check === 'failed') {
    return (
      <BeforeForm>
        <div className="alert info">{checkError}</div>
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
        <p className="alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </BeforeForm>
    );
  }

  return (
    <div className="auth-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Set your password</h1>
        <p className="subtitle">
          BrgyServe — Barangay Ubujan, Tagbilaran City. This link works once,
          and only for 72 hours after it was sent.
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
        <PasswordChecklist value={password} />
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
          {busy ? 'Saving…' : 'Set password'}
        </button>

        <p className="alt">
          <Link to="/login">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
