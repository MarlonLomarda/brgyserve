import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { bookingWindow } from "../utils/bookingTimes";
import { availabilityPath, isAnswer } from "../utils/rentalAvailability";

// How long the form must be still before it asks, so typing a time sends one
// request, not one per keystroke.
export const AVAILABILITY_DELAY_MS = 400;

// What is free for an item at the form's date and times, asked of
// GET /rental-requests/availability (migration 024's rental_availability):
// the booking forms' advice before Book now. A read; it cancels nothing on the
// server and the server decides again at Book now.
//
// Asked only once there is an item and a whole slot (bookingWindow in
// utils/bookingTimes.js), AVAILABILITY_DELAY_MS after the last change. Every
// change numbers a new question at once (seq), so an answer to an older one,
// however late, is dropped. While one is out the previous answer is kept,
// with the slot it was for, so the page can dim it rather than blank it.
//
// Returns { status: "idle" | "loading" | "ready" | "error", data, slot,
// reload }. data and slot are the last answer and its slot (kept while
// "loading"); reload asks again for the same fields, after a booking the
// server refused.
//
// `excludeId`, optional, is the booking being edited (the Edit panel): it is
// left out of the count, so the booking does not clash with its own time.
export default function useRentalAvailability(itemId, date, startTime, endTime, excludeId) {
  const { authFetch } = useAuth();
  const [state, setState] = useState({ status: "idle", data: null, slot: null });
  const [asked, setAsked] = useState(0);
  const seq = useRef(0);
  const ready =
    Boolean(itemId) &&
    bookingWindow({ date, start_time: startTime, end_time: endTime }) !== null;

  useEffect(() => {
    const mine = ++seq.current;
    if (!ready) {
      setState({ status: "idle", data: null, slot: null });
      return undefined;
    }
    setState((s) => ({ ...s, status: "loading" }));
    const fields = { date, start_time: startTime, end_time: endTime };
    const timer = setTimeout(async () => {
      try {
        const data = await authFetch(availabilityPath(itemId, fields, excludeId));
        if (mine !== seq.current) return;
        setState(
          isAnswer(data)
            ? { status: "ready", data, slot: bookingWindow(fields) }
            : { status: "error", data: null, slot: null },
        );
      } catch {
        if (mine === seq.current) setState({ status: "error", data: null, slot: null });
      }
    }, AVAILABILITY_DELAY_MS);
    return () => {
      clearTimeout(timer);
      // Unmounted or changed: whatever is out now answers nobody.
      if (seq.current === mine) seq.current += 1;
    };
  }, [authFetch, ready, itemId, date, startTime, endTime, excludeId, asked]);

  const reload = useCallback(() => setAsked((n) => n + 1), []);
  return { ...state, reload };
}
