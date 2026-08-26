import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { SECRETARY_NAV } from '../constants/nav';
import { ITEM_TYPE_LABELS as TYPE_LABELS } from '../constants/rentals';

// Facilities are whole venues booked as one unit, so quantity locks to 1.

const EMPTY_FORM = { item_id: null, name: '', type: 'facility', description: '', quantity_total: '1', fee: '' };

export default function RentalItemsPage() {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading
  const [listError, setListError] = useState('');
  const [flash, setFlash] = useState(null);
  const [form, setForm] = useState(null); // null = closed; object = create/edit form
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setListError('');
    try {
      const data = await authFetch('/rental-items/all');
      setItems(data.rental_items);
    } catch (err) {
      setListError(err.message);
      setItems([]);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setFormError('');
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(item) {
    setFormError('');
    setForm({
      item_id: item.item_id,
      name: item.name,
      type: item.type,
      description: item.description || '',
      quantity_total: String(item.quantity_total),
      fee: String(item.fee),
    });
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => {
      const next = { ...f, [name]: value };
      // facilities are single-unit — lock the quantity
      if (name === 'type' && value === 'facility') next.quantity_total = '1';
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    setBusy(true);
    try {
      const body = {
        name: form.name,
        type: form.type,
        description: form.description,
        quantity_total: Number(form.quantity_total),
        fee: form.fee,
      };
      const data = form.item_id
        ? await authFetch(`/rental-items/${form.item_id}`, { method: 'PUT', body })
        : await authFetch('/rental-items', { method: 'POST', body });
      setFlash({ type: 'success', text: data.message });
      setForm(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(item) {
    setFlash(null);
    setBusy(true);
    try {
      const action = item.is_active ? 'deactivate' : 'activate';
      const data = await authFetch(`/rental-items/${item.item_id}/${action}`, { method: 'POST' });
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
            {items === null
              ? 'Rental items'
              : `${items.length} rental item${items.length === 1 ? '' : 's'}`}
          </h2>
          <div className="head-actions">
            <button className="btn secondary" onClick={load}>
              Refresh
            </button>
            <button className="btn" onClick={openCreate}>
              New rental item
            </button>
          </div>
        </div>

        {form && (
          <form className="pending-card section-card" onSubmit={handleSubmit}>
            <h3>{form.item_id ? 'Edit rental item' : 'New rental item'}</h3>
            {formError && <div className="alert error">{formError}</div>}
            <div className="grid-2">
              <label>
                Name
                <input name="name" value={form.name} onChange={handleChange} maxLength={100} required />
              </label>
              <label>
                Type
                <select name="type" value={form.type} onChange={handleChange}>
                  {Object.entries(TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Quantity{' '}
                {form.type === 'facility' && <span className="hint">(facilities are single-unit)</span>}
                <input
                  name="quantity_total"
                  type="number"
                  min="1"
                  step="1"
                  value={form.quantity_total}
                  onChange={handleChange}
                  disabled={form.type === 'facility'}
                  required
                />
              </label>
              <label>
                Fee (PHP) <span className="hint">(per unit per booking)</span>
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
                {busy ? 'Saving…' : form.item_id ? 'Save changes' : 'Create'}
              </button>
              <button className="btn secondary" type="button" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {items === null ? (
          <p className="muted">Loading rental items…</p>
        ) : items.length === 0 ? (
          <div className="empty">
            <p>
              No rental items yet. Create one above, or run
              backend/seeds/sample_rental_items.sql for starter items.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="num">Quantity</th>
                  <th className="num">Fee</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.item_id} className={item.is_active ? '' : 'inactive-row'}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>{TYPE_LABELS[item.type] || item.type}</td>
                    <td className="muted">{item.description || '—'}</td>
                    <td className="num">{item.quantity_total}</td>
                    <td className="num">₱{Number(item.fee).toFixed(2)}</td>
                    <td>
                      {item.is_active ? (
                        <span className="badge">Active</span>
                      ) : (
                        <span className="badge gray">Inactive</span>
                      )}
                    </td>
                    <td className="row-actions">
                      <button className="btn secondary" disabled={busy} onClick={() => openEdit(item)}>
                        Edit
                      </button>
                      <button
                        className={`btn secondary${item.is_active ? ' danger' : ''}`}
                        disabled={busy}
                        onClick={() => toggleActive(item)}
                      >
                        {item.is_active ? 'Deactivate' : 'Reactivate'}
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
