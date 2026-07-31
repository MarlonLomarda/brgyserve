-- ============================================================================
-- BrgyServe — Migration 014: PayMongo GCash gateway references on charges
--
-- The GCash payment gateway (PayMongo Checkout Sessions) is layered ON TOP of
-- the existing manual flow — cash onsite and a resident-declared GCash
-- reference verified by the Treasurer both keep working exactly as before.
-- Nothing in the charges/payments model changes; this only records the two
-- PayMongo identifiers a charge can acquire when it is paid online.
--
--   paymongo_session_id  Checkout Session (cs_...) created for this charge.
--                        Lets an in-flight checkout be resumed instead of
--                        opening a second one, and is the handle the Treasurer's
--                        reconciliation action re-checks against PayMongo when a
--                        webhook is missed.
--
--   paymongo_payment_id  Payment (pay_...) from the confirmed webhook event.
--                        Written only after the signature is verified.
--
-- IDEMPOTENCY — the reason paymongo_payment_id is UNIQUE.
-- PayMongo can deliver the same event more than once, and the reconciliation
-- action can race a webhook for the same payment. The application already
-- guards this with a status-guarded claim (UPDATE ... WHERE status = 'UNPAID',
-- the same pattern manual verification uses), but that is application logic.
-- This constraint makes it a database guarantee: the same PayMongo payment can
-- never be recorded against two charges, so a duplicate delivery cannot create
-- a second payments row or double-count collections. NULLs are exempt, so
-- every manually paid charge is unaffected.
--
-- paymongo_session_id is UNIQUE for the same reason in the other direction: one
-- checkout session belongs to exactly one charge, so a forged or confused
-- callback cannot attach one session to several charges.
--
-- Both columns are nullable and default NULL: charges paid at the barangay
-- hall never acquire either, which is exactly the intended fallback behaviour.
--
-- Schema doc Table 15 documents these columns (added in this migration).
-- ============================================================================

ALTER TABLE charges
    ADD COLUMN paymongo_session_id varchar(255),
    ADD COLUMN paymongo_payment_id varchar(255);

ALTER TABLE charges
    ADD CONSTRAINT charges_paymongo_session_id_unique UNIQUE (paymongo_session_id),
    ADD CONSTRAINT charges_paymongo_payment_id_unique UNIQUE (paymongo_payment_id);
