const supabase = require('../config/supabase');

// ===========================================================================
// FINDING AN ACCOUNT BY EMAIL ADDRESS, CASE-INSENSITIVELY.
//
// Used by the two routes that INSERT a users row — POST /api/auth/register
// and POST /api/secretary/accounts — as the pre-check that turns a duplicate
// address into a clear 409 instead of a database error. Migration 021's
// UNIQUE INDEX on lower(email) is the real guarantee; this is what makes the
// refusal legible.
//
// WHY THIS IS SHARED RATHER THAN WRITTEN TWICE. The username pre-check in
// those routes is a plain .eq() and copies harmlessly. This one is not: it
// needs the ilike-prefilter-then-exact-compare shape described below, and the
// tempting "simplification" to a single .eq('email', email) is silently
// WRONG — it would be case-sensitive, so the pre-check would miss a collision
// that the case-insensitive index then rejects at insert time, turning a
// clear 409 into the confusing one the backstop has to guess at. One
// implementation, so that mistake can only be made once.
//
// WHY THE PREFILTER IS NOT THE AUTHORITY. PostgREST's ilike treats `_` as a
// single-character wildcard and `*` as an alias for `%`, and real addresses
// contain underscores (juan_test_mr4iarwh@brgyserve.test is on file). So the
// pattern deliberately over-matches and the exact, lowercased comparison in
// JS below decides. A submitted "%@gmail.com" therefore matches many rows in
// the prefilter and then matches nobody — rather than resolving to somebody
// else's account.
//
// KNOWN DUPLICATION, LEFT DELIBERATELY: eligibleResidentByEmail() in
// routes/auth.js runs the same prefilter-plus-exact-compare shape, with role
// and status filtering on top. It is NOT refactored to call this, because it
// is the password-reset lookup and its behaviour is pinned by 63 assertions
// in scripts/test-password-reset.js. Changing it to gain tidiness would put
// the reset flow at risk for no functional benefit.
// ===========================================================================

// The prefilter is a coarse net, not the answer. Capped for the same reason
// eligibleResidentByEmail caps: a wildcard-bearing input must not drag the
// whole table back.
const EMAIL_PREFILTER_LIMIT = 25;

/**
 * @param {string} email the submitted address, untrimmed
 * @returns {Promise<{user_id: number, username: string, email: string} | null>}
 *          the account already holding this address, or null
 */
async function findUserByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;

  const { data, error } = await supabase
    .from('users')
    .select('user_id, username, email')
    .ilike('email', wanted)
    .limit(EMAIL_PREFILTER_LIMIT);
  if (error) {
    throw new Error(`Email lookup failed: ${error.message}`);
  }

  return (data || []).find((u) => String(u.email || '').trim().toLowerCase() === wanted) || null;
}

// The name migration 021 gives the index, and the string the 23505 backstops
// match on. It lives here so the routes and the migration cannot drift apart
// over a hardcoded literal typed twice.
const EMAIL_UNIQUE_INDEX = 'users_email_lower_unique';

// Migration 001 named this one; measured from a real 23505:
//   "duplicate key value violates unique constraint \"users_username_key\""
const USERNAME_UNIQUE_INDEX = 'users_username_key';

// What a caller is told when the address is taken. It names the EMAIL, which
// is the whole point: the routes used to answer "Username is already taken"
// to every 23505, so someone whose address collided would cycle through new
// usernames forever without being told the real reason.
const EMAIL_TAKEN_MESSAGE =
  'That email address is already registered to another account. Each account needs its own address, because it is what a password reset link is sent to. Please use a different one, or sign in to the existing account instead.';

/**
 * Which unique constraint a 23505 came from.
 *
 * BRANCHES ON THE CONSTRAINT NAME IN `message`, NOT ON `details`. Measured:
 * supabase-js surfaces `message` as
 *   duplicate key value violates unique constraint "users_username_key"
 * and `details` as
 *   Key (username)=(secretary1) already exists.
 * `details` names the offending COLUMN, and a FUNCTIONAL index reports that
 * differently from a column constraint — it would read `Key (lower(email::
 * text))=(…)`. The constraint name is stable across both shapes, so it is the
 * reliable discriminator.
 *
 * @returns {'email' | 'username' | null} null when it is neither, which must
 *          be re-thrown rather than guessed at.
 */
function uniqueViolationField(error) {
  const message = String(error?.message || '');
  if (message.includes(EMAIL_UNIQUE_INDEX)) return 'email';
  if (message.includes(USERNAME_UNIQUE_INDEX)) return 'username';
  return null;
}

module.exports = {
  findUserByEmail,
  uniqueViolationField,
  EMAIL_UNIQUE_INDEX,
  USERNAME_UNIQUE_INDEX,
  EMAIL_TAKEN_MESSAGE,
};
