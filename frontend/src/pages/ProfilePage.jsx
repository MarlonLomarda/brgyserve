import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS } from "../auth/roles";

// The signed-in user's own account, read-only, for every role. It shows what
// GET /api/auth/profile returns and nothing else: the account fields, and the
// details from the profile row (for a resident, what they gave at
// registration). Nothing on it can be edited here.
//
// Staff-type accounts have no birthdate or address on file, so those rows are
// not rendered for them at all, rather than shown as blanks that suggest
// something is missing.

const NOT_PROVIDED = "Not provided";
const shown = (value) =>
  value === null || value === undefined || String(value).trim() === "" ? NOT_PROVIDED : value;

function Field({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{shown(value)}</dd>
    </div>
  );
}

export default function ProfilePage() {
  const { authFetch } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // "Password changed." arrives once, in history state, from a voluntary
  // change. It is read on mount and the state cleared, so a refresh or a
  // return through the browser's history does not show it again.
  const [notice] = useState(location.state?.notice || "");
  useEffect(() => {
    if (location.state?.notice) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    let cancelled = false;
    authFetch("/auth/profile").then(
      (body) => { if (!cancelled) setData(body); },
      (err) => { if (!cancelled) setError(err.message); },
    );
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  // Error first, then loading, then the content (the list rule in CLAUDE.md).
  if (error) {
    return (
      <div className="pending-card">
        <div className="alert error">{error}</div>
      </div>
    );
  }
  if (!data) return <p className="muted">Loading…</p>;

  const { user, profile } = data;
  const isResident = user.role === "resident";

  return (
    <div className="pending-card">
      {notice && <div className="alert success">{notice}</div>}

      <h3>Account</h3>
      <dl className="info-grid">
        <Field label="Username" value={user.username && `@${user.username}`} />
        <Field label="Email" value={user.email} />
        <Field label="Role" value={ROLE_LABELS[user.role] || user.role} />
      </dl>

      <h3>{isResident ? "Personal information" : "Name and contact"}</h3>
      <dl className="info-grid">
        <Field label="First name" value={profile.first_name} />
        <Field label="Middle name" value={profile.middle_name} />
        <Field label="Last name" value={profile.last_name} />
        <Field label="Suffix" value={profile.suffix} />
        {isResident && <Field label="Birthdate" value={profile.birthdate} />}
        {isResident && <Field label="Address" value={profile.address} />}
        <Field label="Contact number" value={profile.phone_number} />
      </dl>

      {isResident && (
        <p className="muted">
          To correct your name, birthdate or address, contact the Barangay Office.
        </p>
      )}

      <Link className="button-link inline" to="/change-password">
        Change password
      </Link>
    </div>
  );
}
