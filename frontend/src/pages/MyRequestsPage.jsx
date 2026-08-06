import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { statusMeta, chargeMeta, chargeOf, formatDate } from '../constants/requestStatus';

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

  const [payTarget, setPayTarget] = useState(null); // request_id entering a GCash ref
  const [gcashRef, setGcashRef] = useState('');

  async function handleDeclare(r, method, reference) {
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(`/document-requests/mine/${r.request_id}/pay`, {
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

  // Gateway payment: PayMongo hosts the payment page, so we hand the resident
  // over to it. Nothing is marked paid here — the signed webhook is the only
  // thing that can do that.
  async function handlePayOnline(r, charge) {
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch('/payments/gcash/checkout', {
        method: 'POST',
        body: { charge_id: charge.charge_id },
      });
      window.location.href = data.checkout_url;
    } catch (err) {
      // A refused checkout often means the charge just changed underneath us —
      // most importantly the resume interlock discovering it is already paid —
      // so reload rather than leave a stale row next to the message.
      setFlash({ type: 'error', text: err.message });
      setBusyId(null);
      await load();
    }
  }

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
                    <th className="col-purpose">Purpose</th>
                    <th className="num">Fee</th>
                    <th>Status</th>
                    <th>Submitted</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const meta = statusMeta(r.status);
                    const charge = chargeOf(r);
                    return (
                      <tr key={r.request_id}>
                        <td>
                          <strong>{r.document_types?.name || '—'}</strong>
                        </td>
                        <td className="muted col-purpose">
                          <span className="cell-clamp">{r.purpose}</span>
                        </td>
                        <td className="num">₱{Number(r.document_types?.fee ?? 0).toFixed(2)}</td>
                        <td>
                          <span className={`badge ${meta.className}`}>{meta.label}</span>
                          {r.status === 'rejected' && r.rejection_reason && (
                            <div className="muted reason-note">Reason: {r.rejection_reason}</div>
                          )}
                          {r.status === 'ready_for_release' && (
                            <div className="muted reason-note">
                              Ready to claim — pick it up at the barangay hall during office hours.
                            </div>
                          )}
                          {r.status === 'claimed' && r.claimed_at && (
                            <div className="muted reason-note">Claimed on {formatDate(r.claimed_at)}.</div>
                          )}
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
                          {r.status === 'approved' &&
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
                                  className="btn"
                                  disabled={busyId === r.request_id}
                                  onClick={() => handlePayOnline(r, charge)}
                                >
                                  {busyId === r.request_id ? 'Opening GCash…' : 'Pay online via GCash'}
                                </button>
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
                                  I already paid via GCash
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
