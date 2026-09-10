import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { roleHome } from "../auth/roles";
import PasswordInput from "../components/PasswordInput";
// The three legal documents. Their wording comes from docs/legal-copy.md,
// which is the source of truth — one component per top-level section of that
// file, so the mapping stays 1:1 when the copy is re-rendered. The modal shell
// below (overlay, close-on-backdrop, activeModal state) is unchanged; only the
// body content moved out.
import HelpCenter from "../components/legal/HelpCenter";
import TermsOfUse from "../components/legal/TermsOfUse";
// LegalPrivacy, not PrivacyPolicy — Brave Shields blocks a path containing
// "privacypolicy" and the page goes white. See the comment in that file.
import PrivacyPolicy from "../components/legal/LegalPrivacy";
import brgyPersonnel from "../assets/loginSlider/brgy-personnel.jpg";
import groupFoto1 from "../assets/loginSlider/ubujan-event-group-foto.jpg";
import groupFoto2 from "../assets/loginSlider/ubujan-group-photo.jpg";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sliderRef = useRef(null);

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

  useEffect(() => {
    const interval = setInterval(() => {
      const slider = sliderRef.current;

      if (!slider) return;

      const sliderWidth = slider.clientWidth;

      slider.scrollBy({
        left: sliderWidth,
        behavior: "smooth",
      });

      if (slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 10) {
        setTimeout(() => {
          slider.scrollTo({
            left: 0,
            behavior: "smooth",
          });
        }, 500);
      }
    }, 6000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="auth-page">
      <div className="slider-wrapper">
        <div className="slider" ref={sliderRef}>
          <img
            id="slider-1"
            src={brgyPersonnel}
            alt="Barangay Ubujan personnel group photo"
          />
          <img
            id="slider-2"
            src={groupFoto1}
            alt="Barangay Ubujan personnel group photo"
          />
          <img
            id="slider-3"
            src={groupFoto2}
            alt="Barangay Ubujan personnel group photo"
          />
          <div className="slider-nav">
            <a href="#slider-1"></a>
            <a href="#slider-2"></a>
            <a href="#slider-3"></a>
          </div>
        </div>
      </div>

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

          <Link className="forgot-password-link" to="/forgot-password">
            Forgot your password?
          </Link>

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
              {activeModal === "help" && <HelpCenter />}
              {activeModal === "terms" && <TermsOfUse />}
              {activeModal === "privacy" && <PrivacyPolicy />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
