-- ============================================================================
-- BrgyServe — Migration 015: event attendance becomes PER HOUSEHOLD
--
-- Chapter 3 Table 6 models attendance per RESIDENT (event_attendees keyed on
-- resident_id). That contradicts how Barangay Ubujan actually runs an
-- assembly, confirmed with the barangay Secretary: **one household signs the
-- sheet once**, and a household with no signature is fined. Fines are billed
-- through charges.household_id, which Table 15 already describes as "Household
-- responsible (mainly for fines)" — so the payer link is a household, and
-- attendance has to be recorded the same way or the two can never be joined.
--
-- Keying on resident_id would also be unworkable in practice: only 8 of 47
-- active residents have a linked user account, and a household's signature
-- says nothing about WHICH member signed.
--
-- WHAT CHANGES
--   1. resident_id is dropped.
--   2. household_id (NOT NULL, FK -> household_records) replaces it.
--   3. UNIQUE (event_id, household_id) — the point of the whole change:
--      "one household, one signature" is enforced by the SCHEMA, not by
--      application convention. It also makes attendance recording idempotent,
--      so re-submitting a sheet cannot create a second row for the same
--      household at the same event.
--   4. recorded_at + recorded_by_user_id — who marked this household present,
--      and when.
--
-- WHY THE ACCOUNTABILITY COLUMNS ARE HERE AND NOT IN THE STAGE 3 MIGRATION
--   Attendance is the evidence base for a FINE, so a household disputing a
--   charge must be answerable with who recorded them and when. Every other
--   money-adjacent table already carries that (payments.received_by_user_id,
--   rental_requests.returned_by_user_id, document_requests.processed_by_user_id).
--   Folding them in here means ONE Chapter 3 Table 6 edit instead of two.
--   recorded_by_user_id matches payments.received_by_user_id exactly in type
--   and target — bigint REFERENCES users (user_id), verified against the live
--   schema — but is NOT NULL here: a gateway payment legitimately has no staff
--   receiver, whereas attendance is always recorded by a person.
--
--   Note there is deliberately NO present/absent status column. Absence is
--   derived as "no row for this household at this event", which is exactly
--   what the UNIQUE constraint makes reliable; an explicit absent row would
--   create a second representation of the same fact that could disagree.
--   attendance_required and fine_amount are NOT here either — they belong on
--   the events table, in the Stage 3 migration.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
--   The table name (event_attendees), the primary key (event_attendee_id) and
--   the existing event_id foreign key all stay exactly as they are. Renaming
--   would buy nothing functionally and would cost another Chapter 3 edit.
--
-- SAFETY
--   event_attendees was verified EMPTY (0 rows) before this was written, and
--   no code in backend/src or frontend/src references the table at all — the
--   attendance module is not built yet. The change is therefore non-
--   destructive in practice. It is also self-guarding: ADD COLUMN ... NOT NULL
--   without a DEFAULT fails outright on a non-empty table, so if this is ever
--   run somewhere that has data, it aborts rather than corrupting it.
--
-- Chapter 3 TABLE 6 still needs the matching manuscript edit (see CLAUDE.md).
-- ============================================================================

BEGIN;

ALTER TABLE event_attendees
    DROP COLUMN resident_id;

ALTER TABLE event_attendees
    ADD COLUMN household_id bigint NOT NULL
        REFERENCES household_records (household_id),
    ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN recorded_by_user_id bigint NOT NULL
        REFERENCES users (user_id);

ALTER TABLE event_attendees
    ADD CONSTRAINT event_attendees_event_household_unique
        UNIQUE (event_id, household_id);

COMMIT;
