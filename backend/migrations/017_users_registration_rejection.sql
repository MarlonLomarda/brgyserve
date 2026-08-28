-- ============================================================================
-- BrgyServe — Migration 017: registration rejection state on users
--
-- Stage 1 of the registration-rejection work. Until now the Secretary could
-- only ever ACTIVATE a pending registration, so an ineligible applicant sat in
-- the pending list forever with no way to clear them.
--
-- WHY A COLUMN IS NEEDED AT ALL
--   A pending registration is created with is_active = false
--   (routes/auth.js), so "rejected" cannot be expressed by clearing that flag
--   — it is ALREADY clear. Pending and rejected were byte-identical row
--   states, which is why routes/auth.js could previously derive the login
--   message from existing state alone. It no longer can; the comment above
--   inactiveMessage() was rewritten in the same change to say so.
--
--   Nothing on users or profiles was free to hold this. The live schema was
--   read from PostgREST's OpenAPI document before writing any code: users has
--   8 columns and profiles 10, all spoken for. email_verified (written, never
--   read) and profile_pic (never referenced anywhere) are structurally
--   available and were deliberately NOT repurposed — a column named
--   email_verified holding "this registration was declined" makes every
--   future reader wrong.
--
-- WHAT CHANGES (all additive, all on users)
--   1. is_rejected          — the state itself. DEFAULT false so every one of
--                             the existing rows is unaffected and the NOT NULL
--                             is safe.
--   2. rejection_reason     — a fixed code from constants/registration.js
--                             (NOT_IN_MASTERLIST | RESIDENCY_TOO_SHORT |
--                             OTHER). The applicant is shown that code's
--                             canned sentence at login.
--   3. rejection_note       — the Secretary's optional free-text note.
--                             INTERNAL ONLY: it is never shown to the
--                             applicant, which is what lets the Secretary
--                             write something specific without it becoming a
--                             message to the person it is about.
--   4. rejected_at
--   5. rejected_by_user_id  — the accountability pair, matching
--                             payments.received_by_user_id and
--                             rental_requests.returned_by_user_id in type and
--                             FK target. Rejection is a decision an applicant
--                             may come to the office to contest, so "who
--                             decided this, and when" must be answerable.
--
-- WHY TWO CHECK CONSTRAINTS (backstops mirroring the app rules, the same
-- pattern migrations 013 and 016 use)
--   users_rejection_state_consistent keeps the five columns from disagreeing:
--     not rejected => all four detail columns NULL
--     rejected     => reason, rejected_at and rejected_by_user_id all present
--   The note stays optional in the database because only the OTHER code
--   requires one, and that rule belongs in the app where the code list lives.
--
--   users_rejection_reason_valid pins the vocabulary.
--   TRADE-OFF, STATED SO IT CAN BE STRUCK BEFORE APPLYING: this makes adding
--   a fourth reason code a migration rather than a one-line constants edit.
--   It is included because events.type (migration 013) set that precedent for
--   a fixed vocabulary in a varchar column. If the team expects the reason
--   list to grow, drop this one constraint and let constants/registration.js
--   be the only authority — the app validates the code either way.
--
-- SAFETY
--   Additive only, no column is dropped or retyped, and no existing row can
--   violate either CHECK: every current row gets is_rejected = false from the
--   DEFAULT with all four detail columns NULL, which is the first branch of
--   the consistency check and exempt from the reason check.
--
-- Chapter 3 TABLE 9 (users) needs the matching manuscript edit for the five
-- new columns; docs/brgyserve-database-schema.md is updated in the same
-- change.
-- ============================================================================

BEGIN;

ALTER TABLE users
    ADD COLUMN is_rejected         boolean      NOT NULL DEFAULT false,
    ADD COLUMN rejection_reason    varchar(50),
    ADD COLUMN rejection_note      varchar(255),
    ADD COLUMN rejected_at         timestamptz,
    ADD COLUMN rejected_by_user_id bigint,
    ADD CONSTRAINT users_rejected_by_user_id_fkey
        FOREIGN KEY (rejected_by_user_id) REFERENCES users (user_id);

ALTER TABLE users
    ADD CONSTRAINT users_rejection_state_consistent
        CHECK (
            (
                is_rejected = false
                AND rejection_reason    IS NULL
                AND rejection_note      IS NULL
                AND rejected_at         IS NULL
                AND rejected_by_user_id IS NULL
            )
            OR
            (
                is_rejected = true
                AND rejection_reason    IS NOT NULL
                AND rejected_at         IS NOT NULL
                AND rejected_by_user_id IS NOT NULL
            )
        );

ALTER TABLE users
    ADD CONSTRAINT users_rejection_reason_valid
        CHECK (
            rejection_reason IS NULL
            OR rejection_reason IN ('NOT_IN_MASTERLIST', 'RESIDENCY_TOO_SHORT', 'OTHER')
        );

COMMIT;
