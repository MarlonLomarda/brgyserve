import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ROLE_HOME, roleHome } from './auth/roles';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import RoleLandingPage from './pages/RoleLandingPage';
import SecretaryReviewPage from './pages/SecretaryReviewPage';

export default function App() {
  const { user } = useAuth();
  const home = user ? roleHome(user.role) : '/login';

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={home} replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to={home} replace /> : <RegisterPage />} />

      {Object.entries(ROLE_HOME).map(([role, path]) => (
        <Route
          key={role}
          path={path}
          element={
            <ProtectedRoute role={role}>
              {role === 'secretary' ? <SecretaryReviewPage /> : <RoleLandingPage />}
            </ProtectedRoute>
          }
        />
      ))}

      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
