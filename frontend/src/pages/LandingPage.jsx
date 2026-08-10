import {
  Banknote,
  CalendarCheck,
  ChartColumn,
  FileText,
  QrCode,
  Scale,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { roleHome } from '../auth/roles';

// The public landing page at "/" — the only screen in the app that renders
// without a session. It makes NO API calls: every section below is static, so
// there is no backend route, no CORS entry and no RLS policy behind it.
//
// It never redirects. A logged-in visitor is offered a link to their own
// dashboard instead of being bounced, because App.jsx and ProtectedRoute
// already hold the only two opinions about where a user belongs — adding a
// third here is what caused the redirect loop documented in CLAUDE.md.
//
// EVERY CLAIM ON THIS PAGE MUST MATCH A FEATURE THAT WORKS. In particular:
// SMS notification is a stub that only console-logs, so nothing here may say
// a resident will be told about anything — every answer about status says to
// sign in and check. Online card/e-wallet checkout runs against the PayMongo
// SANDBOX, so payment is described as cash or a GCash reference verified by
// the Treasurer, which is what actually happens.

// Icons are DECORATIVE — every card already says what it is in words, so they
// are hidden from screen readers rather than described twice.
const SERVICES = [
  {
    title: 'Document Requests',
    body: 'Request barangay clearances, certificates and permits, and follow each one through to release.',
    Icon: FileText,
  },
  {
    title: 'Facility Rentals',
    body: 'Reserve barangay facilities and equipment, with availability checked as you book.',
    Icon: CalendarCheck,
  },
  {
    title: 'Payments',
    body: 'Fees for documents and rentals, recorded and verified by the Barangay Treasurer.',
    Icon: Banknote,
  },
  {
    title: 'QR Attendance',
    body: 'Households present a QR code at barangay assemblies for staff to scan.',
    Icon: QrCode,
  },
  {
    title: 'Blotter and Dispute Records',
    body: 'Incident and complaint records kept by the Barangay Secretary.',
    Icon: Scale,
  },
  {
    title: 'Reports and Records',
    body: 'Resident records and operational reports for barangay officials.',
    Icon: ChartColumn,
  },
];

const STEPS = [
  {
    title: 'Create Account',
    body: 'Register with your details. The Barangay Secretary matches you to the barangay’s resident records and activates your account.',
  },
  {
    title: 'Submit Request',
    body: 'Choose the document you need and give the purpose. The fee is shown before you send it.',
  },
  {
    title: 'Track Status',
    body: 'Sign in and open My Requests to see whether it is pending, approved, or ready for release.',
  },
  {
    title: 'Claim Document',
    body: 'Settle the fee and collect your document at the Barangay Office.',
  },
];

const FAQS = [
  {
    q: 'Do I need an account to request a document?',
    a: 'Yes. Register with your details, and the Barangay Secretary will match you to the barangay’s resident records and activate your account. Requests are made from your own account so the barangay knows who submitted them.',
  },
  {
    q: 'Why does my new account say it is waiting for approval?',
    a: 'New accounts are not active straight away. Barangay staff first link your account to an existing resident record, so that requests only come from verified residents of Barangay Ubujan. You can sign in once that is done.',
  },
  {
    q: 'What documents can I request, and what do they cost?',
    a: 'The list is maintained by the Barangay Secretary, so it always reflects what the barangay currently issues. Each type shows its fee when you select it, before you submit anything. Some documents are free of charge.',
  },
  {
    q: 'How do I pay the fee?',
    a: 'You can pay in cash at the Barangay Office, or by GCash. If you pay by GCash, enter the reference number from your receipt when you record the payment, and the Barangay Treasurer will verify it before your document is released.',
  },
  {
    q: 'How do I know when my document is ready?',
    a: 'Sign in and open My Requests — the status is shown next to each one, from pending, to approved, to ready for release. Check there for updates. Once a request reads ready for release, you can claim it at the Barangay Office.',
  },
  {
    q: 'Can I cancel a request, and what happens if it is rejected?',
    a: 'You can cancel a request yourself while it is still pending. If a request is rejected, My Requests shows the reason the Barangay Secretary recorded, and you are free to submit a corrected request.',
  },
  {
    q: 'How do I reserve a barangay facility or equipment?',
    a: 'Choose the item, the date, the time and how many units you need. The system checks availability as you book and confirms the reservation immediately if the slot is free. If it is already taken, you are told why.',
  },
  {
    q: 'What is the household QR code for?',
    a: 'It is used to record attendance at barangay assemblies. Each household is recorded once, so one member can present the code shown in their account for barangay staff to scan.',
  },
  {
    q: 'What happens if my household misses an assembly?',
    a: 'If the activity carries a fine, the Barangay Secretary may charge it to the household. It then appears as an amount due and is settled at the Barangay Office like any other fee.',
  },
  {
    q: 'Who can see blotter and dispute records?',
    a: 'Only the Barangay Secretary and the Punong Barangay. Blotter and dispute records are not visible to residents.',
  },
  {
    q: 'Who uses the system?',
    a: 'Residents, together with four barangay roles: the Barangay Secretary, the Punong Barangay, the Barangay Treasurer and Barangay Staff. Each role only sees the screens for its own work.',
  },
];

const NAV_LINKS = [
  { href: '#about', label: 'About' },
  { href: '#services', label: 'Services' },
  { href: '#faq', label: 'FAQ' },
];

export default function LandingPage() {
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // Where a signed-in visitor is offered to go. Users on a temporary password
  // are sent to change it — every other route refuses them until they do.
  const signedInTo = user?.must_change_password ? '/change-password' : roleHome(user?.role);
  const signedInLabel = user?.must_change_password ? 'Change your password' : 'Go to my dashboard';

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="landing">
      {/* ---------------------------------------------------------- nav */}
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <a className="landing-logo" href="#about" onClick={closeMenu}>
            Brgy<span>Serve</span>
          </a>

          <button
            type="button"
            className="landing-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="landing-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className={`landing-menu-icon${menuOpen ? ' is-open' : ''}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>

          <div
            id="landing-menu"
            className={`landing-nav-menu${menuOpen ? ' is-open' : ''}`}
          >
            <nav className="landing-nav-links">
              {NAV_LINKS.map((item) => (
                <a key={item.href} href={item.href} onClick={closeMenu}>
                  {item.label}
                </a>
              ))}
            </nav>

            <div className="landing-nav-actions">
              {user ? (
                <>
                  <span className="landing-nav-user">@{user.username}</span>
                  <Link className="button-link landing-cta" to={signedInTo} onClick={closeMenu}>
                    {signedInLabel}
                  </Link>
                </>
              ) : (
                <>
                  <Link className="landing-nav-login" to="/login" onClick={closeMenu}>
                    Login
                  </Link>
                  <Link className="button-link landing-cta" to="/register" onClick={closeMenu}>
                    Create Account
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------- hero */}
      <section className="landing-hero" id="about">
        <div className="landing-hero-inner">
          <span className="badge">Barangay Ubujan, Tagbilaran City</span>
          <h1 className="landing-title">BrgyServe</h1>
          <p className="landing-tagline">
            A Web-Based Barangay Service and Records Management System
          </p>
          <p className="landing-lede">
            Submit your barangay document requests online and follow them through to release,
            instead of making a trip for every step. Reserve barangay facilities, and keep your
            household record up to date with the Barangay Office. Documents are claimed in person
            at the Barangay Office.
          </p>
          <Link className="button-link landing-hero-cta" to={user ? signedInTo : '/login'}>
            {user ? signedInLabel : 'Request a Document'}
          </Link>
        </div>
      </section>

      {/* ----------------------------------------------------- services */}
      <section className="landing-section" id="services">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">Services</h2>
          <p className="landing-section-lede">
            What Barangay Ubujan handles through BrgyServe today.
          </p>
          <div className="landing-grid landing-grid-services">
            {SERVICES.map(({ title, body, Icon }) => (
              <article className="landing-card" key={title}>
                <span className="landing-card-icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- how it works */}
      <section className="landing-section landing-section-alt" id="how">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">How It Works</h2>
          <p className="landing-section-lede">From registration to claiming your document.</p>
          <ol className="landing-grid landing-grid-steps">
            {STEPS.map((step, index) => (
              <li className="landing-step" key={step.title}>
                <span className="landing-step-num" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------------------------------------------------- faq */}
      <section className="landing-section" id="faq">
        <div className="landing-section-inner landing-faq-inner">
          <h2 className="landing-section-title">Frequently Asked Questions</h2>
          <p className="landing-section-lede">
            Questions residents most often bring to the Barangay Office.
          </p>
          <div className="landing-faq">
            {FAQS.map((item) => (
              // Native <details>: keyboard-accessible and works with no
              // JavaScript at all, so nothing to get out of sync.
              <details className="landing-faq-item" key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- footer */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div>
            <p className="landing-footer-brand">BrgyServe</p>
            <p className="landing-footer-line">Barangay Ubujan, Tagbilaran City, Bohol</p>
          </div>

          <div>
            <p className="landing-footer-head">Quick links</p>
            <ul className="landing-footer-links">
              {NAV_LINKS.map((item) => (
                <li key={item.href}>
                  <a href={item.href}>{item.label}</a>
                </li>
              ))}
              <li>{user ? <Link to={signedInTo}>{signedInLabel}</Link> : <Link to="/login">Login</Link>}</li>
              {!user && (
                <li>
                  <Link to="/register">Create Account</Link>
                </li>
              )}
            </ul>
          </div>

          <div>
            <p className="landing-footer-head">Contact</p>
            <p className="landing-footer-line">Barangay Hall, Ubujan, Tagbilaran City, Bohol</p>
            <p className="landing-footer-line landing-footer-placeholder">
              Office hours and contact details to be added.
            </p>
          </div>
        </div>
        <p className="landing-footer-note">
          Barangay Ubujan · A capstone project for Barangay Ubujan, Tagbilaran City, Bohol
        </p>
      </footer>
    </div>
  );
}
