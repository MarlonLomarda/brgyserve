import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { roleHome } from "../auth/roles";
import PasswordInput from "../components/PasswordInput";
import brgyPersonnel from "../assets/brgy-personnel.jpg";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [activeModal, setActiveModal] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);

    try {
      const user = await login(username.trim(), password);
      navigate(roleHome(user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function closeModal() {
    setActiveModal(null);
  }

  return (
    <div className="auth-page">
      <div
        className="login-form-image"
        style={{ backgroundImage: `url(${brgyPersonnel})` }}
      ></div>

      <div className="login-form-wrapper">
        <form className="card" onSubmit={handleSubmit}>
          <h1>BrgyServe</h1>

          <p className="subtitle">Barangay Ubujan, Tagbilaran City</p>

          {error && <div className="alert error">{error}</div>}

          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </label>

          <label>
            Password
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="alt">
            No account yet? <Link to="/register">Register as a resident</Link>
          </p>

          {/* Legal Links */}
          <div className="legal-links">
            <a
              href="#help"
              onClick={(e) => {
                e.preventDefault();
                setActiveModal("help");
              }}
            >
              Help Center
            </a>

            <span>•</span>

            <a
              href="#terms"
              onClick={(e) => {
                e.preventDefault();
                setActiveModal("terms");
              }}
            >
              Terms of Use
            </a>

            <span>•</span>

            <a
              href="#privacy"
              onClick={(e) => {
                e.preventDefault();
                setActiveModal("privacy");
              }}
            >
              Privacy Policy
            </a>
          </div>
        </form>

        {/* Modal */}
        {activeModal && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="legal-modal" onClick={(e) => e.stopPropagation()}>
              {/* Help Center */}
              {activeModal === "help" && (
                <>
                  <h2>Help Center</h2>

                  <p>Welcome to the BrgyServe Help Center.</p>

                  <h3>How do I request a document?</h3>
                  <p>
                    Log in to your account, select the document you need,
                    provide the required information, and submit your request.
                  </p>

                  <h3>How do I track my request?</h3>
                  <p>
                    You can track the status of your submitted request through
                    the tracking section of BrgyServe.
                  </p>
                </>
              )}

              {/* Terms of Use */}
              {activeModal === "terms" && (
                <>
                  <h2>Terms of Use</h2>

                  <p>
                    By using BrgyServe, you agree to use the system only for
                    legitimate barangay-related services and transactions.
                  </p>

                  <h3>Acceptable Use</h3>
                  <p>
                    Users must provide accurate information and must not misuse,
                    interfere with, or attempt to gain unauthorized access to
                    the system.
                  </p>

                  <h3>Account Responsibility</h3>
                  <p>
                    Users are responsible for keeping their account credentials
                    secure and for all activities performed through their
                    account.
                  </p>
                </>
              )}

              {/* Privacy Policy */}
              {activeModal === "privacy" && (
                <>
                  <h2>Privacy Policy</h2>

                  <p>
                    BrgyServe collects personal information needed to provide
                    barangay services and process resident requests.
                  </p>

                  <h3>Information We Collect</h3>
                  <p>
                    Information may include your name, contact details, address,
                    and other information required for barangay transactions.
                  </p>

                  <h3>Use of Information</h3>
                  <p>
                    Your information is used for processing requests,
                    notifications, records management, and other legitimate
                    barangay services.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
