import { useCallback, useEffect, useRef, useState } from "react";
import { IoIosClose } from "react-icons/io";
import { useAuth } from "../auth/AuthContext";
import {
  chargeMeta,
  CHARGE_TYPE_LABELS,
  formatDate,
  formatDateOnly,
  METHOD_LABELS,
} from "../constants/requestStatus";
import { formatSchedule } from "../constants/rentals";
import {
  isAutomatic,
  isZeroFee,
  latestPayment,
  methodOf,
} from "../utils/chargeMethod";

// Payment verification queue for ALL charge types (document fees since stage
// 4b, rental fees since Facility Rentals stage 4). Used by BOTH the Treasurer
// (their landing page) and the Secretary (a Payments tab) — pass the role's
// title and nav.
//
// ONE LINE PER ROW (9 Oct 2026). A row shows who, what for, the amount, a
// one-word Method label (utils/chargeMethod.js), the status, the billed date
// and one View button.
// Everything else, and both money actions (Record and Re-check), is in the
// View panel, which copies the /login modal: see "Overlays follow one
// pattern" in CLAUDE.md.
const FILTERS = ["UNPAID", "PAID", "VOID", "all"];
const FILTER_LABELS = {
  UNPAID: "Needs verification",
  PAID: "Paid",
  VOID: "Void",
  all: "All charges",
};

// Re-check outcomes that mean the charge is ALREADY paid although this call
// recorded nothing (SETTLE_OUTCOME in backend/src/routes/payments.js). The
// list reloads for these as it does for a new payment, so the charge stops
// showing as unpaid and its panel, which still offers Record, closes.
const ALREADY_PAID = [
  "already_recorded",
  "already_processed",
  "already_paid_manually",
];

function fullName(p) {
  if (!p) return null;
  const name = [p.first_name, p.middle_name, p.last_name]
    .filter(Boolean)
    .join(" ");
  if (!name) return null;
  return p.suffix ? `${name}, ${p.suffix}` : name;
}

function payerName(charge) {
  // Document charges carry the verified resident record. Rentals name their
  // own borrower since migration 022 — a linked resident record, or a guest
  // from another barangay typed in at the counter — and only fall back to the
  // payer account's profile name when neither is present, because the payer
  // link is null for a walk-in resident with no account and for every guest.
  // A FINE is owed by a HOUSEHOLD and often has no account behind it at all,
  // so it names the head — and if the household has no head on file, the
  // household number, which always exists.
  if (charge.charge_type === "FINE") {
    return (
      charge.household_records?.head_name ||
      (charge.household_id ? `Household #${charge.household_id}` : "—")
    );
  }
  const name =
    fullName(charge.document_requests?.resident_records) ||
    fullName(charge.rental_requests?.resident_records) ||
    charge.rental_requests?.outside_borrower_name ||
    fullName(charge.payer?.profiles);
  if (name) return name;
  return charge.payer?.username ? `@${charge.payer.username}` : "—";
}

// What the charge is for, per type.
function chargeSubject(charge) {
  if (charge.rental_requests) {
    return {
      main: `${charge.rental_requests.rental_items?.name || "Rental"}${charge.rental_requests.quantity_requested > 1 ? ` × ${charge.rental_requests.quantity_requested}` : ""}`,
      note: formatSchedule(
        charge.rental_requests.start_datetime,
        charge.rental_requests.end_datetime,
      ),
    };
  }
  if (charge.charge_type === "FINE") {
    return {
      main: `Missed ${charge.events?.title || "barangay activity"}`,
      note: charge.household_records?.address || null,
    };
  }
  return {
    main: charge.document_requests?.document_types?.name || charge.charge_type,
    note: null,
  };
}

// What the resident declared, for the panel. "Walk-in" only where no account
// is behind the charge — a walk-in encoded at the counter, a guest, most
// household fines; with an account the resident can still declare from home.
function declaredText(c) {
  if (c.declared_method)
    return METHOD_LABELS[c.declared_method] || c.declared_method;
  return c.payer ? "Nothing declared yet" : "Nothing declared yet (walk-in)";
}

// The gateway's part, which is not a declaration: a charge paid through it
// arrived already confirmed. The panel shows this BESIDE any declared GCash
// reference; the old one-line summary hid the reference once a checkout had
// been started. Not on a paid charge, whose panel shows the payment record
// instead: a PayMongo payment's reference is this same id.
function onlineNote(c) {
  if (c.paymongo_payment_id) return `GCash online · ${c.paymongo_payment_id}`;
  if (c.paymongo_session_id && c.status === "UNPAID")
    return "GCash online — started, not yet confirmed";
  return null;
}

// formatDate's style, in Manila time whatever clock the viewer's computer
// keeps: when a payment was made is a fact about the barangay's day.
function formatManila(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  });
}

// Who recorded a payment: PayMongo when nobody did, otherwise the staff
// member's name, or their username when their profile has no name.
function recordedBy(payment) {
  if (isAutomatic(payment)) return "PayMongo (automatic)";
  const recorder = payment.recorder;
  return (
    fullName(recorder?.profiles) ||
    (recorder?.username ? `@${recorder.username}` : "—")
  );
}

// The Record section of the View panel. `busy` and `setBusy` belong to the
// page, so the panel can refuse to close and Re-check can wait while a
// payment is being recorded; handleSubmit is unchanged. `locked` holds the
// button while Re-check is in flight.
function VerifyPanel({ charge, onDone, busy, setBusy, locked }) {
  const { authFetch } = useAuth();
  const [method, setMethod] = useState(charge.declared_method || "onsite");
  const [reference, setReference] = useState(charge.declared_reference || "");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await authFetch(`/charges/${charge.charge_id}/verify`, {
        method: "POST",
        body: {
          payment_method: method,
          reference_no: reference.trim() || undefined,
        },
      });
      onDone({
        type: "success",
        text: `${data.message} (payment #${data.payment.payment_id})`,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="pay-panel-section">
      <h3>Verify / record</h3>

      {error && <div className="alert error">{error}</div>}

      {/* Each label is one line above its own field, so the two fields share
          their top edge; the optional hint is helper text under the field,
          which used to sit in the label and wrap it onto a second line. */}
      <form onSubmit={handleSubmit}>
        <div className="pay-panel-fields">
          <div className="pay-field">
            <label htmlFor="pay-method">Payment method</label>
            <select
              id="pay-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="onsite">Cash (on-site)</option>
              <option value="gcash">GCash</option>
            </select>
          </div>
          <div className="pay-field">
            <label htmlFor="pay-reference">Reference no.</label>
            <input
              id="pay-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={100}
              required={method === "gcash"}
              aria-describedby={
                method !== "gcash" ? "pay-reference-help" : undefined
              }
              placeholder={
                method === "gcash"
                  ? "GCash reference number"
                  : "Official receipt no."
              }
            />
            {method !== "gcash" && (
              <p className="pay-help" id="pay-reference-help">
                Optional — e.g. OR number
              </p>
            )}
          </div>
        </div>
        <button
          className="btn pay-record"
          type="submit"
          disabled={busy || locked}
        >
          {busy
            ? "Recording…"
            : `Record payment of ₱${Number(charge.amount).toFixed(2)}`}
        </button>
      </form>
    </section>
  );
}

// The View panel: a header (charge, payer, status, Close), the details, which
// scroll when the panel is short, and for an unpaid charge the actions,
// pinned under the details so Record never needs a scroll. Its effects
// (Escape, the scroll lock, focus) live in the page, which owns the busy
// state they depend on.
function ChargePanel({
  charge: c,
  panelRef,
  flash,
  busy,
  verifying,
  setVerifying,
  rechecking,
  onRecheck,
  onRecorded,
  onClose,
}) {
  const subject = chargeSubject(c);
  const online = onlineNote(c);
  const unpaid = c.status === "UNPAID";
  const paid = c.status === "PAID";
  const payment = paid ? latestPayment(c) : null;
  const meta = chargeMeta(c.status);
  return (
    <div className="modal-overlay pay-panel-overlay" onClick={onClose}>
      <div
        className="pay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-panel-charge pay-panel-title"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pay-panel-head">
          <div className="pay-panel-heading">
            <p className="pay-panel-meta">
              <span id="pay-panel-charge">Charge #{c.charge_id}</span>
              <span aria-hidden="true">·</span>
              <span>{CHARGE_TYPE_LABELS[c.charge_type] || c.charge_type}</span>
              <span className={`badge ${meta.className}`}>{meta.label}</span>
            </p>
            <h2 id="pay-panel-title">{payerName(c)}</h2>
            {c.payer?.username && (
              <p className="pay-panel-user">@{c.payer.username}</p>
            )}
          </div>
          <button
            type="button"
            className="pay-panel-x"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <IoIosClose size={26} aria-hidden="true" />
          </button>
        </div>

        <div className="pay-panel-main">
          <div className="pay-panel-details">
            {!unpaid && <p className="pay-panel-note">Read-only</p>}

            {/* One label column, one value column: every field on its own
                row. A paid charge shows its payment record from the list
                payload (the latest row, as the Method column reads it): when
                it was paid, in Manila time; the column's Method label; the
                reference; and who recorded it. A paid charge with no payment
                row says why instead: no payment was needed when its amount
                is 0, otherwise no record is on file. A void one says
                "Void.". What the resident declared still shows below, on any
                charge that has a declaration. */}
            <dl className="pay-panel-list">
              <dt>For</dt>
              <dd>{subject.main}</dd>
              {c.rental_requests && (
                <>
                  <dt>Schedule</dt>
                  <dd>{subject.note}</dd>
                </>
              )}
              {c.charge_type === "FINE" && subject.note && (
                <>
                  <dt>Household address</dt>
                  <dd>{subject.note}</dd>
                </>
              )}
              {c.document_requests?.purpose && (
                <>
                  <dt>Purpose</dt>
                  <dd>{c.document_requests.purpose}</dd>
                </>
              )}
              <dt>Amount</dt>
              <dd className="pay-amount">₱{Number(c.amount).toFixed(2)}</dd>
              <dt>Billed</dt>
              <dd>{formatDate(c.created_at)}</dd>
              {payment && (
                <>
                  <dt>Paid on</dt>
                  <dd>{formatManila(payment.created_at)}</dd>
                  <dt>Method</dt>
                  <dd>{methodOf(c)}</dd>
                  <dt>Reference</dt>
                  <dd>{payment.reference_no || "—"}</dd>
                  <dt>Recorded by</dt>
                  <dd>{recordedBy(payment)}</dd>
                </>
              )}
              {paid && !payment && (
                <>
                  <dt>Payment</dt>
                  <dd>
                    {isZeroFee(c)
                      ? "No payment needed (no fee)."
                      : "No payment record on file."}
                  </dd>
                </>
              )}
              {!unpaid && !paid && (
                <>
                  <dt>Payment</dt>
                  <dd>Void.</dd>
                </>
              )}
              {(unpaid || c.declared_method) && (
                <>
                  <dt>Declared payment</dt>
                  <dd className={c.declared_method ? undefined : "muted"}>
                    {declaredText(c)}
                  </dd>
                  {c.declared_at && (
                    <>
                      <dt>Declared on</dt>
                      <dd>{formatDate(c.declared_at)}</dd>
                    </>
                  )}
                </>
              )}
              {c.declared_reference && (
                <>
                  <dt>GCash reference</dt>
                  <dd>{c.declared_reference}</dd>
                </>
              )}
              {online && !paid && (
                <>
                  <dt>Online payment</dt>
                  <dd>{online}</dd>
                </>
              )}
            </dl>
          </div>

          {/* Re-check comes before Record: a checkout that went through
              should be found before anyone records a second payment by
              hand. Its result is announced here (role="status") while the
              panel stays open; when the charge turns out to be paid, the
              panel closes and the message moves above the list. */}
          {unpaid && (
            <div className="pay-panel-actions">
              {c.paymongo_session_id && (
                <section className="pay-panel-section">
                  <h3>Check with PayMongo</h3>
                  <div className="pay-panel-recheck">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={rechecking || verifying}
                      onClick={onRecheck}
                    >
                      {rechecking ? "Checking…" : "Re-check with PayMongo"}
                    </button>
                    <p className="pay-help">
                      Ask PayMongo whether this online payment went through.
                    </p>
                  </div>
                  <div role="status" className="pay-panel-message">
                    {flash && (
                      <div className={`alert ${flash.type}`}>{flash.text}</div>
                    )}
                  </div>
                </section>
              )}

              <VerifyPanel
                charge={c}
                onDone={onRecorded}
                busy={verifying}
                setBusy={setVerifying}
                locked={rechecking}
              />
            </div>
          )}
        </div>

        {/* A phone has no corner Close: this full-width one, pinned at the
            foot, takes its place (index.css shows it at 640px and below). */}
        <div className="pay-panel-footer">
          <button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Why a load failed, for "Could not load the charges: …". The server's own
// message when it sent one (the API's errors are plain sentences, never a
// stack). Anything else, a server that could not be reached or an answer with
// no message in it, gets a plain fallback rather than the client's own text.
function loadFailure(err) {
  const sent = err?.data?.error;
  return typeof sent === "string" && sent.trim()
    ? sent.trim()
    : "the server did not respond";
}

export default function PaymentsPage() {
  const { authFetch } = useAuth();
  const [filter, setFilter] = useState("UNPAID");
  const [charges, setCharges] = useState(null); // null = loading, or a failed load
  const [loadError, setLoadError] = useState(null); // why the last load failed
  const [flash, setFlash] = useState(null);
  const [selected, setSelected] = useState(null); // charge open in the View panel
  const [recheckingId, setRecheckingId] = useState(null);
  const [verifying, setVerifying] = useState(false);
  // The View button that opened the panel, captured from the click, so a
  // close can give focus back to it (closeModal in LoginPage.jsx).
  const openerRef = useRef(null);
  const panelRef = useRef(null);
  const flashRef = useRef(null);
  // Set when the panel closes because its charge was just paid: focus then
  // goes to the message rather than back to the View button.
  const toMessageRef = useRef(false);
  // Numbers each load, so only the newest one may change the page.
  const loadSeq = useRef(0);

  // Safety net for the GCash gateway: PayMongo disables a webhook endpoint
  // after repeated delivery failures and never replays what was missed, so a
  // payment can be genuinely made yet never confirmed here. This asks PayMongo
  // directly and settles the charge through the same server-side path the
  // webhook uses — so it can never double-record.
  async function handleRecheck(c) {
    setFlash(null);
    setRecheckingId(c.charge_id);
    try {
      const data = await authFetch(`/payments/gcash/reconcile/${c.charge_id}`, {
        method: "POST",
      });
      setFlash({
        type: data.settled ? "success" : "error",
        text: data.message,
      });
      if (data.settled || ALREADY_PAID.includes(data.outcome)) await load();
    } catch (err) {
      setFlash({ type: "error", text: err.message });
    } finally {
      setRecheckingId(null);
    }
  }

  // A FAILED LOAD IS NOT AN EMPTY LIST. This used to store [] beside the
  // error, so the page said "0 charges" and "No charges awaiting
  // verification" while it knew nothing, which reads as nobody owing
  // anything. charges now stays null and the error takes the place of the
  // rows, the count and the empty text (CLAUDE.md: a list that failed to
  // load). Every load starts from the loading state, and an older answer that
  // arrives late (the status changed twice, Refresh pressed during a reload)
  // is dropped rather than shown over a newer one.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    setCharges(null);
    try {
      const data = await authFetch(`/charges?status=${filter}`);
      if (seq === loadSeq.current) setCharges(data.charges);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(loadFailure(err));
    }
  }, [authFetch, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const busy = verifying || recheckingId !== null;
  const openId = selected ? selected.charge_id : null;

  function openPanel(c, opener) {
    openerRef.current = opener;
    setFlash(null);
    setSelected(c);
  }

  // EVERY close route goes through this — Escape, the Close button and the
  // backdrop — and gives focus back to the View button. Refused while Record
  // or Re-check is in flight, so their result never lands on a panel that is
  // no longer there.
  const closePanel = useCallback(() => {
    if (busy) return;
    setSelected(null);
    openerRef.current?.focus();
  }, [busy]);

  // After Record succeeds: the panel closes, the list reloads, and focus goes
  // to the message (the effect further down).
  function handleRecorded(result) {
    setVerifying(false);
    toMessageRef.current = true;
    setSelected(null);
    setFlash(result);
    load();
  }

  // Body-scroll lock and focus, only while the panel is open, and undone in
  // the cleanup: the /login modal's effect. Keyed on the open charge, so a
  // panel opened for another charge runs it again.
  useEffect(() => {
    if (openId === null) return undefined;
    // Captured, not assumed to be '': restoring a value the page did not have
    // would be its own bug.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [openId]);

  useEffect(() => {
    if (openId === null) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [openId, closePanel]);

  // The panel shows the charge as it was when View was pressed. When a reload
  // shows that charge is no longer unpaid — Re-check has just settled it, or
  // found it already paid — the panel has nothing left to offer, so it closes
  // and focus goes to the message, as after Record. A reload that FAILS closes
  // it too, so the load error behind it shows: Re-check reloads only once it
  // has found the charge paid. It waits until nothing is in flight, because
  // handleRecheck reloads before it clears its busy state, and while a load is
  // still out.
  useEffect(() => {
    if (!selected || selected.status !== "UNPAID" || busy) return;
    if (charges === null && !loadError) return;
    const now = charges?.find((c) => c.charge_id === selected.charge_id);
    if (!now || now.status !== "UNPAID") {
      toMessageRef.current = true;
      setSelected(null);
    }
  }, [charges, loadError, selected, busy]);

  // Focus to the message after a payment: the row that held the View button
  // has usually left the list (Needs verification shows unpaid charges only),
  // so there is no button to give focus back to.
  useEffect(() => {
    if (selected || !toMessageRef.current || !flash) return;
    toMessageRef.current = false;
    flashRef.current?.focus();
  }, [selected, flash]);

  return (
    <>
      {flash && !selected && (
        <div ref={flashRef} tabIndex={-1} className={`alert ${flash.type}`}>
          {flash.text}
        </div>
      )}
      <div className="list-head">
        <h2>
          {charges === null
            ? "Charges"
            : `${charges.length} charge${charges.length === 1 ? "" : "s"}`}
        </h2>
        <div className="head-actions">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {FILTER_LABELS[f]}
              </option>
            ))}
          </select>
          <button className="btn secondary" onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      {/* The error first, then loading, then empty, then rows: a load that
          failed shows neither a count nor the empty text. Try again repeats
          the same load, as Refresh does. The markup is Staff accounts'. */}
      {loadError ? (
        <>
          <div className="alert error" role="alert">
            Could not load the charges: {loadError}
          </div>
          <button type="button" className="btn secondary" onClick={load}>
            Try again
          </button>
        </>
      ) : charges === null ? (
        <p className="muted">Loading charges…</p>
      ) : charges.length === 0 ? (
        <div className="empty">
          <p>
            No charges{" "}
            {filter === "UNPAID" ? "awaiting verification" : "here"}.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table stack-narrow payments-table">
            <thead>
              <tr>
                <th className="pay-resident">Resident</th>
                <th className="pay-for">For</th>
                <th className="num">Amount</th>
                <th className="pay-method">Method</th>
                <th>Status</th>
                <th className="col-billed">Billed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => {
                const name = payerName(c);
                const subject = chargeSubject(c);
                return (
                  <tr key={c.charge_id}>
                    <td className="pay-fluid" data-label="Resident">
                      <span className="pay-cut" title={name}>
                        <strong>{name}</strong>
                      </span>
                    </td>
                    <td className="pay-fluid" data-label="For">
                      <span className="pay-cut" title={subject.main}>
                        {subject.main}
                      </span>
                    </td>
                    <td className="num" data-label="Amount">
                      ₱{Number(c.amount).toFixed(2)}
                    </td>
                    <td className="muted pay-method" data-label="Method">
                      {methodOf(c)}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`badge ${chargeMeta(c.status).className}`}
                      >
                        {chargeMeta(c.status).label}
                      </span>
                    </td>
                    <td className="muted col-billed" data-label="Billed">
                      {formatDateOnly(c.created_at)}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={(e) => openPanel(c, e.currentTarget)}
                        aria-label={`View charge for ${name}: ${subject.main}`}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ChargePanel
          key={selected.charge_id}
          charge={selected}
          panelRef={panelRef}
          flash={flash}
          busy={busy}
          verifying={verifying}
          setVerifying={setVerifying}
          rechecking={recheckingId === selected.charge_id}
          onRecheck={() => handleRecheck(selected)}
          onRecorded={handleRecorded}
          onClose={closePanel}
        />
      )}
    </>
  );
}
