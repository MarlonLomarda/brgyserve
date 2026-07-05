import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { roleHome } from '../auth/roles';

// Requires a logged-in user; if `role` is given, also requires that role
// (users on the wrong path are sent to their own landing page).
export default function ProtectedRoute({ role, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.must_change_password) return <Navigate to="/change-password" replace />;
  if (role && user.role !== role) return <Navigate to={roleHome(user.role)} replace />;
  return children;
}
