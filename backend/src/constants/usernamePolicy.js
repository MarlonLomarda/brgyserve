// Canonical username rules for the whole API.
//
// WHY THIS FILE EXISTS. Before it there was NO username rule at either of the
// two places a username can be created — POST /api/auth/register and
// POST /api/secretary/accounts. Both checked that the field was non-empty and
// that it was not already taken, and nothing else: no length, no character
// set, not even a trim. `a`, `admin@brgy`, ` rad` and `JK` were all
// acceptable, and the live data shows it — 8 of the 19 existing accounts
// would fail the rules below.
//
// There is no client-side rule to mirror either. Neither RegisterPage nor the
// staff-account form in SecretaryReviewPage puts a `pattern` or a `minLength`
// on the username field, so the server is the only definition there has ever
// been.
//
// ===========================================================================
// WHY THE VALUE IS NOT LOWERCASED. This was the design as first drafted —
// take the submitted username, lowercase it, store that — and it was rejected
// because it silently creates a lockout that nobody would notice shipping.
//
// Login does an EXACT match: routes/auth.js does `.eq('username', username)`
// against a case-sensitive varchar(100), with no toLowerCase and no trim.
// Measured against the live database: .eq('Secretary1') returns NO MATCH
// while .eq('secretary1') returns user 1.
//
// So normalising at registration and leaving login alone would mean someone
// registering as "Marlon" is stored as "marlon", types "Marlon" at the login
// screen — the name they chose, the one their password manager saved — and
// receives 401 "Invalid username or password", which is the same answer a
// wrong password gets. After five of those the rate limiter locks them out
// for fifteen minutes. Nothing would have told them: the registration success
// response is a fixed sentence that does not contain the username, and the
// register screen renders only that sentence.
//
// REJECTING is therefore the safer rule, and it is also the more honest one.
// A rule that silently rewrites the user's input is not a rule they can learn;
// a rejection naming the problem is. The stored value is always exactly what
// was submitted, so what the user typed and what login matches can never
// diverge. Changing login to lowercase its input would be the other way to
// close this, and it is deliberately NOT done here: it would immediately
// break the `JK` account, whose stored username is uppercase.
//
// WHITESPACE IS THE ONE EXCEPTION, and it is trimmed rather than rejected
// because a leading space is invisible. " rad" and "rad" are different
// strings to a case-sensitive UNIQUE constraint, so without a trim they are
// two separate accounts that look identical in every list on every screen.
// Trimming is not normalisation in the sense rejected above: it cannot
// produce a stored value the user would fail to reproduce, because a user
// cannot see the difference in the first place. Whitespace INSIDE the name is
// a plain rejection like any other illegal character.
// ===========================================================================

const USERNAME_MIN_LENGTH = 5;

// The column is varchar(100) (migration 001). This bound is NOT one of the
// three rules — it exists so an over-long value is a clean 400 naming the
// limit, rather than a Postgres 22001 "value too long" that the error handler
// at the bottom of server.js turns into a 500 the caller cannot act on.
const USERNAME_MAX_LENGTH = 100;

// Lowercase letters, digits and underscores. Anything else is refused,
// including the dot that three existing accounts use and the hyphen.
const ALLOWED_RE = /^[a-z0-9_]+$/;
const UPPERCASE_RE = /[A-Z]/g;
// Everything that is neither allowed nor an uppercase letter. Uppercase is
// pulled out separately because the two have different remedies: an uppercase
// letter is fixed by typing it in lowercase, an illegal character has to go.
const ILLEGAL_RE = /[^a-z0-9_A-Z]/g;

const USERNAME_OK = (value) => ({ ok: true, error: null, value });
const refuse = (error) => ({ ok: false, error, value: null });

// A space shown between quotes is indistinguishable from nothing at all, so
// it is named instead of displayed.
const describeChar = (c) => {
  if (c === ' ') return 'a space';
  if (c === '\t') return 'a tab';
  return `"${c}"`;
};

function joinList(parts) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The one rule set, called by register and secretary account creation.
 *
 * @param {string} username the submitted value, untrimmed
 * @returns {{ ok: boolean, error: string|null, value: string|null }}
 *
 * THE CALLER MUST USE `value`, NOT ITS OWN COPY. That is the whole reason the
 * trimmed string is returned rather than validated and thrown away: a call
 * site that validates the submitted value and then inserts the submitted
 * value has trimmed nothing, and " rad" is back. The `{ ok, error }` shape
 * matches constants/passwordPolicy.js and fails the same way on misuse —
 * `if (result)` refuses every username loudly rather than accepting every one
 * silently.
 */
function validateUsername(username) {
  if (typeof username !== 'string') {
    return refuse('A username is required.');
  }

  const trimmed = username.trim();
  if (trimmed.length === 0) {
    return refuse('A username is required.');
  }

  // Reported on its own rather than folded in with the rules below: it is not
  // a mistake anyone makes by accident, and pairing "too long" with advice
  // about lowercase letters would read as noise.
  if (trimmed.length > USERNAME_MAX_LENGTH) {
    return refuse(`Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`);
  }

  // The fast path MUST test length as well as character set. With only the
  // character-set test here, "rad" matches /^[a-z0-9_]+$/ and returns OK
  // before ever reaching the length rule below — so the minimum would fire
  // only for usernames that ALSO contained an illegal character, which is to
  // say almost never. Caught by the walkthrough, not by reading.
  if (trimmed.length >= USERNAME_MIN_LENGTH && ALLOWED_RE.test(trimmed)) {
    return USERNAME_OK(trimmed);
  }

  // Everything that is wrong, in one message, naming only what is actually
  // wrong — the same rule the password policy follows. Returning the first
  // failure alone would walk someone typing "M.a" through three separate
  // rejections to reach one username.
  const problems = [];

  if (trimmed.length < USERNAME_MIN_LENGTH) {
    problems.push(`be at least ${USERNAME_MIN_LENGTH} characters long`);
  }

  const illegal = [...new Set(trimmed.match(ILLEGAL_RE) || [])];
  if (illegal.length) {
    problems.push(`not contain ${joinList(illegal.map(describeChar))}`);
  }

  const uppercase = trimmed.match(UPPERCASE_RE) || [];
  if (uppercase.length) {
    problems.push('use lowercase letters only');
  }

  let message = `Username must ${joinList(problems)}. Letters, numbers and underscores are allowed.`;

  // The concrete fix, but only when lowercasing really is the whole fix.
  // Offering `Try "ma.rlon"` to someone whose problem is the dot would be
  // advice that fails on the next submit.
  if (uppercase.length && !illegal.length && trimmed.length >= USERNAME_MIN_LENGTH) {
    message += ` Try "${trimmed.toLowerCase()}".`;
  }

  return refuse(message);
}

// Guard against the length rules being edited into disagreement with each
// other. Cheap, runs once at require time, and turns a nonsensical pair into
// a boot failure rather than a rule that can never be satisfied.
if (USERNAME_MIN_LENGTH > USERNAME_MAX_LENGTH) {
  throw new Error('usernamePolicy: USERNAME_MIN_LENGTH exceeds USERNAME_MAX_LENGTH.');
}

module.exports = {
  validateUsername,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
};
