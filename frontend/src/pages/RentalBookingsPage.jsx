import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import ListFilters from "../components/ListFilters";
import ListPager from "../components/ListPager";
import ListTabs from "../components/ListTabs";
import ListToolbar from "../components/ListToolbar";
import ResidentPicker from "../components/ResidentPicker";
import { formatDate } from "../constants/requestStatus";
import {
  ITEM_TYPE_LABELS,
  RETURN_OUTCOMES,
  displayStatus,
  formatSchedule,
  isReturnable,
  rentalMeta,
} from "../constants/rentals";
import { ANY, backwards, manilaToday } from "../utils/chargeFilters";
import { searchTerms } from "../utils/chargeSearch";
import { PAGE_SIZE, PAGE_SIZES, pageOf } from "../utils/paging";
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
} from "../utils/rentalList";

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

const pad = (n) => String(n).padStart(2, "0");
const toDateInput = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const toTimeInput = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function EditPanel({ booking, onDone }) {
  const { authFetch } = useAuth();
  const item = booking.rental_items;
  const isCountable = item?.quantity_total > 1;
  const [form, setForm] = useState({
    date: toDateInput(booking.start_datetime),
    start_time: toTimeInput(booking.start_datetime),
    end_time: toTimeInput(booking.end_datetime),
    quantity: String(booking.quantity_requested),
    purpose: booking.purpose,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await authFetch(`/rental-requests/${booking.request_id}`, {
        method: "PUT",
        body: {
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          quantity_requested: isCountable ? Number(form.quantity) : 1,
          purpose: form.purpose,
        },
      });
      onDone({ type: "success", text: data.message });
    } catch (err) {
      setError(err.message); // conflict messages land here
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="pending-card">
      <div className="pending-head">
        <div>
          <h3>Edit booking #{booking.request_id}</h3>
          <p className="muted">
            {residentName(booking)} · {item?.name} (
            {ITEM_TYPE_LABELS[item?.type] || item?.type})
          </p>
        </div>
        <button className="btn secondary" onClick={() => onDone(null)}>
          ← Back to list
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="grid-2">
          <label>
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
          {isCountable && (
            <label>
              Quantity{" "}
              <span className="hint">(up to {item.quantity_total})</span>
              <input
                name="quantity"
                type="number"
                min="1"
                max={item.quantity_total}
                step="1"
                value={form.quantity}
                onChange={handleChange}
                required
              />
            </label>
          )}
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
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Checking availability…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Staff record a physical item's return: an outcome + optional note.
function ReturnPanel({ booking, onDone }) {
  const { authFetch } = useAuth();
  const item = booking.rental_items;
  const [outcome, setOutcome] = useState(RETURN_OUTCOMES[0].value);
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
    <div className="pending-card">
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

      {error && <div className="alert error">{error}</div>}

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
// THE CONFLICT CHECK IS THE SERVER'S. This posts to the same
// POST /rental-requests handler BookRentalPage does, and that handler runs
// findConflict() before and after the insert for every caller — there is no
// second code path a walk-in could take around it. Refusals surface here in
// `error` exactly as they do on the resident form.
function WalkInBookingPanel({ onDone }) {
  const { authFetch } = useAuth();
  const [items, setItems] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState("resident"); // 'resident' | 'guest'
  const [resident, setResident] = useState(null);
  const [guest, setGuest] = useState({ name: "", contact: "" });
  const [form, setForm] = useState({ ...EMPTY_WALK_IN });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authFetch("/rental-items");
        if (!cancelled) setItems(data.rental_items);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          setItems([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const selectedItem = items?.find(
    (i) => String(i.item_id) === String(form.item_id),
  );
  const isCountable = selectedItem && selectedItem.quantity_total > 1;
  const quantity = isCountable ? Number(form.quantity) || 0 : 1;
  const estimatedFee = selectedItem ? Number(selectedItem.fee) * quantity : 0;

  function handleChange(e) {
    const { name, value } = e.target;
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

  async function handleSubmit(e) {
    e.preventDefault();
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
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="pending-card">
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

      {loadError && <div className="alert error">{loadError}</div>}
      {error && <div className="alert error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="tab-container">
          <button
            type="button"
            className={`tab ${mode === "resident" ? "active-tab" : ""}`}
            onClick={() => switchMode("resident")}
          >
            Existing resident
          </button>
          <button
            type="button"
            className={`tab ${mode === "guest" ? "active-tab" : ""}`}
            onClick={() => switchMode("guest")}
          >
            Guest from another barangay
          </button>
        </div>

        {mode === "resident" ? (
          <>
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

        {items === null ? (
          <p className="muted">Loading rental items…</p>
        ) : items.length === 0 ? (
          <p className="muted">Nothing is currently available for rental.</p>
        ) : (
          <>
            <label>
              Facility / item
              <select
                name="item_id"
                value={form.item_id}
                onChange={handleChange}
                required
              >
                <option value="" disabled>
                  Select an item…
                </option>
                {items.map((i) => (
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
            {selectedItem?.description && (
              <p className="muted type-description">
                {selectedItem.description}
              </p>
            )}

            <div className="grid-2">
              <label>
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
              {isCountable && (
                <label>
                  Quantity{" "}
                  <span className="hint">
                    (up to {selectedItem.quantity_total})
                  </span>
                  <input
                    name="quantity"
                    type="number"
                    min="1"
                    max={selectedItem.quantity_total}
                    step="1"
                    value={form.quantity}
                    onChange={handleChange}
                    required
                  />
                </label>
              )}
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
                {isCountable && quantity > 0 && (
                  <>
                    {" "}
                    ({quantity} × ₱{Number(selectedItem.fee).toFixed(2)})
                  </>
                )}
              </p>
            )}

            <div className="actions">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Checking availability…" : "Record booking"}
              </button>
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
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // booking being edited
  const [returning, setReturning] = useState(null); // booking being returned
  const [encoding, setEncoding] = useState(false); // walk-in panel open
  // The search, as typed. Here rather than in the box, so it outlives the list
  // while the Edit, Mark returned or walk-in panel takes its place.
  const [query, setQuery] = useState("");
  const searchRef = useRef(null); // the search box, for Clear search
  // The page of the chosen tab's matches, and how many rows a page holds.
  // Like the search, both live through every reload and Back from a panel.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // The filters: Item, Payment and Starts (its choice, and From and To under
  // "Choose dates"). Like the search, they live here, so they outlive the list
  // while a panel takes its place; every visit starts them at Any, and none
  // is kept in the browser.
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

  async function handleCancel(r) {
    const when = formatSchedule(r.start_datetime, r.end_datetime);
    if (
      !window.confirm(
        `Cancel ${residentName(r)}'s booking of ${r.rental_items?.name} (${when})? The slot will be freed for others.`,
      )
    ) {
      return;
    }
    setFlash(null);
    setBusyId(r.request_id);
    try {
      const data = await authFetch(`/rental-requests/${r.request_id}/cancel`, {
        method: "POST",
      });
      setFlash({ type: "success", text: data.message });
      await load();
    } catch (err) {
      setFlash({ type: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  }

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
    itemChoice !== ANY_ITEM || paymentChoice !== ANY || range !== null;
  // How many filters are on: the "(2)" on a phone's Filters button, and Clear
  // filters is offered while it is above 0.
  const filtersOn = filterCount({
    item: itemChoice,
    payment: paymentChoice,
    date: dateChoice,
  });
  const searched = requests === null ? [] : matchingBookings(requests, query);
  const matching = searched.filter(
    (r) =>
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

  // Item, Payment, Starts, From and To.
  function narrowBy(set, value) {
    set(value);
    setPage(1);
  }

  function resetFilters() {
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
          {flash && <div className={`alert ${flash.type}`}>{flash.text}</div>}

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
                          {r.return_note && (
                            <div className="muted reason-note">
                              Note: {r.return_note}
                            </div>
                          )}
                          {r.returned_at && r.returned_by?.username && (
                            <div className="muted small-note">
                              by @{r.returned_by.username} on{" "}
                              {formatDate(r.returned_at)}
                            </div>
                          )}
                        </td>
                        {(canManage || canReturn) && (
                          <td className="row-actions">
                            {canManage && r.status === "confirmed" && (
                              <>
                                <button
                                  className="btn secondary"
                                  disabled={busyId === r.request_id}
                                  onClick={() => setEditing(r)}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn secondary danger"
                                  disabled={busyId === r.request_id}
                                  onClick={() => handleCancel(r)}
                                >
                                  {busyId === r.request_id
                                    ? "Cancelling…"
                                    : "Cancel"}
                                </button>
                              </>
                            )}
                            {canReturn &&
                              r.status === "confirmed" &&
                              returnable && (
                                <button
                                  className="btn secondary"
                                  disabled={busyId === r.request_id}
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
