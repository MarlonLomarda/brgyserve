import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import CancelBookingPanel from "../components/CancelBookingPanel";
import PayMenu from "../components/PayMenu";
import { chargeMeta, chargeOf } from "../constants/requestStatus";
import {
  displayStatus,
  formatSchedule,
  rentalMeta,
} from "../constants/rentals";
import { isNoFeeCharge } from "../utils/chargeMethod";

// Why a load failed, for "Could not load your bookings: …". The server's own
// message when it sent one (the API's errors are plain sentences, never a
// stack). Anything else, a server that could not be reached or an answer with
// no message in it, gets a plain fallback rather than the client's own text.
// A copy of the Rental bookings page's function, which the Document requests
// and Payments pages and Book a rental each copy too.
function loadFailure(err) {
  const sent = err?.data?.error;
  return typeof sent === "string" && sent.trim()
    ? sent.trim()
    : "the server did not respond";
}

export default function MyRentalsPage() {
  const { authFetch } = useAuth();
  const [requests, setRequests] = useState(null); // null = loading, or a failed load
  const [loadError, setLoadError] = useState(null); // why the last load failed
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [cancelling, setCancelling] = useState(null); // booking being cancelled
  const refocusId = useRef(null); // whose Cancel booking button gets the focus back
  const flashRef = useRef(null);
  const focusFlash = useRef(false); // a cancel went through: focus its message
  // Numbers each load, so only the newest one may change the list.
  const loadSeq = useRef(0);

  // A FAILED LOAD IS NOT AN EMPTY LIST. This used to store [] beside the
  // error, so the server's bare message sat over "You haven't booked anything
  // yet." and the Book a facility link while the page knew nothing, which
  // reads as nothing booked. requests now stays null and the error, with Try
  // again, takes the place of the rows and the empty text (CLAUDE.md: a list
  // that failed to load), as on Rental bookings. Every load starts from the
  // loading state (the first open, Refresh, Try again, the reload after a
  // payment and the one back from PayMongo), and an older answer that arrives
  // late is dropped rather than shown over a newer one.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    setRequests(null);
    try {
      const data = await authFetch("/rental-requests/mine");
      if (seq === loadSeq.current) setRequests(data.requests);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(loadFailure(err));
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  // BACK FROM PAYMONGO — the back-forward cache.
  //
  // handlePayOnline below hands the browser to PayMongo with
  // window.location.href and deliberately never clears busyId, because on that
  // path the page is expected to be gone. It is not always gone: pressing the
  // browser's BACK button on PayMongo restores this page from the bfcache
  // frozen exactly as it left. React resumes with busyId still holding the
  // request id, so that row's Pay ▾ button stays disabled under "Opening
  // GCash…" until the resident thinks to refresh — and nothing on screen
  // suggests refreshing.
  //
  // `event.persisted` IS THE WHOLE GUARD. It is true only for a bfcache
  // restore, so a first load, a client-side route change and a hard reload all
  // fall straight through and behave exactly as they did before.
  //
  // load() RUNS TOO, AND NOT JUST THE FLAG CLEAR, because the resident may
  // have actually completed the payment before pressing back. Clearing busyId
  // alone would leave the row still offering "Pay online via GCash" for money
  // PayMongo has already taken. The signed webhook is what settles the charge;
  // this re-read is what makes the screen agree with it.
  //
  // The listener depends on `load` so it can never close over a stale one.
  //
  // MyRequestsPage.jsx carries the identical effect for the identical reason.
  // The two pay flows are near-duplicates and were deliberately left that way
  // rather than introducing this codebase's first shared lifecycle hook.
  // IF ONE CHANGES, CHECK THE OTHER.
  useEffect(() => {
    function handlePageShow(event) {
      if (!event.persisted) return;
      setBusyId(null);
      load();
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [load]);

  async function handleDeclare(r, method) {
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(
        `/rental-requests/mine/${r.request_id}/pay`,
        {
          method: "POST",
          body: { method },
        },
      );
      setFlash({ type: "success", text: data.message });
      await load();
    } catch (err) {
      setFlash({ type: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  }

  // Gateway payment: PayMongo hosts the payment page. Nothing is marked paid
  // here — the signed webhook is the only thing that can do that.
  async function handlePayOnline(r, charge) {
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch("/payments/gcash/checkout", {
        method: "POST",
        body: { charge_id: charge.charge_id },
      });
      window.location.href = data.checkout_url;
    } catch (err) {
      // A refused checkout often means the charge just changed underneath us —
      // most importantly the resume interlock discovering it is already paid —
      // so reload rather than leave a stale row next to the message.
      setFlash({ type: "error", text: err.message });
      setBusyId(null);
      await load();
    }
  }

  // A GCASH REFERENCE ON FILE: ASK BEFORE ERASING IT OR PAYING TWICE.
  //
  // Once the resident has submitted a GCash reference, two of the Pay ▾
  // options can do harm without saying so. "Pay onsite" goes through the same
  // /pay route, which records the new method and sets the reference to null,
  // and "Pay online via GCash" can collect a second payment for a charge the
  // resident has already paid by hand. So both ask first, and Cancel sends
  // nothing. Residents can no longer submit a GCash reference (removed
  // 10 Oct 2026), so only a charge that kept one from before then asks. With
  // no GCash reference on file nothing asks.
  //
  // MyRequestsPage.jsx carries the identical checks and wording.
  // IF ONE CHANGES, CHECK THE OTHER.
  function payOnsite(r, charge) {
    if (
      charge.declared_method === "gcash" &&
      !window.confirm(
        "You already submitted a GCash reference for this payment. Choosing Pay onsite will remove it. Continue?",
      )
    ) {
      return;
    }
    handleDeclare(r, "onsite");
  }

  // CANCEL BOOKING (step B2). Drawn only where the server says the booking
  // can be cancelled online (can_cancel_online, from the same check the
  // cancel route makes: their own online booking, 24 hours or more ahead,
  // unpaid); where it says no, its cancel_online_note is shown instead. The
  // panel takes the list's place with an optional reason; a refusal shows in
  // it, and closing after one loads the list again. Keep booking and Escape
  // put the focus back on the button; a cancel that went through moves it to
  // the success message.
  async function sendCancel(r, reason) {
    const data = await authFetch(`/rental-requests/mine/${r.request_id}/cancel`, {
      method: "POST",
      body: reason ? { reason } : {},
    });
    setCancelling(null);
    focusFlash.current = true;
    setFlash({ type: "success", text: data.message });
    load();
  }

  function closeCancel(refused) {
    refocusId.current = cancelling?.request_id ?? null;
    setCancelling(null);
    if (refused) load();
  }

  useEffect(() => {
    if (cancelling) return;
    if (refocusId.current !== null) {
      const button = document.querySelector(`[data-cancel-for="${refocusId.current}"]`);
      if (button) {
        button.focus();
        refocusId.current = null;
      }
    } else if (focusFlash.current && flashRef.current) {
      flashRef.current.focus();
      focusFlash.current = false;
    }
  }, [cancelling, requests, flash]);

  function payOnline(r, charge) {
    if (
      charge.declared_method === "gcash" &&
      !window.confirm(
        "You already submitted a GCash reference for this payment. Paying online as well could charge you twice. Continue?",
      )
    ) {
      return;
    }
    handlePayOnline(r, charge);
  }

  if (cancelling) {
    return (
      <CancelBookingPanel
        title="Cancel booking"
        lines={[
          cancelling.rental_items?.name || "—",
          formatSchedule(cancelling.start_datetime, cancelling.end_datetime),
        ]}
        note="This cannot be undone. You will need to book again."
        reasonLabel="Reason (optional)"
        onSubmit={(reason) => sendCancel(cancelling, reason)}
        onClose={closeCancel}
      />
    );
  }

  return (
    <>
      {flash && (
        <div className={`alert ${flash.type}`} ref={flashRef} tabIndex={-1}>
          {flash.text}
        </div>
      )}

      {/* The heading row is drawn whatever the list's state, so Refresh is
          there while it loads, after it failed and over an empty list, as on
          Rental bookings. The heading counts the bookings only once they have
          loaded; until then it reads "Bookings". */}
      <div className="list-head">
        <h2>
          {requests === null
            ? "Bookings"
            : `${requests.length} booking${requests.length === 1 ? "" : "s"}`}
        </h2>
        <button className="btn secondary" onClick={load}>
          Refresh
        </button>
      </div>

      {/* The error first, then loading, then empty, then rows: a load that
          failed shows neither a count nor the empty text, nor a Pay button.
          Try again repeats the same load, as Refresh does. The markup is the
          Rental bookings page's. */}
      {loadError ? (
        <>
          <div className="alert error" role="alert">
            Could not load your bookings: {loadError}
          </div>
          <button type="button" className="btn secondary" onClick={load}>
            Try again
          </button>
        </>
      ) : requests === null ? (
        <p className="muted">Loading your bookings…</p>
      ) : requests.length === 0 ? (
        <div className="empty">
          <p>You haven&apos;t booked anything yet.</p>
          <Link className="button-link inline" to="/resident/book-rental">
            Book a facility
          </Link>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table stack-narrow my-rentals-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Schedule</th>
                  <th className="num">Qty</th>
                  <th>Purpose</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const meta = rentalMeta(displayStatus(r));
                  const charge = chargeOf(r);
                  const noFee = isNoFeeCharge(charge);
                  return (
                    <tr key={r.request_id}>
                      <td>
                        <strong>{r.rental_items?.name || "—"}</strong>
                      </td>
                      <td data-label="Schedule">
                        {formatSchedule(r.start_datetime, r.end_datetime)}
                      </td>
                      <td className="num" data-label="Qty">
                        {r.quantity_requested}
                      </td>
                      <td className="muted" data-label="Purpose">
                        {r.purpose}
                      </td>
                      <td>
                        <span className={`badge ${meta.className}`}>
                          {meta.label}
                        </span>
                        {r.return_note && (
                          <div className="muted reason-note">
                            Note: {r.return_note}
                          </div>
                        )}
                        {noFee && (
                          <div className="muted reason-note">No fee</div>
                        )}
                        {charge && !noFee && (
                          <div className="muted reason-note">
                            Amount due: ₱{Number(charge.amount).toFixed(2)} —{" "}
                            <strong
                              className={`charge-word ${chargeMeta(charge.status).className}`}
                            >
                              {chargeMeta(charge.status).label}
                            </strong>
                            {charge.status === "UNPAID" &&
                              charge.declared_method === "gcash" && (
                                <>
                                  {" "}
                                  · GCash ref {charge.declared_reference}{" "}
                                  submitted, awaiting verification
                                </>
                              )}
                            {charge.status === "UNPAID" &&
                              charge.declared_method === "onsite" && (
                                <>
                                  {" "}
                                  · pay in cash at the barangay hall
                                  treasurer&apos;s desk
                                </>
                              )}
                          </div>
                        )}
                        {r.status === "cancelled" && r.cancellation_reason && (
                          <div className="muted reason-note">
                            Reason: {r.cancellation_reason}
                          </div>
                        )}
                        {r.can_cancel_online === false &&
                          r.cancel_online_note && (
                            <div className="muted small-note cancel-online-note">
                              {r.cancel_online_note}
                            </div>
                          )}
                      </td>
                      <td className="row-actions">
                        {charge?.status === "UNPAID" && (
                          <PayMenu
                            busy={busyId === r.request_id}
                            onPayOnline={() => payOnline(r, charge)}
                            onPayOnsite={() => payOnsite(r, charge)}
                          />
                        )}
                        {r.can_cancel_online === true && (
                          <button
                            type="button"
                            className="btn secondary danger"
                            data-cancel-for={r.request_id}
                            disabled={busyId === r.request_id}
                            onClick={() => {
                              setFlash(null);
                              setCancelling(r);
                            }}
                          >
                            Cancel booking
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
