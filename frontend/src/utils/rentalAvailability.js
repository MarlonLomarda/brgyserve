// What the booking forms say about availability before a booking: Book a
// rental (BookRentalPage.jsx) and the Secretary's walk-in form
// (WalkInBookingPanel in RentalBookingsPage.jsx). No React.
//
// THE PAGE ONLY ADVISES. Whether a slot is free is decided by the database
// (migration 024's rental_availability, the same rule create_rental_booking
// applies at Book now), and the server decides again on every booking. Nothing
// here computes availability: it words the server's numbers and blocks the
// button only on an answer the server gave. An answer carries numbers and, for
// a facility, that day's taken times; nothing about who booked or why, and
// nothing here would read it if it did.

export const CHECKING = "Checking availability…";
export const AVAILABILITY_FAILED =
  "Couldn't check availability. You can still try to book; the barangay checks again when you do.";
// The Edit panel's: the Secretary is the barangay, and saves rather than books.
export const EDIT_AVAILABILITY_FAILED =
  "Couldn't check availability. You can still save; the system checks again when you do.";
export const FACILITY_NOT_FREE = "Not free. That time overlaps a booking.";
export const FULLY_BOOKED = "Fully booked for that time.";
export const NOTHING_TAKEN = "Nothing is taken that day.";

// "8:00 AM", in Manila whatever clock the computer keeps.
const timeFmt = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  hour: "numeric",
  minute: "2-digit",
});
const manilaTime = (value) => timeFmt.format(new Date(value));

const isOrAre = (n) => (n === 1 ? "is" : "are");

// The question for GET /rental-requests/availability: the item and the form's
// date and two times, as the booking itself would send them. The Edit panel
// adds the booking being edited (`excludeId`), so it is not counted against
// its own new time; the server takes that from the Secretary only.
export function availabilityPath(itemId, { date, start_time, end_time }, excludeId) {
  const query = new URLSearchParams({
    item_id: String(itemId),
    date,
    start_time,
    end_time,
  });
  if (excludeId) query.set("exclude_request_id", String(excludeId));
  return `/rental-requests/availability?${query}`;
}

// Whether `data` is an answer the forms can word: ok, with whole numbers. A
// refusal, an empty body or anything else is a check that failed.
export function isAnswer(data) {
  return (
    data?.ok === true &&
    typeof data.item_type === "string" &&
    ["total", "used", "booked", "stuck", "resting", "left"].every((k) =>
      Number.isInteger(data[k]),
    )
  );
}

// An answer as lines of text, and its tone: "free" while the time can still be
// booked, "none" when it cannot. `slot` is the { start, end } the answer was
// for (bookingWindow in utils/bookingTimes.js).
export function availabilityText(answer, slot) {
  if (answer.item_type === "facility") {
    const taken = Array.isArray(answer.taken) ? answer.taken : [];
    const free = answer.left > 0;
    return {
      tone: free ? "free" : "none",
      lines: [
        free
          ? `Free for ${manilaTime(slot.start)} to ${manilaTime(slot.end)}.`
          : FACILITY_NOT_FREE,
        taken.length
          ? `Already taken that day: ${taken
              .map((t) => `${manilaTime(t.start)} to ${manilaTime(t.end)}`)
              .join(", ")}.`
          : NOTHING_TAKEN,
      ],
    };
  }
  const lines = [
    answer.left > 0
      ? `For that time: ${answer.booked} booked, ${answer.left} left of ${answer.total}.`
      : FULLY_BOOKED,
  ];
  if (answer.stuck > 0) {
    lines.push(`${answer.stuck} ${isOrAre(answer.stuck)} overdue and not yet returned.`);
  }
  if (answer.resting > 0) {
    lines.push(
      `${answer.resting} ${isOrAre(answer.resting)} resting for 24 hours after an earlier booking.`,
    );
  }
  return { tone: answer.left > 0 ? "free" : "none", lines };
}

// The most the quantity box may hold: what is left for the time asked, never
// more than the item has; with no answer, what the item has.
export function quantityCap(item, answer) {
  const has = item.quantity_available ?? item.quantity_total;
  return answer ? Math.min(answer.left, has) : has;
}

// Why the form may not be sent as it stands, from the server's answer, or
// null. With no answer (none asked yet, one out, or a check that failed)
// nothing blocks: the server decides.
export function bookingBlock({ answer, quantity, countable }) {
  if (!answer) return null;
  if (answer.item_type === "facility") {
    return answer.left > 0 ? null : FACILITY_NOT_FREE;
  }
  if (answer.left < 1) return FULLY_BOOKED;
  if (countable && quantity > answer.left) {
    return `Only ${answer.left} left. Lower the quantity to ${answer.left} or less.`;
  }
  return null;
}

// Why an edit may not be saved as it stands, or null: bookingBlock's rule for
// the Edit panel, where the quantity is fixed (cancel and book again to
// change it), so the way out is another time. `quantity` is the booking's
// own; the answer leaves the booking out of the count. No answer blocks
// nothing.
export function editBlock({ answer, quantity }) {
  if (!answer) return null;
  if (answer.item_type === "facility") {
    return answer.left > 0 ? null : FACILITY_NOT_FREE;
  }
  if (answer.left < 1) return FULLY_BOOKED;
  if (quantity > answer.left) {
    return `Only ${answer.left} left for that time; this booking needs ${quantity}. Choose another time.`;
  }
  return null;
}
