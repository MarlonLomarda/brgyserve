import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABELS } from '../auth/roles';

// Temporary placeholder — the real per-role screens replace this next.
export default function RoleLandingPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="auth-page">
      <div className="card">
        <h1>BrgyServe</h1>
        <p>
          Logged in as <strong>{user.role}</strong>
          {ROLE_LABELS[user.role] ? ` — ${ROLE_LABELS[user.role]}` : ''}
        </p>
        <p className="subtitle">Username: {user.username}</p>
        <button onClick={handleLogout}>Log out</button>
      </div>
    </div>
  );
}
