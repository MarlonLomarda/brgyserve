import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS, STAFF_ROLES } from "../auth/roles";
import { formatDateTime } from "../utils/formatDateTime";

const EMPTY_ACCOUNT_FORM = {
  first_name: "",
  last_name: "",
  email: "",
  username: "",
  role: "staff",
  delivery: "email",
};

// How a new official gets their first password. Email is the default here
// and on the server; the second option is the fallback for when email is
// not working, and the account's activity log entry records which was used.
const DELIVERY_OPTIONS = [
  { value: "email", label: "Email a set-password link" },
  {
    value: "temporary_password",
    label: "Email isn't working: show a one-time temporary password instead",
  },
];

// What the Secretary is told about a set-password email, by the status the
// server returned. SIMULATED is not "sent" (nothing left the server), and
// anything else means the email did not go.
function linkEmailNotice(status, email) {
  if (status === "SENT") {
    return {
      type: "success",
      text: `Set-password link emailed to ${email}. It works once and lasts 72 hours.`,
    };
  }
  if (status === "SIMULATED") {
    return {
      type: "info",
      text: "Email is simulated on this server, so nothing was sent. The set-password link was written to the server log instead.",
    };
  }
  return {
    type: "error",
    text: "The email could not be sent. Nothing else changed, so you can try again. If it keeps failing, email is not working on this server.",
  };
}

// The notice after creating an account by email. A failed send is the case
// that matters: the account exists, but nobody can sign in to it until a link
// reaches the official, so the notice says so and points at the list below.
function createdNotice(created) {
  const { status } = created.set_password_email || {};
  const { username, email } = created.user;
  if (status === "SENT") {
    return {
      type: "success",
      text: `Account created. A set-password link was emailed to ${email}. It works once and lasts 72 hours, and the email includes their username. They cannot sign in until they have used it.`,
    };
  }
  if (status === "SIMULATED") {
    return {
      type: "info",
      text: "Account created. Email is simulated on this server, so no email was sent. The set-password link was written to the server log instead.",
    };
  }
  return {
    type: "error",
    text: `Account created, but the set-password email could NOT be sent, so @${username} has no way to sign in yet. Use "Send set-password link" next to @${username} in the list below to try again.`,
  };
}

// Waiting covers both kinds of new account: one waiting for its emailed link,
// and one created with a temporary password that has not signed in yet.
function accountStatus(account) {
  if (!account.is_active) return { label: "Inactive", className: "gray" };
  if (account.must_change_password) {
    return {
      label: "Waiting for the user to set a password",
      className: "status-pending",
    };
  }
  return { label: "Active", className: "status-claimed" };
}

// The server's refusal when the account is ALREADY in the state asked for
// ("@name is already deactivated." / "@name is already active.", in
// routes/secretary.js). It carries no code and shares its 409 with the
// Secretary's own account, so the sentence is how it is told apart, and
// test:auth fails if the routes stop saying it.
const ALREADY_IN_STATE = /^@\S+ is already (deactivated|active)\.$/;

// Reactivating, in words that are true of the account. must_change_password
// is true for two kinds of account the list cannot tell apart: one still
// waiting for its emailed set-password link (it has no password anyone
// knows, and deactivating retired its links) and one on a temporary
// password. "Their current password" is untrue for the first, so both are
// told what to do if no password was set.
function reactivateQuestion(account) {
  return account.must_change_password
    ? `Reactivate @${account.username}? If they have not set a password yet, use "Send set-password link" after reactivating.`
    : `Reactivate @${account.username}? They can sign in again with their current password.`;
}

function reactivatedLine(account) {
  return account.must_change_password
    ? `@${account.username} is reactivated. If they have not set a password yet, use "Send set-password link" to send them one.`
    : `@${account.username} is reactivated. They can sign in again with their current password.`;
}

// What the search box looks in, as each row shows it: the @username, the
// role's label and the email. Not names: this list has none to search.
function accountMatches(account, term) {
  return [`@${account.username}`, ROLE_LABELS[account.role] || account.role, account.email]
    .some((field) => String(field ?? "").toLowerCase().includes(term));
}

// The staff accounts list: Punong Barangay, Treasurer and Staff accounts,
// with a button that emails each a new set-password link. For an account
// still waiting, that is the resend; for an active one it is a password
// reset, and the current password keeps working until the link is used.
//
// Reuses the match-suggestion row styles: a bordered row whose button wraps
// under the details on a phone, inside a card the 720px form cap still
// governs, because there is no table in it. The adjustments for this list are
// scoped under .staff-accounts and .staff-accounts-page in index.css, so the
// match suggestions on Resident review are untouched.
//
// The search box filters the list already loaded, so typing sends no
// request. It HIDES the rows that do not match rather than leaving them out:
// a row left out is mounted again when it matches again, and an open "send a
// link?" question in it would take the focus from the box, because Cancel
// has autoFocus.
//
// Each row's SECOND button deactivates an active account or reactivates an
// inactive one (step O11), after a question in the row like the send one.
// It comes after the send button and is a direct child of the row, as that
// one is. While either question is open, or a request is in flight, both of
// the row's buttons are disabled. Deactivating blocks an official at once,
// but one already signed in is blocked, not signed out, so the question says
// "blocked".
function StaffAccountList({ reloadToken }) {
  const { authFetch } = useAuth();
  const [accounts, setAccounts] = useState(null); // null = loading, or failed
  const [error, setError] = useState("");
  const [sendingId, setSendingId] = useState(null);
  // The account being deactivated or reactivated right now, if any.
  const [statusBusyId, setStatusBusyId] = useState(null);
  const [notices, setNotices] = useState({}); // user_id -> { type, text }
  // The one question open in the list, if any: { id, kind }, where kind is
  // "send" (a link to an ACTIVE account) or "status" (deactivate or
  // reactivate).
  const [asking, setAsking] = useState(null);
  // Each row's two buttons, so closing a question can hand focus back to the
  // button that opened it instead of dropping it to the page.
  const sendButtons = useRef({});
  const statusButtons = useRef({});
  // The button to focus once the row is re-rendered: it is disabled while
  // its question is open, and a disabled button cannot take the focus.
  const focusNext = useRef(null);
  // The search box's text, as typed.
  const [query, setQuery] = useState("");
  const searchBox = useRef(null);

  useEffect(() => {
    const el = focusNext.current;
    if (el && !el.disabled) {
      focusNext.current = null;
      el.focus();
    }
  });

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await authFetch("/secretary/staff-accounts");
      // A body without the list is an error, not an empty list, and must not
      // reach the render, which reads accounts.length.
      if (!Array.isArray(data?.accounts)) {
        throw new Error("The server sent an unexpected response.");
      }
      setAccounts(data.accounts);
    } catch (err) {
      // null, never []: an empty list is the claim "there are no accounts".
      // The render checks the error first, so this null is never read as one.
      setError(err.message);
      setAccounts(null);
    }
  }, [authFetch]);

  // reloadToken changes when an account is created above, so the new account
  // appears here without a page reload.
  useEffect(() => {
    load();
  }, [load, reloadToken]);

  // A waiting account is sent its link straight away: a link is what it is
  // waiting for. An ACTIVE account is asked about first, in the row itself,
  // because a link to an account in use is a password reset. This used to be
  // window.confirm, and a native dialog can be answered by browser automation
  // without anyone seeing it, and never shows in a screenshot.
  function startSend(account) {
    setNotices((n) => ({ ...n, [account.user_id]: null }));
    if (account.must_change_password) {
      sendLink(account);
    } else {
      setAsking({ id: account.user_id, kind: "send" });
    }
  }

  function cancelSend(account) {
    setAsking(null);
    focusNext.current = sendButtons.current[account.user_id] ?? null;
  }

  // A success can make another row's notice untrue (a refusal naming the
  // only active Staff account, once another is reactivated), so it clears
  // every other row's notice and leaves only its own.
  function showOnly(userId, notice) {
    setNotices({ [userId]: notice });
  }

  function startStatus(account) {
    setNotices((n) => ({ ...n, [account.user_id]: null }));
    setAsking({ id: account.user_id, kind: "status" });
  }

  function cancelStatus(account) {
    setAsking(null);
    focusNext.current = statusButtons.current[account.user_id] ?? null;
  }

  // Deactivates an active account or reactivates an inactive one, then
  // reloads the list so the row shows its new state. The words are the
  // screen's own; a refusal (the last active Staff account, say) shows the
  // server's sentence.
  async function changeStatus(account) {
    const deactivating = account.is_active;
    setAsking(null);
    setStatusBusyId(account.user_id);
    try {
      await authFetch(
        `/secretary/staff-accounts/${account.user_id}/${deactivating ? "deactivate" : "reactivate"}`,
        { method: "POST" },
      );
      showOnly(account.user_id, {
        type: "success",
        text: deactivating
          ? `@${account.username} is deactivated. They cannot sign in until you reactivate the account.`
          : reactivatedLine(account),
      });
      await load();
    } catch (err) {
      setNotices((n) => ({
        ...n,
        [account.user_id]: { type: "error", text: err.message },
      }));
      // The account was already in the state asked for, so the row is out of
      // date (another tab changed it): reload so it shows its real state,
      // the refusal staying on it. No other refusal says anything about the
      // row, so none reloads.
      if (err.status === 409 && ALREADY_IN_STATE.test(err.message)) await load();
    } finally {
      focusNext.current = statusButtons.current[account.user_id] ?? null;
      setStatusBusyId(null);
    }
  }

  async function sendLink(account) {
    setAsking(null);
    setSendingId(account.user_id);
    setNotices((n) => ({ ...n, [account.user_id]: null }));
    try {
      const data = await authFetch(
        `/secretary/staff-accounts/${account.user_id}/send-set-password-link`,
        { method: "POST" },
      );
      showOnly(
        account.user_id,
        linkEmailNotice(data.set_password_email?.status, account.email),
      );
      await load();
    } catch (err) {
      // A 429 is the 15-minute cooldown, and the server's sentence says when
      // another link can go. It is not a failure, so it is not shown as one.
      setNotices((n) => ({
        ...n,
        [account.user_id]: {
          type: err.status === 429 ? "info" : "error",
          text: err.message,
        },
      }));
    } finally {
      setSendingId(null);
    }
  }

  // "Clear search" goes away once used, so the focus goes back to the box
  // rather than dropping to the page.
  function clearSearch() {
    setQuery("");
    searchBox.current?.focus();
  }

  const term = query.trim().toLowerCase();
  const searching = term !== "";
  const matches = (account) => !searching || accountMatches(account, term);
  const shownCount = accounts ? accounts.filter(matches).length : 0;

  return (
    <div className="suggest-section staff-accounts">
      <h4>Punong Barangay, Treasurer and Staff accounts</h4>
      {/* Error first, then loading, then empty: a failed request can never
          reach the empty-state line. */}
      {error ? (
        <>
          <div className="alert error">{error}</div>
          <button className="btn secondary" type="button" onClick={load}>
            Try again
          </button>
        </>
      ) : accounts === null ? (
        <p className="muted">Loading staff accounts…</p>
      ) : accounts.length === 0 ? (
        <p className="muted">No staff accounts yet.</p>
      ) : (
        <>
          <label className="account-search">
            Search accounts{" "}
            <span className="hint">(username, role or email)</span>
            <input
              ref={searchBox}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </label>
          {/* Always in the page, empty until a search is on, so a screen
              reader hears the count change. */}
          <p className="muted account-search-status" role="status">
            {searching
              ? `Showing ${shownCount} of ${accounts.length} ${
                  accounts.length === 1 ? "account" : "accounts"
                }`
              : ""}
          </p>
          {/* Its own words: "No staff accounts yet." is only ever the claim
              that there are none at all. */}
          {searching && shownCount === 0 && (
            <div className="account-search-empty">
              <p className="muted">No staff accounts match "{query.trim()}".</p>
              <button
                className="btn secondary"
                type="button"
                onClick={clearSearch}
              >
                Clear search
              </button>
            </div>
          )}
          <ul className="suggestions" hidden={shownCount === 0}>
            {accounts.map((a) => {
              const status = accountStatus(a);
              const notice = notices[a.user_id];
              const sending = sendingId === a.user_id;
              const changing = statusBusyId === a.user_id;
              const confirming = asking?.id === a.user_id && asking.kind === "send";
              const askingStatus = asking?.id === a.user_id && asking.kind === "status";
              // A question open in this row, or a request in flight from it.
              const rowLocked = confirming || askingStatus || sending || changing;
              return (
                <li key={a.user_id} className="suggestion" hidden={!matches(a)}>
                  <div className="suggestion-info">
                    {/* Two lines: who it is, with the status; then where the
                        links go, and when one last went. */}
                    <div className="account-line">
                      <strong>
                        @{a.username}{" "}
                        <span className="muted">
                          · {ROLE_LABELS[a.role] || a.role}
                        </span>
                      </strong>
                      <span className={`badge ${status.className}`}>
                        {status.label}
                      </span>
                    </div>
                    <div className="account-line muted">
                      <span>{a.email}</span>
                      <span>
                        ·{" "}
                        {a.last_link_sent_at ? (
                          <>
                            Last link sent{" "}
                            <span className="account-when">
                              {formatDateTime(a.last_link_sent_at)}
                            </span>
                          </>
                        ) : (
                          "No set-password link sent"
                        )}
                      </span>
                    </div>
                    {confirming && (
                      <div className="alert info">
                        Send @{a.username} a link to set a new password? Their
                        current password keeps working until they use the link.
                        <div className="actions">
                          <button
                            className="btn"
                            type="button"
                            disabled={sending}
                            onClick={() => sendLink(a)}
                          >
                            Send link
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            autoFocus
                            onClick={() => cancelSend(a)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {askingStatus && (
                      <div className="alert info">
                        {a.is_active
                          ? `Deactivate @${a.username}? They are blocked at once and cannot sign in until you reactivate the account. Nothing they recorded is removed.`
                          : reactivateQuestion(a)}
                        <div className="actions">
                          <button
                            className={a.is_active ? "btn secondary danger" : "btn"}
                            type="button"
                            onClick={() => changeStatus(a)}
                          >
                            {a.is_active ? "Deactivate" : "Reactivate"}
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            autoFocus
                            onClick={() => cancelStatus(a)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {notice && (
                      <div className={`alert ${notice.type}`}>{notice.text}</div>
                    )}
                  </div>
                  {/* Send stays the row's FIRST button, and both are direct
                      children of the row. */}
                  <button
                    ref={(el) => {
                      sendButtons.current[a.user_id] = el;
                    }}
                    className="btn secondary"
                    type="button"
                    disabled={rowLocked || !a.is_active}
                    onClick={() => startSend(a)}
                  >
                    {sending ? "Sending…" : "Send set-password link"}
                  </button>
                  <button
                    ref={(el) => {
                      statusButtons.current[a.user_id] = el;
                    }}
                    className={a.is_active ? "btn secondary danger" : "btn secondary"}
                    type="button"
                    disabled={rowLocked}
                    onClick={() => startStatus(a)}
                  >
                    {changing
                      ? a.is_active
                        ? "Deactivating…"
                        : "Reactivating…"
                      : a.is_active
                        ? "Deactivate"
                        : "Reactivate"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function StaffAccountsSection() {
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_ACCOUNT_FORM);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  // Bumped after every account created, so the list below reloads.
  const [listToken, setListToken] = useState(0);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await authFetch("/secretary/accounts", {
        method: "POST",
        body: form,
      });
      setCreated(data);
      setForm(EMPTY_ACCOUNT_FORM);
      setListToken((t) => t + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Decided by what the server sent, not by what the form asked for: a
  // password is shown only if one came back.
  const notice = created && !created.temporary_password && createdNotice(created);

  return (
    <div className="pending-card section-card">
      <div className="pending-head">
        <div>
          <p className="muted">
            Create accounts for barangay officials, who set their own password
            from an emailed link.
          </p>
        </div>
        <button
          className="btn secondary"
          onClick={() => {
            setOpen(!open);
            setCreated(null);
          }}
        >
          {open ? "Close" : "New staff account"}
        </button>
      </div>

      {open && created && created.temporary_password && (
        <div className="created-panel">
          <div className="alert success">{created.message}</div>
          <dl className="info-grid">
            <div>
              <dt>Username</dt>
              <dd>
                <code>{created.user.username}</code>
              </dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{ROLE_LABELS[created.user.role] || created.user.role}</dd>
            </div>
            <div className="span-2">
              <dt>Temporary password (shown only once)</dt>
              <dd>
                <code className="temp-pass">{created.temporary_password}</code>
              </dd>
            </div>
          </dl>
          <div className="actions">
            <button className="btn" onClick={() => setCreated(null)}>
              Create another
            </button>
          </div>
        </div>
      )}

      {open && notice && (
        <div className="created-panel">
          <div className={`alert ${notice.type}`}>{notice.text}</div>
          <dl className="info-grid">
            <div>
              <dt>Username</dt>
              <dd>
                <code>{created.user.username}</code>
              </dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{ROLE_LABELS[created.user.role] || created.user.role}</dd>
            </div>
            <div className="span-2">
              <dt>Email</dt>
              <dd>{created.user.email}</dd>
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
              <input
                name="first_name"
                value={form.first_name}
                onChange={handleChange}
                required
              />
            </label>
            <label>
              Last name
              <input
                name="last_name"
                value={form.last_name}
                onChange={handleChange}
                required
              />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                value={form.email}
                onChange={handleChange}
                required
              />
            </label>
            <label>
              Username
              <input
                name="username"
                value={form.username}
                onChange={handleChange}
                required
              />
            </label>
          </div>
          <label>
            Role
            <select name="role" value={form.role} onChange={handleChange}>
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r] || r}
                </option>
              ))}
            </select>
          </label>
          <label>
            How they get their password
            <select
              name="delivery"
              value={form.delivery}
              onChange={handleChange}
            >
              {DELIVERY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {form.delivery === "temporary_password" && (
            <div className="alert info">
              Use this only if email is not working. You will see the password
              once and must hand it over yourself, and the official has to
              change it the first time they sign in. Choosing this is recorded
              in the activity log.
            </div>
          )}
          <div className="actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>
      )}

      <StaffAccountList reloadToken={listToken} />
    </div>
  );
}

// The Secretary's Staff accounts page, /secretary/staff-accounts, opened from
// the account menu. A div, not a <main>: PageLayout already renders the
// page's one <main className="dash-main"> around this. staff-accounts-page
// scopes this page's own rules in index.css.
export default function StaffAccountsPage() {
  return (
    <div className="capped-column staff-accounts-page">
      <StaffAccountsSection />
    </div>
  );
}
