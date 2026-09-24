import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { API_BASE_URL } from "../api/config";
import { ApiError } from "../api/client";
import DashHeader from "../components/DashHeader";
import { formatDate } from "../constants/requestStatus";
import { formatSchedule } from "../constants/rentals";
import SearchBar from "../components/SearchBar";

// Resident Records Management: browse + search the master list (stage 1),
// add with the fuzzy duplicate check + edit (stage 2), archive/unarchive with
// the linked-account cascade (stage 3), and the masterlist as CSV — export and
// a previewed bulk import (stage 4).
//
// Shared by three roles, like RentalBookingsPage/DisputesPage/HouseholdsPage:
// the Secretary passes canManage, Staff and the Punong Barangay do not. Every
// write control is ABSENT rather than disabled, and the server refuses the
// writes regardless (every write route, and the export, is
// requireRole('secretary')).
//
// SEPARATELY from canManage, the SERVER decides which COLUMNS come back: a
// Staff response omits birthplace, sex, civil_status, religion,
// educational_attainment, contact_number and date_registered, and carries
// account: null / linked_accounts: []. This component therefore renders what
// it was given and never asks who the viewer is — `key in record` is a test of
// the DATA, not of the role. Adding a role check here would put a second
// opinion next to the server's, free to disagree with it.

// Detail rows that may or may not be present depending on the viewer's
// projection. Order matches the old fixed markup.
const OPTIONAL_DETAIL_FIELDS = [
  { key: "birthdate", label: "Birthdate" },
  { key: "birthplace", label: "Birthplace" },
  { key: "sex", label: "Sex" },
  { key: "civil_status", label: "Civil status" },
  { key: "religion", label: "Religion" },
  { key: "educational_attainment", label: "Educational attainment" },
  { key: "contact_number", label: "Contact number" },
  // Withheld from Staff (migration 018) for the same reason date_registered
  // is: no Staff task uses it, and the six-month residency judgement belongs
  // to the Secretary. The row disappears for Staff because the KEY IS ABSENT
  // from a narrowed payload — the filter below tests `key in r` and never the
  // viewer's role.
  { key: "masterlist_registered_on", label: "Registered in masterlist" },
];

const ARCHIVED_FILTERS = [
  { value: "false", label: "Active records" },
  { value: "true", label: "Archived records" },
  { value: "all", label: "All records" },
];

const SEX_OPTIONS = ["Male", "Female"];
const CIVIL_STATUS_OPTIONS = ["Single", "Married", "Widowed", "Separated"];

// EMPTY_FORM is also what the EDIT form prefills from — it maps over these
// keys against the record — so a writable column missing here is silently
// dropped on save rather than merely absent from the add form.
const EMPTY_FORM = {
  first_name: "",
  middle_name: "",
  last_name: "",
  suffix: "",
  birthdate: "",
  birthplace: "",
  address: "",
  sex: "",
  civil_status: "",
  religion: "",
  educational_attainment: "",
  contact_number: "",
  masterlist_registered_on: "",
};

function fullName(r) {
  const name = [r.first_name, r.middle_name, r.last_name]
    .filter(Boolean)
    .join(" ");
  return r.suffix ? `${name}, ${r.suffix}` : name;
}

// Ranked duplicate candidates from the two-stage matching engine. Shown so the
// Secretary can judge whether this is the same person — never a hard block.
function DuplicateMatches({ matches }) {
  if (matches === null) return null;
  if (matches.length === 0) {
    return <p className="muted">No likely duplicates found for that name.</p>;
  }
  return (
    <>
      <p className="muted">
        {matches.length} existing record{matches.length === 1 ? "" : "s"} may be
        the same person:
      </p>
      <ul className="suggestions">
        {matches.map((m) => (
          <li key={m.resident_id} className="suggestion">
            <span className="badge score">
              {Math.round(m.score * 100)}% match
            </span>
            <div className="suggestion-info">
              <strong>
                {fullName(m)}{" "}
                <span className="muted">(record #{m.resident_id})</span>
              </strong>
              <span className="muted">
                b. {m.birthdate || "—"} · {m.address || "—"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// One form for both add and edit. `record` null => add mode (runs the
// duplicate check); otherwise edit mode (no duplicate check — correcting an
// existing person is not creating a new identity).
function RecordForm({ record, onDone }) {
  const { authFetch } = useAuth();
  const isEdit = !!record;
  const [form, setForm] = useState(() =>
    record
      ? Object.fromEntries(
          Object.keys(EMPTY_FORM).map((k) => [
            k,
            record[k] == null ? "" : String(record[k]),
          ]),
        )
      : { ...EMPTY_FORM },
  );
  const [matches, setMatches] = useState(null); // null = not checked yet
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const canCheck = form.first_name.trim() && form.last_name.trim();

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    // any name edit invalidates a previous check
    if (name === "first_name" || name === "last_name") {
      setMatches(null);
      setNeedsConfirm(false);
    }
  }

  async function handleCheck() {
    setError("");
    setBusy(true);
    try {
      const data = await authFetch("/resident-records/check-duplicates", {
        method: "POST",
        body: { first_name: form.first_name, last_name: form.last_name },
      });
      setMatches(data.matches);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(confirmDuplicate) {
    setError("");
    setBusy(true);
    try {
      const data = isEdit
        ? await authFetch(`/resident-records/${record.resident_id}`, {
            method: "PUT",
            body: form,
          })
        : await authFetch("/resident-records", {
            method: "POST",
            body: { ...form, confirm_duplicate: confirmDuplicate },
          });
      onDone({ type: "success", text: data.message }, data.record);
    } catch (err) {
      // 409 = the server found duplicates and refused to create without an
      // explicit confirmation; show them and switch to the confirm action.
      if (err.status === 409 && err.data?.matches) {
        setMatches(err.data.matches);
        setNeedsConfirm(true);
        setError(err.message);
      } else {
        setError(err.message);
      }
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>{isEdit ? `Edit ${fullName(record)}` : "Add resident record"}</h3>
          {isEdit && <p className="muted">Record #{record.resident_id}</p>}
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        <div className="grid-2">
          <label>
            First name
            <input
              name="first_name"
              value={form.first_name}
              onChange={handleChange}
              maxLength={100}
              required
            />
          </label>
          <label>
            Middle name <span className="hint">(optional)</span>
            <input
              name="middle_name"
              value={form.middle_name}
              onChange={handleChange}
              maxLength={100}
            />
          </label>
          <label>
            Last name
            <input
              name="last_name"
              value={form.last_name}
              onChange={handleChange}
              maxLength={100}
              required
            />
          </label>
          <label>
            Suffix <span className="hint">(Jr., Sr., III)</span>
            <input
              name="suffix"
              value={form.suffix}
              onChange={handleChange}
              maxLength={20}
            />
          </label>
          <label>
            Birthdate
            <input
              name="birthdate"
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={form.birthdate}
              onChange={handleChange}
            />
          </label>
          {/* The barangay's OWN registration date, which the six-month
              residency rule counts from — not date_registered, which is when
              this row was created in BrgyServe and is not writable here.
              Markup mirrors Birthdate above, `max` included: same rule (not in
              the future), same validator on the server. Leaving it blank is
              normal and clears the column on edit. */}
          <label>
            Registered in masterlist <span className="hint">(optional)</span>
            <input
              name="masterlist_registered_on"
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={form.masterlist_registered_on}
              onChange={handleChange}
            />
          </label>
          <label>
            Birthplace
            <input
              name="birthplace"
              value={form.birthplace}
              onChange={handleChange}
              maxLength={255}
            />
          </label>
          <label>
            Sex
            <select name="sex" value={form.sex} onChange={handleChange}>
              <option value="">—</option>
              {SEX_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label>
            Civil status
            <select
              name="civil_status"
              value={form.civil_status}
              onChange={handleChange}
            >
              <option value="">—</option>
              {CIVIL_STATUS_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label>
            Religion
            <input
              name="religion"
              value={form.religion}
              onChange={handleChange}
              maxLength={100}
            />
          </label>
          <label>
            Educational attainment
            <input
              name="educational_attainment"
              value={form.educational_attainment}
              onChange={handleChange}
              maxLength={100}
            />
          </label>
          <label>
            Contact number
            <input
              name="contact_number"
              value={form.contact_number}
              onChange={handleChange}
              maxLength={20}
            />
          </label>
        </div>
        <label>
          Address
          <input
            name="address"
            value={form.address}
            onChange={handleChange}
            maxLength={255}
            required
          />
        </label>

        {!isEdit && (
          <div className="suggest-section">
            <h4>Duplicate check</h4>
            <p className="muted">
              Checks the master list for existing records with a similar name
              before adding.
            </p>
            <DuplicateMatches matches={matches} />
            <div className="actions">
              <button
                className="btn secondary"
                type="button"
                disabled={!canCheck || busy}
                onClick={handleCheck}
              >
                {busy ? "Checking…" : "Check for duplicates"}
              </button>
            </div>
          </div>
        )}

        <div className="actions">
          {needsConfirm ? (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => save(true)}
            >
              {busy ? "Adding…" : "This is a new person — add anyway"}
            </button>
          ) : (
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : isEdit ? "Save changes" : "Add resident"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function RecordDetail({ id, canManage, onBack, onEdit, onChanged }) {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null); // { record, linked_accounts }
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [warning, setWarning] = useState(null); // the 409 dependency payload
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await authFetch(`/resident-records/${id}`));
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch, id]);

  useEffect(() => {
    load();
  }, [load]);

  const r = data?.record;
  // Presence, not contents: a response that OMITS linked_accounts was not told
  // about them, which is a different fact from an empty array meaning "this
  // resident has no account". Only the latter may claim "not registered
  // online" on screen; the former renders no section at all.
  const showAccounts = !!data && "linked_accounts" in data;
  const accounts = data?.linked_accounts || [];

  async function act(action, confirm) {
    setActionError("");
    setBusy(true);
    try {
      const result = await authFetch(`/resident-records/${id}/${action}`, {
        method: "POST",
        body: action === "archive" ? { confirm_archive: confirm } : undefined,
      });
      setWarning(null);
      await load();
      onChanged(result.message);
    } catch (err) {
      // 409 = there are dependencies (open work and/or a linked account that
      // will be deactivated); show them and require an explicit confirmation.
      if (err.status === 409 && err.data?.dependencies) {
        setWarning(err.data);
      }
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>
            {r ? fullName(r) : `Resident record #${id}`}{" "}
            {r?.is_archived && <span className="badge gray">Archived</span>}
          </h3>
          {r && (
            <p className="muted">
              Record #{r.resident_id}
              {"date_registered" in r &&
                ` · registered ${formatDate(r.date_registered)}`}
            </p>
          )}
        </div>
        <div className="head-actions">
          {canManage && r && !r.is_archived && (
            <>
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => onEdit(r)}
              >
                Edit
              </button>
              <button
                className="btn secondary danger"
                disabled={busy}
                onClick={() => act("archive", false)}
              >
                {busy ? "Working…" : "Archive"}
              </button>
            </>
          )}
          {canManage && r?.is_archived && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => act("unarchive")}
            >
              {busy ? "Working…" : "Unarchive"}
            </button>
          )}
          <button className="btn secondary" onClick={onBack}>
            ← Back to list
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {actionError && <div className="alert error">{actionError}</div>}

      {r?.is_archived && (
        <div className="alert info">
          This record is archived: it is hidden from the active master list and
          its linked account cannot log in. Existing document requests and
          rental bookings are unaffected. Unarchive restores both the record and
          the account.
        </div>
      )}

      {canManage && warning && (
        <div className="suggest-section">
          <h4>Archiving this record affects:</h4>
          <ul className="suggestions">
            {warning.dependencies.documents.map((d) => (
              <li key={`d${d.request_id}`} className="suggestion">
                <span className="badge score">Open</span>
                <div className="suggestion-info">
                  <strong>
                    {d.document_types?.name || "Document request"} #
                    {d.request_id}
                  </strong>
                  <span className="muted">status: {d.status}</span>
                </div>
              </li>
            ))}
            {warning.dependencies.rentals.map((b) => (
              <li key={`r${b.request_id}`} className="suggestion">
                <span className="badge score">Active</span>
                <div className="suggestion-info">
                  <strong>
                    {b.rental_items?.name || "Rental booking"} #{b.request_id}
                  </strong>
                  <span className="muted">
                    {formatSchedule(b.start_datetime, b.end_datetime)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {warning.dependencies.accounts.length > 0 && (
            <p>
              <strong>
                Account{warning.dependencies.accounts.length === 1 ? "" : "s"}{" "}
                {warning.dependencies.accounts
                  .map((a) => `@${a.username}`)
                  .join(", ")}{" "}
                will be deactivated and can no longer log in.
              </strong>
            </p>
          )}
          <div className="actions">
            <button
              className="btn secondary danger"
              disabled={busy}
              onClick={() => act("archive", true)}
            >
              {busy
                ? "Archiving…"
                : warning.dependencies.accounts.length
                  ? "Archive and deactivate account"
                  : "Archive anyway"}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => {
                setWarning(null);
                setActionError("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!r ? (
        !error && <p className="muted">Loading record…</p>
      ) : (
        <>
          {/* Only the fields the response actually carried. A row whose key is
              absent is not rendered at all, rather than rendering an em dash
              that would read as "we checked and there is nothing on file" —
              which is a different statement from "you were not sent this". */}
          <dl className="info-grid">
            {OPTIONAL_DETAIL_FIELDS.filter((f) => f.key in r).map((f) => (
              <div key={f.key}>
                <dt>{f.label}</dt>
                <dd>{r[f.key] || "—"}</dd>
              </div>
            ))}
            <div>
              <dt>Archived</dt>
              <dd>{r.is_archived ? "Yes" : "No"}</dd>
            </div>
            <div className="span-2">
              <dt>Address</dt>
              <dd>{r.address}</dd>
            </div>
          </dl>

          {/* The whole section, heading included, is withheld when the response
              did not carry linked_accounts — rendering the heading alone would
              still imply we looked and found nothing. */}
          {showAccounts && (
            <div className="suggest-section">
              <h4>Linked user account</h4>
              {accounts.length === 0 ? (
                <p className="muted">
                  Not linked to any account — this resident has not registered
                  online.
                </p>
              ) : (
                accounts.map((a) => (
                  <p key={a.user_id}>
                    <strong>@{a.username}</strong>
                    {a.email && (
                      <span className="muted"> · {a.email}</span>
                    )}{" "}
                    {a.is_active ? (
                      <span className="badge">Active</span>
                    ) : (
                      <span className="badge gray">Inactive</span>
                    )}
                  </p>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 4 — the masterlist as CSV (Secretary only; rendered under canManage).
//
// All three calls use a raw fetch rather than authFetch, as ReportsPage's CSV
// export does: apiFetch always sends and expects JSON (api/client.js), and
// these send or receive the file itself.
// ---------------------------------------------------------------------------

// The file name's scope word for each ?archived= value.
const EXPORT_SCOPE_WORD = { false: "active", true: "archived", all: "all" };

const manilaDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(
    new Date(),
  );

// POST the CSV text itself as the body. A failure throws ApiError carrying the
// parsed body, like apiFetch's, so a 400/409 that includes a fresh preview can
// re-render it.
async function postCsv(path, text, token) {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv", Authorization: `Bearer ${token}` },
      body: text,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the backend running?", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no JSON body
  }
  if (!res.ok) {
    throw new ApiError(
      data?.error || `Request failed (${res.status})`,
      res.status,
      data,
    );
  }
  return data;
}

// Export button, its scope select, and the file picker that starts an import.
function MasterlistTools({ onPreview, onMessage }) {
  const { token } = useAuth();
  const [scope, setScope] = useState("false");
  const [busy, setBusy] = useState(""); // "" | "export" | "import"
  const fileInput = useRef(null);

  async function exportCsv() {
    onMessage(null);
    setBusy("export");
    try {
      const res = await fetch(
        `${API_BASE_URL}/resident-records/export?archived=${scope}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        let message = `Export failed (${res.status})`;
        try {
          message = (await res.json()).error || message;
        } catch {
          // no JSON body
        }
        throw new Error(message);
      }
      // Named here rather than from Content-Disposition: the API is another
      // origin, and the browser hides that header from a cross-origin fetch.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `resident-masterlist-${EXPORT_SCOPE_WORD[scope]}-${manilaDate()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      onMessage({ type: "error", text: err.message });
    } finally {
      setBusy("");
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    // Cleared so that choosing the same file again (after fixing it) still
    // fires onChange.
    e.target.value = "";
    if (!file) return;
    onMessage(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      onMessage({ type: "error", text: "Choose a .csv file." });
      return;
    }
    setBusy("import");
    try {
      // The text is kept and sent again, unchanged, on commit: the server
      // re-derives every row from it, so the row numbers the Secretary
      // decided on must refer to the same file.
      const text = await file.text();
      const preview = await postCsv(
        "/resident-records/import/preview",
        text,
        token,
      );
      onPreview({ fileName: file.name, text, preview });
    } catch (err) {
      onMessage({ type: "error", text: err.message });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="list-head">
      <span className="muted">Masterlist CSV</span>
      <div className="head-actions">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label="Records to export"
        >
          {ARCHIVED_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          className="btn secondary"
          type="button"
          disabled={!!busy}
          onClick={exportCsv}
        >
          {busy === "export" ? "Exporting…" : "Export masterlist"}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={!!busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy === "import" ? "Checking file…" : "Import masterlist"}
        </button>
        {/* display: none inline, not the hidden attribute: index.css gives
            every input display: block, which outranks the browser's own
            [hidden] rule. The button above opens it. */}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={handleFile}
        />
      </div>
    </div>
  );
}

// In-file matches: other rows of the same file, identified by row number.
function FileMatches({ matches }) {
  return (
    <>
      <p className="muted">
        {matches.length} other row{matches.length === 1 ? "" : "s"} in this
        file may be the same person:
      </p>
      <ul className="suggestions">
        {matches.map((m) => (
          <li key={m.index} className="suggestion">
            <span className="badge score">
              {Math.round(m.score * 100)}% match
            </span>
            <div className="suggestion-info">
              <strong>
                {fullName(m)} <span className="muted">(row {m.index})</span>
              </strong>
              <span className="muted">
                b. {m.birthdate || "—"} · {m.address || "—"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// After a commit: accounts rejected as "not in the masterlist" whose claimed
// name matches a record this import added. INFORMATIONAL ONLY, and there is
// deliberately no button here — the Secretary looks into each one through the
// existing Un-reject flow on Resident review, where the card then shows live
// match suggestions. Nothing about these accounts has been changed.
function RejectedMatchesNotice({ accounts }) {
  const n = accounts.length;
  return (
    <div className="alert info">
      <p>
        <strong>
          {n} previously rejected account{n === 1 ? "" : "s"} may now match
          records you just imported.
        </strong>{" "}
        {n === 1 ? "It was" : "They were"} rejected as not in the masterlist.
        To look into {n === 1 ? "it" : "them"}, open Resident review, set the
        filter to Rejected, and use Un-reject. Nothing has been changed on{" "}
        {n === 1 ? "this account" : "these accounts"}.
      </p>
      <ul>
        {accounts.map((a) => (
          <li key={a.user_id}>
            @{a.username} (claimed name: {a.claimed_name}) →{" "}
            {a.matches
              .map(
                (m) =>
                  `${fullName(m)}, record #${m.resident_id}, ${Math.round(m.score * 100)}%`,
              )
              .join("; ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Why Commit is disabled, when it is.
function blockedReason({ invalid, undecided, importing }) {
  if (invalid > 0) {
    return `${invalid} row${invalid === 1 ? " has" : "s have"} errors. Fix the file and choose it again. The import runs only when every row is valid.`;
  }
  if (undecided > 0) {
    return `Decide the ${undecided} flagged row${undecided === 1 ? "" : "s"} above first.`;
  }
  if (importing === 0) return "Every row is left out, so there is nothing to import.";
  return null;
}

// The preview of one file. Clean rows collapse to a count, flagged rows each
// need an explicit decision, and invalid rows are shown with their error and
// cannot be imported.
function ImportPreview({ file, onDone, onCancel }) {
  const { token } = useAuth();
  const [preview, setPreview] = useState(file.preview);
  // index -> "import" | "skip". A flagged row with no entry is UNDECIDED, and
  // Commit stays disabled until there are none — a <select> with a blank first
  // option rather than a checkbox, because a checkbox cannot tell "not looked
  // at yet" apart from "decided to leave out".
  const [decisions, setDecisions] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = preview.rows;
  const clean = rows.filter((r) => r.status === "clean");
  const flagged = rows.filter((r) => r.status === "flagged");
  const invalid = rows.filter((r) => r.status === "invalid");
  const undecided = flagged.filter((r) => !decisions[r.index]).length;
  const importing =
    clean.length + flagged.filter((r) => decisions[r.index] === "import").length;
  const blocked = blockedReason({
    invalid: invalid.length,
    undecided,
    importing,
  });

  async function commit() {
    setError("");
    setBusy(true);
    const decided = (d) =>
      flagged
        .filter((r) => decisions[r.index] === d)
        .map((r) => r.index)
        .join(",");
    const params = new URLSearchParams();
    if (decided("import")) params.set("confirm_rows", decided("import"));
    if (decided("skip")) params.set("skip_rows", decided("skip"));
    try {
      const data = await postCsv(
        `/resident-records/import/commit?${params}`,
        file.text,
        token,
      );
      onDone(data);
    } catch (err) {
      // A 400 or 409 carrying rows is the server's fresh analysis. Show it and
      // start the decisions over: an answer given to the old preview is not an
      // answer to the new one.
      if (err.data?.rows) {
        setPreview({ rows: err.data.rows, summary: err.data.summary });
        setDecisions({});
      }
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Import preview</h3>
          <p className="muted">
            {file.fileName} · {rows.length} row{rows.length === 1 ? "" : "s"}.
            Nothing has been imported yet.
          </p>
        </div>
        <button className="btn secondary" disabled={busy} onClick={onCancel}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <p>
        <strong>{preview.summary.clean}</strong> ready to import ·{" "}
        <strong>{preview.summary.flagged}</strong> possible duplicate
        {preview.summary.flagged === 1 ? "" : "s"} ·{" "}
        <strong>{preview.summary.invalid}</strong> with errors
      </p>

      {clean.length > 0 && (
        <details>
          <summary>
            Show the {clean.length} row{clean.length === 1 ? "" : "s"} ready to
            import
          </summary>
          <ul>
            {clean.map((r) => (
              <li key={r.index}>
                Row {r.index}: {fullName(r.data)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {invalid.length > 0 && (
        <div className="suggest-section">
          <h4>Rows with errors (these cannot be imported)</h4>
          <div className="table-wrap">
            <table className="data-table stack-narrow">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {invalid.map((r) => (
                  <tr key={r.index}>
                    <td data-label="Row">{r.index}</td>
                    <td data-label="Name">{fullName(r.data) || "—"}</td>
                    <td data-label="Problem">{r.errors.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {flagged.length > 0 && (
        <div className="suggest-section">
          <h4>Possible duplicates: decide each row</h4>
          <p className="muted">
            Same-name residents are real, so nothing here is refused. Import a
            row only if it is a different person from every match shown.
          </p>
          {flagged.map((r) => (
            <div key={r.index} className="suggest-section">
              <div className="head-actions">
                <label className="inline-label" htmlFor={`decide-${r.index}`}>
                  <strong>
                    Row {r.index}: {fullName(r.data)}
                  </strong>
                </label>
                <select
                  id={`decide-${r.index}`}
                  value={decisions[r.index] || ""}
                  disabled={busy}
                  onChange={(e) =>
                    setDecisions((d) => ({ ...d, [r.index]: e.target.value }))
                  }
                >
                  <option value="" disabled>
                    Decide…
                  </option>
                  <option value="import">Import anyway (a different person)</option>
                  <option value="skip">Leave out</option>
                </select>
              </div>
              <p className="muted">
                b. {r.data.birthdate || "—"} · {r.data.address}
              </p>
              {r.db_matches.length > 0 && (
                <DuplicateMatches matches={r.db_matches} />
              )}
              {r.file_matches.length > 0 && (
                <FileMatches matches={r.file_matches} />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="actions">
        <button
          className="btn"
          type="button"
          disabled={busy || !!blocked}
          onClick={commit}
        >
          {busy
            ? "Importing…"
            : `Commit import (${importing} record${importing === 1 ? "" : "s"})`}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {blocked && <p className="muted">{blocked}</p>}
    </div>
  );
}

export default function ResidentRecordsPage({ title, nav, canManage = false }) {
  const { authFetch } = useAuth();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState(""); // the applied search
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [flash, setFlash] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [formTarget, setFormTarget] = useState(null); // 'new' | record object
  const [archived, setArchived] = useState("false");
  // { fileName, text, preview } while an import is being reviewed
  const [importFile, setImportFile] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), archived });
      if (search) params.set("search", search);
      const result = await authFetch(`/resident-records?${params}`);
      setData(result);
    } catch (err) {
      setError(err.message);
      setData({ records: [], total: 0, page: 1, total_pages: 0 });
    }
  }, [authFetch, page, search, archived]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput("");
    setSearch("");
    setPage(1);
  }

  const records = data?.records;

  // Column visibility follows the DATA, not the role: a withheld field is
  // simply not a key on a narrowed row, so the column is dropped rather than
  // filled with em dashes that would read as "nobody has a number on file" /
  // "nobody has registered online" — a positive claim the payload cannot
  // support. `account` only became detectable this way once the server stopped
  // sending it as null; before that a withheld value and a genuine absence
  // were indistinguishable here.
  const showContact = !!records?.some((r) => "contact_number" in r);
  const showAccount = !!records?.some((r) => "account" in r);

  return (
    // <DashHeader title={title} subtitle="Resident master list" nav={nav} />

    <>
      {canManage && formTarget ? (
        <RecordForm
          record={formTarget === "new" ? null : formTarget}
          onDone={(result, record) => {
            const wasAdd = formTarget === "new";
            setFormTarget(null);
            if (!result) return;
            setFlash(result);
            setSelectedId(null);
            if (wasAdd && record) {
              // land back on the list with the new record in view: the master
              // list is paginated by surname, so search for it
              setSearchInput(record.last_name);
              setSearch(record.last_name);
              setPage(1);
            }
            load();
          }}
        />
      ) : canManage && importFile ? (
        <ImportPreview
          file={importFile}
          onCancel={() => setImportFile(null)}
          onDone={(result) => {
            setImportFile(null);
            // The two rejected-account fields ride on the success flash, so
            // the notice lives and dies with it: the next action that sets a
            // flash replaces both.
            setFlash({
              type: "success",
              text: `${result.message}.`,
              rejectedMatches: result.rejected_matches,
              rejectedCheckError: result.rejected_matches_error,
            });
            setSelectedId(null);
            load();
          }}
        />
      ) : selectedId ? (
        <RecordDetail
          id={selectedId}
          canManage={canManage}
          onBack={() => setSelectedId(null)}
          onEdit={(record) => setFormTarget(record)}
          onChanged={(message) => {
            setFlash({ type: "success", text: message });
            load();
          }}
        />
      ) : (
        <>
          {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
          {flash?.rejectedMatches?.length > 0 && (
            <RejectedMatchesNotice accounts={flash.rejectedMatches} />
          )}
          {flash?.rejectedCheckError && (
            <div className="alert error">{flash.rejectedCheckError}</div>
          )}
          {error && <div className="alert error">{error}</div>}

          <div className="list-head">
            <h2>
              {data === null
                ? "Resident records"
                : `${data.total} resident record${data.total === 1 ? "" : "s"}${search ? ` matching "${search}"` : ""}`}
            </h2>
            <SearchBar
              search={search}
              onSearch={handleSearch}
              searchInput={searchInput}
              onSearchInput={(e) => setSearchInput(e.target.value)}
              onClear={clearSearch}
              placeholder={"Search by name, address or purok"}
            />
            <form className="head-actions" onSubmit={handleSearch}>
              <select
                value={archived}
                onChange={(e) => {
                  setArchived(e.target.value);
                  setPage(1);
                }}
              >
                {ARCHIVED_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
              {canManage && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => setFormTarget("new")}
                >
                  Add resident
                </button>
              )}
            </form>
          </div>

          {canManage && (
            <MasterlistTools onPreview={setImportFile} onMessage={setFlash} />
          )}

          {records === undefined || data === null ? (
            <p className="muted">Loading resident records…</p>
          ) : records.length === 0 ? (
            <div className="empty">
              <p>
                {search
                  ? `No resident records match "${search}".`
                  : "No resident records yet."}
              </p>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                {/* stack-narrow: below 640px each record becomes a card
                      instead of a six-column row. The data-label attributes
                      below are what the hidden column headers are replaced
                      with — see ISSUE 8 in index.css. */}
                <table className="data-table stack-narrow">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="col-date">Birthdate</th>
                      <th>Address</th>
                      {showContact && <th>Contact</th>}
                      {showAccount && <th>Account</th>}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr
                        key={r.resident_id}
                        className={r.is_archived ? "inactive-row" : ""}
                      >
                        <td>
                          <strong>{fullName(r)}</strong>
                          {r.is_archived && (
                            <div>
                              <span className="badge gray">Archived</span>
                            </div>
                          )}
                        </td>
                        <td className="muted col-date" data-label="Birthdate">
                          {r.birthdate || "—"}
                        </td>
                        <td className="muted">{r.address}</td>
                        {showContact && (
                          <td className="muted" data-label="Contact">
                            {r.contact_number || "—"}
                          </td>
                        )}
                        {showAccount && (
                          <td data-label="Account">
                            {r.account ? (
                              <span className="badge">
                                @{r.account.username}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        )}
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
    </>
  );
}
