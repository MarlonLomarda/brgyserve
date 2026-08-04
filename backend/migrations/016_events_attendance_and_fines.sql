-- ============================================================================
-- BrgyServe — Migration 016: opt-in attendance + fine amount on events,
-- and the idempotency guard for fine generation
--
-- Events stage 3a. Attendance is per HOUSEHOLD (migration 015 repointed
-- event_attendees at household_records); this adds the two things an event
-- itself needs to say about attendance, plus the constraint stage 3b will
-- depend on.
--
-- WHAT CHANGES
--   1. events.attendance_required — opt-in per event. Most events do not take
--      attendance; a General Assembly does. Defaults false so every existing
--      event is unaffected.
--   2. events.fine_amount — NULLABLE on purpose. Null does NOT mean zero: it
--      means attendance is tracked but nothing is chargeable for missing it.
--      A barangay may want the roster without the penalty.
--   3. CHECK events_attendance_activity_only — attendance_required may only be
--      true for type = 'activity'. An announcement has no schedule (migration
--      013 made start/end nullable precisely for that), so "who attended" is
--      meaningless for one. The app enforces this too; this is the backstop.
--   4. A PARTIAL unique index on charges (event_id, household_id).
--
-- WHY THE CHARGES INDEX IS PARTIAL
--   Stage 3b generates one FINE charge per absent household per event, as an
--   explicit Secretary action that may be re-run. This index makes that
--   idempotent at the database level — a second run cannot double-charge a
--   household for the same assembly.
--   It MUST be partial. Verified against the live data: all 34 existing
--   charges have event_id NULL *and* household_id NULL, because every charge
--   so far is a DOCUMENT or RENTAL keyed on its own link. In PostgreSQL a
--   plain UNIQUE treats NULLs as distinct, so a full index would appear to
--   work while silently guaranteeing nothing for those rows — and would
--   become wrong the moment a charge carried only one of the two. Restricting
--   the index to rows where BOTH are present makes it mean exactly what stage
--   3b needs: at most one charge per (event, household) pair.
--
-- SAFETY
--   Additive only. attendance_required has a DEFAULT so the NOT NULL is safe
--   on the 8 existing events, all of which become false and therefore satisfy
--   the new CHECK. No existing row can violate the partial index, since none
--   has either column populated.
--
-- Chapter 3 TABLE 5 (events) needs the matching manuscript edit for the two
-- new columns; TABLE 15 (charges) gains no column, only the index.
-- ============================================================================

BEGIN;

ALTER TABLE events
    ADD COLUMN attendance_required boolean       NOT NULL DEFAULT false,
    ADD COLUMN fine_amount         numeric(10,2);

ALTER TABLE events
    ADD CONSTRAINT events_attendance_activity_only
        CHECK (NOT attendance_required OR type = 'activity');

CREATE UNIQUE INDEX charges_event_household_unique
    ON charges (event_id, household_id)
    WHERE event_id IS NOT NULL AND household_id IS NOT NULL;

COMMIT;
