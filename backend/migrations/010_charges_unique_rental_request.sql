-- ============================================================================
-- BrgyServe — Migration 010: one charge per rental booking + backfill
--
-- Facility Rentals stage 4 (rental payment through the existing
-- charges/payments system).
--
-- 1) UNIQUE on charges.rental_request_id — database-level guarantee that a
--    booking never accumulates duplicate charges, even under races (same
--    backstop migration 007 gave document requests). NULLs are exempt, so
--    DOCUMENT / FINE charges are unaffected.
--
-- 2) Backfill — bookings confirmed BEFORE stage 4 have no charge; create one
--    using the same rules the code applies (amount = item fee x quantity;
--    amount > 0 -> UNPAID, zero -> PAID). Cancelled bookings get nothing
--    (nothing is owed). Idempotent: the LEFT JOIN guard skips bookings that
--    already have a charge, so re-running this file is safe.
-- ============================================================================

ALTER TABLE charges
    ADD CONSTRAINT charges_rental_request_id_unique UNIQUE (rental_request_id);

INSERT INTO charges (charge_type, amount, status, user_id, rental_request_id, created_at)
SELECT
    'RENTAL',
    ri.fee * rr.quantity_requested,
    CASE WHEN ri.fee * rr.quantity_requested > 0 THEN 'UNPAID' ELSE 'PAID' END,
    rr.requested_by_user_id,
    rr.request_id,
    now()
FROM rental_requests rr
JOIN rental_items ri ON ri.item_id = rr.item_id
LEFT JOIN charges c ON c.rental_request_id = rr.request_id
WHERE rr.status = 'confirmed'
  AND c.charge_id IS NULL;
