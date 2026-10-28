import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import ListFilters from "../components/ListFilters";
import ListPager from "../components/ListPager";
import ListTabs from "../components/ListTabs";
import ListToolbar from "../components/ListToolbar";
import CancelBookingPanel from "../components/CancelBookingPanel";
import RentalAvailability from "../components/RentalAvailability";
import ResidentPicker from "../components/ResidentPicker";
import { chargeOf, formatDate } from "../constants/requestStatus";
import {
  ITEM_TYPE_LABELS,
  RETURN_OUTCOMES,
  displayStatus,
  formatSchedule,
  isReturnable,
  rentalMeta,
} from "../constants/rentals";
import useRentalAvailability from "../hooks/useRentalAvailability";
import useRentalSettings from "../hooks/useRentalSettings";
import {
  bookingRuleError,
  bookingTimeError,
  earliestBookingDate,
  hoursText,
  latestBookingDate,
  manilaInputs,
  timeLimits,
} from "../utils/bookingTimes";
import { ANY, backwards, clock, manilaToday } from "../utils/chargeFilters";
import { searchTerms } from "../utils/chargeSearch";
import { PAGE_SIZE, PAGE_SIZES, pageOf } from "../utils/paging";
import {
  bookingBlock,
  EDIT_AVAILABILITY_FAILED,
  editBlock,
  quantityCap,
} from "../utils/rentalAvailability";
import {
  accountHandle,
  ANY_ITEM,
  bookedForName,
  bookingNumber,
  emptyText,
  filterCount,
  filtersNoMatchText,
  inTab,
  isGuest,
  itemOptions,
  matchesItem,
  matchesPayment,
  matchesStarts,
  matchesType,
  matchingBookings,
  noMatchText,
  openingTab,
  orderBookings,
  paymentMarker,
  paymentOptions,
  RENTAL_TABS,
  scheduleParts,
  searchHeading,
  searchPlaceholder,
  STARTS_OPTIONS,
  startsRange,
  tabCounts,
  tabHeading,
  TYPE_OPTIONS,
} from "../utils/rentalList";
import {
  FACILITY,
  ITEM,
  KIND_TEXT,
  NOT_ASKED,
  ofKind,
} from "../utils/bookingKinds";

// All-bookings view, shared by three roles: the Secretary manages
// (canManage — edit/cancel), Barangay Staff mark physical items returned
// (canReturn), the Punong Barangay is read-only. Pass the role's title and
// nav like PaymentsPage.
//
// STATUS TABS (14 Oct 2026). The list is loaded once, every booking
// (?status=all), and six tabs split it in the browser with no further
// request: Upcoming, Overdue, Completed, Returned, Cancelled and All, each
// with its count over the whole list (utils/rentalList.js). A booking is in
// the tab of the status its badge reads, the server's derived_status. They
// replace a status select whose every choice sent a new request, and whose
// first choice, "Confirmed / upcoming", asked for the STORED status, so it
// listed every past confirmed booking too. The strip is the Payments page's
// type tabs, as components/ListTabs.jsx, as on Document requests. Staff open
// on Overdue, as the select did; the Secretary and the Punong Barangay on
// Upcoming. The chosen tab lives through every reload: Refresh, Try again, and
// the reload after an edit, a return, a cancel or a filed walk-in.
//
// SEARCH (15 Oct 2026). The Document requests search box, as
// components/ListToolbar.jsx, in a row of its own between the row that holds
// Refresh and the tabs. It filters the loaded list as you type, with no
// request, over what a row shows of who and what: the name in the Booked for
// column, the @account under it where the row shows one, and the item
// (utils/rentalList.js); never the purpose or a guest's contact number. The
// search runs over the whole list and the tabs split what matches, so their
// counts follow it; the chosen tab stays. While a search is on, the heading
// reads "4 of 7 overdue bookings match". The search lives through every
// reload and through Back from a panel, and is kept nowhere in the browser:
// the barangay hall's PC is shared.
//
// PAGES (15 Oct 2026). The Document requests pager, as
// components/ListPager.jsx, under the rows: "Showing 1 to 25 of 28 results",
// Rows per page (10, 25, 50 or 100, 25 to start), then Previous, the page
// numbers and Next. It pages the list already loaded, with no request, and
// shows from 11 matches. Only the rows drawn are one page: the heading and
// the tab counts still count every match, and the search runs over the whole
// list. A tab, a search or a new Rows per page goes back to page 1; Rows per
// page stays as chosen. Refresh, Try again, Back from a panel and the reload
// after an action keep the page, and a list that shrank under it lands on its
// last page. Like the search, neither is kept in the browser. The list is
// kept in ONE order (orderBookings in utils/rentalList.js), the route's with
// its ties settled, so a page never repeats a row or leaves one out.
//
// PAYMENT AND NUMBER (15 Oct 2026). Every row shows its booking number, "#12"
// as the Edit and Mark returned panels name it, on a line of its own under
// the name, and under the status badge where the booking stands with its
// fee: "Paid", "No fee", "Unpaid", "Void" or "Not billed", read from its
// charge alone by the Document requests list's own function
// (utils/rentalList.js). Both sit in cells the table already had, so it has
// no new column, and neither is a <strong>: a row's first <strong> is still
// the name. The search reads the number and never the marker. They carry the
// Document requests number's and marker's classes, so they look as those do,
// and on a phone card each is labelled from its own data-label (index.css).
//
// FILTERS (15 Oct 2026). The Document requests filters row, as
// components/ListFilters.jsx, between the search and the tabs: Item (the
// items the loaded rows hold, by the name each row shows), Payment (the
// marker's words, matched through the marker itself) and Starts (the Manila
// day a booking starts on, with presets both ways and "Choose dates";
// utils/rentalList.js). The list shown is tab AND search AND filters: the
// tab counts, the heading ("3 of 5 upcoming bookings match") and the pager
// follow the search and the filters, and any filter change goes back to page
// 1, with no request. Like the search, the filters live through every reload
// and Back from a panel, a choice a reload no longer offers goes back to Any,
// and nothing is kept in the browser. On a phone the row is a panel behind a
// "Filters" button that counts the filters on ("Filters (2)") and opens it in
// place; whether it is open lives here too, closed on every visit. The
// wrapper carries the Document requests filters' class as well as its own,
// so the button, the panel and Clear filters' kept place look as they do
// there (index.css).
//
// COLUMNS (15 Oct 2026). Above 640px the table keeps its columns in the same
// places on every tab, page, search and filter result: it is
// .rental-bookings-table, with fixed widths set through its header cells'
// classes (index.css); Purpose has none and takes the rest. The Schedule cell
// is two spans in every row, the date with its comma and the times
// (scheduleParts in utils/rentalList.js), each a line of its own there, so
// every row breaks after the year. On a phone the cards are as they were.
//
// RETURNED BY (15 Oct 2026). A returned booking's line after its payment
// marker names the return, "Returned by @staff1 on Oct 8, 2026, 1:20 PM"
// (ReturnedBy, below), where it read "by @staff1 on …", as if staff1 had
// marked the booking unpaid; a return note follows it.
//
// EDIT AND CANCEL (25 Oct 2026, step B2). The Secretary's Edit and Cancel are
// drawn only where the server's not_started says the booking has not started
// (routes/rentalRequests.js, hasNotStarted()), so never on one that is under
// way, Overdue, Completed, cancelled or returned. Edit shows the date, the
// times and the purpose, and the quantity as text only. Cancel opens
// CancelBookingPanel with a required reason, and for a paid booking says the
// payment stays recorded and a refund is due. A cancelled booking shows its
// reason under its status, as text.
//
// TYPE AND KIND (27 Oct 2026, step C2). The filters row opens with a Type
// filter, Any type, Facility, Equipment or Furniture (utils/rentalList.js),
// which narrows with the others: the tab counts, the heading and Clear
// filters treat it as they treat Item. The walk-in form splits its dropdown
// with a Facility | Item toggle, as Book a rental's tabs do
// (utils/bookingKinds.js). The Edit panel is unchanged: its item is fixed.

// Mirrors PH_MOBILE_RE in routes/rentalRequests.js, which is the real guard;
// this copy only lets the Secretary see the problem without a round trip.
// Three forms and nothing else: 09XXXXXXXXX, 639XXXXXXXXX, +639XXXXXXXXX.
const PH_MOBILE_RE = /^(09\d{9}|\+?639\d{9})$/;

// WHO THE BOOKING IS FOR — the borrower, not the requester: bookedForName in
// utils/rentalList.js, which the search reads too, so a search finds a booking
// by exactly the name its row shows. "—" when there is nothing to name.
function residentName(booking) {
  return bookedForName(booking) || "—";
}

// The handle beneath the borrower's name is the BORROWER'S account, never the
// requester's — on a walk-in the requester is the Secretary, and printing
// requester.username put "@secretary1" under the resident's name. `account`
// arrives inside resident_records when the server sends it; this tests the
// key, not the viewer's role. Null means the resident has no online account,
// said plainly rather than left blank. Guests never reach this: they have no
// resident record, and their row says "Guest" instead. The handle is
// accountHandle's (utils/rentalList.js), which the search reads too.
function AccountNote({ record }) {
  if (!record || !("account" in record)) return null;
  return (
    <div className="muted small-note">
      {accountHandle(record) || "No online account"}
    </div>
  );
}

// Where the booking stands with its fee, under its status badge, in the
// colours .charge-word gives the charge's own status words. The class is the
// Document requests marker's, reused by name, so the two look the same;
// data-label is the phone card's label for it, and above 640px nothing reads
// it.
function PaymentMarker({ booking }) {
  const marker = paymentMarker(booking);
  return (
    <div
      className={`charge-word ${marker.className} doc-requests-pay`}
      data-label="Payment"
    >
      {marker.label}
    </div>
  );
}

// The Cancel panel's warning for a booking with a PAID charge above PHP 0:
// the charge stays PAID (the server never rewrites money) and the borrower's
// notice says a refund is due. Null otherwise, an open GCash checkout
// included: the server expires that one itself.
function paidWarning(booking) {
  const charge = chargeOf(booking);
  if (charge?.status !== "PAID" || !(Number(charge.amount) > 0)) return null;
  return `This booking was paid (PHP ${Number(charge.amount).toFixed(2)}). The payment stays recorded. The resident is told to contact the barangay about the refund.`;
}

// Who took a returned booking back, and when, the line after its payment
// marker: "Returned by @staff1 on Oct 8, 2026, 1:20 PM". It read "by @staff1
// on …" there, as if staff1 had marked the booking unpaid. Only a return
// writes returned_at (routes/rentalRequests.js), so only a returned, returned
// late or returned with an issue booking shows it. Two spans, who and when:
// above 640px each is a line of its own and the date never breaks
// (index.css), so every row breaks the note in one place. On a phone card the
// line is labelled from its own data-label ("Return"), so it cannot read as
// part of the payment above it, and a return note follows it there.
function ReturnedBy({ booking }) {
  return (
    <div
      className="muted small-note rental-bookings-return"
      data-label="Return"
    >
      <span className="rental-bookings-return-by">
        Returned by @{booking.returned_by.username} on
      </span>{" "}
      <span className="rental-bookings-return-at">
        {formatDate(booking.returned_at)}
      </span>
    </div>
  );
}

// Edit changes the date, the times and the purpose, and nothing else (step
// B2): the server refuses a different quantity, and the item and borrower
// were never editable. So the quantity is shown, not offered, and the PUT
// carries no quantity_requested; to change either, cancel and book again.
//
// Since step C3 it shows what is free for the new time under the time
// fields, as the booking forms do, with this booking left out of the count
// (exclude_request_id), and the booking's own quantity decides whether Save
// is blocked (editBlock). Advice only: the server checks again on Save. The
// fields are filled, and the date's earliest day set, in Manila time.
function EditPanel({ booking, onDone }) {
  const { authFetch } = useAuth();
  const item = booking.rental_items;
  const [form, setForm] = useState(() => {
    const start = manilaInputs(booking.start_datetime);
    return {
      date: start.date,
      start_time: start.time,
      end_time: manilaInputs(booking.end_datetime).time,
      purpose: booking.purpose,
    };
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const availability = useRentalAvailability(
    item?.item_id,
    form.date,
    form.start_time,
    form.end_time,
    booking.request_id,
  );
  const answer = availability.status === "ready" ? availability.data : null;
  const blocked = editBlock({ answer, quantity: booking.quantity_requested });
  const blockedId = useId();

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Save is disabled then; this stops the Enter key too.
    if (blocked) return;
    setError("");
    setBusy(true);
    try {
      const data = await authFetch(`/rental-requests/${booking.request_id}`, {
        method: "PUT",
        body: {
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          purpose: form.purpose,
        },
      });
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message); // conflict messages land here
      // The time was taken after the panel last asked: ask again.
      if (err.status === 409) availability.reload();
      setBusy(false);
    }
  }

  // Today in Manila, as on the booking forms: it was today in UTC, which
  // until 8 AM in Manila is yesterday.
  const today = earliestBookingDate(clock.now());

  return (
    <div className="pending-card rental-form-panel">
      <div className="pending-head">
        <div>
          <h3>Edit booking #{booking.request_id}</h3>
          <p className="muted">
            {residentName(booking)} · {item?.name} (
            {ITEM_TYPE_LABELS[item?.type] || item?.type})
          </p>
          <p className="muted">
            Quantity: {booking.quantity_requested}
          </p>
          <p className="muted small-note">
            To change the item or quantity, cancel this booking and book again.
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* No Quantity box here, ever: Date takes the whole row, so Start
            and End time sit side by side under it. */}
        <div className="grid-2">
          <label className="rental-date-full">
            Date
            <input
              name="date"
              type="date"
              min={today}
              value={form.date}
              onChange={handleChange}
              required
            />
          </label>
          <label>
            Start time
            <input
              name="start_time"
              type="time"
              value={form.start_time}
              onChange={handleChange}
              required
            />
          </label>
          <label>
            End time
            <input
              name="end_time"
              type="time"
              value={form.end_time}
              onChange={handleChange}
              required
            />
          </label>
        </div>
        <RentalAvailability
          check={availability}
          failedText={EDIT_AVAILABILITY_FAILED}
        />
        <label>
          Purpose
          <textarea
            name="purpose"
            value={form.purpose}
            onChange={handleChange}
            rows={3}
            maxLength={1000}
            required
          />
        </label>
        <div className="actions">
          <button
            className="btn"
            type="submit"
            disabled={busy || Boolean(blocked)}
            aria-describedby={blocked ? blockedId : undefined}
          >
            {busy ? "Checking availability…" : "Save changes"}
          </button>
          {blocked && (
            <span id={blockedId} className="rental-block-reason">
              {blocked}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

// Staff record a physical item's return: an outcome + optional note. An
// overdue booking (the Overdue tab's own test, inTab) starts on "Returned
// late", any other on time (step C3); Staff can change either.
function ReturnPanel({ booking, onDone }) {
  const { authFetch } = useAuth();
  const item = booking.rental_items;
  const [outcome, setOutcome] = useState(() =>
    inTab(booking, "overdue") ? "returned_late" : RETURN_OUTCOMES[0].value,
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await authFetch(
        `/rental-requests/${booking.request_id}/return`,
        {
          method: "POST",
          body: { outcome, note: note.trim() || undefined },
        },
      );
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="pending-card rental-form-panel">
      <div className="pending-head">
        <div>
          <h3>Mark returned — booking #{booking.request_id}</h3>
          <p className="muted">
            {residentName(booking)} · {item?.name} (
            {ITEM_TYPE_LABELS[item?.type] || item?.type}) ·{" "}
            {booking.quantity_requested} unit
            {booking.quantity_requested === 1 ? "" : "s"}
          </p>
          <p className="muted">
            {formatSchedule(booking.start_datetime, booking.end_datetime)}
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {RETURN_OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note{" "}
          <span className="hint">
            (optional — e.g. what was damaged or missing)
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
          />
        </label>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Recording…" : "Record return"}
          </button>
        </div>
      </form>
    </div>
  );
}

const EMPTY_WALK_IN = {
  item_id: "",
  date: "",
  start_time: "",
  end_time: "",
  quantity: "1",
  purpose: "",
};

// The Secretary encodes a booking for someone at the hall: a registered
// resident picked from the master list, or a guest from another barangay
// typed in by name and contact number — a real, current practice (outsiders
// rent select items, mostly costumes). Exactly one of the two, matching the
// CHECK constraint from migration 022; the server validates the same rule.
//
// Standalone rather than sharing BookRentalPage's fields: EditPanel above
// already duplicates that grid the same way, and extracting it would refactor
// a resident-facing page this feature does not otherwise touch. The fields
// are the same ones that form collects; only who-it-is-for is new.
//
// THE AVAILABILITY CHECK IS THE SERVER'S. This posts to the same
// POST /rental-requests handler BookRentalPage does, and that handler books
// through create_rental_booking (migration 024) for every caller — there is
// no second code path a walk-in could take around it. Before the press the
// form shows what is free, from the same rule (RentalAvailability, as on Book
// a rental), and its own time check runs as Book a rental's does; refusals
// surface here in `error` exactly as they do on the resident form.
function WalkInBookingPanel({ onDone }) {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading, or a failed load
  const [loadError, setLoadError] = useState(null); // why the last load failed
  const [mode, setMode] = useState("resident"); // 'resident' | 'guest'
  // What is booked: a facility or an item (utils/bookingKinds.js), as Book a
  // rental's tabs split it. Facility to start, on every visit.
  const [kind, setKind] = useState(FACILITY);
  const [resident, setResident] = useState(null);
  const residentBoxId = useId(); // the "Resident" label's for=
  const [guest, setGuest] = useState({ name: "", contact: "" });
  const [form, setForm] = useState({ ...EMPTY_WALK_IN });
  const [error, setError] = useState("");
  // The form's own check of the times, shown under the time fields.
  const [timeError, setTimeError] = useState("");
  const [busy, setBusy] = useState(false);
  // Numbers each load, so only the newest one may change the items.
  const loadSeq = useRef(0);

  // A FAILED LOAD IS NOT AN EMPTY LIST (CLAUDE.md: a list that failed to
  // load). This used to store [] beside the error, which showed "Nothing is
  // currently available for rental." under it. items now stays null and the
  // error, with Try again, takes the place of the fields, as on Book a rental.
  const loadItems = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    setItems(null);
    try {
      const data = await authFetch("/rental-items");
      if (seq === loadSeq.current) setItems(data.rental_items);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(loadFailure(err));
    }
  }, [authFetch]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // How many days ahead a booking may start, or null while not known, asked
  // after the items. The same rules as a resident's booking: the server
  // applies them to both.
  const maxDaysAhead = useRentalSettings();

  // The toggle's own items, and Book a rental's rules for them: a Quantity
  // for an item, none for a facility.
  const words = KIND_TEXT[kind];
  const shownItems = items === null ? null : ofKind(items, kind);
  const selectedItem = shownItems?.find(
    (i) => String(i.item_id) === String(form.item_id),
  );
  const withQuantity = kind === ITEM;
  const quantity = withQuantity ? Number(form.quantity) || 0 : 1;
  const estimatedFee = selectedItem ? Number(selectedItem.fee) * quantity : 0;
  // The booking rules, as on Book a rental: the item's hours and how far
  // ahead.
  const hours = selectedItem ? hoursText(selectedItem) : null;
  const limits = timeLimits(selectedItem);

  // What is free for the chosen time: advice only, as on Book a rental, and
  // nothing while no item is chosen or while the slot breaks the booking
  // rules (Record booking refuses it in their words).
  const ruleBroken = selectedItem
    ? bookingRuleError(form, clock.now(), { item: selectedItem, maxDaysAhead })
    : null;
  const askable = selectedItem && !ruleBroken;
  const availability = useRentalAvailability(
    askable ? selectedItem.item_id : undefined,
    form.date,
    form.start_time,
    form.end_time,
  );
  const check = askable ? availability : NOT_ASKED;
  const answer = check.status === "ready" ? check.data : null;
  const cap = selectedItem ? quantityCap(selectedItem, answer) : null;
  const blocked = bookingBlock({ answer, quantity, countable: withQuantity });
  const blockedId = useId();

  function handleChange(e) {
    const { name, value } = e.target;
    // A changed date or time may answer the check; it runs again on Record.
    if (name === "date" || name === "start_time" || name === "end_time") {
      setTimeError("");
    }
    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === "item_id") next.quantity = "1"; // reset when switching items
      return next;
    });
  }

  function switchMode(next) {
    setMode(next);
    setError("");
  }

  // Facility | Item clears the item, the quantity and a time message (the
  // availability answer goes with the item), as Book a rental's tabs do. The
  // resident or guest above, the date, the times and the purpose stay.
  function switchKind(next) {
    if (next === kind) return;
    setKind(next);
    setForm((f) => ({ ...f, item_id: "", quantity: "1" }));
    setTimeError("");
    setError("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Record booking is disabled then; this stops the Enter key too.
    if (blocked) return;
    if (mode === "resident" && !resident) {
      setError("Pick the resident this booking is for.");
      return;
    }
    if (mode === "guest" && (!guest.name.trim() || !guest.contact.trim())) {
      setError("A guest booking needs both a name and a contact number.");
      return;
    }
    if (mode === "guest" && !PH_MOBILE_RE.test(guest.contact.trim())) {
      setError(
        "Enter the guest's mobile number as 09XXXXXXXXX, 639XXXXXXXXX or +639XXXXXXXXX — digits only, no spaces.",
      );
      return;
    }
    setError("");
    // The times, checked as the server will and in its words, before anything
    // is sent (utils/bookingTimes.js, as on Book a rental). The server checks
    // again with its own clock.
    const refused = bookingTimeError(form, clock.now(), {
      item: selectedItem,
      maxDaysAhead,
    });
    setTimeError(refused || "");
    if (refused) return;
    setBusy(true);
    try {
      const data = await authFetch("/rental-requests", {
        method: "POST",
        body: {
          item_id: Number(form.item_id),
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          quantity_requested: quantity,
          purpose: form.purpose,
          ...(mode === "guest"
            ? {
                outside_borrower_name: guest.name.trim(),
                outside_borrower_contact: guest.contact.trim(),
              }
            : { resident_id: resident.resident_id }),
        },
      });
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message); // conflict reasons surface here — pick another slot
      // The slot was taken after the form last asked: ask again.
      if (err.status === 409) availability.reload();
      setBusy(false);
    }
  }

  // Today in Manila, whatever clock the hall's computer keeps: the date
  // field's earliest day. It was today in UTC, which until 8 AM in Manila is
  // yesterday.
  const today = earliestBookingDate(clock.now());
  const latest = latestBookingDate(clock.now(), maxDaysAhead);

  return (
    <div className="pending-card rental-form-panel">
      <div className="pending-head">
        <div>
          <h3>Encode walk-in booking</h3>
          <p className="muted">
            For someone at the barangay hall. Filed under your account and
            recorded for the borrower you name.
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Two toggles, one pressed: which kind of borrower this is for. */}
        <div className="tab-container">
          <button
            type="button"
            className={`tab ${mode === "resident" ? "active-tab" : ""}`}
            aria-pressed={mode === "resident"}
            onClick={() => switchMode("resident")}
          >
            Existing resident
          </button>
          <button
            type="button"
            className={`tab ${mode === "guest" ? "active-tab" : ""}`}
            aria-pressed={mode === "guest"}
            onClick={() => switchMode("guest")}
          >
            Guest from another barangay
          </button>
        </div>

        {mode === "resident" ? (
          <>
            <label htmlFor={residentBoxId} className="picker-label">
              Resident
            </label>
            <ResidentPicker
              inputId={residentBoxId}
              value={resident}
              onPick={(r) => {
                setResident(r);
                setError("");
              }}
              onClear={() => setResident(null)}
              placeholder="Search the resident master list…"
            />
          </>
        ) : (
          <div className="grid-2">
            <label>
              Full name
              <input
                value={guest.name}
                onChange={(e) =>
                  setGuest((g) => ({ ...g, name: e.target.value }))
                }
                maxLength={200}
                placeholder="As given at the counter"
                required
              />
            </label>
            <label>
              Contact number{" "}
              <span className="hint">(mobile — booking notices go here)</span>
              <input
                value={guest.contact}
                onChange={(e) =>
                  setGuest((g) => ({ ...g, contact: e.target.value }))
                }
                maxLength={50}
                inputMode="tel"
                placeholder="09XXXXXXXXX"
                required
              />
            </label>
          </div>
        )}

        {/* The second toggle: what is booked. Drawn whatever the load did. */}
        <div
          className="tab-container"
          role="group"
          aria-label="What to book"
        >
          {[FACILITY, ITEM].map((k) => (
            <button
              key={k}
              type="button"
              className={`tab ${kind === k ? "active-tab" : ""}`}
              aria-pressed={kind === k}
              onClick={() => switchKind(k)}
            >
              {KIND_TEXT[k].toggle}
            </button>
          ))}
        </div>

        {/* The error first, then loading, then empty, then the fields. Try
            again is a plain button, so pressing it inside this form loads the
            items again and submits nothing. */}
        {loadError ? (
          <>
            <div className="alert error" role="alert">
              Could not load the rental items: {loadError}
            </div>
            <div className="actions book-rental-retry">
              <button
                type="button"
                className="btn secondary"
                onClick={loadItems}
              >
                Try again
              </button>
            </div>
          </>
        ) : items === null ? (
          <p className="muted">Loading rental items…</p>
        ) : shownItems.length === 0 ? (
          <p className="muted">{words.none}</p>
        ) : (
          <>
            <label>
              {words.field}
              <select
                name="item_id"
                value={form.item_id}
                onChange={handleChange}
                required
              >
                <option value="" disabled>
                  {words.choose}
                </option>
                {shownItems.map((i) => (
                  <option key={i.item_id} value={i.item_id}>
                    {i.name} ({ITEM_TYPE_LABELS[i.type] || i.type}) — ₱
                    {Number(i.fee).toFixed(2)}
                    {i.quantity_total > 1
                      ? ` per unit · ${i.quantity_total} units`
                      : " per booking"}
                  </option>
                ))}
              </select>
            </label>
            {hours && (
              <p className="muted type-description">Open {hours}</p>
            )}
            {selectedItem?.description && (
              <p className="muted type-description">
                {selectedItem.description}
              </p>
            )}

            {/* Facility: Date takes the whole row, so Start and End time sit
                side by side under it. Item: Date | Quantity, then Pick-up |
                Return time. */}
            <div className="grid-2">
              <label className={withQuantity ? undefined : "rental-date-full"}>
                Date{" "}
                {maxDaysAhead !== null && (
                  <span className="hint">
                    (up to {maxDaysAhead} day{maxDaysAhead === 1 ? "" : "s"}{" "}
                    ahead)
                  </span>
                )}
                <input
                  name="date"
                  type="date"
                  min={today}
                  max={latest ?? undefined}
                  value={form.date}
                  onChange={handleChange}
                  required
                />
              </label>
              {withQuantity && (
                <label>
                  Quantity{" "}
                  {selectedItem && (
                    <span className="hint">
                      {cap > 0 ? `(up to ${cap})` : "(none left)"}
                    </span>
                  )}
                  <input
                    name="quantity"
                    type="number"
                    min="1"
                    max={selectedItem ? Math.max(1, cap) : undefined}
                    step="1"
                    value={form.quantity}
                    onChange={handleChange}
                    required
                  />
                </label>
              )}
              <label>
                {words.start}
                <input
                  name="start_time"
                  type="time"
                  {...limits.start}
                  value={form.start_time}
                  onChange={handleChange}
                  required
                />
              </label>
              <label>
                {words.end}
                <input
                  name="end_time"
                  type="time"
                  {...limits.end}
                  value={form.end_time}
                  onChange={handleChange}
                  required
                />
              </label>
            </div>
            {/* The times' own check, by the fields it is about. */}
            {timeError && (
              <div className="alert error" role="alert">
                {timeError}
              </div>
            )}
            <RentalAvailability check={check} />

            <label>
              Purpose
              <textarea
                name="purpose"
                value={form.purpose}
                onChange={handleChange}
                rows={3}
                maxLength={1000}
                placeholder="e.g. Birthday party, basketball league practice, family reunion…"
                required
              />
            </label>

            {selectedItem && (
              <p className="muted">
                Estimated fee: <strong>₱{estimatedFee.toFixed(2)}</strong>
                {withQuantity && quantity > 0 && (
                  <>
                    {" "}
                    ({quantity} × ₱{Number(selectedItem.fee).toFixed(2)})
                  </>
                )}
              </p>
            )}

            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={busy || Boolean(blocked)}
                aria-describedby={blocked ? blockedId : undefined}
              >
                {busy ? "Checking availability…" : "Record booking"}
              </button>
              {blocked && (
                <span id={blockedId} className="rental-block-reason">
                  {blocked}
                </span>
              )}
            </div>
          </>
        )}
      </form>
    </div>
  );
}

// Why a load failed, for "Could not load the bookings: …". The server's own
// message when it sent one (the API's errors are plain sentences, never a
// stack). Anything else, a server that could not be reached or an answer with
// no message in it, gets a plain fallback rather than the client's own text.
// The Document requests and Payments pages word their load errors with the
// same function, each its own copy.
function loadFailure(err) {
  const sent = err?.data?.error;
  return typeof sent === "string" && sent.trim()
    ? sent.trim()
    : "the server did not respond";
}

export default function RentalBookingsPage({
  canManage = false,
  canReturn = false,
}) {
  const { authFetch } = useAuth();
  // The chosen status tab: Overdue for Staff, Upcoming for the others.
  const [tab, setTab] = useState(() => openingTab(canReturn));
  const [requests, setRequests] = useState(null); // null = loading, or a failed load
  const [loadError, setLoadError] = useState(null); // why the last load failed
  const [flash, setFlash] = useState(null);
  const [editing, setEditing] = useState(null); // booking being edited
  const [returning, setReturning] = useState(null); // booking being returned
  const [cancelling, setCancelling] = useState(null); // booking being cancelled
  const refocusId = useRef(null); // whose Cancel button gets the focus back
  const flashRef = useRef(null);
  const focusFlash = useRef(false); // a cancel went through: focus its message
  const [encoding, setEncoding] = useState(false); // walk-in panel open
  // The search, as typed. Here rather than in the box, so it outlives the list
  // while the Edit, Mark returned or walk-in panel takes its place.
  const [query, setQuery] = useState("");
  const searchRef = useRef(null); // the search box, for Clear search
  // The page of the chosen tab's matches, and how many rows a page holds.
  // Like the search, both live through every reload and Back from a panel.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // The filters: Type, Item, Payment and Starts (its choice, and From and To
  // under "Choose dates"). Like the search, they live here, so they outlive
  // the list while a panel takes its place; every visit starts them at Any,
  // and none is kept in the browser.
  const [typeChoice, setTypeChoice] = useState(ANY);
  const [itemChoice, setItemChoice] = useState(ANY_ITEM);
  const [paymentChoice, setPaymentChoice] = useState(ANY);
  const [dateChoice, setDateChoice] = useState(ANY);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Whether a phone's Filters panel is open. Here, not in the filters row,
  // which is not drawn while the list loads or while a panel takes its place,
  // so it lives through those as the filters do: closed on every visit, kept
  // through Refresh, Try again, a tab, a search and Back, and kept nowhere in
  // the browser.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const headingRef = useRef(null); // the list's heading, for a page change
  // Numbers each load, so only the newest one may change the list.
  const loadSeq = useRef(0);

  // A FAILED LOAD IS NOT AN EMPTY LIST. This used to store [] beside the
  // error, so the page said "0 bookings" and "No confirmed / upcoming
  // bookings." under the server's bare message while it knew nothing, which
  // reads as nothing booked. requests now stays null and the error, with Try
  // again, takes the place of the rows, the count and the empty text
  // (CLAUDE.md: a list that failed to load), as on Document requests. Every
  // load starts from the loading state, and an older answer that arrives late
  // (Refresh pressed during a reload) is dropped rather than shown over a
  // newer one. It asks for every booking, whatever tab is chosen: a tab only
  // splits what is loaded, so choosing one sends nothing. load depends on
  // authFetch alone; the tab in its dependencies would reload on every press.
  // The list is kept in one order (orderBookings): the route's, newest start
  // first, with the bookings that start together, which the route leaves in
  // no fixed order, settled by booking number, so a page shows the same rows
  // on every load.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    setRequests(null);
    try {
      const data = await authFetch("/rental-requests?status=all");
      if (seq === loadSeq.current) setRequests(orderBookings(data.requests));
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(loadFailure(err));
    }
  }, [authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  // CANCEL ASKS FOR A REASON (step B2). Cancel opens CancelBookingPanel in the
  // list's place, where window.confirm used to ask and the cancel went out
  // with no body; the server now refuses a Secretary cancel without a reason
  // of 3 to 300 characters, and sends it to the borrower. A refusal shows in
  // the panel; closing after one loads the list again, since the booking
  // usually changed underneath. Keep booking and Escape put the focus back on
  // the row's Cancel button; a cancel that went through moves it to the
  // success message, since that row's buttons are gone.
  async function sendCancel(r, reason) {
    const data = await authFetch(`/rental-requests/${r.request_id}/cancel`, {
      method: "POST",
      body: { reason },
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

  // After the panel closes, back to the row's Cancel button once it is drawn
  // again (after the reload, when there was one); after a cancel, to the
  // success message.
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

  // The search runs over the whole list, then the filters over what it
  // leaves, then the tabs split what matches. The tab counts come from every
  // match, so they read the same on every tab and follow the search and the
  // filters; the rows and the heading are the chosen tab's. With no search
  // and no filter every booking matches, as before. "Today" is read on every
  // render, as on Document requests, so a page left open past midnight in
  // Manila moves its presets on with the day.
  const searching = searchTerms(query).length > 0;
  const range = startsRange(dateChoice, from, to, manilaToday());
  // A filter that restricts something: "Choose dates" with no date is on
  // (Clear filters shows) but restricts nothing.
  const filtered =
    typeChoice !== ANY ||
    itemChoice !== ANY_ITEM ||
    paymentChoice !== ANY ||
    range !== null;
  // How many filters are on: the "(2)" on a phone's Filters button, and Clear
  // filters is offered while it is above 0.
  const filtersOn = filterCount({
    type: typeChoice,
    item: itemChoice,
    payment: paymentChoice,
    date: dateChoice,
  });
  const searched = requests === null ? [] : matchingBookings(requests, query);
  const matching = searched.filter(
    (r) =>
      matchesType(r, typeChoice) &&
      matchesItem(r, itemChoice) &&
      matchesPayment(r, paymentChoice) &&
      matchesStarts(r, range),
  );
  const counts = requests === null ? null : tabCounts(matching);
  const shown = matching.filter((r) => inTab(r, tab));
  // One page of the tab's matches (utils/paging.js). Only the rows drawn are
  // a page: the heading and the counts still count every match.
  const paging = pageOf(shown.length, page, pageSize);
  const rows = shown.slice(paging.start, paging.end);
  // A reload that shrank the list lands on its last page, and stays there.
  // Not while a list is loading: the page must survive the reload itself.
  if (requests !== null && paging.page !== page) setPage(paging.page);
  // The Item and Payment choices are the loaded rows', made by
  // utils/rentalList.js. A choice a reload no longer offers (its item
  // renamed, the last void charge no longer void) goes back to Any, and the
  // page to 1: a select never reads a choice over rows that do not hold it.
  const itemChoices = requests === null ? null : itemOptions(requests);
  const paymentChoices = requests === null ? null : paymentOptions(requests);
  if (itemChoices && !itemChoices.some((o) => o.value === itemChoice)) {
    setItemChoice(ANY_ITEM);
    setPage(1);
  }
  if (
    paymentChoices &&
    !paymentChoices.some((o) => o.value === paymentChoice)
  ) {
    setPaymentChoice(ANY);
    setPage(1);
  }
  // "4 of 7 overdue bookings match": how many of the tab's bookings match, of
  // how many it holds with no search and no filter.
  let heading = "Bookings";
  if (requests !== null) {
    heading =
      searching || filtered
        ? searchHeading(
            tab,
            shown.length,
            requests.filter((r) => inTab(r, tab)).length,
          )
        : tabHeading(tab, shown.length);
  }

  // A new search, tab, filter or Rows per page goes back to page 1, as on
  // Document requests. Rows per page itself stays as chosen through the
  // others.
  function changeQuery(text) {
    setQuery(text);
    setPage(1);
  }

  // Type, Item, Payment, Starts, From and To.
  function narrowBy(set, value) {
    set(value);
    setPage(1);
  }

  function resetFilters() {
    setTypeChoice(ANY);
    setItemChoice(ANY_ITEM);
    setPaymentChoice(ANY);
    setDateChoice(ANY);
    setFrom("");
    setTo("");
  }

  // "Clear filters" in the row: the filters only; the search and the tab
  // stay. The row moves focus to its first select (components/ListFilters).
  function clearFilters() {
    resetFilters();
    setPage(1);
  }

  // "Clear search and filters", where they leave the tab nothing: the search
  // and the filters, as on Document requests; the tab stays. Focus goes to
  // the box: the button pressed is gone once the rows are back.
  function clearSearchAndFilters() {
    setQuery("");
    resetFilters();
    setPage(1);
    searchRef.current?.focus();
  }

  function chooseTab(key) {
    setTab(key);
    setPage(1);
  }

  function changePageSize(size) {
    setPageSize(PAGE_SIZES.includes(size) ? size : PAGE_SIZE);
    setPage(1);
  }

  // "Clear search", where nothing matches: the search only, and the tab stays.
  // Focus goes to the box, as the Clear (x) button's does: the button pressed
  // is gone once the rows are back.
  function clearSearch() {
    changeQuery("");
    searchRef.current?.focus();
  }

  return (
    <>
      {encoding ? (
        <WalkInBookingPanel
          onDone={(result) => {
            setEncoding(false);
            if (result) {
              setFlash(result);
              load();
            }
          }}
        />
      ) : editing ? (
        <EditPanel
          booking={editing}
          onDone={(result) => {
            setEditing(null);
            if (result) {
              setFlash(result);
              load();
            }
          }}
        />
      ) : cancelling ? (
        <CancelBookingPanel
          title={`Cancel booking ${bookingNumber(cancelling)}`}
          lines={[
            `${residentName(cancelling)} · ${cancelling.rental_items?.name || "—"}`,
            formatSchedule(cancelling.start_datetime, cancelling.end_datetime),
          ]}
          warning={paidWarning(cancelling)}
          reasonLabel="Reason for cancelling"
          required
          helper="The resident receives this reason by text message. Keep it short and use plain letters."
          onSubmit={(reason) => sendCancel(cancelling, reason)}
          onClose={closeCancel}
        />
      ) : returning ? (
        <ReturnPanel
          booking={returning}
          onDone={(result) => {
            setReturning(null);
            if (result) {
              setFlash(result);
              load();
            }
          }}
        />
      ) : (
        <>
          {flash && (
            <div className={`alert ${flash.type}`} ref={flashRef} tabIndex={-1}>
              {flash.text}
            </div>
          )}

          {/* The heading is a polite live region, as on Document requests, so
              a screen reader hears "4 of 7 overdue bookings match" as the
              search is typed. rental-bookings-head: a page change brings the
              heading into view, and index.css keeps it clear of the sticky
              header. */}
          <div className="list-head rental-bookings-head">
            <h2 ref={headingRef} aria-live="polite">
              {heading}
            </h2>
            <div className="head-actions">
              <button className="btn secondary" onClick={load}>
                Refresh
              </button>
              {/* Secretary only. canManage is passed by App.jsx on the
                  /secretary route alone — Staff get canReturn, the Punong
                  Barangay neither — so this is the role gate, in the same
                  prop Edit and Cancel already key on. */}
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

          {/* The search, the filters, then the tabs, under the row that holds
              Refresh, so a reload leaves Refresh where it was: all three are
              drawn only once the list has loaded, never while it loads or
              after it failed, as on Document requests. The filters' wrapper
              carries that list's class too, for its look (index.css). */}
          {requests !== null && (
            <>
              <ListToolbar
                className="rental-bookings-toolbar"
                label="Search bookings"
                placeholder={searchPlaceholder(requests)}
                value={query}
                onChange={changeQuery}
                inputRef={searchRef}
              />
              <ListFilters
                className="rental-bookings-filters doc-requests-filters"
                selects={[
                  {
                    label: "Type",
                    value: typeChoice,
                    options: TYPE_OPTIONS,
                    onChange: (value) => narrowBy(setTypeChoice, value),
                  },
                  {
                    label: "Item",
                    value: itemChoice,
                    options: itemChoices,
                    onChange: (value) => narrowBy(setItemChoice, value),
                  },
                  {
                    label: "Payment",
                    value: paymentChoice,
                    options: paymentChoices,
                    onChange: (value) => narrowBy(setPaymentChoice, value),
                  },
                  {
                    label: "Starts",
                    value: dateChoice,
                    options: STARTS_OPTIONS,
                    onChange: (value) => narrowBy(setDateChoice, value),
                  },
                ]}
                range={{
                  shown: dateChoice === "custom",
                  from,
                  to,
                  onFrom: (value) => narrowBy(setFrom, value),
                  onTo: (value) => narrowBy(setTo, value),
                  reversed: backwards(range),
                }}
                count={filtersOn}
                onClear={clearFilters}
                open={filtersOpen}
                onToggle={() => setFiltersOpen((open) => !open)}
              />
              <ListTabs
                label="Status"
                tabs={RENTAL_TABS}
                counts={counts}
                active={tab}
                onChoose={chooseTab}
              />
            </>
          )}

          {/* The error first, then loading, then empty, then rows: a load that
              failed shows neither a count nor the empty text. Try again
              repeats the same load, as Refresh does; Refresh above stays
              usable. The markup is the Document requests page's. A tab with
              no bookings keeps its own text; one whose bookings the filters
              hide, with or without a search, says so in Document requests'
              words, naming the tab, and offers to clear the search and the
              filters; one whose bookings a search alone hides says so, naming
              the tab, and offers to clear the search. */}
          {loadError ? (
            <>
              <div className="alert error" role="alert">
                Could not load the bookings: {loadError}
              </div>
              <button type="button" className="btn secondary" onClick={load}>
                Try again
              </button>
            </>
          ) : requests === null ? (
            <p className="muted">Loading bookings…</p>
          ) : shown.length === 0 && filtered ? (
            <div className="empty">
              <p>{filtersNoMatchText(tab)}</p>
              <button
                type="button"
                className="btn secondary"
                onClick={clearSearchAndFilters}
              >
                Clear search and filters
              </button>
            </div>
          ) : shown.length === 0 && searching ? (
            <div className="empty">
              <p>{noMatchText(tab, query)}</p>
              <button
                type="button"
                className="btn secondary"
                onClick={clearSearch}
              >
                Clear search
              </button>
            </div>
          ) : shown.length === 0 ? (
            <div className="empty">
              <p>{emptyText(tab)}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table stack-narrow rental-bookings-table">
                <thead>
                  <tr>
                    <th className="rental-bookings-booked">Booked for</th>
                    <th className="rental-bookings-item">Item</th>
                    <th className="rental-bookings-schedule">Schedule</th>
                    <th className="num rental-bookings-qty">Qty</th>
                    <th>Purpose</th>
                    <th className="rental-bookings-status">Status</th>
                    {(canManage || canReturn) && (
                      <th className="rental-bookings-actions"></th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const meta = rentalMeta(displayStatus(r));
                    const returnable = isReturnable(r.rental_items?.type);
                    const schedule = scheduleParts(r);
                    return (
                      <tr key={r.request_id}>
                        <td>
                          <strong>{residentName(r)}</strong>
                          {isGuest(r) ? (
                            <div className="muted small-note">
                              Guest · {r.outside_borrower_contact}
                            </div>
                          ) : (
                            <AccountNote record={r.resident_records} />
                          )}
                          <div
                            className="muted doc-requests-number"
                            data-label="Booking"
                          >
                            {bookingNumber(r)}
                          </div>
                        </td>
                        <td data-label="Item">{r.rental_items?.name || "—"}</td>
                        <td data-label="Schedule">
                          {schedule ? (
                            <>
                              <span className="rental-bookings-date">
                                {schedule.date}
                              </span>{" "}
                              <span className="rental-bookings-times">
                                {schedule.times}
                              </span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num" data-label="Qty">
                          {r.quantity_requested}
                        </td>
                        <td className="muted truncate" data-label="Purpose">
                          {r.purpose}
                        </td>
                        <td>
                          <span className={`badge ${meta.className}`}>
                            {meta.label}
                          </span>
                          <PaymentMarker booking={r} />
                          {r.returned_at && r.returned_by?.username && (
                            <ReturnedBy booking={r} />
                          )}
                          {r.return_note && (
                            <div className="muted reason-note">
                              Note: {r.return_note}
                            </div>
                          )}
                          {r.status === "cancelled" &&
                            r.cancellation_reason && (
                              <div className="muted reason-note">
                                Reason: {r.cancellation_reason}
                              </div>
                            )}
                        </td>
                        {(canManage || canReturn) && (
                          <td className="row-actions">
                            {/* Edit and Cancel only where the server says the
                                booking has not started (not_started: stored
                                confirmed and its start ahead, the rule both
                                routes apply), online or walk-in. */}
                            {canManage && r.not_started === true && (
                              <>
                                <button
                                  className="btn secondary"
                                  onClick={() => setEditing(r)}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn secondary danger"
                                  data-cancel-for={r.request_id}
                                  onClick={() => {
                                    setFlash(null);
                                    setCancelling(r);
                                  }}
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                            {/* Never before the booking starts (the
                                server's not_started; it refuses too). */}
                            {canReturn &&
                              r.status === "confirmed" &&
                              returnable &&
                              r.not_started !== true && (
                                <button
                                  className="btn secondary"
                                  onClick={() => setReturning(r)}
                                >
                                  Mark returned
                                </button>
                              )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* The pager, under the rows, as on Document requests, from 11
              matches (components/ListPager.jsx). Drawn only once the list has
              loaded, never while it loads or beside a failed load, as the
              search and the tabs are. */}
          {requests !== null && (
            <ListPager
              paging={paging}
              onPage={setPage}
              onSize={changePageSize}
              headingRef={headingRef}
            />
          )}
        </>
      )}
    </>
  );
}
