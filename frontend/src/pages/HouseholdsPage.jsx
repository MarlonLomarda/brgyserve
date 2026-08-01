import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import ResidentPicker from '../components/ResidentPicker';
import { SECRETARY_NAV } from '../constants/nav';
import { formatDate } from '../constants/requestStatus';

// Households module, stage 1: browse + search the household list, and create a
// household by naming its HEAD. Households are identified by their head, not
// their address — two households may legitimately share one address.
//
// Member add/remove is stage 2, so there are deliberately no controls for it.

const ACTIVE_FILTERS = [
  { value: 'true', label: 'Active households' },
  { value: 'false', label: 'Inactive households' },
  { value: 'all', label: 'All households' },
];

function ageFrom(birthdate) {
  if (!birthdate) return '—';
  const born = new Date(`${birthdate}T00:00:00+08:00`);
  if (Number.isNaN(born.getTime())) return '—';
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
  return age >= 0 ? String(age) : '—';
}

const dateOnly = (value) => (value ? new Date(`${value}T00:00:00+08:00`).toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—');

// "Nothing registered yet" is only true when no household exists AT ALL, which
// is why the list reports total_all alongside the filtered total: an empty
// Inactive view must not claim the barangay has no households.
const isTrulyEmpty = (search, active, totalAll) => !search && active === 'true' && totalAll === 0;

function emptyMessage(search, active, totalAll) {
  if (search) return 'No households match that search.';
  if (isTrulyEmpty(search, active, totalAll)) return 'No households have been registered yet.';
  if (active === 'true') return 'No active households.';
  if (active === 'false') return 'No inactive households.';
  return 'No households found.';
}

// --- create ---------------------------------------------------------------
function CreateHouseholdModal({ onClose, onCreated }) {
  const { authFetch } = useAuth();
  const [head, setHead] = useState(null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null); // { household_id, head_name }
  const [busy, setBusy] = useState(false);

  function pickHead(resident) {
    setHead(resident);
    setError('');
    setConflict(null);
    // The head's own address is the household's address in almost every case;
    // still editable, because the household may be registered elsewhere.
    if (resident.address) setAddress(resident.address);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setConflict(null);
    setBusy(true);
    try {
      const data = await authFetch('/households', {
        method: 'POST',
        body: { address: address.trim(), head_resident_id: head.resident_id },
      });
      onCreated(data);
    } catch (err) {
      setError(err.message);
      // A 409 carries the household the resident already belongs to.
      if (err.status === 409 && err.data?.household_id) setConflict(err.data);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="list-head">
          <h2>New household</h2>
          <button className="btn secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <div className="alert error">
            {error}
            {conflict && (
              <div className="reason-note">
                Open household #{conflict.household_id}
                {conflict.head_name && !conflict.head_is_self
                  ? ` (household of ${conflict.head_name})`
                  : ''}{' '}
                to review that membership first.
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label>
            Household head
            <span className="hint"> — the household is identified by this person</span>
          </label>
          <ResidentPicker
            value={head}
            onPick={pickHead}
            onClear={() => setHead(null)}
            placeholder="Search residents by name…"
          />

          <label style={{ marginTop: 14, display: 'block' }}>
            Address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={255}
              placeholder="Purok, street, barangay"
              required
            />
          </label>
          <p className="muted small-note">
            Two households may share an address — you will get a notice, not an error.
          </p>

          <div className="actions">
            <button className="btn" type="submit" disabled={!head || !address.trim() || busy}>
              {busy ? 'Creating…' : 'Create household'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- detail ---------------------------------------------------------------
function HouseholdDetail({ householdId, onBack }) {
  const { authFetch } = useAuth();
  const [household, setHousehold] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch(`/households/${householdId}`);
        if (!cancelled) setHousehold(data.household);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, householdId]);

  if (error) return <div className="alert error">{error}</div>;
  if (!household) return <p className="muted">Loading household…</p>;

  return (
    <>
      <div className="list-head">
        <h2>
          Household #{household.household_id}
          {household.head_name ? ` — Household of ${household.head_name}` : ' — no head assigned'}
        </h2>
        <button className="btn secondary" onClick={onBack}>
          ← Back to households
        </button>
      </div>

      {household.head_is_archived && (
        <div className="alert error">
          <strong>This household&apos;s head is an archived resident record.</strong>
          <div className="reason-note">
            The household is still on file, but its head is no longer on the active resident master
            list. Assign a new head once member management is available.
          </div>
        </div>
      )}
      {!household.head_name && (
        <div className="alert error">
          <strong>This household has no active head.</strong>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <tbody>
            <tr>
              <th>Address</th>
              <td>{household.address}</td>
            </tr>
            <tr>
              <th>Registered</th>
              <td>{formatDate(household.registered_at)}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                <span className={`badge ${household.is_active ? 'status-claimed' : 'status-cancelled'}`}>
                  {household.is_active ? 'Active' : 'Inactive'}
                </span>
              </td>
            </tr>
            <tr>
              <th>Members</th>
              <td>{household.member_count}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="list-head" style={{ marginTop: 20 }}>
        <h2>Members</h2>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Sex</th>
              <th className="num">Age</th>
              <th>Date started</th>
            </tr>
          </thead>
          <tbody>
            {household.members.map((m) => (
              <tr key={m.membership_id}>
                <td>
                  <strong>{m.name}</strong>
                  {m.resident_is_archived && <span className="muted"> · archived record</span>}
                  {!m.is_active && <span className="muted"> · ended {dateOnly(m.date_ended)}</span>}
                </td>
                <td>{m.role}</td>
                <td className="muted">{m.sex || '—'}</td>
                <td className="num">{ageFrom(m.birthdate)}</td>
                <td className="muted">{dateOnly(m.date_started)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// --- page -----------------------------------------------------------------
export default function HouseholdsPage() {
  const { authFetch } = useAuth();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('true');
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), active });
      if (search) params.set('search', search);
      const result = await authFetch(`/households?${params}`);
      setData(result);
    } catch (err) {
      setError(err.message);
      setData({ households: [], total: 0, page: 1, total_pages: 0 });
    }
  }, [authFetch, page, search, active]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  const households = data?.households;

  return (
    <div className="dash">
      <DashHeader
        title="BrgyServe — Secretary"
        subtitle="Household records"
        nav={SECRETARY_NAV}
      />

      <main className="dash-main">
        {selectedId ? (
          <HouseholdDetail householdId={selectedId} onBack={() => setSelectedId(null)} />
        ) : (
          <>
            {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
            {notice && <div className="alert">{notice}</div>}
            {error && <div className="alert error">{error}</div>}

            <div className="list-head">
              <form onSubmit={handleSearch} className="head-actions">
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search by head, member, address, or household #"
                />
                <button className="btn secondary" type="submit">
                  Search
                </button>
                {search && (
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setSearch('');
                      setPage(1);
                    }}
                  >
                    Clear
                  </button>
                )}
              </form>
              <div className="head-actions">
                <select
                  value={active}
                  onChange={(e) => {
                    setActive(e.target.value);
                    setPage(1);
                  }}
                >
                  {ACTIVE_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={() => setShowCreate(true)}>
                  New household
                </button>
              </div>
            </div>

            {households === undefined ? (
              <p className="muted">Loading households…</p>
            ) : households.length === 0 ? (
              <div className="empty">
                <p>{emptyMessage(search, active, data.total_all)}</p>
                {/* Only offer to create the first one when there genuinely
                    isn't one — not when a filter merely hid them all. */}
                {isTrulyEmpty(search, active, data.total_all) && (
                  <button className="btn" onClick={() => setShowCreate(true)}>
                    Create the first household
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="list-head">
                  <h2>
                    {data.total} household{data.total === 1 ? '' : 's'}
                  </h2>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Household #</th>
                        <th>Head</th>
                        <th>Address</th>
                        <th className="num">Members</th>
                        <th>Registered</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {households.map((h) => (
                        <tr
                          key={h.household_id}
                          className="clickable-row"
                          onClick={() => setSelectedId(h.household_id)}
                        >
                          <td>
                            <strong>#{h.household_id}</strong>
                          </td>
                          <td>{h.head_name || <span className="muted">no head assigned</span>}</td>
                          <td className="muted">{h.address}</td>
                          <td className="num">{h.member_count}</td>
                          <td className="muted">{formatDate(h.registered_at)}</td>
                          <td>
                            <span
                              className={`badge ${h.is_active ? 'status-claimed' : 'status-cancelled'}`}
                            >
                              {h.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.total_pages > 1 && (
                  <div className="list-head">
                    <span className="muted">
                      Page {data.page} of {data.total_pages}
                    </span>
                    <div className="head-actions">
                      <button
                        className="btn secondary"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        ← Previous
                      </button>
                      <button
                        className="btn secondary"
                        disabled={page >= data.total_pages}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      {showCreate && (
        <CreateHouseholdModal
          onClose={() => setShowCreate(false)}
          onCreated={(data) => {
            setShowCreate(false);
            setFlash({ type: 'success', text: data.message });
            setNotice(data.notice);
            setSelectedId(null);
            setPage(1);
            load();
          }}
        />
      )}
    </div>
  );
}
