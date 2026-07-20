import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { chargeMeta, chargeOf } from '../constants/requestStatus';
import { formatSchedule, rentalMeta } from '../constants/rentals';

export default function MyRentalsPage() {
  const { authFetch } = useAuth();
  const [requests, setRequests] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [payTarget, setPayTarget] = useState(null); // request_id entering a GCash ref
  const [gcashRef, setGcashRef] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch('/rental-requests/mine');
      setRequests(data.requests);
    } catch (err) {
      setError(err.message);
      setRequests([]);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDeclare(r, method, reference) {
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(`/rental-requests/mine/${r.request_id}/pay`, {
        method: 'POST',
        body: { method, reference_no: reference },
      });
      setFlash({ type: 'success', text: data.message });
      setPayTarget(null);
      setGcashRef('');
      await load();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dash">
      <DashHeader
        title="BrgyServe — Resident"
        subtitle="Your facility and item bookings"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
        {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
        {error && <div className="alert error">{error}</div>}

        {requests === null ? (
          <p className="muted">Loading your bookings…</p>
        ) : requests.length === 0 ? (
          <div className="empty">
            <p>You haven&apos;t booked anything yet.</p>
            <Link className="button-link inline" to="/resident/book-rental">
              Book a facility
            </Link>
          </div>
        ) : (
          <>
            <div className="list-head">
              <h2>
                {requests.length} booking{requests.length === 1 ? '' : 's'}
              </h2>
              <button className="btn secondary" onClick={load}>
                Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Schedule</th>
                    <th className="num">Qty</th>
                    <th>Purpose</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const meta = rentalMeta(r.status);
                    const charge = chargeOf(r);
                    return (
                      <tr key={r.request_id}>
                        <td>
                          <strong>{r.rental_items?.name || '—'}</strong>
                        </td>
                        <td>{formatSchedule(r.start_datetime, r.end_datetime)}</td>
                        <td className="num">{r.quantity_requested}</td>
                        <td className="muted">{r.purpose}</td>
                        <td>
                          <span className={`badge ${meta.className}`}>{meta.label}</span>
                          {charge && (
                            <div className="muted reason-note">
                              Amount due: ₱{Number(charge.amount).toFixed(2)} —{' '}
                              <strong className={`charge-word ${chargeMeta(charge.status).className}`}>
                                {chargeMeta(charge.status).label}
                              </strong>
                              {charge.status === 'UNPAID' && charge.declared_method === 'gcash' && (
                                <> · GCash ref {charge.declared_reference} submitted, awaiting verification</>
                              )}
                              {charge.status === 'UNPAID' && charge.declared_method === 'onsite' && (
                                <> · pay in cash at the barangay hall treasurer&apos;s desk</>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="row-actions">
                          {r.status === 'confirmed' &&
                            charge?.status === 'UNPAID' &&
                            (payTarget === r.request_id ? (
                              <form
                                className="inline-form"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleDeclare(r, 'gcash', gcashRef.trim());
                                }}
                              >
                                <input
                                  value={gcashRef}
                                  onChange={(e) => setGcashRef(e.target.value)}
                                  placeholder="GCash reference no."
                                  maxLength={100}
                                  required
                                  autoFocus
                                />
                                <button
                                  className="btn secondary"
                                  type="submit"
                                  disabled={busyId === r.request_id}
                                >
                                  Submit
                                </button>
                                <button
                                  className="btn secondary"
                                  type="button"
                                  onClick={() => setPayTarget(null)}
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <>
                                <button
                                  className="btn secondary"
                                  disabled={busyId === r.request_id}
                                  onClick={() => handleDeclare(r, 'onsite')}
                                >
                                  Pay onsite
                                </button>
                                <button
                                  className="btn secondary"
                                  disabled={busyId === r.request_id}
                                  onClick={() => {
                                    setPayTarget(r.request_id);
                                    setGcashRef('');
                                  }}
                                >
                                  Pay via GCash
                                </button>
                              </>
                            ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
