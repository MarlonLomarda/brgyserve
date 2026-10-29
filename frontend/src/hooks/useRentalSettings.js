import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";

// How many days ahead a booking may start (GET /rental-settings, migration
// 025; a constant in the server's code, 31, since step O43), for the booking
// forms and the Secretary's Edit panel: the hint beside the date, the date
// field's max and the form's own check. Asked once when the form opens.
//
// Returns the number, or null while it is out, after a failed load, or when
// the answer holds no whole number. Null shows nothing and limits nothing:
// the hint is left out rather than guessed, and the server, which applies the
// rule itself on every booking, still refuses a date too far ahead in its own
// words. The rule is advice on the page, never the page's to decide.
export default function useRentalSettings() {
  const { authFetch } = useAuth();
  const [maxDaysAhead, setMaxDaysAhead] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await authFetch("/rental-settings");
        if (live && Number.isInteger(data?.max_days_ahead)) setMaxDaysAhead(data.max_days_ahead);
      } catch {
        // Nothing is shown; the server checks at Book now.
      }
    })();
    return () => {
      live = false;
    };
  }, [authFetch]);

  return maxDaysAhead;
}
