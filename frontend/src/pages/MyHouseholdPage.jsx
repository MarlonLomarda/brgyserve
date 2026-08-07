import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';

// Events stage 3c — the household QR code a resident presents at an assembly.
//
// The code is the ONLY thing on this page. No household number, no head name,
// no address, no member list: this gets held up on a phone in a crowd, and a
// screen that also lists who lives where would be handing that to whoever is
// standing behind you. The server sends nothing else either.

// Every reason the server can give for having no code to show. None of these
// is an error — a resident who simply is not in a household is a normal state,
// so each gets a plain explanation instead of a red alert.
const NO_HOUSEHOLD_MESSAGE = {
  no_resident_record:
    'Your account is not linked to a resident record yet. The Barangay Office links it when your registration is approved.',
  no_membership:
    'You are not listed as a member of a household yet. Ask the Barangay Office to add you to your household record.',
  household_inactive:
    'Your household record is no longer active. Please visit the Barangay Office to have it restored.',
  no_qr:
    'Your household does not have a QR code yet. Please ask the Barangay Office to issue one.',
};

const FALLBACK_MESSAGE =
  'No household QR code is available for your account. Please contact the Barangay Office.';

export default function MyHouseholdPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await authFetch('/my-household'));
    } catch (err) {
      setError(err.message);
      setData(null);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="dash">
      <DashHeader
        title="BrgyServe — Resident"
        subtitle="Your household QR code"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
        <div className="pending-card">
          <div className="pending-head">
            <h3>My household</h3>
          </div>

          {error && <div className="alert error">{error}</div>}

          {!error && data === null && <p className="muted">Loading…</p>}

          {data && !data.has_household && (
            <div className="empty">
              <p>
                <strong>No QR code to show yet.</strong>
              </p>
              <p className="muted">
                {NO_HOUSEHOLD_MESSAGE[data.reason] || FALLBACK_MESSAGE}
              </p>
            </div>
          )}

          {data && data.has_household && (
            <div className="qr-panel">
              <div className="qr-frame">
                {/* SVG rather than canvas: it stays sharp when the phone is
                    held up close to a scanner, and it survives a screenshot
                    or a printout at any size. */}
                <QRCodeSVG
                  value={data.qr_token}
                  size={256}
                  level="M"
                  marginSize={2}
                  title="Household QR code"
                />
              </div>
              <p className="qr-caption">
                Show this code when you sign in at a barangay assembly.
              </p>
              <p className="muted small-note">
                {data.is_head
                  ? 'One code per household — any member may present it.'
                  : 'This is your household’s code. Any member may present it.'}
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
