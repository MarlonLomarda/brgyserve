import { Check, Circle } from 'lucide-react';

// ===========================================================================
// THESE FIVE RULES ARE A DELIBERATE DUPLICATE OF THE SERVER'S.
//
// The single definition is backend/src/constants/passwordPolicy.js. THE
// SERVER IS THE AUTHORITY — it validates every password on register,
// change-password and reset-password, and nothing here changes that. This
// component only shows a resident what they are still missing while they
// type, so they find out before a round trip instead of after one.
//
// WHY IT IS DUPLICATED RATHER THAN IMPORTED. Importing the real module
// across the directory boundary was measured and rejected:
//   * passwordPolicy.js does `require('crypto')` for the temporary-password
//     generator. Vite does not fail on that — it silently substitutes an
//     EMPTY OBJECT and prints a warning, so the bundle would carry a
//     function that throws at call time in the browser and nowhere else.
//   * `vite build` resolves the path, but the DEV SERVER refuses it:
//     server.fs.allow defaults to the workspace root, which resolves to
//     frontend/ and not the repo root, so dev 403s while the build succeeds.
//   * Vercel's Root Directory is `frontend`, so reaching outside it couples
//     the deploy to a setting that lives in a dashboard rather than in this
//     repo.
// Five regexes are cheaper to duplicate than to share. If a rule changes in
// passwordPolicy.js, change it here too.
//
// THIS CHECKLIST IS NOT THE WHOLE RULE SET. It covers COMPOSITION ONLY. The
// server additionally refuses a password that is on its 63-entry common
// password blocklist, that contains the account's own username, or that
// contains brgyserve / ubujan / barangay / tagbilaran. Those rules are NOT
// shown here — two of them cannot be (the reset screen does not know the
// username), and the blocklist is a list, not a rule anyone can act on while
// typing. So **a password showing all five ticks can still be rejected on
// submit**, and that is expected behaviour, not a contradiction. The server's
// message says which rule it failed.
// ===========================================================================

const RULES = [
  { id: 'length', label: 'At least 8 characters', test: (v) => v.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'lower', label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { id: 'digit', label: 'A number', test: (v) => /[0-9]/.test(v) },
  {
    id: 'symbol',
    label: 'A symbol (for example ! ? - #)',
    test: (v) => /[^A-Za-z0-9]/.test(v),
  },
];

export default function PasswordChecklist({ value = '' }) {
  // Nothing is shown for an empty field. An untouched form opening with five
  // unmet rules reads as five things already wrong, which is both untrue and
  // discouraging before anyone has typed a character. It appears on the first
  // keystroke and disappears again if the field is cleared.
  if (!value) return null;

  return (
    <ul className="pw-rules">
      {RULES.map((rule) => {
        const met = rule.test(value);
        return (
          <li
            key={rule.id}
            className={met ? 'met' : undefined}
            // The icon is decorative, so the row carries the state in text
            // for a screen reader instead. Deliberately NOT aria-live: this
            // re-renders on every keystroke and announcing five rows each
            // time would be unusable.
            aria-label={`${met ? 'Met' : 'Not met yet'}: ${rule.label}`}
          >
            {met ? (
              <Check size={15} aria-hidden="true" focusable="false" />
            ) : (
              <Circle size={15} aria-hidden="true" focusable="false" />
            )}
            <span>{rule.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
