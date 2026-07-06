import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Shared header for the Secretary dashboard pages: title, section nav,
// current user, and logout.
export default function DashHeader({ subtitle }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="dash-header">
      <div>
        <h1>BrgyServe — Secretary</h1>
        <p className="muted">{subtitle}</p>
        <nav className="dash-nav">
          <NavLink to="/secretary" end>
            Resident review
          </NavLink>
          <NavLink to="/secretary/document-types">Document types</NavLink>
        </nav>
      </div>
      <div className="dash-user">
        <span className="muted">@{user.username}</span>
        <button className="btn secondary" onClick={handleLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
