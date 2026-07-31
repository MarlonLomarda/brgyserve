import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { chargeMeta, CHARGE_TYPE_LABELS, formatDate, METHOD_LABELS } from '../constants/requestStatus';
import { formatSchedule } from '../constants/rentals';

// Payment verification queue for ALL charge types (document fees since stage
// 4b, rental fees since Facility Rentals stage 4). Used by BOTH the Treasurer
// (their landing page) and the Secretary (a Payments tab) — pass the role's
// title and nav.
const FILTERS = ['UNPAID', 'PAID', 'VOID', 'all'];
const FILTER_LABELS = { UNPAID: 'Needs verification', PAID: 'Paid', VOID: 'Void', all: 'All charges' };

function fullName(p) {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
  if (!name) return null;
  return p.suffix ? `${name}, ${p.suffix}` : name;
}

function payerName(charge) {
  // Document charges carry the verified resident record; rental (and future
  // fine) charges fall back to the payer account's profile name.
  const name = fullName(charge.document_requests?.resident_records) || fullName(charge.payer?.profiles);
  if (name) return name;
  return charge.payer?.username ? `@${charge.payer.username}` : '—';
}

// What the charge is for, per type.
function chargeSubject(charge) {
  if (charge.rental_requests) {
    return {
      main: `${charge.rental_requests.rental_items?.name || 'Rental'}${charge.rental_requests.quantity_requested > 1 ? ` × ${charge.rental_requests.quantity_requested}` : ''}`,
      note: formatSchedule(charge.rental_requests.start_datetime, charge.rental_requests.end_datetime),
    };
  }
  return {
    main: charge.document_requests?.document_types?.name || charge.charge_type,
    note: null,
  };
}

function declaredInfo(c) {
  // A charge paid through the GCash gateway was never "declared" — it arrived
  // already confirmed, so say so rather than showing a blank cell.
  if (c.paymongo_payment_id) return `GCash online · ${c.paymongo_payment_id}`;
  if (c.paymongo_session_id && c.status === 'UNPAID') return 'GCash online — started, not yet confirmed';
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
            {payerName(charge)} · {CHARGE_TYPE_LABELS[charge.charge_type] || charge.charge_type}:{' '}
            {chargeSubject(charge).main}
            {chargeSubject(charge).note && <> · {chargeSubject(charge).note}</>}
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
  const [recheckingId, setRecheckingId] = useState(null);

  // Safety net for the GCash gateway: PayMongo disables a webhook endpoint
  // after repeated delivery failures and never replays what was missed, so a
  // payment can be genuinely made yet never confirmed here. This asks PayMongo
  // directly and settles the charge through the same server-side path the
  // webhook uses — so it can never double-record.
  async function handleRecheck(c) {
    setFlash(null);
    setRecheckingId(c.charge_id);
    try {
      const data = await authFetch(`/payments/gcash/reconcile/${c.charge_id}`, { method: 'POST' });
      setFlash({ type: data.settled ? 'success' : 'error', text: data.message });
      if (data.settled) await load();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setRecheckingId(null);
    }
  }

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
                      <th>Type</th>
                      <th>For</th>
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
                        <td>{CHARGE_TYPE_LABELS[c.charge_type] || c.charge_type}</td>
                        <td>
                          {chargeSubject(c).main}
                          {chargeSubject(c).note && (
                            <div className="muted small-note">{chargeSubject(c).note}</div>
                          )}
                        </td>
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
                          {c.status === 'UNPAID' && c.paymongo_session_id && (
                            <button
                              className="btn secondary"
                              disabled={recheckingId === c.charge_id}
                              onClick={() => handleRecheck(c)}
                              title="Ask PayMongo whether this online payment went through"
                            >
                              {recheckingId === c.charge_id ? 'Checking…' : 'Re-check with PayMongo'}
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
