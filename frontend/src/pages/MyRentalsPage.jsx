import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { formatSchedule, rentalMeta } from '../constants/rentals';

export default function MyRentalsPage() {
  const { authFetch } = useAuth();
  const [requests, setRequests] = useState(null); // null = loading
  const [error, setError] = useState('');

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

  return (
    <div className="dash">
      <DashHeader
        title="BrgyServe — Resident"
        subtitle="Your facility and item bookings"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
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
                    <th className="num">Fee</th>
                    <th>Purpose</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const meta = rentalMeta(r.status);
                    return (
                      <tr key={r.request_id}>
                        <td>
                          <strong>{r.rental_items?.name || '—'}</strong>
                        </td>
                        <td>{formatSchedule(r.start_datetime, r.end_datetime)}</td>
                        <td className="num">{r.quantity_requested}</td>
                        <td className="num">
                          ₱{(Number(r.rental_items?.fee ?? 0) * r.quantity_requested).toFixed(2)}
                        </td>
                        <td className="muted">{r.purpose}</td>
                        <td>
                          <span className={`badge ${meta.className}`}>{meta.label}</span>
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
