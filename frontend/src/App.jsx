import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ROLE_HOME, roleHome } from './auth/roles';
import ProtectedRoute from './components/ProtectedRoute';
import ChangePasswordPage from './pages/ChangePasswordPage';
import DocumentTypesPage from './pages/DocumentTypesPage';
import LoginPage from './pages/LoginPage';
import MyRequestsPage from './pages/MyRequestsPage';
import PaymentsPage from './pages/PaymentsPage';
import RegisterPage from './pages/RegisterPage';
import RequestDocumentPage from './pages/RequestDocumentPage';
import RoleLandingPage from './pages/RoleLandingPage';
import SecretaryRequestsPage from './pages/SecretaryRequestsPage';
import SecretaryReviewPage from './pages/SecretaryReviewPage';
import { SECRETARY_NAV, TREASURER_NAV } from './constants/nav';

// Per-role home pages; roles without a real screen yet fall back to the
// placeholder landing page.
const ROLE_PAGES = {
  secretary: <SecretaryReviewPage />,
  resident: <MyRequestsPage />,
  treasurer: <PaymentsPage title="BrgyServe — Treasurer" nav={TREASURER_NAV} />,
};

export default function App() {
  const { user } = useAuth();
  // Users on a temporary password are routed to /change-password before
  // anything else (the backend enforces this on the API side too).
  const home = user
    ? user.must_change_password
      ? '/change-password'
      : roleHome(user.role)
    : '/login';

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={home} replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to={home} replace /> : <RegisterPage />} />
      <Route
        path="/change-password"
        element={user ? <ChangePasswordPage /> : <Navigate to="/login" replace />}
      />

      <Route
        path="/secretary/document-types"
        element={
          <ProtectedRoute role="secretary">
            <DocumentTypesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/requests"
        element={
          <ProtectedRoute role="secretary">
            <SecretaryRequestsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/payments"
        element={
          <ProtectedRoute role="secretary">
            <PaymentsPage title="BrgyServe — Secretary" nav={SECRETARY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/request"
        element={
          <ProtectedRoute role="resident">
            <RequestDocumentPage />
          </ProtectedRoute>
        }
      />

      {Object.entries(ROLE_HOME).map(([role, path]) => (
        <Route
          key={role}
          path={path}
          element={
            <ProtectedRoute role={role}>
              {ROLE_PAGES[role] || <RoleLandingPage />}
            </ProtectedRoute>
          }
        />
      ))}

      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
