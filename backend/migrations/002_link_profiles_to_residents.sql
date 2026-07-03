-- ============================================================================
-- BrgyServe — Migration 002: Secretary-approved resident linking
--
-- Adds to profiles:
--   * resident_id — set by the Secretary when approving a resident account
--     (nullable; pending accounts have no link yet). UNIQUE so one resident
--     record can only ever be linked to one user account.
--   * birthdate, address — personal info claimed by the resident at
--     self-registration. The Secretary uses these to match the account to an
--     existing resident_records row or to create a new one. NOTE: these two
--     columns are additions beyond the thesis data dictionary — update
--     docs/brgyserve-database-schema.md (Table 10) after applying.
-- ============================================================================

BEGIN;

ALTER TABLE profiles
    ADD COLUMN resident_id bigint REFERENCES resident_records (resident_id),
    ADD COLUMN birthdate   date,
    ADD COLUMN address     varchar(255);

-- One user account per resident record. Multiple NULLs (pending, unlinked
-- accounts) are allowed — UNIQUE ignores NULL values.
ALTER TABLE profiles
    ADD CONSTRAINT profiles_resident_id_unique UNIQUE (resident_id);

COMMIT;
