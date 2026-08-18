import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { chargeMeta } from '../constants/requestStatus';

// Where PayMongo sends the resident back to after the hosted checkout.
//
// IMPORTANT: landing here is NOT proof of payment. The redirect is just the
// browser coming back — it carries no verified information, and a resident
// could reach this url by typing it. The only things that can mark a charge
// paid are the signature-verified webhook and the Treasurer's reconciliation
// action, both server-side. So this screen reports the charge's REAL status,
// read back from the API, and simply waits for confirmation to land.
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 10; // ~20s, then stop and let them refresh

export default function PaymentResultPage() {
  const { authFetch } = useAuth();
  const [params] = useSearchParams();
  const chargeId = params.get('charge');
  const result = params.get('result');

  const [charge, setCharge] = useState(null);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(result === 'success');
  const attemptsRef = useRef(0);

  const check = useCallback(async () => {
    try {
      const data = await authFetch(`/payments/gcash/status/${chargeId}`);
      setCharge(data);
      return data.status;
    } catch (err) {
      setError(err.message);
      return 'ERROR';
    }
  }, [authFetch, chargeId]);

  useEffect(() => {
    if (!chargeId) {
      setError('No charge was specified.');
      setWaiting(false);
      return undefined;
    }

    let cancelled = false;
    let timer = null;

    const poll = async () => {
      const status = await check();
      if (cancelled) return;
      // Stop as soon as it is settled, or once we have waited long enough.
      if (status === 'PAID' || status === 'ERROR' || result !== 'success') {
        setWaiting(false);
        return;
      }
      attemptsRef.current += 1;
      if (attemptsRef.current >= POLL_ATTEMPTS) {
        setWaiting(false);
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [chargeId, check, result]);

  const paid = charge?.status === 'PAID';

  return (
    <div className="dash">
      <DashHeader
        title="GCash payment"
        subtitle="Your online payment for a barangay charge"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
        {error && <div className="alert error">{error}</div>}

        {result === 'cancelled' && !paid && (
          <div className="alert">
            <strong>Payment cancelled.</strong>
            <div className="reason-note">
              Nothing was charged. You can try again, or pay at the barangay hall instead.
            </div>
          </div>
        )}

        {result === 'success' && waiting && (
          <div className="alert">
            <strong>Confirming your payment…</strong>
            <div className="reason-note">
              GCash has sent you back to BrgyServe. We are waiting for PayMongo to confirm the
              payment before marking this as paid — this usually takes a few seconds.
            </div>
          </div>
        )}

        {result === 'success' && !waiting && !paid && (
          <div className="alert">
            <strong>Payment not confirmed yet.</strong>
            <div className="reason-note">
              We have not received confirmation from PayMongo. If the amount was deducted from your
              GCash account, do not pay again — refresh this page in a moment, or show your GCash
              receipt to the barangay treasurer and they will confirm it for you.
            </div>
          </div>
        )}

        {paid && (
          <div className="alert success">
            <strong>Payment confirmed.</strong>
            <div className="reason-note">
              Your payment of ₱{Number(charge.amount).toFixed(2)} for {charge.label} has been
              received. No need to pay again at the barangay hall.
            </div>
          </div>
        )}

        {charge && (
          <div className="table-wrap">
            <table className="data-table">
              <tbody>
                <tr>
                  <th>For</th>
                  <td>{charge.label}</td>
                </tr>
                <tr>
                  <th>Amount</th>
                  <td className="num">₱{Number(charge.amount).toFixed(2)}</td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>
                    <span className={`badge ${chargeMeta(charge.status).className}`}>
                      {chargeMeta(charge.status).label}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="row-actions" style={{ marginTop: '1rem' }}>
          <Link className="button-link inline" to="/resident">
            Back to my requests
          </Link>
          <Link className="button-link inline" to="/resident/rentals">
            My rentals
          </Link>
          {!paid && (
            <button
              className="btn secondary"
              onClick={() => {
                attemptsRef.current = 0;
                setError('');
                check();
              }}
            >
              Check again
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
