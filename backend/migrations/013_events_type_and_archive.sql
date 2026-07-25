-- ============================================================================
-- BrgyServe — Migration 013: event type + archive (Events & Activities stage 1)
--
-- The events table (Table 5) holds ONE record kind today. Stage 1 splits it
-- into two, distinguished by `type`:
--
--   'activity'      a real timed event  — start/end REQUIRED (General Assembly,
--                   Aug 3, 8:00 AM - 5:00 PM)
--   'announcement'  an informational notice with NO required time window —
--                   start/end/location may be null ("Barangay office closed
--                   Monday")
--
-- 1) Two new columns. type defaults to 'activity' and is_archived to false, so
--    any existing row keeps working (the table is empty in the current
--    database, so there is nothing to backfill).
--
-- 2) start_datetime, end_datetime and location are currently NOT NULL, which
--    makes announcements impossible — they are made nullable here. The
--    per-type rules are then enforced by CHECK constraints below (and by the
--    same rules in the API's validation), so an ACTIVITY still cannot be saved
--    without its schedule.
--
-- 3) CHECK constraints as database-level backstops for the app validation:
--    a valid type, an activity always carrying start+end, and end always after
--    start when both are present.
--
-- NOTE: this migration is REQUIRED before the Events module will run — the
-- routes select `type` and `is_archived`.
--
-- Run manually in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- 1) new columns
ALTER TABLE events
    ADD COLUMN type        varchar(20) NOT NULL DEFAULT 'activity',
    ADD COLUMN is_archived boolean     NOT NULL DEFAULT false;

-- 2) announcements have no required time window or venue
ALTER TABLE events
    ALTER COLUMN start_datetime DROP NOT NULL,
    ALTER COLUMN end_datetime   DROP NOT NULL,
    ALTER COLUMN location       DROP NOT NULL;

-- 3) per-type rules, enforced at the database layer too
ALTER TABLE events
    ADD CONSTRAINT events_type_valid
        CHECK (type IN ('announcement', 'activity')),
    ADD CONSTRAINT events_activity_has_schedule
        CHECK (type <> 'activity'
               OR (start_datetime IS NOT NULL AND end_datetime IS NOT NULL)),
    ADD CONSTRAINT events_end_after_start
        CHECK (start_datetime IS NULL
               OR end_datetime IS NULL
               OR end_datetime > start_datetime);

COMMIT;
