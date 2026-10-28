// The barangay's booking rules (migration 025, 28 Oct 2026): each rental item
// can be booked only within its own hours (rental_items.booking_opens_at and
// booking_closes_at), and a booking may start no more than MAX_DAYS_AHEAD
// days after today in Manila. Same-day bookings are allowed; the start must
// only be in the future, which parseBookingBody and migration 024's
// functions already check.
//
// THE 31 IS FIXED IN THE CODE (step O43, 28 Oct 2026). Migration 025 kept it
// in a one-row rental_settings table that the Secretary could change on the
// Rental items page; the Secretary does not need to, so the box, PUT
// /api/rental-settings and every read of the table were removed, and
// migration 026 drops the table. GET /api/rental-settings still answers
// { max_days_ahead } for the booking forms, from this constant.
//
// No requires, so test:auth can load this file and compare the booking
// forms' copy of these sentences (frontend/src/utils/bookingTimes.js) with
// this one, input by input. A change to a sentence here owes that file the
// same edit.
//
// MIDNIGHT. A close at midnight is stored as 24:00:00, which Postgres's
// `time` holds. A booking that ends at midnight ends at 00:00 of the next
// day: the form's end time "00:00" (or "24:00") means the end of the
// booking's date, minute 1440, and is allowed only for an item that closes
// at 24:00.

const MIDNIGHT = 24 * 60;
const MAX_DAYS_AHEAD = 31;

// "HH:MM" or "HH:MM:SS" (what PostgREST sends for a `time`) as minutes since
// midnight, 0 to 1440; null for anything else. Seconds must be :00.
function clockMinutes(text) {
  const m = /^(\d{2}):(\d{2})(?::00)?$/.exec(String(text ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return MIDNIGHT;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes since midnight as the barangay says them: "7:00 AM", "5:00 PM",
// "12:00 PM" at noon, and "12:00 midnight" at either end of the day.
function clockText(minutes) {
  if (minutes === 0 || minutes === MIDNIGHT) return '12:00 midnight';
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

// The refusals, word for word as the booking forms say them.
function hoursRefusal(name, opensAt, closesAt) {
  return `The ${name} can be booked from ${clockText(clockMinutes(opensAt))} to ${clockText(clockMinutes(closesAt))}.`;
}
function daysAheadRefusal(maxDaysAhead) {
  return `Bookings can be made up to ${maxDaysAhead} day${maxDaysAhead === 1 ? '' : 's'} ahead.`;
}

// Whole days from `today` to `date`, both "YYYY-MM-DD".
function daysBetween(today, date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

// Why a booking breaks the rules, or null. `slot` is the date ("YYYY-MM-DD",
// Manila) and the start and end as minutes since midnight on that date (the
// end 1440 for midnight); `item` carries name, booking_opens_at and
// booking_closes_at; `today` is today's Manila date. How far ahead first,
// then the hours. A start or end time the item does not have (an item read
// without its hours) is thrown, never treated as open all day.
function bookingRuleRefusal(slot, item, maxDaysAhead, today) {
  if (daysBetween(today, slot.date) > maxDaysAhead) return daysAheadRefusal(maxDaysAhead);
  const opens = clockMinutes(item.booking_opens_at);
  const closes = clockMinutes(item.booking_closes_at);
  if (opens === null || closes === null) {
    throw new Error(`Rental item ${item.item_id} has no booking hours (${item.booking_opens_at}, ${item.booking_closes_at})`);
  }
  if (slot.startMinutes < opens || slot.endMinutes > closes) {
    return hoursRefusal(item.name, item.booking_opens_at, item.booking_closes_at);
  }
  return null;
}

module.exports = {
  MIDNIGHT,
  MAX_DAYS_AHEAD,
  clockMinutes,
  clockText,
  hoursRefusal,
  daysAheadRefusal,
  daysBetween,
  bookingRuleRefusal,
};
