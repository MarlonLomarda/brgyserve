import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";

// The resident's own blotter cases, read-only (GET /api/disputes/mine).
//
// The server decides what is shown: only cases where this resident's own
// record is a party, and only each case's label fields plus the resident's
// role in it. No other party is named here and none is sent. There are no
// write actions on this page — only the Barangay Secretary adds or updates
// cases.
//
// A person recorded only by a typed name is never linked to a resident record,
// so an empty list means "no cases are linked to your record", never "you are
// in no cases" — the wording below says exactly that.

// Every reason the server can give for having no list to show. Not errors: an
// account without a linked record is a known state, so it gets a plain message.
const REASON_MESSAGE = {
  no_resident_record:
    "Your account is not linked to a resident record yet. The Barangay Office links it when your registration is approved.",
};

const FALLBACK_MESSAGE =
  "Your dispute records cannot be shown for this account. Please contact the Barangay Office.";

// date_filed is a plain YYYY-MM-DD date. Read it as a local calendar date, so
// no timezone can move it to the day before.
function formatFiled(value) {
  const [y, m, d] = String(value || "").split("-").map(Number);
  if (!y || !m || !d) return value || "—";
  return new Date(y, m - 1, d).toLocaleDateString("en-PH", {
    dateStyle: "medium",
  });
}

export default function MyDisputesPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await authFetch("/disputes/mine"));
    } catch (err) {
      // null, never an empty list: a failed request must not read as
      // "no cases are linked to your record".
      setError(err.message);
      setData(null);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  const cases = data && !data.reason ? data.cases || [] : null;

  return (
    <>
      <div className="pending-card">
        <div className="pending-head">
          <h3>My disputes</h3>
        </div>
        <p className="muted">
          These are the cases recorded under your resident record. They are
          read-only; only the Barangay Secretary can add or update cases. If
          you think a case is missing, please contact the Barangay Secretary.
        </p>

        {/* Error first, then loading, then the reason, then the list — so a
            failed request never reaches the empty-state line. */}
        {error && <div className="alert error">{error}</div>}

        {!error && data === null && <p className="muted">Loading…</p>}

        {data && data.reason && (
          <div className="empty">
            <p className="muted">
              {REASON_MESSAGE[data.reason] || FALLBACK_MESSAGE}
            </p>
          </div>
        )}

        {cases && cases.length === 0 && (
          <div className="empty">
            <p>No cases are linked to your resident record.</p>
          </div>
        )}

        {cases && cases.length > 0 && (
          <div className="table-wrap">
            <table className="data-table stack-narrow">
              <thead>
                <tr>
                  <th>Case no.</th>
                  <th>Date filed</th>
                  <th>Filed for</th>
                  <th>Nature</th>
                  <th>Status</th>
                  <th>Your role</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c, i) => (
                  <tr key={`${c.barangay_case_no}-${i}`}>
                    <td>
                      <strong>{c.barangay_case_no}</strong>
                    </td>
                    <td className="muted" data-label="Date filed">
                      {formatFiled(c.date_filed)}
                    </td>
                    <td data-label="Filed for">{c.filed_for}</td>
                    <td className="muted" data-label="Nature">
                      {c.nature_of_case}
                    </td>
                    <td>
                      <span
                        className={`badge ${c.is_settled ? "status-claimed" : "status-pending"}`}
                      >
                        {c.is_settled ? "Settled" : "Open"}
                      </span>
                    </td>
                    <td data-label="Your role">
                      {(c.my_roles || []).join(" and ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
