import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";

// Public. Deliberately does NOT use useAuth or authFetch — the caller is
// someone who cannot log in, so there is no session to read and no token to
// attach. ChangePasswordPage looks similar and is not reusable for exactly
// that reason: it reads user, authFetch, updateUser and logout from context.
//
// The server answers identically whether or not the address has an account,
// so this screen simply renders whatever it is told. It must not add wording
// of its own about whether the address was found — that would undo the whole
// point of the neutral response.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: { email: email.trim() },
      });
      setSent(data.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-page">
        <div className="card">
          <h1>Check your email</h1>
          <div className="alert success">{sent}</div>
          <p className="muted">
            The link opens a page where you choose a new password. If nothing
            arrives, the address may not have an account, or the account may
            still be waiting for the Barangay Secretary&apos;s approval.
          </p>
          <Link className="button-link" to="/login">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="forgot-password-form-wrapper">
        <form className="card" onSubmit={handleSubmit}>
          <h1>Forgot password</h1>
          <p className="subtitle">
            Enter the email address on your BrgyServe account and we will send
            you a link to set a new password.
          </p>

          {error && <div className="alert error">{error}</div>}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus
            />
          </label>

          <button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </button>

          <p className="alt">
            Remembered it? <Link to="/login">Back to sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
