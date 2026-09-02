-- ============================================================================
-- BrgyServe — Migration 020: password_resets
--
-- The storage behind POST /api/auth/forgot-password and
-- POST /api/auth/reset-password. Residents only; the routes enforce that.
--
-- HARD DEPENDENCY. routes/auth.js selects from this table, so the two reset
-- routes 500 until it is applied. Login, registration and change-password are
-- untouched and keep working either way — unlike migration 017, which login
-- itself depended on.
--
-- WHY THE TOKEN IS HASHED AND NOT STORED RAW
--   For the lifetime of the row the token IS the account password: anyone
--   holding it can set a new one. A leaked database dump, a stray SELECT in a
--   support session or a screenshot of this table would otherwise hand over
--   every outstanding reset. SHA-256 makes the stored value useless on its
--   own — the route hashes the token it is given and looks the hash up.
--
--   THE FAST HASH IS DELIBERATE and is the opposite of the rule for passwords.
--   bcrypt is slow because a password is low-entropy and worth brute-forcing;
--   a 256-bit random token is not, so slowness would buy nothing and only make
--   an unauthenticated route expensive to call. See constants/passwordReset.js.
--
--   household_qr.qr_token is stored RAW, and that is a different case rather
--   than an inconsistency: it is a long-lived identifier, scanned repeatedly,
--   granting no account access.
--
-- varchar(64) IS EXACTLY A SHA-256 HEX DIGEST — 32 bytes, 64 hex characters.
-- The column cannot hold anything longer, which is a cheap structural check
-- that a raw 43-character token was not written here by mistake (it would fit,
-- but the UNIQUE index and the route's own hashing are what actually decide
-- this; the length is documentation more than enforcement).
--
-- UNIQUE ON token_hash
--   Two rows can never claim the same token, so the lookup in
--   POST /reset-password resolves to at most one row without ordering or
--   tie-breaking. Collisions are not a realistic risk at 256 bits; the
--   constraint is there so the LOOKUP is unambiguous, not to prevent them.
--
-- used_at RATHER THAN A DELETE
--   Consuming a token sets used_at instead of removing the row, for two
--   reasons. The route claims it with a status-guarded UPDATE
--   (... WHERE used_at IS NULL), which is the same read-then-write gap closer
--   used by document approval, charge verification and attendance recording —
--   two simultaneous submissions of the same link cannot both win. And a used
--   row is the record that a reset happened, which is the only trace of the
--   event once the password is changed.
--
-- NO ON DELETE CLAUSE, matching every other FK in this schema (there is not
-- one ON DELETE anywhere in migrations 001-019). Users are deactivated, never
-- deleted, so a cascade would be describing something that does not happen.
--
-- THE INDEX IS FOR THE COOLDOWN, NOT FOR THE LOOKUP
--   The token lookup already has the UNIQUE index on token_hash. The extra
--   index serves the OTHER query: "has this user asked in the last 15
--   minutes", which filters on user_id and orders on created_at. That is the
--   only rate limiting in the entire API, so the query it depends on gets an
--   index rather than a sequential scan that grows with every reset ever made.
--
-- ROW LEVEL SECURITY IS ENABLED EXPLICITLY, AND THAT LINE IS NOT OPTIONAL.
--   RLS was switched on for all 19 existing tables as a separate hardening
--   pass, so it is easy to assume a new table inherits it. IT DOES NOT —
--   PostgreSQL creates tables with RLS off, so without this line
--   password_resets would be the ONLY table in the database readable and
--   writable through the anon/publishable key, and it would be the worst
--   possible one: reading it is not enough to take an account over (the
--   tokens are hashed), but INSERTing a row with a hash of a token you chose
--   is. Enabled with zero policies, exactly like the other 19: the backend
--   uses the service role key, which bypasses RLS entirely.
--
-- Chapter 3 needs a matching manuscript edit — this is a NEW TABLE, so it is a
-- new File Structure table (numbered 20 in docs/brgyserve-database-schema.md),
-- and the ERD page "amoncio - erd" needs the entity and its FK to users.
-- ============================================================================

BEGIN;

CREATE TABLE password_resets (
    reset_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint      NOT NULL REFERENCES users (user_id),
    token_hash varchar(64) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Serves the per-user cooldown check (user_id = ? AND created_at > ?).
CREATE INDEX password_resets_user_created_idx
    ON password_resets (user_id, created_at DESC);

-- See the note above: a new table does NOT inherit the RLS that was enabled on
-- the other 19. Without this, the anon key could insert a reset row of its own
-- choosing.
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

COMMIT;
