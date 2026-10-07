import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import PayMenu from "../components/PayMenu";
import { chargeMeta, chargeOf } from "../constants/requestStatus";
import {
  displayStatus,
  formatSchedule,
  rentalMeta,
} from "../constants/rentals";

export default function MyRentalsPage() {
  const { authFetch } = useAuth();
  const [requests, setRequests] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [payTarget, setPayTarget] = useState(null); // request_id entering a GCash ref
  const [gcashRef, setGcashRef] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await authFetch("/rental-requests/mine");
      setRequests(data.requests);
    } catch (err) {
      setError(err.message);
      setRequests([]);
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

  async function handleDeclare(r, method, reference) {
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(
        `/rental-requests/mine/${r.request_id}/pay`,
        {
          method: "POST",
          body: { method, reference_no: reference },
        },
      );
      setFlash({ type: "success", text: data.message });
      setPayTarget(null);
      setGcashRef("");
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
  // nothing. "I already paid via GCash" does not ask: it only replaces the
  // reference, which is how a mistyped one is fixed. With no GCash reference
  // on file nothing asks.
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

  return (
    <>
      {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}
      {error && <div className="alert error">{error}</div>}

      {requests === null ? (
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
          <div className="list-head">
            <h2>
              {requests.length} booking{requests.length === 1 ? "" : "s"}
            </h2>
            <button className="btn secondary" onClick={load}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table stack-narrow">
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
                        {charge && (
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
                      </td>
                      <td className="row-actions">
                        {charge?.status === "UNPAID" &&
                          (payTarget === r.request_id ? (
                            <form
                              className="inline-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                handleDeclare(r, "gcash", gcashRef.trim());
                              }}
                            >
                              <input
                                value={gcashRef}
                                onChange={(e) => setGcashRef(e.target.value)}
                                placeholder="GCash reference no."
                                maxLength={100}
                                required
                                autoFocus
                              />
                              <button
                                className="btn secondary"
                                type="submit"
                                disabled={busyId === r.request_id}
                              >
                                Submit
                              </button>
                              <button
                                className="btn secondary"
                                type="button"
                                onClick={() => setPayTarget(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <PayMenu
                              busy={busyId === r.request_id}
                              onPayOnline={() => payOnline(r, charge)}
                              onPayOnsite={() => payOnsite(r, charge)}
                              onAlreadyPaid={() => {
                                setPayTarget(r.request_id);
                                setGcashRef("");
                              }}
                            />
                          ))}
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
