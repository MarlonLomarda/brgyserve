-- ============================================================================
-- BrgyServe — Migration 005: submission timestamp for document requests
--
-- The thesis data dictionary (Table 12) has no column recording WHEN a
-- request was submitted, but residents track their requests by date and the
-- list is ordered newest-first. Defaults to now() so inserts don't need to
-- set it. Schema doc Table 12 documents this column (added here).
-- ============================================================================

ALTER TABLE document_requests
    ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now();
