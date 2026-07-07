-- ============================================================================
-- BrgyServe — Migration 006: Secretary decision fields for document requests
--
--   * rejection_reason — required when the Secretary rejects a request;
--     shown to the resident so they know what to fix. Null otherwise.
--   * processed_at — when the approve/reject decision was made. Complements
--     processed_by_user_id (who decided) for auditing and future reports.
--     Null until a decision is made.
--
-- Schema doc Table 12 documents both columns (added in this migration).
-- ============================================================================

ALTER TABLE document_requests
    ADD COLUMN rejection_reason text,
    ADD COLUMN processed_at timestamptz;
