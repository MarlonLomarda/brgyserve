-- ============================================================================
-- BrgyServe — Migration 019: drop profiles.profile_pic
--
-- WHY IT IS DROPPED RATHER THAN KEPT AS RESERVED
--   The group decided AGAINST a resident photo feature. Under the Data Privacy
--   Act a photograph needs a stated purpose, and no function in BrgyServe uses
--   one: document requests are identified by the resident record, attendance is
--   per household by QR, payments are by charge, and the Secretary verifies an
--   applicant by name, birthdate and address. There is no task a photo would
--   serve, so there is no justification to collect one. This is the same
--   data-minimization reasoning already applied to the Staff projection, where
--   each field Staff receive had to earn its place and the rest were withheld.
--
--   That is a DECISION AGAINST, not a deferral — which is what separates this
--   column from users.email_verified. email_verified is also unused today but
--   is RESERVED for a planned email-verification feature, so it stays. A column
--   nobody intends to use is clutter that invites exactly the wrong kind of
--   reuse: it was one of the two columns eyed as a home for the rejection state
--   in migration 017, and repurposing it would have made every future reader
--   wrong. Removing it closes that door.
--
-- VERIFIED BEFORE WRITING THIS
--   No read, no write, no select list, no form field, no test references
--   profile_pic anywhere in backend/src, frontend/src, either scripts
--   directory, or the seeds. `git log --all -S "profile_pic"` returns only the
--   three commits that DEFINE or DESCRIBE it: 8c842fa (initial schema) and the
--   two that record it as unreferenced. It has never been touched by code.
--
-- DROPPING A COLUMN IS IRREVERSIBLE WITHOUT A RESTORE
--   There is no "un-drop". Re-adding the column later gives a new, empty
--   column; any data that had been in it would be gone. That is acceptable
--   here only because the column is empty — which the review block CONFIRMS
--   WITH A COUNT rather than assuming. Run the review block first and check
--   that the non-null count is 0 before switching ROLLBACK to COMMIT.
--
-- SAFETY
--   Nothing selects '*' from profiles in a way that depends on the column:
--   routes/secretary.js and routes/auth.js name their profile columns
--   explicitly (PROFILE_FIELDS), and no frontend form binds it. Dropping it
--   changes no response shape that any client reads.
--
-- Chapter 3 TABLE 10 (profiles) needs the matching manuscript edit;
-- docs/brgyserve-database-schema.md is updated in the same change.
-- ============================================================================

BEGIN;

ALTER TABLE profiles
    DROP COLUMN profile_pic;

COMMIT;
