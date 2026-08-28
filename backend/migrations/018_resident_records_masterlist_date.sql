-- ============================================================================
-- BrgyServe — Migration 018: masterlist_registered_on on resident_records
--
-- Stage 2 of the registration-rejection work. The barangay's eligibility rule
-- counts residency from the date a person was registered in the BARANGAY'S OWN
-- masterlist. Nothing in the database held that date.
--
-- WHY date_registered COULD NOT BE USED
--   date_registered is the timestamp the row entered BrgyServe. It is
--   server-set on insert at both creation paths and is never client-writable,
--   so it cannot be corrected even when the Secretary knows the real date.
--   Measured against the live data before this migration was written: all 47
--   non-archived records read July 2026, because that is when the masterlist
--   was loaded into this system. A six-month check against that column would
--   have rejected 100% of them, including a resident on the paper masterlist
--   since 2009. The two columns measure different things and both are kept.
--
-- NULLABLE, NO DEFAULT
--   The barangay will not have a date for everyone, and "no date on file" is a
--   real state that must stay distinguishable from "registered recently". The
--   application renders NOTHING for a null - no date, no badge, no "unknown"
--   pill - because a placeholder would read as "under six months" to anyone
--   glancing at the screen.
--
-- NO CHECK CONSTRAINT, DELIBERATELY
--   The rule is "not in the future", and expressing that in SQL needs
--   CURRENT_DATE, a non-immutable expression inside a constraint - a
--   documented PostgreSQL anti-pattern. It is also inconsistent with the
--   column this one sits beside: birthdate has the same rule and no database
--   CHECK either, enforced in validateBody() instead. One rule, one place.
--
-- NO INDEX
--   The six-month comparison is display-only, computed per row on the way out
--   of the route (deriveResidency in constants/registration.js). It is never a
--   query filter, so there is nothing for an index to serve.
--
-- SAFETY
--   Additive only. A nullable column with no default cannot invalidate any
--   existing row, and no existing query selects '*' in a way that breaks.
--
-- Chapter 3 TABLE 4 (resident_records) needs the matching manuscript edit;
-- docs/brgyserve-database-schema.md is updated in the same change.
-- ============================================================================

BEGIN;

ALTER TABLE resident_records
    ADD COLUMN masterlist_registered_on date;

COMMIT;
