import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { RESIDENT_NAV } from '../constants/nav';
import { ITEM_TYPE_LABELS, formatSchedule, rentalMeta } from '../constants/rentals';

const EMPTY_FORM = { item_id: '', date: '', start_time: '', end_time: '', quantity: '1', purpose: '' };

export default function BookRentalPage() {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState(null); // confirmed booking

  const loadItems = useCallback(async () => {
    setLoadError('');
    try {
      const data = await authFetch('/rental-items');
      setItems(data.rental_items);
    } catch (err) {
      setLoadError(err.message);
      setItems([]);
    }
  }, [authFetch]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const selectedItem = items?.find((i) => String(i.item_id) === String(form.item_id));
  const isCountable = selectedItem && selectedItem.quantity_total > 1;
  const quantity = isCountable ? Number(form.quantity) || 0 : 1;
  const estimatedFee = selectedItem ? Number(selectedItem.fee) * quantity : 0;

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === 'item_id') next.quantity = '1'; // reset when switching items
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await authFetch('/rental-requests', {
        method: 'POST',
        body: {
          item_id: Number(form.item_id),
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          quantity_requested: quantity,
          purpose: form.purpose,
        },
      });
      setBooked(data.request);
      setForm({ ...EMPTY_FORM });
    } catch (err) {
      setError(err.message); // conflict reasons surface here — pick another slot
    } finally {
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const meta = booked ? rentalMeta(booked.status) : null;

  return (
    <div className="dash">
      <DashHeader
        title="BrgyServe — Resident"
        subtitle="Book a barangay facility or item"
        nav={RESIDENT_NAV}
      />

      <main className="dash-main">
        {booked ? (
          <div className="pending-card section-card">
            <h3>Booking confirmed</h3>
            <div className="alert success">
              Your slot is reserved — no further approval is needed. Please settle the fee with
              the barangay.
            </div>
            <dl className="info-grid">
              <div>
                <dt>Item</dt>
                <dd>{booked.rental_items?.name}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${meta.className}`}>{meta.label}</span>
                </dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>{formatSchedule(booked.start_datetime, booked.end_datetime)}</dd>
              </div>
              <div>
                <dt>Quantity</dt>
                <dd>{booked.quantity_requested}</dd>
              </div>
              <div>
                <dt>Fee</dt>
                <dd>
                  ₱{(Number(booked.rental_items?.fee ?? 0) * booked.quantity_requested).toFixed(2)}
                </dd>
              </div>
              <div className="span-2">
                <dt>Purpose</dt>
                <dd>{booked.purpose}</dd>
              </div>
            </dl>
            <div className="actions">
              <Link className="button-link inline" to="/resident/rentals">
                View my rentals
              </Link>
              <button className="btn secondary" onClick={() => setBooked(null)}>
                Book another
              </button>
            </div>
          </div>
        ) : (
          <form className="pending-card section-card" onSubmit={handleSubmit}>
            <h3>Book a facility or item</h3>
            {loadError && <div className="alert error">{loadError}</div>}
            {error && <div className="alert error">{error}</div>}

            {items === null ? (
              <p className="muted">Loading rental items…</p>
            ) : items.length === 0 ? (
              <p className="muted">Nothing is currently available for rental.</p>
            ) : (
              <>
                <label>
                  Facility / item
                  <select name="item_id" value={form.item_id} onChange={handleChange} required>
                    <option value="" disabled>
                      Select an item…
                    </option>
                    {items.map((i) => (
                      <option key={i.item_id} value={i.item_id}>
                        {i.name} ({ITEM_TYPE_LABELS[i.type] || i.type}) — ₱
                        {Number(i.fee).toFixed(2)}
                        {i.quantity_total > 1 ? ` per unit · ${i.quantity_total} units` : ' per booking'}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedItem?.description && (
                  <p className="muted type-description">{selectedItem.description}</p>
                )}

                <div className="grid-2">
                  <label>
                    Date
                    <input
                      name="date"
                      type="date"
                      min={today}
                      value={form.date}
                      onChange={handleChange}
                      required
                    />
                  </label>
                  {isCountable && (
                    <label>
                      Quantity <span className="hint">(up to {selectedItem.quantity_total})</span>
                      <input
                        name="quantity"
                        type="number"
                        min="1"
                        max={selectedItem.quantity_total}
                        step="1"
                        value={form.quantity}
                        onChange={handleChange}
                        required
                      />
                    </label>
                  )}
                  <label>
                    Start time
                    <input
                      name="start_time"
                      type="time"
                      value={form.start_time}
                      onChange={handleChange}
                      required
                    />
                  </label>
                  <label>
                    End time
                    <input
                      name="end_time"
                      type="time"
                      value={form.end_time}
                      onChange={handleChange}
                      required
                    />
                  </label>
                </div>

                <label>
                  Purpose
                  <textarea
                    name="purpose"
                    value={form.purpose}
                    onChange={handleChange}
                    rows={3}
                    maxLength={1000}
                    placeholder="e.g. Birthday party, basketball league practice, family reunion…"
                    required
                  />
                </label>

                {selectedItem && (
                  <p className="muted">
                    Estimated fee:{' '}
                    <strong>₱{estimatedFee.toFixed(2)}</strong>
                    {isCountable && quantity > 0 && (
                      <> ({quantity} × ₱{Number(selectedItem.fee).toFixed(2)})</>
                    )}
                  </p>
                )}

                <div className="actions">
                  <button className="btn" type="submit" disabled={busy}>
                    {busy ? 'Checking availability…' : 'Book now'}
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
