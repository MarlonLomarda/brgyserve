// The booking form's earliest date and its time checks (BookRentalPage.jsx).
// No React.
//
// A BOOKING RUNS WITHIN ONE MANILA DAY, whatever clock the resident's computer
// keeps: the server builds its start and end from one date and two times at
// +08:00 (parseBookingBody in backend/src/routes/rentalRequests.js). So the
// form reads them the same way: "today" is the Manila day, and a time is a
// Manila time. The checks stop only what the server would refuse for its
// times, in the server's order and the server's words, before anything is
// sent. The server stays the authority and checks again; its clock decides.
//
// THE BOOKING RULES (migration 025): each item has its own hours, and a
// booking may start no more than max_days_ahead days after today in Manila
// (31, a constant in the server's code since step O43, sent by GET
// /rental-settings).
// An end time of 00:00 is MIDNIGHT AT THE END OF THE DATE, allowed only for
// an item that closes at midnight (stored as 24:00:00). The sentences are the
// server's, from backend/src/constants/rentalBookingRules.js, which this file
// cannot import (CommonJS, another package): test:auth compares the two
// copies input by input, so a change to one owes the other the same edit.
import { manilaDay } from "./chargeFilters";

// parseBookingBody's two refusals, word for word.
export const PAST_START = "The booking must start in the future";
export const END_NOT_AFTER_START =
  "End time must be after the start time (bookings run within one day)";

// The server's own patterns: a date input gives "YYYY-MM-DD", a time input
// with no step gives "HH:MM".
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const MIDNIGHT = 24 * 60;

// "HH:MM" or "HH:MM:SS" (an item's hours as the server sends them) as
// minutes since midnight, 0 to 1440; null for anything else.
export function clockMinutes(text) {
  const m = /^(\d{2}):(\d{2})(?::00)?$/.exec(String(text ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return MIDNIGHT;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes since midnight as the barangay says them: "7:00 AM", "5:00 PM",
// "12:00 PM" at noon, and "12:00 midnight" at either end of the day. The one
// way an item's hours are written, on the booking forms, the Rental items
// page and the Activity Log.
export function clockText(minutes) {
  if (minutes === 0 || minutes === MIDNIGHT) return "12:00 midnight";
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

// An item's hours, "7:00 AM – 5:00 PM", or null when it carries none (an
// answer from before migration 025: nothing is said rather than a guess).
export function hoursText(item) {
  const opens = clockMinutes(item?.booking_opens_at);
  const closes = clockMinutes(item?.booking_closes_at);
  if (opens === null || closes === null) return null;
  return `${clockText(opens)} – ${clockText(closes)}`;
}

// The server's two booking-rule refusals, word for word.
export function hoursRefusal(name, opensAt, closesAt) {
  return `The ${name} can be booked from ${clockText(clockMinutes(opensAt))} to ${clockText(clockMinutes(closesAt))}.`;
}
export function daysAheadRefusal(maxDaysAhead) {
  return `Bookings can be made up to ${maxDaysAhead} day${maxDaysAhead === 1 ? "" : "s"} ahead.`;
}

// The earliest date the form offers: today in Manila at `now`. Until 8 AM in
// Manila, today in UTC is still yesterday.
export function earliestBookingDate(now) {
  return manilaDay(now);
}

// A day plus n days, on the calendar (UTC midnights, so no clock's daylight
// saving can move it).
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The latest date the form offers: today in Manila plus max_days_ahead, or
// null while the limit is not known (the field then has no max, and the
// server still checks).
export function latestBookingDate(now, maxDaysAhead) {
  if (!Number.isInteger(maxDaysAhead)) return null;
  return addDays(earliestBookingDate(now), maxDaysAhead);
}

// "HH:MM" from minutes, for an input's min and max.
const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// The time fields' limits for an item, as input attributes, or {} for an
// item with no hours. A time field cannot hold 24:00: for an item that closes
// at midnight the start runs to 23:59, and the end's max is 00:00, below its
// min, which a time field reads as a range that wraps past midnight.
export function timeLimits(item) {
  const opens = clockMinutes(item?.booking_opens_at);
  const closes = clockMinutes(item?.booking_closes_at);
  if (opens === null || closes === null) return { start: {}, end: {} };
  return {
    start: { min: hhmm(opens), max: hhmm(closes === MIDNIGHT ? MIDNIGHT - 1 : closes) },
    end: { min: hhmm(opens), max: hhmm(closes === MIDNIGHT ? 0 : closes) },
  };
}

// A stored booking time as the form's two fields, "YYYY-MM-DD" and "HH:MM",
// in Manila whatever clock the computer keeps (the Edit panel's prefill).
const MANILA_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function manilaInputs(value) {
  return { date: manilaDay(value), time: MANILA_TIME.format(new Date(value)) };
}

// A date and a time from the form, as the moment the server will read them,
// or null while either is missing or not yet whole. `asEnd` reads 00:00 as
// midnight at the end of the date, as the server reads an end time.
function manilaMoment(date, time, asEnd = false) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return null;
  const moment = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(moment.getTime())) return null;
  return asEnd && time === "00:00"
    ? new Date(moment.getTime() + MIDNIGHT * 60000)
    : moment;
}

// The slot the form describes, as the two moments the server will read, or
// null while the date or a time is missing or not yet whole, or the end is not
// after the start. A start already past still gives a slot: the form may ask
// what is taken then, and bookingTimeError refuses the booking itself. The
// availability check (hooks/useRentalAvailability.js) asks only for a slot.
export function bookingWindow({ date, start_time, end_time }) {
  const start = manilaMoment(date, start_time);
  const end = manilaMoment(date, end_time, true);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start, end };
}

// Why the server would refuse the form's times, in its words, or null. The
// server checks an end not after the start first, then a start not ahead of
// `now`, then (migration 025) how far ahead and the item's hours, so these
// do too. A date before today in Manila is refused even before its times are
// in; any other missing time is left to the form's required fields and to
// the server. `rules` is { item, maxDaysAhead }; either may be missing (no
// item chosen yet, or the limit not loaded), and then that rule is left to
// the server.
export function bookingTimeError({ date, start_time, end_time }, now, rules = {}) {
  const start = manilaMoment(date, start_time);
  const end = manilaMoment(date, end_time, true);
  if (start && end && end.getTime() <= start.getTime()) {
    return END_NOT_AFTER_START;
  }
  if (start && start.getTime() <= now.getTime()) return PAST_START;
  if (DATE_RE.test(date) && date < earliestBookingDate(now)) return PAST_START;
  return bookingRuleError({ date, start_time, end_time }, now, rules);
}

// The booking rules alone (migration 025), in the server's order and words:
// how far ahead, then the item's hours. Null while the date or a time is not
// whole, and for a rule whose facts are missing. The forms also use it to
// leave the availability check unasked while the slot breaks a rule, so a
// "Free for …" never sits beside a refusal of the same slot.
export function bookingRuleError({ date, start_time, end_time }, now, rules = {}) {
  if (!manilaMoment(date, start_time) || !manilaMoment(date, end_time, true)) return null;
  const latest = latestBookingDate(now, rules.maxDaysAhead);
  if (latest && date > latest) return daysAheadRefusal(rules.maxDaysAhead);
  const { item } = rules;
  const opens = clockMinutes(item?.booking_opens_at);
  const closes = clockMinutes(item?.booking_closes_at);
  if (opens !== null && closes !== null) {
    const startMinutes = clockMinutes(start_time);
    const endMinutes = end_time === "00:00" ? MIDNIGHT : clockMinutes(end_time);
    if (startMinutes < opens || endMinutes > closes) {
      return hoursRefusal(item.name, item.booking_opens_at, item.booking_closes_at);
    }
  }
  return null;
}
