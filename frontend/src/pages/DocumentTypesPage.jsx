import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { SECRETARY_NAV } from '../constants/nav';

const EMPTY_FORM = { document_type_id: null, name: '', description: '', fee: '' };

export default function DocumentTypesPage() {
  const { authFetch } = useAuth();
  const [types, setTypes] = useState(null); // null = loading
  const [listError, setListError] = useState('');
  const [flash, setFlash] = useState(null);
  const [form, setForm] = useState(null); // null = closed; object = create/edit form
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setListError('');
    try {
      const data = await authFetch('/document-types/all');
      setTypes(data.document_types);
    } catch (err) {
      setListError(err.message);
      setTypes([]);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setFormError('');
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(t) {
    setFormError('');
    setForm({
      document_type_id: t.document_type_id,
      name: t.name,
      description: t.description || '',
      fee: String(t.fee),
    });
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    setBusy(true);
    try {
      const body = { name: form.name, description: form.description, fee: form.fee };
      const data = form.document_type_id
        ? await authFetch(`/document-types/${form.document_type_id}`, { method: 'PUT', body })
        : await authFetch('/document-types', { method: 'POST', body });
      setFlash({ type: 'success', text: data.message });
      setForm(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(t) {
    setFlash(null);
    setBusy(true);
    try {
      const action = t.is_active ? 'deactivate' : 'activate';
      const data = await authFetch(`/document-types/${t.document_type_id}/${action}`, {
        method: 'POST',
      });
      setFlash({ type: 'success', text: data.message });
      await load();
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dash">
    

      <main className="dash-main">
        {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
        {listError && <div className="alert error">{listError}</div>}

        <div className="list-head">
          <h2>
            {types === null
              ? 'Document types'
              : `${types.length} document type${types.length === 1 ? '' : 's'}`}
          </h2>
          <div className="head-actions">
            <button className="btn secondary" onClick={load}>
              Refresh
            </button>
            <button className="btn" onClick={openCreate}>
              New document type
            </button>
          </div>
        </div>

        {form && (
          <form className="pending-card section-card" onSubmit={handleSubmit}>
            <h3>{form.document_type_id ? 'Edit document type' : 'New document type'}</h3>
            {formError && <div className="alert error">{formError}</div>}
            <div className="grid-2">
              <label>
                Name
                <input name="name" value={form.name} onChange={handleChange} maxLength={100} required />
              </label>
              <label>
                Fee (PHP)
                <input
                  name="fee"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.fee}
                  onChange={handleChange}
                  required
                />
              </label>
            </div>
            <label>
              Description <span className="hint">(optional)</span>
              <textarea name="description" value={form.description} onChange={handleChange} rows={3} />
            </label>
            <div className="actions">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? 'Saving…' : form.document_type_id ? 'Save changes' : 'Create'}
              </button>
              <button className="btn secondary" type="button" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {types === null ? (
          <p className="muted">Loading document types…</p>
        ) : types.length === 0 ? (
          <div className="empty">
            <p>
              No document types yet. Create one above, or run
              backend/seeds/sample_document_types.sql for starter types.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th className="num">Fee</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.document_type_id} className={t.is_active ? '' : 'inactive-row'}>
                    <td>
                      <strong>{t.name}</strong>
                    </td>
                    <td className="muted">{t.description || '—'}</td>
                    <td className="num">₱{Number(t.fee).toFixed(2)}</td>
                    <td>
                      {t.is_active ? (
                        <span className="badge">Active</span>
                      ) : (
                        <span className="badge gray">Inactive</span>
                      )}
                    </td>
                    <td className="row-actions">
                      <button className="btn secondary" disabled={busy} onClick={() => openEdit(t)}>
                        Edit
                      </button>
                      <button
                        className={`btn secondary${t.is_active ? ' danger' : ''}`}
                        disabled={busy}
                        onClick={() => toggleActive(t)}
                      >
                        {t.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
