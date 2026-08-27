import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// A password field with a show/hide toggle. One component for all five
// password inputs in the app (login, registration, and the three on change
// password) so they cannot drift apart in behaviour or wording.
//
// The toggle is a real <button type="button">. That matters twice over:
//   * type="button" keeps it out of implicit form submission — pressing Enter
//     in a text input submits via the first SUBMIT button, and this is not
//     one, so revealing a password can never post the form.
//   * a native button is focusable by Tab and fires on both Enter and Space
//     with no key handling of our own. A <div role="button"> would need
//     tabIndex and a keydown handler to match, and would still miss things
//     browsers give buttons for free.
//
// Visibility is per-field state, so revealing "New password" does not also
// reveal "Confirm new password" — they are checked against each other and
// showing both at once defeats the point of confirming.
export default function PasswordInput({ ...rest }) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="pw-field">
      {/* `type` is set AFTER the spread on purpose: callers pass
          type="password" (RegisterPage's Field helper does), and this must win
          over it rather than be overridden by it. */}
      <input {...rest} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setVisible((shown) => !shown)}
        aria-label={label}
        aria-pressed={visible}
        title={label}
      >
        {visible ? (
          <EyeOff size={18} aria-hidden="true" focusable="false" />
        ) : (
          <Eye size={18} aria-hidden="true" focusable="false" />
        )}
      </button>
    </div>
  );
}
