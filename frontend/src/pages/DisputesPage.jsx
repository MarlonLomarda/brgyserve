import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';

// Blotter (dispute records). Shared by the Secretary (canManage: create / edit
// / settle) and the Punong Barangay (read-only) — pass the role's title, nav,
// and canManage, like RentalBookingsPage.

const NATURES = ['Criminal', 'Civil', 'Others'];
const ROLES = ['Complainant', 'Respondent'];
const SETTLED_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'settled', label: 'Settled' },
  { value: 'all', label: 'All' },
];

function residentName(r) {
  const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return r.suffix ? `${name}, ${r.suffix}` : name;
}
function partyName(p) {
  if (p.resident_records) return residentName(p.resident_records);
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown';
}
const hm = (t) => (t ? String(t).slice(0, 5) : '');

// --- resident picker (reuses the master-list search) -----------------------
function ResidentPicker({ value, onPick, onClear }) {
  const { authFetch } = useAuth();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value || term.trim().length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await authFetch(`/resident-records?search=${encodeURIComponent(term.trim())}&per_page=8`);
        if (!cancelled) setResults(data.records);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, value, authFetch]);

  if (value) {
    return (
      <div className="picker-selected">
        <span>
          <strong>{value.label}</strong> <span className="muted">(record #{value.resident_id})</span>
        </span>
        <button type="button" className="btn secondary" onClick={onClear}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search the resident master list…"
      />
      {term.trim().length >= 2 && (
        <div className="picker-results">
          {searching && <p className="muted">Searching…</p>}
          {results && results.length === 0 && !searching && (
            <p className="muted">No matching residents.</p>
          )}
          {results?.map((r) => (
            <button
              key={r.resident_id}
              type="button"
              className="picker-option"
              onClick={() => {
                onPick({ resident_id: r.resident_id, label: residentName(r) });
                setTerm('');
              }}
            >
              <strong>{residentName(r)}</strong>{' '}
              <span className="muted">
                · {r.birthdate || 'no birthdate'} · {r.address}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- one party row in the form ---------------------------------------------
let partyKeySeq = 0;
const newParty = (role) => ({
  key: `p${partyKeySeq++}`,
  mode: 'resident',
  role,
  resident: null, // { resident_id, label }
  first_name: '',
  last_name: '',
});

function PartyRow({ party, onChange, onRemove, canRemove }) {
  const set = (patch) => onChange({ ...party, ...patch });
  return (
    <div className="party-row">
      <div className="party-controls">
        <label>
          Role
          <select value={party.role} onChange={(e) => set({ role: e.target.value })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Party type
          <select value={party.mode} onChange={(e) => set({ mode: e.target.value })}>
            <option value="resident">Registered resident</option>
            <option value="nonresident">Non-resident (walk-in)</option>
          </select>
        </label>
        {canRemove && (
          <button type="button" className="btn secondary danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {party.mode === 'resident' ? (
        <ResidentPicker
          value={party.resident}
          onPick={(resident) => set({ resident })}
          onClear={() => set({ resident: null })}
        />
      ) : (
        <div className="grid-2">
          <label>
            First name
            <input value={party.first_name} onChange={(e) => set({ first_name: e.target.value })} maxLength={100} />
          </label>
          <label>
            Last name
            <input value={party.last_name} onChange={(e) => set({ last_name: e.target.value })} maxLength={100} />
          </label>
        </div>
      )}
    </div>
  );
}

// --- create / edit form ----------------------------------------------------
function CaseForm({ dispute, onDone }) {
  const { authFetch } = useAuth();
  const isEdit = !!dispute;
  const [form, setForm] = useState(() =>
    dispute
      ? {
          barangay_case_no: dispute.barangay_case_no,
          date_filed: dispute.date_filed,
          time_filed: hm(dispute.time_filed),
          filed_for: dispute.filed_for,
          nature_of_case: dispute.nature_of_case,
        }
      : { barangay_case_no: '', date_filed: '', time_filed: '', filed_for: '', nature_of_case: 'Criminal' }
  );
  const [parties, setParties] = useState(() =>
    dispute
      ? dispute.dispute_parties.map((p) => ({
          key: `p${partyKeySeq++}`,
          mode: p.resident_id ? 'resident' : 'nonresident',
          role: p.role,
          resident: p.resident_id ? { resident_id: p.resident_id, label: partyName(p) } : null,
          first_name: p.first_name || '',
          last_name: p.last_name || '',
        }))
      : [newParty('Complainant'), newParty('Respondent')]
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  const updateParty = (key, next) => setParties((ps) => ps.map((p) => (p.key === key ? next : p)));
  const removeParty = (key) => setParties((ps) => ps.filter((p) => p.key !== key));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // client-side gate (the server is the real one)
    const hasComplainant = parties.some((p) => p.role === 'Complainant');
    const hasRespondent = parties.some((p) => p.role === 'Respondent');
    if (!hasComplainant || !hasRespondent) {
      setError('A case needs at least one Complainant and one Respondent.');
      return;
    }
    const bad = parties.find((p) =>
      p.mode === 'resident' ? !p.resident : !p.first_name.trim() || !p.last_name.trim()
    );
    if (bad) {
      setError('Every party needs a chosen resident or a typed first and last name.');
      return;
    }

    const payloadParties = parties.map((p) =>
      p.mode === 'resident'
        ? { resident_id: p.resident.resident_id, role: p.role }
        : { first_name: p.first_name.trim(), last_name: p.last_name.trim(), role: p.role }
    );

    setBusy(true);
    try {
      const body = { ...form, parties: payloadParties };
      const data = isEdit
        ? await authFetch(`/disputes/${dispute.dispute_id}`, { method: 'PUT', body })
        : await authFetch('/disputes', { method: 'POST', body });
      onDone({ type: 'success', text: data.message }, data.dispute);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <h3>{isEdit ? `Edit case ${dispute.barangay_case_no}` : 'Record a blotter case'}</h3>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="grid-2">
          <label>
            Barangay case no.
            <input name="barangay_case_no" value={form.barangay_case_no} onChange={handleChange} maxLength={50} required />
          </label>
          <label>
            Nature of case
            <select name="nature_of_case" value={form.nature_of_case} onChange={handleChange}>
              {NATURES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            Date filed
            <input name="date_filed" type="date" max={new Date().toISOString().slice(0, 10)} value={form.date_filed} onChange={handleChange} required />
          </label>
          <label>
            Time filed <span className="hint">(defaults to now if blank)</span>
            <input name="time_filed" type="time" value={form.time_filed} onChange={handleChange} />
          </label>
        </div>
        <label>
          Filed for <span className="hint">(the complaint, e.g. Unjust Vexation)</span>
          <input name="filed_for" value={form.filed_for} onChange={handleChange} maxLength={255} required />
        </label>

        <div className="suggest-section">
          <h4>Parties</h4>
          <p className="muted">
            Each party is a registered resident (pick from the master list) or a non-resident
            walk-in (type the name). At least one Complainant and one Respondent are required.
          </p>
          {parties.map((p) => (
            <PartyRow
              key={p.key}
              party={p}
              onChange={(next) => updateParty(p.key, next)}
              onRemove={() => removeParty(p.key)}
              canRemove={parties.length > 1}
            />
          ))}
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setParties((ps) => [...ps, newParty('Complainant')])}>
              + Add complainant
            </button>
            <button type="button" className="btn secondary" onClick={() => setParties((ps) => [...ps, newParty('Respondent')])}>
              + Add respondent
            </button>
          </div>
        </div>

        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Record case'}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- detail ----------------------------------------------------------------
function CaseDetail({ id, canManage, onBack, onEdit, onChanged }) {
  const { authFetch } = useAuth();
  const [dispute, setDispute] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await authFetch(`/disputes/${id}`);
      setDispute(data.dispute);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch, id]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleSettled() {
    setBusy(true);
    try {
      const data = await authFetch(`/disputes/${id}/settle`, {
        method: 'PATCH',
        body: { is_settled: !dispute.is_settled },
      });
      setDispute(data.dispute);
      onChanged(data.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const d = dispute;
  const group = (role) => (d?.dispute_parties || []).filter((p) => p.role === role);

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>
            {d ? `Case ${d.barangay_case_no}` : `Case #${id}`}{' '}
            {d && (
              <span className={`badge ${d.is_settled ? 'status-claimed' : 'status-pending'}`}>
                {d.is_settled ? 'Settled' : 'Open'}
              </span>
            )}
          </h3>
        </div>
        <div className="head-actions">
          {canManage && d && (
            <>
              <button className="btn secondary" disabled={busy} onClick={() => onEdit(d)}>
                Edit
              </button>
              <button className="btn secondary" disabled={busy} onClick={toggleSettled}>
                {busy ? 'Working…' : d.is_settled ? 'Reopen' : 'Mark settled'}
              </button>
            </>
          )}
          <button className="btn secondary" onClick={onBack}>
            ← Back to list
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {!d ? (
        !error && <p className="muted">Loading case…</p>
      ) : (
        <>
          <dl className="info-grid">
            <div>
              <dt>Filed for</dt>
              <dd>{d.filed_for}</dd>
            </div>
            <div>
              <dt>Nature of case</dt>
              <dd>{d.nature_of_case}</dd>
            </div>
            <div>
              <dt>Date &amp; time filed</dt>
              <dd>{d.date_filed} at {hm(d.time_filed)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{d.is_settled ? 'Settled' : 'Open'}</dd>
            </div>
          </dl>

          {ROLES.map((role) => (
            <div className="suggest-section" key={role}>
              <h4>{role}{group(role).length === 1 ? '' : 's'}</h4>
              {group(role).length === 0 ? (
                <p className="muted">None recorded.</p>
              ) : (
                <ul className="suggestions">
                  {group(role).map((p) => (
                    <li key={p.dispute_party_id} className="suggestion">
                      <span className={`badge ${p.resident_id ? '' : 'gray'}`}>
                        {p.resident_id ? 'Resident' : 'Non-resident'}
                      </span>
                      <div className="suggestion-info">
                        <strong>{partyName(p)}</strong>
                        {p.resident_records && (
                          <span className="muted">
                            record #{p.resident_records.resident_id} · {p.resident_records.address || 'no address'}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// --- page ------------------------------------------------------------------
export default function DisputesPage({ title, nav, canManage = false }) {
  const { authFetch } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [settled, setSettled] = useState('open');
  const [nature, setNature] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [formTarget, setFormTarget] = useState(null); // 'new' | dispute object

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), settled, nature });
      if (search) params.set('search', search);
      setData(await authFetch(`/disputes?${params}`));
    } catch (err) {
      setError(err.message);
      setData({ disputes: [], total: 0, total_pages: 0 });
    }
  }, [authFetch, page, settled, nature, search]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  const disputes = data?.disputes;

  return (
    <div className="dash">
      <DashHeader title={title} subtitle="Barangay blotter / dispute records" nav={nav} />

      <main className="dash-main">
        {formTarget ? (
          <CaseForm
            dispute={formTarget === 'new' ? null : formTarget}
            onDone={(result, dispute) => {
              setFormTarget(null);
              if (!result) return;
              setFlash(result);
              if (dispute) setSelectedId(dispute.dispute_id);
              load();
            }}
          />
        ) : selectedId ? (
          <CaseDetail
            id={selectedId}
            canManage={canManage}
            onBack={() => setSelectedId(null)}
            onEdit={(d) => setFormTarget(d)}
            onChanged={(message) => {
              setFlash({ type: 'success', text: message });
              load();
            }}
          />
        ) : (
          <>
            {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
            {error && <div className="alert error">{error}</div>}

            <div className="list-head">
              <h2>
                {data === null
                  ? 'Blotter cases'
                  : `${data.total} case${data.total === 1 ? '' : 's'}`}
              </h2>
              <form className="head-actions" onSubmit={handleSearch}>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search case no, complaint, or party…"
                  maxLength={100}
                />
                <button className="btn secondary" type="submit">Search</button>
                {search && (
                  <button className="btn secondary" type="button" onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}>
                    Clear
                  </button>
                )}
                <select value={settled} onChange={(e) => { setSettled(e.target.value); setPage(1); }}>
                  {SETTLED_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <select value={nature} onChange={(e) => { setNature(e.target.value); setPage(1); }}>
                  <option value="all">All natures</option>
                  {NATURES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                {canManage && (
                  <button className="btn" type="button" onClick={() => setFormTarget('new')}>
                    Record case
                  </button>
                )}
              </form>
            </div>

            {disputes === undefined || data === null ? (
              <p className="muted">Loading cases…</p>
            ) : disputes.length === 0 ? (
              <div className="empty">
                <p>No blotter cases{search ? ` matching "${search}"` : settled === 'open' ? ' are open' : ''}.</p>
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Case no.</th>
                        <th>Filed</th>
                        <th>Filed for</th>
                        <th>Nature</th>
                        <th>Parties</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {disputes.map((d) => (
                        <tr key={d.dispute_id}>
                          <td><strong>{d.barangay_case_no}</strong></td>
                          <td className="muted">{d.date_filed}</td>
                          <td>{d.filed_for}</td>
                          <td className="muted">{d.nature_of_case}</td>
                          <td className="muted truncate">{d.party_summary}</td>
                          <td>
                            <span className={`badge ${d.is_settled ? 'status-claimed' : 'status-pending'}`}>
                              {d.is_settled ? 'Settled' : 'Open'}
                            </span>
                          </td>
                          <td className="row-actions">
                            <button className="btn secondary" onClick={() => setSelectedId(d.dispute_id)}>
                              View
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.total_pages > 1 && (
                  <div className="list-head">
                    <span className="muted">Page {data.page} of {data.total_pages}</span>
                    <div className="head-actions">
                      <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                        ← Previous
                      </button>
                      <button className="btn secondary" disabled={page >= data.total_pages} onClick={() => setPage((p) => p + 1)}>
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
    </div>
  );
}
