import { Fragment, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import ResidentPicker from '../components/ResidentPicker';
import { ASSIGNABLE_ROLES, HOUSEHOLD_ROLE } from '../constants/households';
import { formatDate } from '../constants/requestStatus';

// Households module. Shared by the Secretary (canManage: create, member
// management, headship, edit/deactivate) and Staff (read-only) — pass the
// role's title, nav and canManage, like RentalBookingsPage and DisputesPage.
//
// Households are identified by their HEAD, not their address: two households
// may legitimately share one address.

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

const dateOnly = (value) =>
  value ? new Date(`${value}T00:00:00+08:00`).toLocaleDateString('en-PH', { dateStyle: 'medium' }) : '—';

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
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);

  function pickHead(resident) {
    setHead(resident);
    setError('');
    setConflict(null);
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

// --- add a member (with the transfer confirmation step) --------------------
function AddMemberPanel({ householdId, onDone, onCancel }) {
  const { authFetch } = useAuth();
  const [resident, setResident] = useState(null);
  const [role, setRole] = useState(ASSIGNABLE_ROLES[0]);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null); // 409 -> offer the transfer
  const [busy, setBusy] = useState(false);

  async function submit(transfer) {
    setError('');
    setBusy(true);
    try {
      const data = await authFetch(`/households/${householdId}/members`, {
        method: 'POST',
        body: { resident_id: resident.resident_id, role, transfer },
      });
      onDone({ type: 'success', text: data.message });
    } catch (err) {
      setError(err.message);
      // Only a conflict in ANOTHER household can be resolved by transferring.
      if (err.status === 409 && err.data?.household_id && err.data.household_id !== householdId) {
        setConflict(err.data);
      } else {
        setConflict(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card wide" style={{ maxWidth: '100%', marginBottom: 16 }}>
      <div className="list-head">
        <h2>Add a member</h2>
        <button className="btn secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && (
        <div className="alert error">
          {error}
          {conflict && (
            <div className="reason-note">
              Moving them here will end their membership in household #{conflict.household_id} today.
              The old membership is kept as history.
            </div>
          )}
        </div>
      )}

      <label>Resident</label>
      <ResidentPicker
        value={resident}
        onPick={(r) => {
          setResident(r);
          setError('');
          setConflict(null);
        }}
        onClear={() => {
          setResident(null);
          setConflict(null);
        }}
        placeholder="Search residents by name…"
      />

      <label style={{ marginTop: 14, display: 'block' }}>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small-note">
        The head is set with “Make head”, so it is not offered here.
      </p>

      <div className="actions">
        {conflict ? (
          <button className="btn" type="button" disabled={busy} onClick={() => submit(true)}>
            {busy ? 'Moving…' : 'Move them to this household'}
          </button>
        ) : (
          <button className="btn" type="button" disabled={!resident || busy} onClick={() => submit(false)}>
            {busy ? 'Adding…' : 'Add member'}
          </button>
        )}
      </div>
    </div>
  );
}

// --- prompt for the sitting head's new role before promoting someone -------
function MakeHeadPanel({ member, currentHeadName, onConfirm, onCancel, busy }) {
  const [demoteTo, setDemoteTo] = useState(ASSIGNABLE_ROLES[0]);
  return (
    <tr>
      <td colSpan={6}>
        <div className="alert">
          <strong>Make {member.name} the household head?</strong>
          {currentHeadName ? (
            <>
              <div className="reason-note">
                {currentHeadName} is the current head and needs a new role.
              </div>
              <label style={{ marginTop: 8, display: 'block' }}>
                {currentHeadName}&apos;s new role
                <select value={demoteTo} onChange={(e) => setDemoteTo(e.target.value)}>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <div className="reason-note">This household currently has no head.</div>
          )}
          <div className="actions">
            <button className="btn" type="button" disabled={busy} onClick={() => onConfirm(demoteTo)}>
              {busy ? 'Working…' : 'Confirm'}
            </button>
            <button className="btn secondary" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// --- detail ---------------------------------------------------------------
function HouseholdDetail({ householdId, canManage, onBack, onChanged }) {
  const { authFetch } = useAuth();
  const [household, setHousehold] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showEnded, setShowEnded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [headTarget, setHeadTarget] = useState(null);
  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch(`/households/${householdId}`);
      setHousehold(data.household);
      setAddressDraft(data.household.address);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch, householdId]);

  useEffect(() => {
    load();
  }, [load]);

  // Every mutation funnels through here so the panel state, the flash message
  // and the reload stay consistent.
  async function run(label, fn) {
    setFlash(null);
    setNotice(null);
    setBusyId(label);
    try {
      const data = await fn();
      setFlash({ type: 'success', text: data.message });
      if (data.notice) setNotice(data.notice);
      await load();
      onChanged?.();
      return true;
    } catch (err) {
      setFlash({ type: 'error', text: err.message });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const changeRole = (m, role) =>
    run(`role-${m.membership_id}`, () =>
      authFetch(`/households/${householdId}/members/${m.membership_id}`, {
        method: 'PATCH',
        body: { role },
      })
    );

  async function endMembership(m) {
    if (!window.confirm(`End ${m.name}'s membership in this household? The record is kept as history.`)) return;
    await run(`end-${m.membership_id}`, () =>
      authFetch(`/households/${householdId}/members/${m.membership_id}`, { method: 'DELETE' })
    );
  }

  async function makeHead(m, demoteTo) {
    const ok = await run(`head-${m.membership_id}`, () =>
      authFetch(`/households/${householdId}/head`, {
        method: 'POST',
        body: { membership_id: m.membership_id, demote_current_head_to: demoteTo },
      })
    );
    if (ok) setHeadTarget(null);
  }

  async function saveAddress(e) {
    e.preventDefault();
    const ok = await run('address', () =>
      authFetch(`/households/${householdId}`, { method: 'PATCH', body: { address: addressDraft.trim() } })
    );
    if (ok) setEditingAddress(false);
  }

  async function toggleActive() {
    if (household.is_active) {
      const n = household.member_count;
      if (
        !window.confirm(
          `Deactivate household #${household.household_id}?\n\n` +
            `This will end ${n} active membership${n === 1 ? '' : 's'} today, freeing ` +
            `${n === 1 ? 'that resident' : 'those residents'} to join other households.\n\n` +
            'Reactivating later does NOT restore them — members must be re-added.'
        )
      ) {
        return;
      }
    }
    await run('active', () =>
      authFetch(`/households/${householdId}`, { method: 'PATCH', body: { is_active: !household.is_active } })
    );
  }

  if (error && !household) return <div className="alert error">{error}</div>;
  if (!household) return <p className="muted">Loading household…</p>;

  const visibleMembers = showEnded ? household.members : household.members.filter((m) => m.is_active);
  const endedCount = household.members.filter((m) => !m.is_active).length;

  return (
    <>
      <div className="list-head">
        <h2>
          Household #{household.household_id}
          {household.head_name ? ` — Household of ${household.head_name}` : ' — no head assigned'}
        </h2>
        <div className="head-actions">
          {canManage && (
            <button className="btn secondary" disabled={busyId === 'active'} onClick={toggleActive}>
              {household.is_active ? 'Deactivate' : 'Reactivate'}
            </button>
          )}
          <button className="btn secondary" onClick={onBack}>
            ← Back
          </button>
        </div>
      </div>

      {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
      {notice && <div className="alert">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      {household.head_is_archived && (
        <div className="alert error">
          <strong>This household&apos;s head is an archived resident record.</strong>
          <div className="reason-note">
            The household is still on file, but its head is no longer on the active resident master
            list. Reassign the head to another member.
          </div>
        </div>
      )}
      {!household.head_name && household.is_active && (
        <div className="alert error">
          <strong>This household has no active head.</strong>
          <div className="reason-note">Use “Make head” on a member to assign one.</div>
        </div>
      )}
      {!household.is_active && (
        <div className="alert">
          <strong>This household is inactive.</strong>
          <div className="reason-note">
            Its memberships were ended when it was deactivated. Reactivating does not restore them —
            members must be re-added.
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <tbody>
            <tr>
              <th>Address</th>
              <td>
                {editingAddress ? (
                  <form className="inline-form" onSubmit={saveAddress}>
                    <input
                      value={addressDraft}
                      onChange={(e) => setAddressDraft(e.target.value)}
                      maxLength={255}
                      required
                      autoFocus
                    />
                    <button className="btn secondary" type="submit" disabled={busyId === 'address'}>
                      Save
                    </button>
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => {
                        setEditingAddress(false);
                        setAddressDraft(household.address);
                      }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    {household.address}
                    {canManage && (
                      <button
                        className="btn secondary"
                        style={{ marginLeft: 8 }}
                        onClick={() => setEditingAddress(true)}
                      >
                        Edit
                      </button>
                    )}
                  </>
                )}
              </td>
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
        <div className="head-actions">
          {endedCount > 0 && (
            <button className="btn secondary" onClick={() => setShowEnded((v) => !v)}>
              {showEnded ? `Hide past members (${endedCount})` : `Show past members (${endedCount})`}
            </button>
          )}
          {canManage && household.is_active && !adding && (
            <button className="btn" onClick={() => setAdding(true)}>
              Add member
            </button>
          )}
        </div>
      </div>

      {adding && (
        <AddMemberPanel
          householdId={householdId}
          onCancel={() => setAdding(false)}
          onDone={async (result) => {
            setAdding(false);
            setFlash(result);
            await load();
            onChanged?.();
          }}
        />
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Sex</th>
              <th className="num">Age</th>
              <th>Date started</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {visibleMembers.map((m) => {
              const isHead = m.role === HOUSEHOLD_ROLE.HEAD && m.is_active;
              return (
                // The row and its "make head" panel are siblings, so the key
                // belongs on the Fragment, not on the <tr>.
                <Fragment key={m.membership_id}>
                  <tr className={m.is_active ? undefined : 'row-ended'}>
                    <td>
                      <strong>{m.name}</strong>
                      {m.resident_is_archived && <span className="muted"> · archived record</span>}
                      {!m.is_active && (
                        <span className="muted"> · ended {dateOnly(m.date_ended)}</span>
                      )}
                    </td>
                    <td>
                      {canManage && m.is_active && !isHead ? (
                        <select
                          value={m.role}
                          disabled={busyId === `role-${m.membership_id}`}
                          onChange={(e) => changeRole(m, e.target.value)}
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        m.role
                      )}
                    </td>
                    <td className="muted">{m.sex || '—'}</td>
                    <td className="num">{ageFrom(m.birthdate)}</td>
                    <td className="muted">{dateOnly(m.date_started)}</td>
                    {canManage && (
                      <td className="row-actions">
                        {m.is_active && !isHead && household.is_active && (
                          <>
                            <button
                              className="btn secondary"
                              disabled={!!busyId}
                              onClick={() => setHeadTarget(m.membership_id)}
                            >
                              Make head
                            </button>
                            <button
                              className="btn secondary danger"
                              disabled={busyId === `end-${m.membership_id}`}
                              onClick={() => endMembership(m)}
                            >
                              End membership
                            </button>
                          </>
                        )}
                        {isHead && <span className="muted small-note">Head — reassign to change</span>}
                      </td>
                    )}
                  </tr>
                  {headTarget === m.membership_id && (
                    <MakeHeadPanel
                      member={m}
                      currentHeadName={household.head_name}
                      busy={busyId === `head-${m.membership_id}`}
                      onCancel={() => setHeadTarget(null)}
                      onConfirm={(demoteTo) => makeHead(m, demoteTo)}
                    />
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// --- unassigned residents --------------------------------------------------
function UnassignedResidents() {
  const { authFetch } = useAuth();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (search) params.set('search', search);
      setData(await authFetch(`/households/unassigned-residents?${params}`));
    } catch (err) {
      setError(err.message);
      setData({ residents: [], total: 0, page: 1, total_pages: 0 });
    }
  }, [authFetch, page, search]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading residents…</p>;

  return (
    <>
      <div className="alert">
        <strong>
          {data.total} resident{data.total === 1 ? '' : 's'} not yet in a household
        </strong>
        <div className="reason-note">
          Active residents with no current membership. Add them from a household&apos;s detail page.
        </div>
      </div>

      <div className="list-head">
        <form
          className="head-actions"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(searchInput.trim());
          }}
        >
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or address"
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
      </div>

      {data.residents.length === 0 ? (
        <div className="empty">
          <p>{search ? 'No unassigned residents match that search.' : 'Every active resident belongs to a household.'}</p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sex</th>
                  <th className="num">Age</th>
                  <th>Address</th>
                  <th>Contact</th>
                </tr>
              </thead>
              <tbody>
                {data.residents.map((r) => (
                  <tr key={r.resident_id}>
                    <td>
                      <strong>{r.name}</strong>{' '}
                      <span className="muted">(#{r.resident_id})</span>
                    </td>
                    <td className="muted">{r.sex || '—'}</td>
                    <td className="num">{ageFrom(r.birthdate)}</td>
                    <td className="muted">{r.address}</td>
                    <td className="muted">{r.contact_number || '—'}</td>
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
                <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
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
  );
}

// --- page -----------------------------------------------------------------
export default function HouseholdsPage({ title, nav, canManage = false }) {
  const { authFetch } = useAuth();
  const [view, setView] = useState('households'); // 'households' | 'unassigned'
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('true');
  const [data, setData] = useState(null);
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
      setData(await authFetch(`/households?${params}`));
    } catch (err) {
      setError(err.message);
      setData({ households: [], total: 0, page: 1, total_pages: 0, total_all: 0 });
    }
  }, [authFetch, page, search, active]);

  useEffect(() => {
    load();
  }, [load]);

  const households = data?.households;

  return (
    <div className="dash">
      <DashHeader title={title} subtitle="Household records" nav={nav} />

      <main className="dash-main">
        {selectedId ? (
          <HouseholdDetail
            householdId={selectedId}
            canManage={canManage}
            onBack={() => setSelectedId(null)}
            onChanged={load}
          />
        ) : (
          <>
            <div className="list-head">
              <div className="head-actions">
                <button
                  className={view === 'households' ? 'btn' : 'btn secondary'}
                  onClick={() => setView('households')}
                >
                  Households
                </button>
                <button
                  className={view === 'unassigned' ? 'btn' : 'btn secondary'}
                  onClick={() => setView('unassigned')}
                >
                  Unassigned residents
                </button>
              </div>
            </div>

            {view === 'unassigned' ? (
              <UnassignedResidents />
            ) : (
              <>
                {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
                {notice && <div className="alert">{notice}</div>}
                {error && <div className="alert error">{error}</div>}

                <div className="list-head">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setPage(1);
                      setSearch(searchInput.trim());
                    }}
                    className="head-actions"
                  >
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
                    {canManage && (
                      <button className="btn" onClick={() => setShowCreate(true)}>
                        New household
                      </button>
                    )}
                  </div>
                </div>

                {households === undefined ? (
                  <p className="muted">Loading households…</p>
                ) : households.length === 0 ? (
                  <div className="empty">
                    <p>{emptyMessage(search, active, data.total_all)}</p>
                    {canManage && isTrulyEmpty(search, active, data.total_all) && (
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
                              <td>
                                {h.head_name || <span className="muted">no head assigned</span>}
                              </td>
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
          </>
        )}
      </main>

      {showCreate && (
        <CreateHouseholdModal
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setShowCreate(false);
            setFlash({ type: 'success', text: result.message });
            setNotice(result.notice);
            setSelectedId(null);
            setPage(1);
            load();
          }}
        />
      )}
    </div>
  );
}
