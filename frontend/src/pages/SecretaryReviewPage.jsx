import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABELS, STAFF_ROLES } from '../auth/roles';
import DashHeader from '../components/DashHeader';
import { SECRETARY_NAV } from '../constants/nav';
import {
  PENDING_STATUS_FILTERS,
  REJECTION_REASON_OPTIONS,
  RESIDENCY_BADGE,
  formatResidency,
  rejectionReasonLabel,
  rejectionReasonRequiresNote,
} from '../constants/registration';

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

// Heading noun and empty-state line per ?status= value. Kept beside each other
// so the count and the "nothing here" message can never describe different
// lists.
//
// BOTH forms are written out rather than appending an "s" to the singular.
// Two of these three phrases do not end in their own noun — "account awaiting
// review" and "account not yet active" — so a trailing "s" landed on "review"
// and "active", giving "2 account awaiting reviews". Only "rejected
// registration" happened to end in the word that pluralises, which is what
// made the append look like it worked.
const STATUS_NOUN = {
  pending: { one: 'account awaiting review', many: 'accounts awaiting review' },
  rejected: { one: 'rejected registration', many: 'rejected registrations' },
  all: { one: 'account not yet active', many: 'accounts not yet active' },
};

const EMPTY_TEXT = {
  pending: 'No resident accounts are awaiting review.',
  rejected: 'No registrations have been rejected.',
  all: 'No resident accounts are waiting — every registration has been activated.',
};

// The masterlist registration date and how long ago it was, with an advisory
// badge under six months.
//
// RENDERS NOTHING AT ALL when there is no date on file — the component returns
// null, so there is no date, no badge and no "unknown" pill. A placeholder
// would read as "under six months" at a glance, and the Secretary would
// decline someone for failing a check that never ran.
//
// It tests `record?.residency`, never the viewer's role. The server decided
// what to send; a role check here would be a second opinion free to disagree.
//
// PURELY ADVISORY — it renders text and a badge and nothing else. No caller
// passes it a disabled flag and nothing downstream reads meets_minimum.
function ResidencyLine({ record }) {
  const residency = record?.residency;
  if (!residency) return null;

  const elapsed = formatResidency(residency);
  return (
    <span className="muted">
      registered {record.masterlist_registered_on} · {elapsed} ago{' '}
      {!residency.meets_minimum && (
        <span className={`badge ${RESIDENCY_BADGE.className}`} title={RESIDENCY_BADGE.title}>
          {RESIDENCY_BADGE.label}
        </span>
      )}
    </span>
  );
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

// The reason + note step. Rejection is confirm-then-act like the resident
// archive and the fines void, but it needs more than a yes/no: the reason code
// decides what the applicant is told at login, so the confirmation IS the form.
function RejectPanel({ busy, onSubmit, onCancel }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const needsNote = rejectionReasonRequiresNote(reason);
  const trimmedNote = note.trim();
  // Mirrors the server's rule rather than replacing it: the route validates
  // this again and is the real gate.
  const ready = Boolean(reason) && (!needsNote || Boolean(trimmedNote));

  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit({ reason, note: trimmedNote });
      }}
    >
      <p className="muted">
        The applicant is shown this reason the next time they try to sign in, with what
        to do next. Your note is internal and is never shown to them.
      </p>
      <label>
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value)} required>
          <option value="">Choose a reason…</option>
          {REJECTION_REASON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Note {needsNote ? <span className="hint">(required)</span> : <span className="hint">(optional, internal)</span>}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={255}
          placeholder="Only the barangay sees this"
        />
      </label>
      <div className="actions">
        <button className="btn danger" type="submit" disabled={busy || !ready}>
          {busy ? 'Rejecting…' : 'Reject this registration'}
        </button>
        <button className="btn secondary" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// What a rejected account shows instead of the review actions. There is
// deliberately no link/create/activate path here — a rejected registration is
// not mid-review, and un-rejecting is the one way back to it.
function RejectedPanel({ account, busy, onUnreject }) {
  const by = account.rejected_by_username ? ` by @${account.rejected_by_username}` : '';
  return (
    <div className="created-panel">
      <div className="alert error">
        This registration was rejected. The applicant is told the reason when they try to
        sign in, and cannot be activated until the rejection is cleared.
      </div>
      <dl className="info-grid">
        <div>
          <dt>Reason</dt>
          <dd>{rejectionReasonLabel(account.rejection_reason)}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>
            {formatDateTime(account.rejected_at)}
            {by}
          </dd>
        </div>
        {account.rejection_note && (
          <div className="span-2">
            <dt>Note (internal, not shown to the applicant)</dt>
            <dd>{account.rejection_note}</dd>
          </div>
        )}
      </dl>
      <div className="actions">
        <button className="btn secondary" disabled={busy} onClick={onUnreject}>
          {busy ? 'Working…' : 'Un-reject'}
        </button>
      </div>
    </div>
  );
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
                <ResidencyLine record={s} />
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
  const [rejecting, setRejecting] = useState(false);
  const p = account.profile || {};
  const linked = p.resident_id != null;
  const rejected = account.is_rejected === true;

  function handleUnreject() {
    if (
      !window.confirm(
        `Clear the rejection on @${account.username}? The account goes back to awaiting review — it does NOT become active, and you can still activate or reject it afterwards.`
      )
    ) {
      return;
    }
    onAction(account, 'unreject');
  }

  // The reject button, shown in BOTH review branches. The not-linked branch is
  // the commonest rejection case by far — an applicant with no matching record
  // is exactly the one to decline — and before this it offered no exit at all,
  // only "create a record for them" and "link them to one".
  const rejectButton = (
    <button
      className="btn danger"
      type="button"
      disabled={busy}
      onClick={() => setRejecting(true)}
    >
      Reject registration
    </button>
  );

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>{fullName(p) || account.username}</h3>
          <p className="muted">@{account.username} · {account.email}</p>
        </div>
        {rejected && <span className="badge status-rejected">Rejected</span>}
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
        {/* The LINKED branch used to fetch no resident record at all, so the
            masterlist date had nowhere to appear once an account was linked.
            The whole row is omitted when there is no date on file — the same
            rule as ResidencyLine, applied one level up so no empty <dt> is
            left behind. */}
        {account.linked_record?.residency && (
          <div className="span-2">
            <dt>Masterlist registration (record #{account.linked_record.resident_id})</dt>
            <dd>
              <ResidencyLine record={account.linked_record} />
            </dd>
          </div>
        )}
      </dl>

      {message && <div className={`alert ${message.type}`}>{message.text}</div>}

      {rejected ? (
        <RejectedPanel account={account} busy={busy} onUnreject={handleUnreject} />
      ) : rejecting ? (
        <RejectPanel
          busy={busy}
          onCancel={() => setRejecting(false)}
          onSubmit={(payload) => {
            setRejecting(false);
            onAction(account, 'reject', payload);
          }}
        />
      ) : !linked ? (
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
            {rejectButton}
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
          {rejectButton}
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
  // Drives ?status= on the server. 'pending' matches the route's default, so
  // the screen opens on exactly the list it always showed.
  const [status, setStatus] = useState('pending');

  const load = useCallback(async () => {
    setListError('');
    try {
      const data = await authFetch(`/secretary/pending-residents?status=${status}`);
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
  }, [authFetch, status]);

  useEffect(() => {
    load();
  }, [load]);

  // `payload` is the resident_id for 'link' and the { reason, note } body for
  // 'reject'; the other kinds ignore it.
  async function handleAction(account, kind, payload) {
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
          body: { resident_id: payload },
        });
      } else if (kind === 'reject') {
        data = await authFetch(`/secretary/pending-residents/${userId}/reject`, {
          method: 'POST',
          body: payload,
        });
      } else if (kind === 'unreject') {
        data = await authFetch(`/secretary/pending-residents/${userId}/unreject`, {
          method: 'POST',
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

        {/* The filter sits OUTSIDE the empty check on purpose: switching to
            Rejected and finding it empty must not remove the control that
            switches back. */}
        <div className="list-head">
          <h2>
            {pending === null
              ? 'Resident accounts'
              : `${pending.length} ${
                  pending.length === 1 ? STATUS_NOUN[status].one : STATUS_NOUN[status].many
                }`}
          </h2>
          <div className="head-actions">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {PENDING_STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button className="btn secondary" onClick={load}>
              Refresh
            </button>
          </div>
        </div>

        {pending === null ? (
          <p className="muted">Loading resident accounts…</p>
        ) : pending.length === 0 ? (
          <div className="empty">
            <p>{EMPTY_TEXT[status]}</p>
          </div>
        ) : (
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
        )}
      </main>
    </div>
  );
}
