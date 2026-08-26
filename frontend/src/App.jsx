import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { ROLE_HOME, roleHome, ROLE_NAV } from "./auth/roles";
import ProtectedRoute from "./components/ProtectedRoute";
import PageLayout from "./components/PageLayout";
import BookRentalPage from "./pages/BookRentalPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import DisputesPage from "./pages/DisputesPage";
import DocumentTypesPage from "./pages/DocumentTypesPage";
import EventsPage from "./pages/EventsPage";
import HouseholdsPage from "./pages/HouseholdsPage";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import MyHouseholdPage from "./pages/MyHouseholdPage";
import MyRentalsPage from "./pages/MyRentalsPage";
import NotificationsPage from "./pages/NotificationsPage";
import MyRequestsPage from "./pages/MyRequestsPage";
import PaymentResultPage from "./pages/PaymentResultPage";
import PaymentsPage from "./pages/PaymentsPage";
import PublicEventsPage from "./pages/PublicEventsPage";
import RegisterPage from "./pages/RegisterPage";
import ReportsPage from "./pages/ReportsPage";
import RentalBookingsPage from "./pages/RentalBookingsPage";
import RentalItemsPage from "./pages/RentalItemsPage";
import RequestDocumentPage from "./pages/RequestDocumentPage";
import ResidentRecordsPage from "./pages/ResidentRecordsPage";
import RoleLandingPage from "./pages/RoleLandingPage";
import SecretaryRequestsPage from "./pages/SecretaryRequestsPage";
import SecretaryReviewPage from "./pages/SecretaryReviewPage";
import {
  PUNONG_BARANGAY_NAV,
  RESIDENT_NAV,
  SECRETARY_NAV,
  STAFF_NAV,
  TREASURER_NAV,
} from "./constants/nav";

// Per-role home pages; roles without a real screen yet fall back to the
// placeholder landing page. Staff and the Punong Barangay get the read-only
// rental-bookings view (no canManage) — writes are blocked server-side too.
const ROLE_PAGES = {
  secretary: <SecretaryReviewPage />,
  resident: <MyRequestsPage />,
  treasurer: <PaymentsPage title="Payments" nav={TREASURER_NAV} />,
  staff: (
    <RentalBookingsPage title="Rental bookings" nav={STAFF_NAV} canReturn />
  ),
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
      ? "/change-password"
      : roleHome(user.role)
    : "/login";

  return (
    <Routes>
      {/* The public landing page. Deliberately NOT wrapped in a redirect for
          signed-in users: it offers them a link to their own dashboard rather
          than bouncing them, so "/" stays reachable mid-session and this page
          never becomes a third opinion about where a user belongs. */}
      <Route path="/" element={<LandingPage />} />

      <Route
        path="/login"
        element={user ? <Navigate to={home} replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={user ? <Navigate to={home} replace /> : <RegisterPage />}
      />
      <Route
        path="/change-password"
        element={
          user ? <ChangePasswordPage /> : <Navigate to="/login" replace />
        }
      />

      <Route
        path="/secretary/residents"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Resident records"}
              subtitle={"Manage the barangay's resident records masterlist"}
              nav={SECRETARY_NAV}
            >
              <ResidentRecordsPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/requests"
        element={
          <ProtectedRoute role="staff">
            <PageLayout
              title={"Document requests"}
              subtitle={"Barangay's records of document requests"}
              nav={STAFF_NAV}
            >
              <SecretaryRequestsPage
                title="Document requests"
                nav={STAFF_NAV}
              />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/households"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Households"}
              subtitle={"Manage the barangay's household records masterlist"}
              nav={SECRETARY_NAV}
            >
              <HouseholdsPage
                title="Households"
                nav={SECRETARY_NAV}
                canManage
              />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      {/* Staff see the same views read-only; every write control is absent,
          and the server refuses the writes regardless. */}
      <Route
        path="/staff/households"
        element={
          <ProtectedRoute role="staff">
            <PageLayout
              title={"Household records"}
              subtitle={"Barangay's household records masterlist"}
              nav={STAFF_NAV}
            >
              <HouseholdsPage title="Households" nav={STAFF_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/document-types"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Document types"}
              subtitle={"Manage document types for residents to make a request"}
              nav={SECRETARY_NAV}
            >
              <DocumentTypesPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/requests"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Document requests"}
              subtitle={"Manage document requests from the barangay residents"}
              nav={SECRETARY_NAV}
            >
              <SecretaryRequestsPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/payments"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Payments"}
              subtitle={"Financial records of the barangay"}
              nav={SECRETARY_NAV}
            >
              <PaymentsPage title="Payments" nav={SECRETARY_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/rental-items"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Rental items"}
              subtitle={"Manage rental items being offered by the barangay"}
              nav={SECRETARY_NAV}
            >
              <RentalItemsPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/rentals"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Rental bookings"}
              subtitle={"Manage the barangay's rental bookings"}
              nav={SECRETARY_NAV}
            >
              {" "}
              <RentalBookingsPage
                title="Rental bookings"
                nav={SECRETARY_NAV}
                canManage
              />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/blotter"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Blotter"}
              subtitle={"Manage the barangay's blotter list"}
              nav={SECRETARY_NAV}
            >
              <DisputesPage title="Blotter" nav={SECRETARY_NAV} canManage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/events"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Events"}
              subtitle={"Manage the barangay's events and activities"}
              nav={SECRETARY_NAV}
            >
              <EventsPage title="Events" nav={SECRETARY_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/staff/events"
        element={
          <ProtectedRoute role="staff">
            <PageLayout
              title={"Events"}
              subtitle={"Barangay's list of events and activities"}
              nav={STAFF_NAV}
            >
              <EventsPage title="Events" nav={STAFF_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/notifications"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Notifications"}
              subtitle={"System notifications and alerts"}
              nav={SECRETARY_NAV}
            >
              <NotificationsPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/secretary/reports"
        element={
          <ProtectedRoute role="secretary">
            <PageLayout
              title={"Reports"}
              subtitle={
                "System generated reports based on the barangay's operations"
              }
              nav={SECRETARY_NAV}
            >
              <ReportsPage title="Reports" nav={SECRETARY_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/treasurer/reports"
        element={
          <ProtectedRoute role="treasurer">
            <PageLayout
              title={"Reports"}
              subtitle={
                "System generated reports based on the barangay's operations"
              }
              nav={TREASURER_NAV}
            >
              <ReportsPage title="Reports" nav={TREASURER_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/reports"
        element={
          <ProtectedRoute role="punong_barangay">
            <PageLayout
              title={"Reports"}
              subtitle={
                "System generated reports based on the barangay's operations"
              }
              nav={PUNONG_BARANGAY_NAV}
            >
              <ReportsPage title="Reports" nav={PUNONG_BARANGAY_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/events"
        element={
          <ProtectedRoute role="resident">
            <PageLayout
              title={"Events"}
              subtitle={"Barangay's list of events and activities"}
              nav={RESIDENT_NAV}
            >
              <PublicEventsPage title="Events" nav={RESIDENT_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/events"
        element={
          <ProtectedRoute role="punong_barangay">
            <PageLayout
              title={"Events"}
              subtitle={"Barangay's list of events and activities"}
              nav={PUNONG_BARANGAY_NAV}
            >
              <PublicEventsPage title="Events" nav={PUNONG_BARANGAY_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/punong-barangay/blotter"
        element={
          <ProtectedRoute role="punong_barangay">
            <PageLayout
              title={"Blotter"}
              subtitle={"Barangay's recorded blotters"}
              nav={PUNONG_BARANGAY_NAV}
            >
              <DisputesPage title="Blotter" nav={PUNONG_BARANGAY_NAV} />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/request"
        element={
          <ProtectedRoute role="resident">
            <PageLayout
              title={"Request a document"}
              subtitle={"Create a document request for your needs"}
              nav={RESIDENT_NAV}
            >
              <RequestDocumentPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/rentals"
        element={
          <ProtectedRoute role="resident">
            <PageLayout
              title={"My rentals"}
              subtitle={"Manage your rentals from the barangay"}
              nav={RESIDENT_NAV}
            >
              <MyRentalsPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/resident/book-rental"
        element={
          <ProtectedRoute role="resident">
            <PageLayout
              title={"Book a facility"}
              subtitle={"Rental booking for facilities and items from the barangay"}
              nav={RESIDENT_NAV}
            >
              <BookRentalPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />
      {/* Events stage 3c — the household QR a resident presents at an
          assembly. Resident-only; there is no Secretary-side QR view. */}
      <Route
        path="/resident/household"
        element={
          <ProtectedRoute role="resident">
            <PageLayout
              title={"My household"}
              subtitle={"Resident household QR code for quick attendance recording"}
              nav={RESIDENT_NAV}
            >
              <MyHouseholdPage />
            </PageLayout>
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
            <PageLayout
              title={"Resident records"}
              subtitle={"Manage the barangay's resident records masterlist"}
              nav={RESIDENT_NAV}
            >
              <PaymentResultPage />
            </PageLayout>
          </ProtectedRoute>
        }
      />

      {Object.entries(ROLE_HOME).map(([role, path]) => (
        <Route
          key={role}
          path={path}
          element={
            <ProtectedRoute role={role}>
              <PageLayout
                title={"Page title"}
                subtitle={"Page subtitle"}
                nav={ROLE_NAV[role]}
              >
                {ROLE_PAGES[role] || <RoleLandingPage />}
              </PageLayout>
            </ProtectedRoute>
          }
        />
      ))}

      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
