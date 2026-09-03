import { useState } from "react";
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

  return (
    <div className="auth-page">
      <div className="slider-wrapper">
        <div className="slider">
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

          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="alt">
            <Link to="/forgot-password">Forgot your password?</Link>
          </p>
          <p className="alt">
            No account yet? <Link to="/register">Register as a resident</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
