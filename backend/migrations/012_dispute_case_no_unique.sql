-- ============================================================================
-- BrgyServe — Migration 012: unique barangay case number (Blotter)
--
-- APPLIED to the live database and verified: the constraint
-- dispute_records_barangay_case_no_unique exists. It was written as optional,
-- because the Blotter module also enforces one case per barangay_case_no in
-- application code (a friendly 409 before insert), and the module ran without
-- it before it was applied. That app-level check has a small race
-- window between the SELECT and the INSERT: if the Secretary submits the
-- form twice in quick succession — a double-click, a slow-network retry, or
-- two browser tabs open on the same case number — both submissions can pass
-- the check before either inserts, and two rows with the same case number get
-- created. This UNIQUE constraint closes that window at the database layer, so
-- the second write fails instead — the same guarantee migrations 007/010 gave
-- charges.
--
-- When this was written the dispute tables were empty, so there was nothing to
-- de-duplicate first. It has since been applied; running it again fails,
-- because the constraint already exists. On a fresh database with cases
-- already in it, resolve any duplicate barangay_case_no values before running
-- it or the constraint will fail to create.
--
-- Run manually in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE dispute_records
    ADD CONSTRAINT dispute_records_barangay_case_no_unique UNIQUE (barangay_case_no);
