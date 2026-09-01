import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ROLE_HOME, roleHome } from './auth/roles';
import ProtectedRoute from './components/ProtectedRoute';
import BookRentalPage from './pages/BookRentalPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import DisputesPage from './pages/DisputesPage';
import DocumentTypesPage from './pages/DocumentTypesPage';
import EventsPage from './pages/EventsPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import HouseholdsPage from './pages/HouseholdsPage';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import MyHouseholdPage from './pages/MyHouseholdPage';
import MyRentalsPage from './pages/MyRentalsPage';
import NotificationsPage from './pages/NotificationsPage';
import MyRequestsPage from './pages/MyRequestsPage';
import PaymentResultPage from './pages/PaymentResultPage';
import PaymentsPage from './pages/PaymentsPage';
import PublicEventsPage from './pages/PublicEventsPage';
import RegisterPage from './pages/RegisterPage';
import ReportsPage from './pages/ReportsPage';
import RentalBookingsPage from './pages/RentalBookingsPage';
import RentalItemsPage from './pages/RentalItemsPage';
import RequestDocumentPage from './pages/RequestDocumentPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ResidentRecordsPage from './pages/ResidentRecordsPage';
import RoleLandingPage from './pages/RoleLandingPage';
import SecretaryRequestsPage from './pages/SecretaryRequestsPage';
import SecretaryReviewPage from './pages/SecretaryReviewPage';
import { PUNONG_BARANGAY_NAV, RESIDENT_NAV, SECRETARY_NAV, STAFF_NAV, TREASURER_NAV } from './constants/nav';

// Per-role home pages; roles without a real screen yet fall back to the
// placeholder landing page. Staff and the Punong Barangay get the read-only
// rental-bookings view (no canManage) — writes are blocked server-side too.
const ROLE_PAGES = {
  secretary: <SecretaryReviewPage />,
  resident: <MyRequestsPage />,
  treasurer: <PaymentsPage title="Payments" nav={TREASURER_NAV} />,
  staff: <RentalBookingsPage title="Rental bookings" nav={STAFF_NAV} canReturn />,
  punong_barangay: (
    <RentalBookingsPage title="Rental bookings" nav={PUNONG_BARANGAY_NAV} />
  ),
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
      {/* The public landing page. Deliberately NOT wrapped in a redirect for
          signed-in users: it offers them a link to their own dashboard rather
          than bouncing them, so "/" stays reachable mid-session and this page
          never becomes a third opinion about where a user belongs. */}
      <Route path="/" element={<LandingPage />} />

      <Route path="/login" element={user ? <Navigate to={home} replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to={home} replace /> : <RegisterPage />} />
      {/* Forgot password bounces a signed-in user for the same reason /login
          and /register do: they already have a working session, and
          /change-password is the screen they want. */}
      <Route
        path="/forgot-password"
        element={user ? <Navigate to={home} replace /> : <ForgotPasswordPage />}
      />
      {/* Reset password DOES NOT bounce, and the asymmetry is deliberate. The
          token in the URL is the authority here, not the session — this page
          never reads `user`. A resident who resets on their phone and opens
          the emailed link on a laptop that is still signed in would otherwise
          be redirected away from the only screen that can spend their link. */}
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/change-password"
        element={user ? <ChangePasswordPage /> : <Navigate to="/login" replace />}
      />

      <Route
        path="/secretary/residents"
        element={
          <ProtectedRoute role="secretary">
            <ResidentRecordsPage title="Resident records" nav={SECRETARY_NAV} canManage />
          </ProtectedRoute>
        }
      />
      {/* Staff and the Punong Barangay read the master list; no canManage, so
          every write control is absent. The server narrows what Staff receive
          (no contact details, no linked account) — see routes/residentRecords.js. */}
      <Route
        path="/staff/residents"
        element={
          <ProtectedRoute role="staff">
            <ResidentRecordsPage title="Resident records" nav={STAFF_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/residents"
        element={
          <ProtectedRoute role="punong_barangay">
            <ResidentRecordsPage title="Resident records" nav={PUNONG_BARANGAY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/households"
        element={
          <ProtectedRoute role="secretary">
            <HouseholdsPage title="Households" nav={SECRETARY_NAV} canManage />
          </ProtectedRoute>
        }
      />
      {/* Staff see the same views read-only; every write control is absent,
          and the server refuses the writes regardless. */}
      <Route
        path="/staff/households"
        element={
          <ProtectedRoute role="staff">
            <HouseholdsPage title="Households" nav={STAFF_NAV} />
          </ProtectedRoute>
        }
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
            <SecretaryRequestsPage title="Document requests" nav={SECRETARY_NAV} canManage />
          </ProtectedRoute>
        }
      />
      {/* View-only for both: approve/reject/ready-for-release/claim stay
          Secretary-only server-side as well. */}
      <Route
        path="/staff/requests"
        element={
          <ProtectedRoute role="staff">
            <SecretaryRequestsPage title="Document requests" nav={STAFF_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/requests"
        element={
          <ProtectedRoute role="punong_barangay">
            <SecretaryRequestsPage title="Document requests" nav={PUNONG_BARANGAY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/payments"
        element={
          <ProtectedRoute role="secretary">
            <PaymentsPage title="Payments" nav={SECRETARY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/rental-items"
        element={
          <ProtectedRoute role="secretary">
            <RentalItemsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/rentals"
        element={
          <ProtectedRoute role="secretary">
            <RentalBookingsPage title="Rental bookings" nav={SECRETARY_NAV} canManage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/blotter"
        element={
          <ProtectedRoute role="secretary">
            <DisputesPage title="Blotter" nav={SECRETARY_NAV} canManage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/events"
        element={
          <ProtectedRoute role="secretary">
            <EventsPage title="Events" nav={SECRETARY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/events"
        element={
          <ProtectedRoute role="staff">
            <EventsPage title="Events" nav={STAFF_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/notifications"
        element={
          <ProtectedRoute role="secretary">
            <NotificationsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/reports"
        element={
          <ProtectedRoute role="secretary">
            <ReportsPage title="Reports" nav={SECRETARY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/treasurer/reports"
        element={
          <ProtectedRoute role="treasurer">
            <ReportsPage title="Reports" nav={TREASURER_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/reports"
        element={
          <ProtectedRoute role="punong_barangay">
            <ReportsPage title="Reports" nav={PUNONG_BARANGAY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/events"
        element={
          <ProtectedRoute role="resident">
            <PublicEventsPage title="Events" nav={RESIDENT_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/events"
        element={
          <ProtectedRoute role="punong_barangay">
            <PublicEventsPage title="Events" nav={PUNONG_BARANGAY_NAV} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/blotter"
        element={
          <ProtectedRoute role="punong_barangay">
            <DisputesPage title="Blotter" nav={PUNONG_BARANGAY_NAV} />
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
      <Route
        path="/resident/rentals"
        element={
          <ProtectedRoute role="resident">
            <MyRentalsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/book-rental"
        element={
          <ProtectedRoute role="resident">
            <BookRentalPage />
          </ProtectedRoute>
        }
      />
      {/* Events stage 3c — the household QR a resident presents at an
          assembly. Resident-only; there is no Secretary-side QR view. */}
      <Route
        path="/resident/household"
        element={
          <ProtectedRoute role="resident">
            <MyHouseholdPage />
          </ProtectedRoute>
        }
      />
      {/* Where PayMongo redirects after the hosted GCash checkout. The
          redirect proves nothing — this page reads the charge's real status
          back from the API. */}
      <Route
        path="/resident/payment-result"
        element={
          <ProtectedRoute role="resident">
            <PaymentResultPage />
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
