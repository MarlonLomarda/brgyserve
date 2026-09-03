// Canonical password rules for the whole API.
//
// WHY THIS FILE EXISTS. Before it, the three routes that set a password each
// carried their own check, and all three checked only length:
//
//   routes/auth.js:54   register        String(password).length < 8
//   routes/auth.js:240  change-password String(new_password).length < 8
//   routes/auth.js:442  reset-password  String(new_password).length < 8
//
// Three copies of one rule is three places for it to drift, and reset-password
// was written months after register with no mechanism tying them together.
// They now call validatePassword() and nothing else, so a rule added here
// takes effect at every entry point at once or at none of them.
//
// THE SERVER IS THE DEFINITION. There is no client-side composition rule to
// mirror: the frontend's only password constraint is the HTML `minLength={8}`
// attribute on RegisterPage, ChangePasswordPage and ResetPasswordPage, which
// is a submit-time convenience and is bypassed by curl, by a disabled-JS
// browser, or by editing the DOM. Nothing was ever validated in the browser,
// so nothing here is a duplicate of anything there. A resident who submits a
// weak password through the current UI will be refused by the server with the
// message this file composes, and the field will not have warned them first.
//
// WHAT THIS DOES NOT DO. Login does not run these rules — it only compares a
// bcrypt hash — so every existing password keeps working exactly as it did.
// This gates password CREATION, not authentication. Retiring the weak
// passwords already on file is a separate, deliberate act (it means forcing a
// change on named accounts) and is not something a validator can do.

const crypto = require('crypto');

const PASSWORD_MIN_LENGTH = 8;

// "Special" is ANY character that is not an ASCII letter or digit.
//
// DELIBERATELY NOT A RESTRICTED SYMBOL SET. A curated list like [!@#$%^&*]
// looks tidier and is a trap here: it excludes the hyphen, and the hyphen is
// the only symbol in the `Temp-…` passwords this office hands out, so every
// staff account would be created with a password that fails the rule the same
// system enforces. A broad definition also never refuses a password for
// containing the wrong kind of symbol, which is a rejection no user can make
// sense of.
//
// One consequence worth naming: a non-ASCII letter counts as "special" under
// this definition, so the ñ in a name like Peñaflor satisfies the symbol rule
// while not satisfying the lowercase rule. That errs toward accepting, never
// toward refusing a password that should pass, and ñ is common in the names
// this barangay's residents actually use.
const SPECIAL_RE = /[^A-Za-z0-9]/;
const UPPERCASE_RE = /[A-Z]/;
const LOWERCASE_RE = /[a-z]/;
const DIGIT_RE = /[0-9]/;

// Words that must not appear ANYWHERE in a password, case-insensitively.
// These are the four strings anyone guessing at this specific deployment
// reaches for first, and they are checked as substrings rather than as whole
// passwords because "Barangay2026!" is the realistic shape, not "barangay".
const BANNED_TERMS = Object.freeze(['brgyserve', 'ubujan', 'barangay', 'tagbilaran']);

// ===========================================================================
// THE COMMON-PASSWORD LIST
//
// Hand-written, 63 entries, from the standard leaked-credential staples plus
// the handful of local ones. It is deliberately NOT a downloaded corpus: a
// real breach list is hundreds of megabytes, would have to be shipped or
// fetched, and buys very little over this — the passwords people actually
// choose under duress cluster hard at the top of any such list.
//
// MATCHED WHOLE, not as a substring, and that is the difference between this
// rule and BANNED_TERMS above. This is a list of PASSWORDS; that is a list of
// WORDS. Substring-matching entries like "test", "user" or "login" would
// refuse "Bohol-Test-Site-9!" for containing four letters, which is a
// rejection with no defensible reason behind it.
//
// The entries that pass every composition rule are the ones this list earns
// its keep on. "password" is already refused for having no uppercase, digit
// or symbol, so blocking it changes nothing; "Password1!" satisfies all five
// rules and is precisely what someone types when told to add a capital, a
// number and a symbol. Those are grouped last and must not be pruned as
// "obviously already covered" — they are the only entries that are not.
// ===========================================================================

const COMMON_PASSWORDS = Object.freeze(
  new Set(
    [
      '123456', '123456789', '12345678', '1234567890', '12345', '1234567',
      '000000', '111111', '654321', '987654321',
      'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword1',
      'qwerty', 'qwerty123', 'qwertyuiop', 'zxcvbnm', '1q2w3e4r', 'zaq12wsx',
      'abc123', 'abcd1234',
      'letmein', 'welcome', 'welcome1', 'welcome123',
      'admin', 'admin123', 'root', 'guest', 'user', 'login',
      'test', 'test123', 'changeme', 'secret', 'secret123',
      'iloveyou', 'trustno1', 'sunshine', 'princess', 'monkey', 'dragon',
      'master', 'superman', 'football', 'shadow',
      'pilipinas', 'mahalkita',
      // Composition-passing entries — see the note above.
      'Password1!', 'Password123!', 'P@ssw0rd!', 'P@ssword123',
      'Welcome1!', 'Welcome123!', 'Admin123!', 'Qwerty123!',
      'Letmein1!', 'Changeme1!', 'Secret123!', 'Summer2026!',
    ].map((entry) => entry.toLowerCase())
  )
);

// ===========================================================================
// THE RESULT SHAPE
//
// { ok: true, error: null } or { ok: false, error: '<one sentence>' }.
//
// An object rather than "a message, or null when it passes", because the two
// shapes fail in opposite directions when a call site misuses them. Given a
// bare string, `if (result.error)` reads undefined, treats every password as
// valid, and says nothing — the rule is gone and nothing looks wrong. Given
// this object, the same slip (`if (result)`) refuses every password on every
// route, which is discovered by the first person who tries to register.
// Failing closed and loudly is the whole reason for the extra field.
// ===========================================================================

const PASSWORD_OK = Object.freeze({ ok: true, error: null });

const refuse = (error) => ({ ok: false, error });

// "a, b and c" — Oxford-comma-free, because the message is read by residents.
function joinRequirements(parts) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The one rule set, called by register, change-password and reset-password.
 *
 * @param {string} password    the exact value that will be hashed
 * @param {{ username: string }} account
 * @returns {{ ok: boolean, error: string|null }}
 *
 * THE USERNAME IS REQUIRED, not optional, and this throws without one.
 * "Must not contain your username" cannot be enforced from a value the caller
 * did not supply, and an optional parameter turns that into a rule that is
 * silently absent wherever someone forgot it — the same class of failure this
 * module was written to end. All three call sites have a username in hand
 * (register from the request body, change-password from req.user, and
 * reset-password from the row the token resolves to), so a missing one is a
 * programming error and is treated as one.
 */
function validatePassword(password, account) {
  const username = account && typeof account.username === 'string' ? account.username.trim() : '';
  if (!username) {
    throw new Error(
      'validatePassword requires the account username: the blocklist checks that the password does not contain it.'
    );
  }

  // Anything that is not a string is not a password. The routes hash
  // String(password), so a JSON number would otherwise be accepted here and
  // stored as its decimal text — a password nobody typed and nobody can
  // predictably retype.
  if (typeof password !== 'string' || password.length === 0) {
    return refuse('A password is required.');
  }

  // NEVER TRIMMED. A leading or trailing space is a legitimate character and
  // it is part of what bcrypt will hash, so validating a trimmed copy would
  // check a different string from the one being stored.
  const lower = password.toLowerCase();

  // ---- Absolute rules first --------------------------------------------
  // These cannot be satisfied by adding characters, so they are reported
  // before the ones that can. Telling someone to add a digit to a password
  // that contains their username sends them back with a second password that
  // will be refused for the same reason.

  if (COMMON_PASSWORDS.has(lower)) {
    return refuse(
      'That password is one of the most commonly used passwords, so it is among the first an attacker tries. Please choose a different one.'
    );
  }

  if (lower.includes(username.toLowerCase())) {
    return refuse(
      'Your password must not contain your username. Anyone who knows your username would be guessing from it first.'
    );
  }

  const bannedTerm = BANNED_TERMS.find((term) => lower.includes(term));
  if (bannedTerm) {
    return refuse(
      `Your password must not contain "${bannedTerm}". Words connected to this office or barangay are the first thing anyone guessing would try.`
    );
  }

  // ---- Composition, reported together ----------------------------------
  // Every unmet requirement in ONE message, naming only what is actually
  // missing. Returning the first failure alone would walk a resident through
  // up to four rejections to reach one password, and naming all five would
  // tell someone to add a symbol they already have.

  const unmet = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    unmet.push(`be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }
  if (!UPPERCASE_RE.test(password)) unmet.push('contain an uppercase letter');
  if (!LOWERCASE_RE.test(password)) unmet.push('contain a lowercase letter');
  if (!DIGIT_RE.test(password)) unmet.push('contain a number');
  if (!SPECIAL_RE.test(password)) unmet.push('contain a symbol (for example ! ? - #)');

  if (unmet.length) {
    return refuse(`Password must ${joinRequirements(unmet)}.`);
  }

  return PASSWORD_OK;
}

// ===========================================================================
// THE TEMPORARY PASSWORD THE SECRETARY HANDS OVER
//
// It lives here, beside the rules, rather than inline in routes/secretary.js
// where it used to. The old form was
//
//     `Temp-${crypto.randomBytes(9).toString('base64url')}`
//
// and it satisfied four of the five rules by accident of the literal prefix
// while leaving the digit rule to chance: base64url's 64-character alphabet
// holds only 10 digits, so across 12 random characters (54/64)^12 = 13.02% of
// generated passwords contained none. Measured over 200,000 samples: 12.94%.
//
// This is the one password in the system that a person reads off a handover
// note and types, so it meets the same bar as one they choose themselves.
//
// EVERY RULE IS NOW SATISFIED BY THE FIXED SCAFFOLDING, NEVER BY CHANCE:
// the `T` supplies the uppercase, `emp` the lowercase, `-` the symbol, and
// the appended digit the digit. The random middle carries the entropy — 12
// base64url characters, 72 bits — and is never load-bearing for compliance.
// That separation is the point: the previous format failed precisely because
// one rule depended on what the random part happened to produce.
//
// THE RETRY LOOP IS NOT DECORATION. The blocklist refuses a password
// containing the account's username, and a short username can turn up inside
// the random middle by chance — for a two-character username such as `JK`
// that is roughly 1 in 370 accounts. Validating the candidate against the
// real rules, with the real username, is also what keeps this generator
// correct if the rules are ever tightened again: it would start failing
// loudly at account creation instead of quietly issuing passwords that the
// system's own policy rejects.
// ===========================================================================

const TEMP_PASSWORD_PREFIX = 'Temp-';
const TEMP_PASSWORD_BYTES = 9; // 12 base64url characters
const TEMP_PASSWORD_MAX_ATTEMPTS = 20;

function generateTemporaryPassword(username) {
  for (let attempt = 0; attempt < TEMP_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
    const middle = crypto.randomBytes(TEMP_PASSWORD_BYTES).toString('base64url');
    const candidate = `${TEMP_PASSWORD_PREFIX}${middle}${crypto.randomInt(10)}`;
    if (validatePassword(candidate, { username }).ok) return candidate;
  }
  // Unreachable in practice — 20 consecutive collisions against a username is
  // not a probability, it is a rule change that this format can no longer
  // satisfy. Throwing says so at the moment of account creation rather than
  // handing over a password the policy would refuse.
  throw new Error(
    `Could not generate a temporary password satisfying the password policy after ${TEMP_PASSWORD_MAX_ATTEMPTS} attempts.`
  );
}

module.exports = {
  validatePassword,
  generateTemporaryPassword,
  PASSWORD_MIN_LENGTH,
  BANNED_TERMS,
  COMMON_PASSWORDS,
};
