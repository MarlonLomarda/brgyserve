// The two kinds of booking the booking forms split (step C2, 27 Oct 2026):
// Book a rental's Facilities | Items tabs (BookRentalPage.jsx) and the
// walk-in form's Facility | Item toggle (WalkInBookingPanel in
// RentalBookingsPage.jsx). No React.
//
// A FACILITY is booked and used in place: one at a time, no quantity, no
// return step. An ITEM, equipment or furniture, is taken out in a quantity
// and brought back, so its times read "Pick-up time" and "Return time". Only
// the words change: both kinds send the same body (start_time and end_time),
// and the server, which decides every booking, never sees the kind.
import { isReturnable } from "../constants/rentals";

export const FACILITY = "facility";
export const ITEM = "item";

// The items a kind lists, in the order loaded: facilities on one, equipment
// and furniture (isReturnable) on the other. An item of any other type is
// listed on neither.
export function ofKind(items, kind) {
  return items.filter((i) =>
    kind === FACILITY ? i.type === "facility" : isReturnable(i.type),
  );
}

// What each kind's tab, heading and fields say. `none` takes the place of the
// fields after a load that held nothing of that kind.
export const KIND_TEXT = {
  [FACILITY]: {
    tab: "Facilities",
    toggle: "Facility",
    title: "Book a Facility",
    subtitle: "Book a barangay facility",
    field: "Facility",
    choose: "Select a facility…",
    start: "Start time",
    end: "End time",
    none: "No facility is currently available for booking.",
  },
  [ITEM]: {
    tab: "Items",
    toggle: "Item",
    title: "Rent an Item",
    subtitle: "Rent a barangay item",
    field: "Item",
    choose: "Select an item…",
    start: "Pick-up time",
    end: "Return time",
    none: "No item is currently available for rental.",
  },
};

// What RentalAvailability is shown while no item is chosen: nothing. The
// hook goes idle once the item is cleared, but only after the render that
// cleared it, so a facility's answer would otherwise show for that render
// under the Items tab.
export const NOT_ASKED = { status: "idle", data: null, slot: null };
