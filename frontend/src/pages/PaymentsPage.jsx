import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { chargeMeta, formatDate, METHOD_LABELS } from '../constants/requestStatus';

// Payment verification queue. Used by BOTH the Treasurer (their landing page)
// and the Secretary (a Payments tab) — pass the role's title and nav.
const FILTERS = ['UNPAID', 'PAID', 'all'];
const FILTER_LABELS = { UNPAID: 'Needs verification', PAID: 'Paid', all: 'All charges' };

function payerName(charge) {
  const res = charge.document_requests?.resident_records;
  if (res) {
    const name = [res.first_name, res.middle_name, res.last_name].filter(Boolean).join(' ');
    return res.suffix ? `${name}, ${res.suffix}` : name;
  }
  return charge.payer?.username ? `@${charge.payer.username}` : '—';
}

function declaredInfo(c) {
  if (!c.declared_method) return null;
  const label = METHOD_LABELS[c.declared_method] || c.declared_method;
  return c.declared_method === 'gcash' && c.declared_reference
    ? `${label} · ref ${c.declared_reference}`
    : label;
}

function VerifyPanel({ charge, onDone }) {
  const { authFetch } = useAuth();
  const [method, setMethod] = useState(charge.declared_method || 'onsite');
  const [reference, setReference] = useState(charge.declared_reference || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await authFetch(`/charges/${charge.charge_id}/verify`, {
        method: 'POST',
        body: { payment_method: method, reference_no: reference.trim() || undefined },
      });
      onDone({ type: 'success', text: `${data.message} (payment #${data.payment.payment_id})` });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Verify payment — charge #{charge.charge_id}</h3>
          <p className="muted">
            {payerName(charge)} · {charge.document_requests?.document_types?.name || charge.charge_type}
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <dl className="info-grid">
        <div>
          <dt>Amount</dt>
          <dd>
            <strong>₱{Number(charge.amount).toFixed(2)}</strong>
          </dd>
        </div>
        <div>
          <dt>Billed</dt>
          <dd>{formatDate(charge.created_at)}</dd>
        </div>
        <div className="span-2">
          <dt>Resident declared</dt>
          <dd>
            {declaredInfo(charge) || <span className="muted">nothing yet (walk-in)</span>}
            {charge.declared_at && (
              <span className="muted"> — {formatDate(charge.declared_at)}</span>
            )}
          </dd>
        </div>
      </dl>

      <form onSubmit={handleSubmit}>
        <div className="grid-2">
          <label>
            Payment method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="onsite">Onsite (cash)</option>
              <option value="gcash">GCash</option>
            </select>
          </label>
          <label>
            Reference no. {method !== 'gcash' && <span className="hint">(optional — e.g. OR number)</span>}
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={100}
              required={method === 'gcash'}
              placeholder={method === 'gcash' ? 'GCash reference number' : 'Official receipt no.'}
            />
          </label>
        </div>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Recording…' : `Record payment of ₱${Number(charge.amount).toFixed(2)}`}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function PaymentsPage({ title, nav }) {
  const { authFetch } = useAuth();
  const [filter, setFilter] = useState('UNPAID');
  const [charges, setCharges] = useState(null); // null = loading
  const [listError, setListError] = useState('');
  const [flash, setFlash] = useState(null);
  const [selected, setSelected] = useState(null); // charge being verified

  const load = useCallback(async () => {
    setListError('');
    try {
      const data = await authFetch(`/charges?status=${filter}`);
      setCharges(data.charges);
    } catch (err) {
      setListError(err.message);
      setCharges([]);
    }
  }, [authFetch, filter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="dash">
      <DashHeader title={title} subtitle="Record and verify payments" nav={nav} />

      <main className="dash-main">
        {selected ? (
          <VerifyPanel
            charge={selected}
            onDone={(result) => {
              setSelected(null);
              if (result) {
                setFlash(result);
                load();
              }
            }}
          />
        ) : (
          <>
            {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
            {listError && <div className="alert error">{listError}</div>}

            <div className="list-head">
              <h2>
                {charges === null
                  ? 'Charges'
                  : `${charges.length} charge${charges.length === 1 ? '' : 's'}`}
              </h2>
              <div className="head-actions">
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {FILTER_LABELS[f]}
                    </option>
                  ))}
                </select>
                <button className="btn secondary" onClick={load}>
                  Refresh
                </button>
              </div>
            </div>

            {charges === null ? (
              <p className="muted">Loading charges…</p>
            ) : charges.length === 0 ? (
              <div className="empty">
                <p>No charges {filter === 'UNPAID' ? 'awaiting verification' : 'here'}.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Resident</th>
                      <th>Document</th>
                      <th className="num">Amount</th>
                      <th>Declared payment</th>
                      <th>Status</th>
                      <th>Billed</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {charges.map((c) => (
                      <tr key={c.charge_id}>
                        <td>
                          <strong>{payerName(c)}</strong>
                          {c.payer?.username && (
                            <div className="muted small-note">@{c.payer.username}</div>
                          )}
                        </td>
                        <td>{c.document_requests?.document_types?.name || c.charge_type}</td>
                        <td className="num">₱{Number(c.amount).toFixed(2)}</td>
                        <td className="muted">{declaredInfo(c) || '—'}</td>
                        <td>
                          <span className={`badge ${chargeMeta(c.status).className}`}>
                            {chargeMeta(c.status).label}
                          </span>
                        </td>
                        <td className="muted">{formatDate(c.created_at)}</td>
                        <td className="row-actions">
                          {c.status === 'UNPAID' && (
                            <button className="btn secondary" onClick={() => setSelected(c)}>
                              Verify / record
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
