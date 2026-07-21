-- ============================================================================
-- BrgyServe — Migration 011: rental return tracking (Facility Rentals stage 5)
--
-- Barangay Staff mark a physical item (furniture / equipment) booking as
-- returned, with an outcome stored in rental_requests.status
-- (returned / returned_late / returned_with_issue) and these details:
--
--   return_note          optional note (e.g. what was damaged)
--   returned_at          when Staff recorded the return
--   returned_by_user_id  the Staff member who recorded it
--
-- rental_requests.status is varchar(50), which already fits the new values —
-- no type change needed. Facilities have no return step (they auto-complete
-- after their end, a derived display state — nothing is written for them).
--
-- Run manually in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE rental_requests
    ADD COLUMN return_note text,
    ADD COLUMN returned_at timestamptz,
    ADD COLUMN returned_by_user_id bigint REFERENCES users (user_id);
