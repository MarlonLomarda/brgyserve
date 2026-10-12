import { useCallback, useEffect, useRef, useState } from "react";
import { IoIosClose } from "react-icons/io";
import {
  IoChevronBack,
  IoChevronForward,
  IoClose,
  IoSearch,
} from "react-icons/io5";
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
  ANY,
  backwards,
  DATE_OPTIONS,
  dateKind,
  dateRange,
  dateText,
  manilaToday,
  matchesDate,
  matchesMethod,
  methodOffered,
  methodOptions,
} from "../utils/chargeFilters";
import {
  isAutomatic,
  isZeroFee,
  latestPayment,
  methodOf,
} from "../utils/chargeMethod";
import {
  chargeSearchText,
  inTab,
  matchesTerms,
  searchTerms,
  tabCounts,
  TYPE_TABS,
} from "../utils/chargeSearch";
import { totalsLine } from "../utils/chargeTotals";
import {
  GAP,
  PAGE_SIZE,
  PAGE_SIZES,
  pageItems,
  pageOf,
  pagerText,
} from "../utils/paging";

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
//
// SEARCH, TYPE TABS, TOTALS AND PAGES (12 Oct 2026). Above the rows: a search
// box (utils/chargeSearch.js), the status and Refresh; the type tabs; and the
// totals line (utils/chargeTotals.js), which is the list's h2. Below them,
// the pager (utils/paging.js): "Showing 1 to 25 of 89 results", Rows per
// page (10, 25, 50 or 100, 25 to start), then Previous, the page numbers and
// Next. All of it works on the list already loaded: nothing here sends a
// request.
//
// METHOD AND DATE (12 Oct 2026, batch 7). A second row under the search:
// Method, which mirrors the Method column, and the date, "Billed date" or,
// under Paid, "Paid date", with From and To under "Choose dates"
// (utils/chargeFilters.js). Days are Manila days. Both compose with the
// status, the search and the tabs, and the totals line names the date and
// the range it counts, so it is never read as the Collections report's.
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
  // The search, the type tab, the method, the date (its choice, and From and
  // To for "Choose dates"), the page and the rows per page. All of them start
  // fresh on every visit (the barangay hall's PC is shared, so nothing is
  // kept in the browser) and live through Refresh, Record payment and
  // Re-check, which reload the list without touching them. A new status keeps
  // the search, the tab, the date and the rows per page, keeps the method only
  // where the new view offers it, and goes back to page 1.
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [method, setMethod] = useState(ANY);
  const [dateChoice, setDateChoice] = useState(ANY);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // How many charges the server says the status has. More than it sent means
  // its 1,000-row cap cut the list (routes/charges.js).
  const [total, setTotal] = useState(null);
  const searchRef = useRef(null);
  const methodRef = useRef(null);
  const dateRef = useRef(null);
  const headingRef = useRef(null);
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
    setTotal(null);
    try {
      const data = await authFetch(`/charges?status=${filter}`);
      if (seq === loadSeq.current) {
        setCharges(data.charges);
        setTotal(data.total);
      }
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

  // What is in view: the charges that match the search, then those that
  // match the method and the date, then those of the selected tab, then one
  // page of those. The tab counts come from the second (they follow the
  // search, the method and the date, not the tab), the totals from the third
  // (every match, not just the page on screen). The View panel and the
  // effect above keep using `charges`, the whole list, so a charge the
  // filters hide can neither close its open panel nor stop it closing once
  // it is paid. "Today" is read on every render, so a page left open past
  // midnight moves its presets on with the day.
  const terms = searchTerms(query);
  const searched = (charges || []).filter((c) =>
    matchesTerms(
      chargeSearchText(c, {
        name: payerName(c),
        forText: chargeSubject(c).main,
      }),
      terms,
    ),
  );
  const kind = dateKind(filter);
  const today = manilaToday();
  const range = dateRange(dateChoice, from, to, today);
  const narrowed = searched.filter(
    (c) => matchesMethod(c, method) && matchesDate(c, kind, range),
  );
  const counts = tabCounts(narrowed);
  const shown = narrowed.filter((c) => inTab(c, tab));
  const paging = pageOf(shown.length, page, pageSize);
  const pager = pagerText(paging);
  const rows = shown.slice(paging.start, paging.end);
  // A reload that shrank the list lands on its last page, and stays there.
  // Not while a list is loading: the page must survive the reload itself.
  if (charges !== null && paging.page !== page) setPage(paging.page);
  const capped =
    charges !== null && Number.isFinite(total) && total > charges.length;
  const totals =
    charges === null
      ? null
      : totalsLine({
          status: filter,
          shown,
          received: charges.length,
          total,
          filtered:
            terms.length > 0 || tab !== "all" || method !== ANY || !!range,
          dated: dateText(kind, dateChoice, range, today),
        });
  const methodChoices = methodOptions(filter);
  const reversed = backwards(range);
  const filtersOn = method !== ANY || dateChoice !== ANY;

  // A new status keeps the search, the tab and the date. The method stays
  // only where the new view offers it: Cash means nothing on Needs
  // verification, so there it goes back to Any method.
  function changeStatus(value) {
    setFilter(value);
    if (!methodOffered(value, method)) setMethod(ANY);
    setPage(1);
  }

  // Method, the date choice, From and To: each change goes back to page 1,
  // as a search or a tab change does.
  function narrowBy(set, value) {
    set(value);
    setPage(1);
  }

  function resetMethodAndDate() {
    setMethod(ANY);
    setDateChoice(ANY);
    setFrom("");
    setTo("");
  }

  // "Clear filters" in the second row: the method and the date only. Focus
  // goes to the Method select (the date's under Void, where Method is
  // disabled), because the button pressed is gone once nothing is on.
  function clearMethodAndDate() {
    resetMethodAndDate();
    setPage(1);
    const methodSelect = methodRef.current;
    (methodSelect?.disabled ? dateRef.current : methodSelect)?.focus();
  }

  function changeQuery(value) {
    setQuery(value);
    setPage(1);
  }

  // The Clear (x) button and Escape. Focus stays in the box: the button that
  // was pressed is gone once the box is empty.
  function clearSearch() {
    changeQuery("");
    searchRef.current?.focus();
  }

  function chooseTab(key) {
    setTab(key);
    setPage(1);
  }

  // "Clear search and filters", where nothing matches: the search, the tab,
  // the method and the date. The status stays.
  function clearFilters() {
    setQuery("");
    setTab("all");
    resetMethodAndDate();
    setPage(1);
    searchRef.current?.focus();
  }

  // Previous, Next and the page numbers. The list heading is brought into
  // view, and nothing else moves: focus stays on the button. An end button is
  // aria-disabled, not disabled, so it keeps focus when the page reaches it;
  // a press on it, or on the current page, does nothing here.
  function goToPage(n) {
    if (n < 1 || n > paging.pages || n === paging.page) return;
    setPage(n);
    headingRef.current?.scrollIntoView({ block: "nearest" });
  }

  // Rows per page: back to page 1, and the heading into view, as for a page
  // change. Focus stays on the select.
  function changePageSize(value) {
    setPageSize(PAGE_SIZES.includes(value) ? value : PAGE_SIZE);
    setPage(1);
    headingRef.current?.scrollIntoView({ block: "nearest" });
  }

  return (
    <>
      {flash && !selected && (
        <div ref={flashRef} tabIndex={-1} className={`alert ${flash.type}`}>
          {flash.text}
        </div>
      )}
      {/* The search is not a <form>: nothing is submitted, it filters as
          you type. Escape clears it and goes no further, so a View panel
          open behind it is left alone. type="search" brings the phone's
          search key; index.css hides the browser's own clear button. */}
      <div className="list-head pay-toolbar">
        <div className="pay-search" role="search">
          <IoSearch className="pay-search-icon" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                clearSearch();
              }
            }}
            aria-label="Search charges"
            placeholder="Search name, charge no. or reference"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="pay-search-clear"
              aria-label="Clear search"
              onClick={clearSearch}
            >
              <IoClose aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="head-actions">
          <select
            aria-label="Status"
            value={filter}
            onChange={(e) => changeStatus(e.target.value)}
          >
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

      {/* The second row: Method and the date, native selects with visible
          labels; From and To under "Choose dates"; and Clear filters while
          either is on. Method offers what the status view can show, so Void,
          with Any method alone, has it disabled. The date names itself:
          "Paid date" under Paid, "Billed date" everywhere else. */}
      <div className="pay-filters">
        <div className="pay-filter">
          <label htmlFor="pay-method-filter">Method</label>
          <select
            id="pay-method-filter"
            ref={methodRef}
            value={method}
            onChange={(e) => narrowBy(setMethod, e.target.value)}
            disabled={methodChoices.length === 1}
          >
            {methodChoices.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="pay-filter">
          <label htmlFor="pay-date-filter">
            {kind === "paid" ? "Paid date" : "Billed date"}
          </label>
          <select
            id="pay-date-filter"
            ref={dateRef}
            value={dateChoice}
            onChange={(e) => narrowBy(setDateChoice, e.target.value)}
          >
            {DATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {dateChoice === "custom" && (
          <div className="pay-filter-range">
            <div className="pay-filter">
              <label htmlFor="pay-date-from">From</label>
              <input
                id="pay-date-from"
                type="date"
                value={from}
                onChange={(e) => narrowBy(setFrom, e.target.value)}
                aria-describedby="pay-date-hint"
              />
            </div>
            <div className="pay-filter">
              <label htmlFor="pay-date-to">To</label>
              <input
                id="pay-date-to"
                type="date"
                value={to}
                onChange={(e) => narrowBy(setTo, e.target.value)}
                aria-describedby="pay-date-hint"
              />
            </div>
          </div>
        )}
        {filtersOn && (
          <button
            type="button"
            className="pay-filters-clear"
            onClick={clearMethodAndDate}
          >
            Clear filters
          </button>
        )}
      </div>
      {/* Always in the page, so a screen reader announces it when the text
          appears (role="status" is polite); empty, and no taller than
          nothing, while the dates are the right way round. */}
      <p id="pay-date-hint" className="pay-filters-hint" role="status">
        {reversed ? "The start date is after the end date." : ""}
      </p>

      {capped && (
        <div className="alert info pay-cap">
          Showing the newest {charges.length.toLocaleString("en-US")} of{" "}
          {total.toLocaleString("en-US")} charges. Older ones are not listed,
          and the counts and totals below cover only these{" "}
          {charges.length.toLocaleString("en-US")}.
        </div>
      )}

      {/* The tabs count what matches the search, the method and the date,
          whatever tab is selected. A tab with nothing in it is dimmed, never
          disabled. No page here uses role="tab", so these are toggle
          buttons. */}
      {charges !== null && (
        <div className="pay-tabs" role="group" aria-label="Charge type">
          {TYPE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`pay-tab${counts[t.key] === 0 ? " pay-tab-empty" : ""}`}
              aria-pressed={tab === t.key}
              onClick={() => chooseTab(t.key)}
            >
              {t.label}{" "}
              <span className="pay-tab-count">
                {counts[t.key].toLocaleString("en-US")}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* The totals line is the list's heading: "Charges" while loading or
          after a failed load, then how many charges are in view and what
          they add up to, over every page. */}
      <div className="pay-totals" aria-live="polite">
        <h2 ref={headingRef}>{totals ? totals.heading : "Charges"}</h2>
        {totals?.detail && (
          <p className="pay-totals-detail">{totals.detail}</p>
        )}
      </div>

      {/* The error first, then loading, then empty, then rows: a load that
          failed shows neither a count nor the empty text. Try again repeats
          the same load, as Refresh does. The markup is Staff accounts'. A
          status with no charges at all keeps its own text; one whose charges
          the search, tab, method or date hide says so, and offers to clear
          them. */}
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
      ) : shown.length === 0 ? (
        <div className="empty">
          <p>No charges match your search or filters.</p>
          <button
            type="button"
            className="btn secondary"
            onClick={clearFilters}
          >
            Clear search and filters
          </button>
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
              {rows.map((c) => {
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

      {/* The pager, from 11 matches (utils/paging.js): the count, Rows per
          page, then Previous, the page numbers and Next. The count is
          announced when it changes, because a press moves no focus. A phone
          draws "Page 2 of 4" between Previous and Next in place of the
          numbers (index.css), so both are in the markup at every width. */}
      {paging.show && (
        <nav className="pay-pager" aria-label="Pagination">
          <p className="pay-pager-count" aria-live="polite">
            Showing <strong>{pager.from}</strong> to{" "}
            <strong>{pager.to}</strong> of <strong>{pager.of}</strong> results
          </p>
          <div className="pay-pager-size">
            <label htmlFor="pay-page-size">Rows per page</label>
            <select
              id="pay-page-size"
              value={pageSize}
              onChange={(e) => changePageSize(Number(e.target.value))}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="pay-pager-pages">
            <button
              type="button"
              className="btn secondary pay-pager-step"
              aria-disabled={paging.page === 1}
              onClick={() => goToPage(paging.page - 1)}
            >
              <IoChevronBack aria-hidden="true" />
              Previous
            </button>
            <ul className="pay-pager-numbers">
              {pageItems(paging.page, paging.pages).map((item, i) =>
                item === GAP ? (
                  <li key={`gap-${i}`} className="pay-pager-gap">
                    …
                  </li>
                ) : (
                  <li key={item}>
                    <button
                      type="button"
                      className="pay-page"
                      aria-label={`Page ${item}`}
                      aria-current={item === paging.page ? "page" : undefined}
                      onClick={() => goToPage(item)}
                    >
                      {item}
                    </button>
                  </li>
                ),
              )}
            </ul>
            <p className="pay-pager-short">{pager.page}</p>
            <button
              type="button"
              className="btn secondary pay-pager-step"
              aria-disabled={paging.page === paging.pages}
              onClick={() => goToPage(paging.page + 1)}
            >
              Next
              <IoChevronForward aria-hidden="true" />
            </button>
          </div>
        </nav>
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
