-- ============================================================================
-- BrgyServe — Migration 004: soft-deactivation for document types
--
-- Document types are deactivated, never deleted: document_requests (next
-- stage) will reference document_types, so deleting a type would break or
-- orphan request history and its fee context. is_active = false simply hides
-- the type from residents choosing a document, and it is reversible.
-- Existing rows default to active.
--
-- After applying, docs/brgyserve-database-schema.md Table 11 documents this
-- column (added in this migration).
-- ============================================================================

ALTER TABLE document_types
    ADD COLUMN is_active boolean NOT NULL DEFAULT true;
