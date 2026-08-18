import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABELS, STAFF_ROLES } from '../auth/roles';
import DashHeader from '../components/DashHeader';
import { SECRETARY_NAV } from '../constants/nav';

const EMPTY_ACCOUNT_FORM = {
  first_name: '',
  last_name: '',
  email: '',
  username: '',
  role: 'staff',
};

function CreateAccountSection() {
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_ACCOUNT_FORM);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await authFetch('/secretary/accounts', { method: 'POST', body: form });
      setCreated(data);
      setForm(EMPTY_ACCOUNT_FORM);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pending-card section-card">
      <div className="pending-head">
        <div>
          <h3>Staff accounts</h3>
          <p className="muted">
            Create accounts for barangay officials — residents register themselves.
          </p>
        </div>
        <button className="btn secondary" onClick={() => { setOpen(!open); setCreated(null); }}>
          {open ? 'Close' : 'New staff account'}
        </button>
      </div>

      {open && created && (
        <div className="created-panel">
          <div className="alert success">{created.message}</div>
          <dl className="info-grid">
            <div>
              <dt>Username</dt>
              <dd><code>{created.user.username}</code></dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{ROLE_LABELS[created.user.role] || created.user.role}</dd>
            </div>
            <div className="span-2">
              <dt>Temporary password (shown only once)</dt>
              <dd><code className="temp-pass">{created.temporary_password}</code></dd>
            </div>
          </dl>
          <div className="actions">
            <button className="btn" onClick={() => setCreated(null)}>
              Create another
            </button>
          </div>
        </div>
      )}

      {open && !created && (
        <form onSubmit={handleSubmit} className="account-form">
          {error && <div className="alert error">{error}</div>}
          <div className="grid-2">
            <label>
              First name
              <input name="first_name" value={form.first_name} onChange={handleChange} required />
            </label>
            <label>
              Last name
              <input name="last_name" value={form.last_name} onChange={handleChange} required />
            </label>
            <label>
              Email
              <input name="email" type="email" value={form.email} onChange={handleChange} required />
            </label>
            <label>
              Username
              <input name="username" value={form.username} onChange={handleChange} required />
            </label>
          </div>
          <label>
            Role
            <select name="role" value={form.role} onChange={handleChange}>
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function fullName(p) {
  const name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
  return p.suffix ? `${name}, ${p.suffix}` : name;
}

function MatchSuggestions({ account, busy, onAction }) {
  const { authFetch } = useAuth();
  const [suggestions, setSuggestions] = useState(null); // null = loading
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch(
          `/secretary/pending-residents/${account.user_id}/match-suggestions`
        );
        if (!cancelled) setSuggestions(data.suggestions);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setSuggestions([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.user_id, authFetch]);

  return (
    <div className="suggest-section">
      <h4>Suggested matches from resident records</h4>
      {suggestions === null ? (
        <p className="muted">Finding matches…</p>
      ) : error ? (
        <div className="alert error">{error}</div>
      ) : suggestions.length === 0 ? (
        <p className="muted">
          No similar resident records found — create a new record below, or link
          one manually.
        </p>
      ) : (
        <ul className="suggestions">
          {suggestions.map((s) => (
            <li key={s.resident_id} className="suggestion">
              <span className="badge score">{Math.round(s.score * 100)}% match</span>
              <div className="suggestion-info">
                <strong>
                  {fullName(s)} <span className="muted">(record #{s.resident_id})</span>
                </strong>
                <span className="muted">
                  b. {s.birthdate || '—'} · {s.address || '—'}
                </span>
              </div>
              {s.already_linked ? (
                <span className="muted linked-note">already linked to another account</span>
              ) : (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => onAction(account, 'link', s.resident_id)}
                >
                  Link this record
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PendingCard({ account, busy, message, onAction }) {
  const [linkId, setLinkId] = useState('');
  const p = account.profile || {};
  const linked = p.resident_id != null;

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>{fullName(p) || account.username}</h3>
          <p className="muted">@{account.username} · {account.email}</p>
        </div>
        {linked && <span className="badge">Linked to record #{p.resident_id}</span>}
      </div>

      <dl className="info-grid">
        <div>
          <dt>Birthdate</dt>
          <dd>{p.birthdate || '—'}</dd>
        </div>
        <div>
          <dt>Contact number</dt>
          <dd>{p.phone_number || '—'}</dd>
        </div>
        <div className="span-2">
          <dt>Claimed address</dt>
          <dd>{p.address || '—'}</dd>
        </div>
      </dl>

      {message && <div className={`alert ${message.type}`}>{message.text}</div>}

      {!linked ? (
        <>
          <MatchSuggestions account={account} busy={busy} onAction={onAction} />
          <div className="actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => onAction(account, 'create')}
            >
              Create new resident record &amp; link
            </button>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                onAction(account, 'link', Number(linkId));
              }}
            >
              <input
                type="number"
                min="1"
                placeholder="Or enter a resident_id manually"
                value={linkId}
                onChange={(e) => setLinkId(e.target.value)}
                required
              />
              <button className="btn secondary" type="submit" disabled={busy}>
                Link by ID
              </button>
            </form>
          </div>
        </>
      ) : (
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => onAction(account, 'activate')}
          >
            Activate account
          </button>
        </div>
      )}
    </div>
  );
}

export default function SecretaryReviewPage() {
  const { authFetch } = useAuth();

  const [pending, setPending] = useState(null); // null = loading
  const [listError, setListError] = useState('');
  const [flash, setFlash] = useState(null); // top banner for successful actions
  const [busyId, setBusyId] = useState(null);
  const [errors, setErrors] = useState({}); // user_id -> { type, text }

  const load = useCallback(async () => {
    setListError('');
    try {
      const data = await authFetch('/secretary/pending-residents');
      setPending(
        data.pending.map((u) => ({
          ...u,
          // profiles is one-to-one but normalize in case it arrives as an array
          profile: Array.isArray(u.profiles) ? u.profiles[0] : u.profiles,
        }))
      );
    } catch (err) {
      setListError(err.message);
      setPending([]);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAction(account, kind, residentId) {
    const userId = account.user_id;
    setBusyId(userId);
    setFlash(null);
    setErrors((m) => ({ ...m, [userId]: null }));
    try {
      let data;
      if (kind === 'create') {
        data = await authFetch(`/secretary/pending-residents/${userId}/create-resident`, {
          method: 'POST',
          body: {},
        });
      } else if (kind === 'link') {
        data = await authFetch(`/secretary/pending-residents/${userId}/link`, {
          method: 'POST',
          body: { resident_id: residentId },
        });
      } else {
        data = await authFetch(`/secretary/pending-residents/${userId}/activate`, {
          method: 'POST',
        });
      }
      setFlash({ type: 'success', text: `@${account.username}: ${data.message}` });
      await load();
    } catch (err) {
      setErrors((m) => ({ ...m, [userId]: { type: 'error', text: err.message } }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dash">
      <DashHeader
        title="Resident review"
        subtitle="Manage accounts and review pending residents"
        nav={SECRETARY_NAV}
      />

      <main className="dash-main capped-column">
        <CreateAccountSection />

        {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
        {listError && <div className="alert error">{listError}</div>}

        {pending === null ? (
          <p className="muted">Loading pending accounts…</p>
        ) : pending.length === 0 ? (
          <div className="empty">
            <p>No pending resident accounts.</p>
            <button className="btn secondary" onClick={load}>
              Refresh
            </button>
          </div>
        ) : (
          <>
            <div className="list-head">
              <h2>
                {pending.length} pending account{pending.length === 1 ? '' : 's'}
              </h2>
              <button className="btn secondary" onClick={load}>
                Refresh
              </button>
            </div>
            <div className="pending-list">
              {pending.map((a) => (
                <PendingCard
                  key={a.user_id}
                  account={a}
                  busy={busyId === a.user_id}
                  message={errors[a.user_id]}
                  onAction={handleAction}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
