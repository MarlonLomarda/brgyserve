import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { roleHome } from "../auth/roles";
import PasswordInput from "../components/PasswordInput";
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
              {/* Help Center */}
              {activeModal === "help" && (
                <>
                  <h2>Help Center</h2>

                  <p>
                    Welcome to the <strong>BrgyServe Help Center</strong>. Here
                    you can find answers to common questions about using the
                    system.
                  </p>

                  <h4>1. How do I create an account?</h4>
                  <p>
                    Click <strong>Register as a resident</strong> on the login
                    page. Enter the required information and submit your
                    registration. Make sure the information you provide is
                    accurate.
                  </p>

                  <h4>2. How do I request a document?</h4>
                  <p>
                    Log in to your account and select the document you need.
                    Fill out the required information, upload any required
                    documents, and submit your request.
                  </p>

                  <h4>3. How do I track my request?</h4>
                  <p>
                    After submitting a request, you can check its status through
                    the
                    <strong> Document Requests</strong> section. You may also
                    use your tracking ID to identify your request.
                  </p>

                  <h4>4. What do the request statuses mean?</h4>
                  <ul>
                    <li>
                      <strong>Pending:</strong> Your request is waiting for
                      review.
                    </li>
                    <li>
                      <strong>Processing:</strong> Your request is currently
                      being processed.
                    </li>
                    <li>
                      <strong>Approved:</strong> Your request has been approved.
                    </li>
                    <li>
                      <strong>Rejected:</strong> Your request was not approved.
                    </li>
                    <li>
                      <strong>Ready for Claim:</strong> Your document is ready
                      to be claimed.
                    </li>
                    <li>
                      <strong>Completed:</strong> Your request has been
                      successfully completed.
                    </li>
                  </ul>

                  <h4>5. How do I make a payment?</h4>
                  <p>
                    Follow the payment instructions provided by the barangay. If
                    a payment receipt or screenshot is required, upload a clear
                    copy through the system. Payments are subject to
                    verification by the barangay treasurer.
                  </p>

                  <h4>6. How do I rent a facility?</h4>
                  <p>
                    Go to the <strong>Facility Rentals</strong> section, select
                    an available facility, choose your preferred date, provide
                    the required information, and submit your rental request.
                  </p>

                  <h4>7. What should I do if my request is rejected?</h4>
                  <p>
                    Check the reason provided by the barangay. If additional
                    information or documents are required, correct the issue and
                    submit a new request when applicable.
                  </p>

                  <h4>8. I forgot my password. What should I do?</h4>
                  <p>
                    Use the password recovery option on the login page. Follow
                    the instructions provided to reset your password.
                  </p>

                  <h4>9. Who can I contact for assistance?</h4>
                  <p>
                    For problems that cannot be resolved through the Help
                    Center, contact the Barangay Office during official office
                    hours.
                  </p>
                </>
              )}

              {/* Terms of Use */}
              {activeModal === "terms" && (
                <>
                  <h2>Terms of Use</h2>

                  <h4>1. Acceptance of Terms</h4>
                  <p>
                    By accessing or using the <strong>BrgyServe</strong>, you
                    agree to be bound by these Terms of Use. If you do not
                    agree, please refrain from using the platform.
                  </p>

                  <h4>2. Eligibility</h4>
                  <p>
                    You must be a registered resident of{" "}
                    <strong>Barangay Ubujan</strong>
                    and at least 18 years old to create an account. Minors may
                    use the portal under parental or guardian supervision.
                  </p>

                  <h4>3. Account Responsibilities</h4>
                  <p>
                    You are responsible for maintaining the confidentiality of
                    your login credentials. Any activity under your account is
                    your responsibility. Notify us immediately of any
                    unauthorized use.
                  </p>

                  <h4>4. Acceptable Use</h4>
                  <p>You agree not to:</p>

                  <ul>
                    <li>Use the portal for unlawful purposes</li>
                    <li>Impersonate any person or entity</li>
                    <li>Upload false or misleading information</li>
                    <li>Interfere with portal functionality</li>
                  </ul>

                  <h4>5. Document Requests</h4>
                  <p>
                    All requests are subject to verification. False declarations
                    may result in denial of service or legal action. Approved
                    documents must be claimed within <strong>30 days</strong>.
                  </p>

                  <h4>6. Limitation of Liability</h4>
                  <p>
                    The Barangay is not liable for technical failures, data
                    loss, or delays beyond our control. We strive to maintain
                    99.9% uptime.
                  </p>

                  <h4>7. Changes to Terms</h4>
                  <p>
                    We may update these terms at any time. Continued use of the
                    portal constitutes acceptance of the new terms.
                  </p>

                  <p>
                    <em>
                      Thank you for being a responsible digital citizen of
                      Barangay Ubujan.
                    </em>
                  </p>
                </>
              )}

              {/* Privacy Policy */}
              {activeModal === "privacy" && (
                <>
                  <h2>Privacy Policy</h2>

                  <h4>Our Commitment to Your Privacy</h4>
                  <p>
                    At <strong>BrgyServe</strong>, we take your privacy
                    seriously. This policy explains how we collect, use, and
                    protect your personal information in compliance with the{" "}
                    <em>Data Privacy Act of 2012 (RA 10173)</em>.
                  </p>

                  <h4>1. Information We Collect</h4>
                  <ul>
                    <li>
                      <strong>Personal Information:</strong> Full name, address,
                      contact number, email, birthdate
                    </li>
                    <li>
                      <strong>Government IDs:</strong> For verification (e.g.,
                      Barangay ID, Voter's ID)
                    </li>
                    <li>
                      <strong>Usage Data:</strong> Login history, request logs
                    </li>
                  </ul>

                  <h4>2. How We Use Your Data</h4>
                  <p>Your information is used solely to:</p>
                  <ul>
                    <li>Process document requests</li>
                    <li>Verify identity and residency</li>
                    <li>Send important notifications</li>
                    <li>Improve portal services</li>
                  </ul>

                  <h4>3. Data Security</h4>
                  <p>
                    We use industry-standard encryption (SSL/TLS) and store data
                    in secure, access-controlled servers. Only authorized
                    personnel can access your information.
                  </p>

                  <h4>4. Data Sharing</h4>
                  <p>
                    We <strong>do not sell</strong> your data. Information is
                    shared only with:
                  </p>
                  <ul>
                    <li>Barangay officials for verification</li>
                    <li>LGU partners for official transactions</li>
                    <li>Law enforcement (when legally required)</li>
                  </ul>

                  <h4>5. Your Rights</h4>
                  <p>Under RA 10173, you have the right to:</p>
                  <ul>
                    <li>Access your personal data</li>
                    <li>Correct inaccurate information</li>
                    <li>Request deletion (subject to legal retention)</li>
                    <li>File a complaint with the NPC</li>
                  </ul>

                  <h4>6. Contact Us</h4>
                  <p>
                    <strong>Data Privacy Officer</strong>
                    <br />
                    Email: <strong>BrgyServeUbujan@gmail.com</strong>
                    <br />
                    Phone: 09-123-456-78911
                  </p>

                  <p>
                    <em>
                      Your trust is the foundation of our digital barangay.
                    </em>
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
