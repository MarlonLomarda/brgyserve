import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { statusMeta, formatDate } from '../constants/requestStatus';

export default function RequestDocumentPage() {
  const { authFetch } = useAuth();
  const [types, setTypes] = useState(null); // null = loading
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ document_type_id: '', purpose: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(null); // created request

  const loadTypes = useCallback(async () => {
    setLoadError('');
    try {
      const data = await authFetch('/document-types');
      setTypes(data.document_types);
    } catch (err) {
      setLoadError(err.message);
      setTypes([]);
    }
  }, [authFetch]);

  useEffect(() => {
    loadTypes();
  }, [loadTypes]);

  const selectedType = types?.find(
    (t) => String(t.document_type_id) === String(form.document_type_id)
  );

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await authFetch('/document-requests', {
        method: 'POST',
        body: { document_type_id: Number(form.document_type_id), purpose: form.purpose },
      });
      setSubmitted(data.request);
      setForm({ document_type_id: '', purpose: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const meta = submitted ? statusMeta(submitted.status) : null;

  return (
    <div className="dash">
      <DashHeader
        title="Request a document"
        subtitle="Request an official barangay document"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
        {submitted ? (
          <div className="pending-card section-card">
            <h3>Request submitted</h3>
            <div className="alert success">
              Your request is now with the barangay. You can track its status under My
              Requests.
            </div>
            <dl className="info-grid">
              <div>
                <dt>Document</dt>
                <dd>{submitted.document_types?.name}</dd>
              </div>
              <div>
                <dt>Fee</dt>
                <dd>₱{Number(submitted.document_types?.fee ?? 0).toFixed(2)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${meta.className}`}>{meta.label}</span>
                </dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{formatDate(submitted.requested_at)}</dd>
              </div>
              <div className="span-2">
                <dt>Purpose</dt>
                <dd>{submitted.purpose}</dd>
              </div>
            </dl>
            <div className="actions">
              <Link className="button-link inline" to="/resident">
                View my requests
              </Link>
              <button className="btn secondary" onClick={() => setSubmitted(null)}>
                Request another document
              </button>
            </div>
          </div>
        ) : (
          <form className="pending-card section-card" onSubmit={handleSubmit}>
            <h3>Request a document</h3>
            {loadError && <div className="alert error">{loadError}</div>}
            {error && <div className="alert error">{error}</div>}

            {types === null ? (
              <p className="muted">Loading document types…</p>
            ) : types.length === 0 ? (
              <p className="muted">No document types are currently offered.</p>
            ) : (
              <>
                <label>
                  Document type
                  <select
                    name="document_type_id"
                    value={form.document_type_id}
                    onChange={handleChange}
                    required
                  >
                    <option value="" disabled>
                      Select a document…
                    </option>
                    {types.map((t) => (
                      <option key={t.document_type_id} value={t.document_type_id}>
                        {t.name} — ₱{Number(t.fee).toFixed(2)}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedType?.description && (
                  <p className="muted type-description">{selectedType.description}</p>
                )}
                <label>
                  Purpose
                  <textarea
                    name="purpose"
                    value={form.purpose}
                    onChange={handleChange}
                    rows={3}
                    maxLength={1000}
                    placeholder="e.g. Employment requirement, scholarship application…"
                    required
                  />
                </label>
                <div className="actions">
                  <button className="btn" type="submit" disabled={busy}>
                    {busy ? 'Submitting…' : 'Submit request'}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </main>
    </div>
  );
}
