import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import DashHeader from "../components/DashHeader";
import ResidentPicker from "../components/ResidentPicker";
import {
  statusMeta,
  chargeMeta,
  chargeOf,
  formatDate,
  STATUS_META,
} from "../constants/requestStatus";

// Document request processing. Shared by three roles: the Secretary passes
// canManage and gets the four workflow actions; Staff and the Punong Barangay
// view only, with every write control ABSENT (the server keeps all four
// transitions on requireRole('secretary') regardless).
//
// The SERVER also narrows what comes back — a Staff response drops the
// resident's birthplace, sex, civil_status, contact_number and date_registered
// and the requester's email. This component renders whatever it was handed and
// never checks the viewer's role to decide: `key in object` tests the DATA.

const FILTERS = [
  "pending",
  "all",
  ...Object.keys(STATUS_META).filter((s) => s !== "pending"),
];

// Resident rows that may be absent depending on the viewer's projection.
const OPTIONAL_RESIDENT_FIELDS = [
  { key: "birthdate", label: "Birthdate" },
  { key: "birthplace", label: "Birthplace" },
  { key: "sex", label: "Sex" },
  { key: "civil_status", label: "Civil status" },
  { key: "contact_number", label: "Contact number" },
];

function personName(p) {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name]
    .filter(Boolean)
    .join(" ");
  return p.suffix ? `${name}, ${p.suffix}` : name;
}

// The handle beneath the name is the SUBJECT'S account — the resident the
// request is for — never the requester's. They are the same person on a
// self-service row and different on a walk-in, where the requester is the
// Secretary; printing requester.username put "@secretary1" under the
// resident's name on every walk-in. `account` arrives inside resident_records
// only when the server sends it (the Staff projection withholds it), so this
// tests the KEY, never the viewer's role: absent renders nothing; null means
// the resident has no online account, said plainly rather than left blank.
function AccountNote({ record }) {
  if (!record || !("account" in record)) return null;
  return (
    <div className="muted small-note">
      {record.account?.username
        ? `@${record.account.username}`
        : "No online account"}
    </div>
  );
}

function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

function RequestDetail({ id, canManage, onBack }) {
  const { authFetch } = useAuth();
  const [request, setRequest] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [flash, setFlash] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [acted, setActed] = useState(false); // tells the list to refresh on back

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch(`/document-requests/${id}`);
        if (!cancelled) setRequest(data.request);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, id]);

  async function decide(action) {
    setBusy(true);
    setFlash(null);
    try {
      const data = await authFetch(`/document-requests/${id}/${action}`, {
        method: "POST",
        body: action === "reject" ? { reason } : undefined,
      });
      setRequest(data.request);
      setFlash({ type: "success", text: data.message });
      setRejecting(false);
      setReason("");
      setActed(true);
    } catch (err) {
      setFlash({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const r = request;
  const resident = r?.resident_records;
  const charge = chargeOf(r);

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Request #{id}</h3>
          {r && (
            <p className="muted">
              @{r.requester?.username}
              {r.requester?.email && ` · ${r.requester.email}`}
            </p>
          )}
        </div>
        <button className="btn secondary" onClick={() => onBack(acted)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}
      {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}

      {!r ? (
        !error && <p className="muted">Loading request…</p>
      ) : (
        <>
          <dl className="info-grid">
            <div>
              <dt>Document</dt>
              <dd>{r.document_types?.name}</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd>₱{Number(r.document_types?.fee ?? 0).toFixed(2)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={r.status} />
              </dd>
            </div>
            <div>
              <dt>Charge</dt>
              <dd>
                {charge ? (
                  <>
                    ₱{Number(charge.amount).toFixed(2)}{" "}
                    <span
                      className={`badge ${chargeMeta(charge.status).className}`}
                    >
                      {chargeMeta(charge.status).label}
                    </span>
                  </>
                ) : (
                  <span className="muted">No charge (billed on approval)</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Billed</dt>
              <dd className="muted">
                {charge ? formatDate(charge.created_at) : "—"}
              </dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>{formatDate(r.requested_at)}</dd>
            </div>
            {r.claimed_at && (
              <div>
                <dt>Claimed</dt>
                <dd>{formatDate(r.claimed_at)}</dd>
              </div>
            )}
            <div className="span-2">
              <dt>Purpose</dt>
              <dd>{r.purpose}</dd>
            </div>
            {r.rejection_reason && (
              <div className="span-2">
                <dt>Rejection reason</dt>
                <dd>{r.rejection_reason}</dd>
              </div>
            )}
            {r.processed_by && (
              <div className="span-2">
                <dt>Decision</dt>
                <dd className="muted">
                  by @{r.processed_by.username} on {formatDate(r.processed_at)}
                </dd>
              </div>
            )}
          </dl>

          <div className="suggest-section">
            <h4>Linked resident record (verify the requester)</h4>
            {/* Rows below are rendered only when the response carried them. Sex
                and civil status were one combined row before; they are separate
                now so either can be dropped on its own. (The comment sits here,
                not inside the ternary branch — a JSX comment beside an element
                in a parenthesised branch makes two sibling expressions with no
                wrapper and the build fails.) */}
            {!resident ? (
              <p className="muted">No resident record linked.</p>
            ) : (
              <dl className="info-grid">
                <div>
                  <dt>Name</dt>
                  <dd>
                    <strong>{personName(resident)}</strong>{" "}
                    <span className="muted">
                      (record #{resident.resident_id})
                    </span>
                  </dd>
                </div>
                {OPTIONAL_RESIDENT_FIELDS.filter((f) => f.key in resident).map(
                  (f) => (
                    <div key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{resident[f.key] || "—"}</dd>
                    </div>
                  ),
                )}
                {"date_registered" in resident && (
                  <div>
                    <dt>Registered</dt>
                    <dd>{formatDate(resident.date_registered)}</dd>
                  </div>
                )}
                <div className="span-2">
                  <dt>Address</dt>
                  <dd>{resident.address || "—"}</dd>
                </div>
              </dl>
            )}
          </div>

          {/* Stage 4c release flow: approved + paid → ready_for_release → claimed */}
          {canManage &&
            r.status === "approved" &&
            (charge?.status === "PAID" ? (
              <div className="actions">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => decide("ready-for-release")}
                >
                  {busy ? "Working…" : "Mark ready for release"}
                </button>
              </div>
            ) : (
              <p className="muted">
                Awaiting payment — verify it under the Payments tab before
                releasing this document.
              </p>
            ))}

          {canManage && r.status === "ready_for_release" && (
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Mark this document as claimed? This records that it was handed to the resident and cannot be undone.",
                    )
                  ) {
                    decide("claim");
                  }
                }}
              >
                {busy ? "Working…" : "Mark as claimed"}
              </button>
            </div>
          )}

          {canManage && r.status === "pending" && !rejecting && (
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() => decide("approve")}
              >
                {busy ? "Working…" : "Approve request"}
              </button>
              <button
                className="btn secondary danger"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Reject…
              </button>
            </div>
          )}

          {canManage && r.status === "pending" && rejecting && (
            <form
              className="reject-form"
              onSubmit={(e) => {
                e.preventDefault();
                decide("reject");
              }}
            >
              <label>
                Rejection reason (shown to the resident)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={500}
                  required
                  autoFocus
                />
              </label>
              <div
                className={`char-counter muted${reason.length >= 500 ? " at-limit" : ""}`}
              >
                {reason.length}/500
              </div>
              <div className="actions">
                <button
                  className="btn secondary danger"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? "Working…" : "Confirm rejection"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setRejecting(false);
                    setReason("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// The Secretary encodes a request for a resident standing at the hall. It is
// filed under the Secretary's account (requested_by_user_id) and recorded FOR
// the picked resident (resident_id) — the server keeps the two apart.
//
// Built standalone rather than sharing RequestDocumentPage's fields: those
// are inline JSX coupled to that page's own state, and EditPanel in
// RentalBookingsPage already duplicates BookRentalPage's grid the same way.
// Extracting them would be a refactor of a resident-facing page this feature
// does not otherwise touch. The two fields are the same ones that form
// collects; only the resident picker is new. Residents only — Chapter 1
// restricts documents to registered residents, so there is no guest path
// here, unlike bookings.
function WalkInRequestPanel({ onDone }) {
  const { authFetch } = useAuth();
  const [types, setTypes] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [resident, setResident] = useState(null);
  const [form, setForm] = useState({ document_type_id: "", purpose: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch("/document-types");
        if (!cancelled) setTypes(data.document_types);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          setTypes([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const selectedType = types?.find(
    (t) => String(t.document_type_id) === String(form.document_type_id),
  );

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!resident) {
      setError("Pick the resident this request is for.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const data = await authFetch("/document-requests", {
        method: "POST",
        body: {
          resident_id: resident.resident_id,
          document_type_id: Number(form.document_type_id),
          purpose: form.purpose,
        },
      });
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Encode walk-in request</h3>
          <p className="muted">
            For a resident at the barangay hall. Filed under your account and
            recorded for the resident you pick.
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {loadError && <div className="alert error">{loadError}</div>}
      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <label>Resident</label>
        <ResidentPicker
          value={resident}
          onPick={(r) => {
            setResident(r);
            setError("");
          }}
          onClear={() => setResident(null)}
          placeholder="Search the resident master list…"
        />

        {types === null ? (
          <p className="muted">Loading document types…</p>
        ) : types.length === 0 ? (
          <p className="muted">No document types are currently offered.</p>
        ) : (
          <>
            <label>
              Document type
              <select
                name="document_type_id"
                value={form.document_type_id}
                onChange={handleChange}
                required
              >
                <option value="" disabled>
                  Select a document…
                </option>
                {types.map((t) => (
                  <option key={t.document_type_id} value={t.document_type_id}>
                    {t.name} — ₱{Number(t.fee).toFixed(2)}
                  </option>
                ))}
              </select>
            </label>
            {selectedType?.description && (
              <p className="muted type-description">
                {selectedType.description}
              </p>
            )}
            <label>
              Purpose
              <textarea
                name="purpose"
                value={form.purpose}
                onChange={handleChange}
                rows={3}
                maxLength={1000}
                placeholder="e.g. Employment requirement, scholarship application…"
                required
              />
            </label>
            <div className="actions">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Recording…" : "Record request"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

export default function SecretaryRequestsPage({
  title,
  nav,
  canManage = false,
}) {
  const { authFetch } = useAuth();
  const [filter, setFilter] = useState("pending");
  const [requests, setRequests] = useState(null); // null = loading
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [encoding, setEncoding] = useState(false); // walk-in panel open
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    setListError("");
    try {
      const query = filter === "all" ? "" : `?status=${filter}`;
      const data = await authFetch(`/document-requests${query}`);
      setRequests(data.requests);
    } catch (err) {
      setListError(err.message);
      setRequests([]);
    }
  }, [authFetch, filter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    // <DashHeader
    //   title={title}
    //   subtitle={canManage ? 'Process document requests' : 'Document requests across residents'}
    //   nav={nav}
    // />

    <>
      {encoding ? (
        <WalkInRequestPanel
          onDone={(result) => {
            setEncoding(false);
            if (result) {
              setFlash(result);
              load();
            }
          }}
        />
      ) : selectedId ? (
        <RequestDetail
          id={selectedId}
          canManage={canManage}
          onBack={(refresh) => {
            setSelectedId(null);
            if (refresh) load();
          }}
        />
      ) : (
        <>
          {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
          {listError && <div className="alert error">{listError}</div>}

          <div className="list-head">
            <h2>
              {requests === null
                ? "Document requests"
                : `${requests.length} request${requests.length === 1 ? "" : "s"}`}
            </h2>
            <div className="head-actions">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                {FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {f === "all" ? "All statuses" : statusMeta(f).label}
                  </option>
                ))}
              </select>
              <button className="btn secondary" onClick={load}>
                Refresh
              </button>
              {/* Secretary only. canManage is passed by App.jsx on the
                  /secretary route alone — Staff and the Punong Barangay share
                  this component without it — so this is the role gate, in
                  the same prop the four workflow actions already key on. */}
              {canManage && (
                <button
                  className="btn"
                  onClick={() => {
                    setFlash(null);
                    setEncoding(true);
                  }}
                >
                  Encode walk-in
                </button>
              )}
            </div>
          </div>

          {requests === null ? (
            <p className="muted">Loading requests…</p>
          ) : requests.length === 0 ? (
            <div className="empty">
              <p>
                No{" "}
                {filter === "all"
                  ? ""
                  : `${statusMeta(filter).label.toLowerCase()} `}
                requests.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table stack-narrow">
                <thead>
                  <tr>
                    <th>Requester</th>
                    <th>Document</th>
                    <th>Purpose</th>
                    <th>Status</th>
                    <th>Submitted</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.request_id}>
                      <td>
                        <strong>
                          {personName(r.resident_records) ||
                            `@${r.requester?.username}`}
                        </strong>
                        <AccountNote record={r.resident_records} />
                      </td>
                      <td data-label="Document">{r.document_types?.name}</td>
                      <td className="muted truncate" data-label="Purpose">
                        {r.purpose}
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="muted" data-label="Submitted">
                        {formatDate(r.requested_at)}
                      </td>
                      <td className="row-actions">
                        <button
                          className="btn secondary"
                          onClick={() => setSelectedId(r.request_id)}
                        >
                          {canManage ? "Review" : "View"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
