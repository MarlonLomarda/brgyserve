-- ============================================================================
-- BrgyServe — Migration 001: Initial schema
-- Source: docs/brgyserve-database-schema.md (Chapter 3 data dictionary,
-- converted to PostgreSQL). Table numbers match the thesis File Structure;
-- Table 19 is the fuzzy name-matching research addition.
--
-- Note: resident_records (Table 4) is created before household_members
-- (Table 3) because Table 3 references it. All other tables follow
-- document order.
-- ============================================================================

BEGIN;

-- Required by the Stage 1 trigram candidate blocking (research contribution)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Household & Residents
-- ============================================================

-- TABLE 1. household_records
CREATE TABLE household_records (
    household_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    address       varchar(255) NOT NULL,
    registered_at timestamptz  NOT NULL,
    is_active     boolean      NOT NULL
);

-- TABLE 2. household_qr
CREATE TABLE household_qr (
    qr_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    household_id bigint  NOT NULL REFERENCES household_records (household_id),
    qr_token     text    NOT NULL UNIQUE,
    is_active    boolean NOT NULL
);

-- TABLE 4. resident_records (created before Table 3, which references it)
CREATE TABLE resident_records (
    resident_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name             varchar(100) NOT NULL,
    middle_name            varchar(100),
    last_name              varchar(100) NOT NULL,
    suffix                 varchar(20),
    birthdate              date,
    birthplace             varchar(255),
    address                varchar(255) NOT NULL,
    sex                    varchar(20),
    civil_status           varchar(50),
    religion               varchar(100),
    educational_attainment varchar(100),
    contact_number         varchar(20),
    date_registered        timestamptz NOT NULL,
    is_archived            boolean     NOT NULL
);

-- TABLE 3. household_members
CREATE TABLE household_members (
    membership_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    household_id  bigint      NOT NULL REFERENCES household_records (household_id),
    resident_id   bigint      NOT NULL REFERENCES resident_records (resident_id),
    role          varchar(50) NOT NULL,
    date_started  date        NOT NULL,
    date_ended    date
);

-- ============================================================
-- Events & Attendance
-- ============================================================

-- TABLE 5. events
CREATE TABLE events (
    event_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title          varchar(255) NOT NULL,
    description    text,
    start_datetime timestamptz  NOT NULL,
    end_datetime   timestamptz  NOT NULL,
    location       varchar(255) NOT NULL,
    date_created   timestamptz  NOT NULL
);

-- TABLE 6. event_attendees
CREATE TABLE event_attendees (
    event_attendee_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          bigint NOT NULL REFERENCES events (event_id),
    resident_id       bigint NOT NULL REFERENCES resident_records (resident_id)
);

-- ============================================================
-- Disputes (Blotter)
-- ============================================================

-- TABLE 7. dispute_records
CREATE TABLE dispute_records (
    dispute_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    barangay_case_no varchar(50)  NOT NULL,
    time_filed       time         NOT NULL,
    date_filed       date         NOT NULL,
    filed_for        varchar(255) NOT NULL,
    nature_of_case   varchar(20)  NOT NULL,
    is_settled       boolean      NOT NULL
);

-- TABLE 8. dispute_parties
CREATE TABLE dispute_parties (
    dispute_party_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispute_id       bigint       NOT NULL REFERENCES dispute_records (dispute_id),
    resident_id      bigint       REFERENCES resident_records (resident_id),
    first_name       varchar(100),
    last_name        varchar(100),
    role             varchar(100) NOT NULL
);

-- ============================================================
-- Users & Accounts
-- ============================================================

-- TABLE 9. users
CREATE TABLE users (
    user_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username             varchar(100) NOT NULL UNIQUE,
    password_hash        varchar(255) NOT NULL,
    email                varchar(255) NOT NULL,
    email_verified       boolean      NOT NULL,
    role                 varchar(50)  NOT NULL,
    must_change_password boolean      NOT NULL,
    is_active            boolean      NOT NULL
);

-- TABLE 10. profiles (user_id is both PK and FK — no identity column)
CREATE TABLE profiles (
    user_id      bigint PRIMARY KEY REFERENCES users (user_id),
    first_name   varchar(100),
    middle_name  varchar(100),
    last_name    varchar(100),
    suffix       varchar(20),
    phone_number varchar(20),
    profile_pic  varchar(255)
);

-- ============================================================
-- Documents
-- ============================================================

-- TABLE 11. document_types
CREATE TABLE document_types (
    document_type_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name             varchar(100)  NOT NULL,
    description      text,
    fee              numeric(10,2) NOT NULL
);

-- TABLE 12. document_requests
CREATE TABLE document_requests (
    request_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_type_id     bigint      NOT NULL REFERENCES document_types (document_type_id),
    requested_by_user_id bigint      NOT NULL REFERENCES users (user_id),
    resident_id          bigint      NOT NULL REFERENCES resident_records (resident_id),
    purpose              text        NOT NULL,
    status               varchar(50) NOT NULL,
    processed_by_user_id bigint      REFERENCES users (user_id),
    claimed_at           timestamptz
);

-- ============================================================
-- Rentals
-- ============================================================

-- TABLE 13. rental_items
CREATE TABLE rental_items (
    item_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name               varchar(100) NOT NULL,
    type               varchar(50)  NOT NULL,
    description        text,
    quantity_total     integer      NOT NULL,
    quantity_available integer      NOT NULL,
    is_active          boolean      NOT NULL
);

-- TABLE 14. rental_requests
CREATE TABLE rental_requests (
    request_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id              bigint      NOT NULL REFERENCES rental_items (item_id),
    requested_by_user_id bigint      NOT NULL REFERENCES users (user_id),
    quantity_requested   integer     NOT NULL,
    start_datetime       timestamptz NOT NULL,
    end_datetime         timestamptz NOT NULL,
    purpose              text        NOT NULL,
    status               varchar(50) NOT NULL,
    processed_by_user_id bigint      REFERENCES users (user_id)
);

-- ============================================================
-- Finance
-- ============================================================

-- TABLE 15. charges
CREATE TABLE charges (
    charge_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    charge_type         varchar(50)   NOT NULL,
    amount              numeric(10,2) NOT NULL,
    status              varchar(50)   NOT NULL,
    household_id        bigint        REFERENCES household_records (household_id),
    user_id             bigint        REFERENCES users (user_id),
    event_id            bigint        REFERENCES events (event_id),
    document_request_id bigint        REFERENCES document_requests (request_id),
    rental_request_id   bigint        REFERENCES rental_requests (request_id),
    created_at          timestamptz   NOT NULL
);

-- TABLE 16. payments
CREATE TABLE payments (
    payment_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    charge_id           bigint        NOT NULL REFERENCES charges (charge_id),
    amount              numeric(10,2) NOT NULL,
    payment_method      varchar(20)   NOT NULL,
    reference_no        varchar(100),
    received_by_user_id bigint        REFERENCES users (user_id),
    created_at          timestamptz   NOT NULL
);

-- ============================================================
-- System
-- ============================================================

-- TABLE 17. notifications
CREATE TABLE notifications (
    notification_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type              varchar(20)  NOT NULL,
    user_id           bigint       REFERENCES users (user_id),
    household_id      bigint       REFERENCES household_records (household_id),
    destination       varchar(255) NOT NULL,
    subject           varchar(255),
    message           text         NOT NULL,
    status            varchar(50)  NOT NULL,
    provider_response text,
    related_type      varchar(50),
    related_to        bigint,      -- polymorphic reference — not an enforced FK
    created_at        timestamptz  NOT NULL,
    sent_at           timestamptz
);

-- TABLE 18. activity_logs
CREATE TABLE activity_logs (
    log_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint       NOT NULL REFERENCES users (user_id),
    action      varchar(100) NOT NULL,
    table_name  varchar(100) NOT NULL,
    record_id   bigint,      -- polymorphic reference — not an enforced FK
    old_value   jsonb,
    new_value   jsonb,
    "timestamp" timestamptz  NOT NULL
);

-- ============================================================
-- Research Contribution — fuzzy name matching
-- ============================================================

-- TABLE 19. resident_duplicate_candidates
-- Pairs are stored ordered (a < b): the CHECK prevents self-pairs and,
-- together with the UNIQUE constraint, prevents mirror duplicates
-- (B,A) of an existing (A,B).
CREATE TABLE resident_duplicate_candidates (
    candidate_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resident_id_a       bigint        NOT NULL REFERENCES resident_records (resident_id),
    resident_id_b       bigint        NOT NULL REFERENCES resident_records (resident_id),
    similarity_score    numeric(5,4)  NOT NULL,
    match_status        varchar(20)   NOT NULL DEFAULT 'pending',
    reviewed_by_user_id bigint        REFERENCES users (user_id),
    reviewed_at         timestamptz,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT resident_duplicate_candidates_ordered_pair
        CHECK (resident_id_a < resident_id_b),
    CONSTRAINT resident_duplicate_candidates_unique_pair
        UNIQUE (resident_id_a, resident_id_b)
);

-- GIN trigram indexes on resident name columns: make the Stage 1
-- pg_trgm similarity() blocking fast.
CREATE INDEX idx_resident_records_first_name_trgm
    ON resident_records USING gin (first_name gin_trgm_ops);
CREATE INDEX idx_resident_records_last_name_trgm
    ON resident_records USING gin (last_name gin_trgm_ops);

COMMIT;
