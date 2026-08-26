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

// "Ask GCash directly" makes an outbound PayMongo request per press, and there
// is no rate limiting on the API, so the button locks briefly after each click.
// Long enough to stop a flood, short enough not to feel broken to someone who
// is worried about money.
const RECHECK_COOLDOWN_S = 10;

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

  // The poll above only re-reads OUR record. This asks PayMongo itself, which
  // is the only thing that can help when the webhook never arrived — the local
  // row would otherwise say UNPAID for ever.
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState(null); // { kind, text }
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function askGcash() {
    setRecheckBusy(true);
    setRecheckMsg(null);
    setError('');
    try {
      const data = await authFetch(`/payments/gcash/recheck/${chargeId}`, { method: 'POST' });
      setRecheckMsg({ kind: data.settled ? 'success' : '', text: data.message });
      // ONE source of truth for the charge itself: re-read it through the same
      // status endpoint the poll uses, rather than trusting this response to
      // describe the row. If a poll is in flight they cannot disagree — both
      // read the same record after the settlement has been committed.
      await check();
    } catch (err) {
      setRecheckMsg({ kind: 'error', text: err.message });
    } finally {
      setRecheckBusy(false);
      setCooldown(RECHECK_COOLDOWN_S);
    }
  }

  const paid = charge?.status === 'PAID';

  return (
    <div className="dash">
     

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

        {recheckMsg && <div className={`alert ${recheckMsg.kind}`}>{recheckMsg.text}</div>}

        {/* The helper line and BOTH check buttons sit under ONE `!paid` guard,
            rather than three parallel ones, so the explanation cannot outlive
            the buttons it describes. The navigation links are always shown,
            which is why they keep a row of their own below.

            Spacing does the grouping: 1rem above the helper line separates it
            from the status table, 8px below ties it to its buttons. Without
            that the line would sit directly under the table and read as a
            caption for it — .row-actions is justify-content: flex-end, so the
            buttons are right-aligned and cannot be lined up with body text
            without a new rule. */}
        {!paid && (
          <>
            <p className="muted" style={{ marginTop: '1rem' }}>
              “Check again” looks for a confirmation we may already have received. “Ask GCash”
              contacts GCash itself — use that one if the wait is taking too long.
            </p>
            <div className="row-actions" style={{ marginTop: '8px' }}>
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
              {/* Deliberately a SEPARATE action from "Check again", not a
                  replacement. That one re-reads our own record and is right for
                  the normal case, where the webhook is seconds away. This one
                  asks GCash — the helper line above now carries the "directly"
                  that used to be in this label, so it only has to name the
                  other system.

                  The seconds are padded with a figure space (U+2007, the width
                  of a digit) so the button does not change width when the
                  countdown ticks from 10 to 9. */}
              <button
                className="btn secondary"
                onClick={askGcash}
                disabled={recheckBusy || cooldown > 0}
              >
                {recheckBusy
                  ? 'Asking GCash…'
                  : cooldown > 0
                    ? `Ask GCash (${String(cooldown).padStart(2, ' ')}s)`
                    : 'Ask GCash'}
              </button>
            </div>
          </>
        )}

        <div className="row-actions" style={{ marginTop: '1rem' }}>
          <Link className="button-link inline" to="/resident">
            Back to my requests
          </Link>
          <Link className="button-link inline" to="/resident/rentals">
            My rentals
          </Link>
        </div>
      </main>
    </div>
  );
}
