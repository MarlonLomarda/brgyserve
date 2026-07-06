import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Shared dashboard header: title, section nav tabs, current user, logout.
// nav = [{ to, label, end? }]
export default function DashHeader({ title, subtitle, nav = [] }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="dash-header">
      <div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {nav.length > 0 && (
          <nav className="dash-nav">
            {nav.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
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
