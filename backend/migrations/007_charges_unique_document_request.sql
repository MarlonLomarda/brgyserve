-- ============================================================================
-- BrgyServe — Migration 007: one charge per document request + backfill
--
-- 1) UNIQUE on charges.document_request_id — database-level guarantee that a
--    document request never accumulates duplicate charges, even under races.
--    NULLs are exempt from UNIQUE in PostgreSQL, so future FINE / RENTAL
--    charges (which leave document_request_id null) are unaffected.
--
-- 2) Backfill — requests approved BEFORE stage 4a have no charge; create one
--    using the same rules the code applies (fee > 0 -> UNPAID, zero fee ->
--    PAID). Idempotent: the LEFT JOIN guard skips requests that already have
--    a charge, so re-running this file is safe.
-- ============================================================================

ALTER TABLE charges
    ADD CONSTRAINT charges_document_request_id_unique UNIQUE (document_request_id);

INSERT INTO charges (charge_type, amount, status, user_id, document_request_id, created_at)
SELECT
    'DOCUMENT',
    dt.fee,
    CASE WHEN dt.fee > 0 THEN 'UNPAID' ELSE 'PAID' END,
    dr.requested_by_user_id,
    dr.request_id,
    now()
FROM document_requests dr
JOIN document_types dt ON dt.document_type_id = dr.document_type_id
LEFT JOIN charges c ON c.document_request_id = dr.request_id
WHERE dr.status = 'approved'
  AND c.charge_id IS NULL;
