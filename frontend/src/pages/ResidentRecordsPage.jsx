import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import DashHeader from '../components/DashHeader';
import { SECRETARY_NAV } from '../constants/nav';
import { formatDate } from '../constants/requestStatus';

// Stage 1 of Resident Records Management: browse + search the master list.
// Read-only — add/edit arrive in Stage 2, archiving in Stage 3.

function fullName(r) {
  const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  return r.suffix ? `${name}, ${r.suffix}` : name;
}

function RecordDetail({ id, onBack }) {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null); // { record, linked_accounts }
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await authFetch(`/resident-records/${id}`);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, id]);

  const r = data?.record;
  const accounts = data?.linked_accounts || [];

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>{r ? fullName(r) : `Resident record #${id}`}</h3>
          {r && <p className="muted">Record #{r.resident_id} · registered {formatDate(r.date_registered)}</p>}
        </div>
        <button className="btn secondary" onClick={onBack}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {!r ? (
        !error && <p className="muted">Loading record…</p>
      ) : (
        <>
          <dl className="info-grid">
            <div>
              <dt>Birthdate</dt>
              <dd>{r.birthdate || '—'}</dd>
            </div>
            <div>
              <dt>Birthplace</dt>
              <dd>{r.birthplace || '—'}</dd>
            </div>
            <div>
              <dt>Sex</dt>
              <dd>{r.sex || '—'}</dd>
            </div>
            <div>
              <dt>Civil status</dt>
              <dd>{r.civil_status || '—'}</dd>
            </div>
            <div>
              <dt>Religion</dt>
              <dd>{r.religion || '—'}</dd>
            </div>
            <div>
              <dt>Educational attainment</dt>
              <dd>{r.educational_attainment || '—'}</dd>
            </div>
            <div>
              <dt>Contact number</dt>
              <dd>{r.contact_number || '—'}</dd>
            </div>
            <div>
              <dt>Archived</dt>
              <dd>{r.is_archived ? 'Yes' : 'No'}</dd>
            </div>
            <div className="span-2">
              <dt>Address</dt>
              <dd>{r.address}</dd>
            </div>
          </dl>

          <div className="suggest-section">
            <h4>Linked user account</h4>
            {accounts.length === 0 ? (
              <p className="muted">
                Not linked to any account — this resident has not registered online.
              </p>
            ) : (
              accounts.map((a) => (
                <p key={a.user_id}>
                  <strong>@{a.username}</strong> <span className="muted">· {a.email}</span>{' '}
                  {a.is_active ? (
                    <span className="badge">Active</span>
                  ) : (
                    <span className="badge gray">Inactive</span>
                  )}
                </p>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ResidentRecordsPage() {
  const { authFetch } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState(''); // the applied search
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (search) params.set('search', search);
      const result = await authFetch(`/resident-records?${params}`);
      setData(result);
    } catch (err) {
      setError(err.message);
      setData({ records: [], total: 0, page: 1, total_pages: 0 });
    }
  }, [authFetch, page, search]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput('');
    setSearch('');
    setPage(1);
  }

  const records = data?.records;

  return (
    <div className="dash">
      <DashHeader
        title="BrgyServe — Secretary"
        subtitle="Resident master list"
        nav={SECRETARY_NAV}
      />

      <main className="dash-main">
        {selectedId ? (
          <RecordDetail id={selectedId} onBack={() => setSelectedId(null)} />
        ) : (
          <>
            {error && <div className="alert error">{error}</div>}

            <div className="list-head">
              <h2>
                {data === null
                  ? 'Resident records'
                  : `${data.total} resident record${data.total === 1 ? '' : 's'}${search ? ` matching "${search}"` : ''}`}
              </h2>
              <form className="head-actions" onSubmit={handleSearch}>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search name or address/purok…"
                  maxLength={100}
                />
                <button className="btn secondary" type="submit">
                  Search
                </button>
                {search && (
                  <button className="btn secondary" type="button" onClick={clearSearch}>
                    Clear
                  </button>
                )}
              </form>
            </div>

            {records === undefined || data === null ? (
              <p className="muted">Loading resident records…</p>
            ) : records.length === 0 ? (
              <div className="empty">
                <p>
                  {search
                    ? `No resident records match "${search}".`
                    : 'No resident records yet.'}
                </p>
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Birthdate</th>
                        <th>Address</th>
                        <th>Contact</th>
                        <th>Account</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r) => (
                        <tr key={r.resident_id}>
                          <td>
                            <strong>{fullName(r)}</strong>
                          </td>
                          <td className="muted">{r.birthdate || '—'}</td>
                          <td className="muted">{r.address}</td>
                          <td className="muted">{r.contact_number || '—'}</td>
                          <td>
                            {r.account ? (
                              <span className="badge">@{r.account.username}</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="row-actions">
                            <button
                              className="btn secondary"
                              onClick={() => setSelectedId(r.resident_id)}
                            >
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
    </div>
  );
}
