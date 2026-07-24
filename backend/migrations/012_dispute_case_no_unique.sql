-- ============================================================================
-- BrgyServe — Migration 012: unique barangay case number (Blotter)
--
-- OPTIONAL. The Blotter module already enforces one case per
-- barangay_case_no in application code (a friendly 409 before insert), so it
-- runs fine without this migration. That app-level check has a small race
-- window between the SELECT and the INSERT: if the Secretary submits the
-- form twice in quick succession — a double-click, a slow-network retry, or
-- two browser tabs open on the same case number — both submissions can pass
-- the check before either inserts, and two rows with the same case number get
-- created. This UNIQUE constraint closes that window at the database layer, so
-- the second write fails instead — the same guarantee migrations 007/010 gave
-- charges.
--
-- The dispute tables are empty in the current database, so there is nothing to
-- de-duplicate first. If cases already exist when you apply this, resolve any
-- duplicate barangay_case_no values before running it or the constraint will
-- fail to create.
--
-- Run manually in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE dispute_records
    ADD CONSTRAINT dispute_records_barangay_case_no_unique UNIQUE (barangay_case_no);
