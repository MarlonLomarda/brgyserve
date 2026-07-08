-- ============================================================================
-- BrgyServe — Migration 008: resident payment declaration on charges
--
-- Modeling decision (stage 4b): when a resident says HOW they will pay
-- (onsite cash, or GCash with a reference number), that claim is recorded on
-- the charge itself as declared_* — the charge stays UNPAID. A row in the
-- payments table is only created when the Treasurer/Secretary VERIFIES the
-- payment, so payments remains strictly "verified money received", every row
-- with a real verifier in received_by_user_id. Declarations are overwritable
-- while the charge is UNPAID (residents can fix a mistyped reference).
--
--   declared_method     'onsite' | 'gcash' (lowercase canonical values)
--   declared_reference  GCash reference number the resident submitted
--   declared_at         when the resident declared
--
-- Schema doc Table 15 documents these columns (added in this migration).
-- ============================================================================

ALTER TABLE charges
    ADD COLUMN declared_method varchar(20),
    ADD COLUMN declared_reference varchar(100),
    ADD COLUMN declared_at timestamptz;
