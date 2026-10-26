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
import { manilaDay } from "./chargeFilters";

// parseBookingBody's two refusals, word for word.
export const PAST_START = "The booking must start in the future";
export const END_NOT_AFTER_START =
  "End time must be after the start time (bookings run within one day)";

// The server's own patterns: a date input gives "YYYY-MM-DD", a time input
// with no step gives "HH:MM".
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// The earliest date the form offers: today in Manila at `now`. Until 8 AM in
// Manila, today in UTC is still yesterday.
export function earliestBookingDate(now) {
  return manilaDay(now);
}

// A date and a time from the form, as the moment the server will read them,
// or null while either is missing or not yet whole.
function manilaMoment(date, time) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return null;
  const moment = new Date(`${date}T${time}:00+08:00`);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

// Why the server would refuse the form's times, in its words, or null. The
// server checks an end not after the start first, then a start not ahead of
// `now`, so these do too. A date before today in Manila is refused even
// before its times are in; any other missing time is left to the form's
// required fields and to the server.
export function bookingTimeError({ date, start_time, end_time }, now) {
  const start = manilaMoment(date, start_time);
  const end = manilaMoment(date, end_time);
  if (start && end && end.getTime() <= start.getTime()) {
    return END_NOT_AFTER_START;
  }
  if (start && start.getTime() <= now.getTime()) return PAST_START;
  if (DATE_RE.test(date) && date < earliestBookingDate(now)) return PAST_START;
  return null;
}
