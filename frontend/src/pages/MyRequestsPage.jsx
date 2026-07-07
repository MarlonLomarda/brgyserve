import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { statusMeta, formatDate } from '../constants/requestStatus';

export default function MyRequestsPage() {
  const { authFetch } = useAuth();
  const [requests, setRequests] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch('/document-requests/mine');
      setRequests(data.requests);
    } catch (err) {
      setError(err.message);
      setRequests([]);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCancel(r) {
    const name = r.document_types?.name || 'document';
    if (!window.confirm(`Cancel your ${name} request? This cannot be undone — submit a new request if you still need the document.`)) {
      return;
    }
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(`/document-requests/mine/${r.request_id}/cancel`, {
        method: 'POST',
      });
      setFlash({ type: 'success', text: data.message });
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
        subtitle="Track your barangay document requests"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
        {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
        {error && <div className="alert error">{error}</div>}

        {requests === null ? (
          <p className="muted">Loading your requests…</p>
        ) : requests.length === 0 ? (
          <div className="empty">
            <p>You haven&apos;t requested any documents yet.</p>
            <Link className="button-link inline" to="/resident/request">
              Request a document
            </Link>
          </div>
        ) : (
          <>
            <div className="list-head">
              <h2>
                {requests.length} request{requests.length === 1 ? '' : 's'}
              </h2>
              <button className="btn secondary" onClick={load}>
                Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Purpose</th>
                    <th className="num">Fee</th>
                    <th>Status</th>
                    <th>Submitted</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const meta = statusMeta(r.status);
                    return (
                      <tr key={r.request_id}>
                        <td>
                          <strong>{r.document_types?.name || '—'}</strong>
                        </td>
                        <td className="muted">{r.purpose}</td>
                        <td className="num">₱{Number(r.document_types?.fee ?? 0).toFixed(2)}</td>
                        <td>
                          <span className={`badge ${meta.className}`}>{meta.label}</span>
                          {r.status === 'rejected' && r.rejection_reason && (
                            <div className="muted reason-note">Reason: {r.rejection_reason}</div>
                          )}
                        </td>
                        <td className="muted">{formatDate(r.requested_at)}</td>
                        <td className="row-actions">
                          {r.status === 'pending' && (
                            <button
                              className="btn secondary danger"
                              disabled={busyId === r.request_id}
                              onClick={() => handleCancel(r)}
                            >
                              {busyId === r.request_id ? 'Cancelling…' : 'Cancel'}
                            </button>
                          )}
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
