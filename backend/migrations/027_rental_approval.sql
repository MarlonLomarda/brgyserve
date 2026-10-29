-- ===========================================================================
-- Migration 027 — rental approval: a booking can wait as PENDING until the
-- Secretary approves or declines it (batch R2a of 4, 28 Oct 2026).
--
-- WHY. The barangay's real process: a resident asks for a facility or item,
-- and the Secretary approves or declines it. Until now create_rental_booking
-- (migration 024) confirmed a booking the moment it was submitted. This
-- migration builds the machinery for approval and leaves it DORMANT: the code
-- that ships with it still books everything as 'confirmed' (through the new
-- place_rental_booking), and a later batch switches residents' bookings to
-- 'pending'. Decided by Lon, 28 Oct 2026 (the R2 read-only diagnosis).
--
-- THE FUNERAL FEE (design C, decided by Lon, 29 Oct 2026). Chairs, tables
-- and tents are free for a funeral, for barangay RESIDENTS only. The resident
-- ticks nothing: they say so in the purpose text. The Secretary decides, at
-- approval, by passing p_waive_for_funeral = true to approve_rental_booking,
-- which then refuses an item she has not marked funeral_eligible
-- (FUNERAL_NOT_ALLOWED) and a booking with no resident, i.e. a guest's
-- (FUNERAL_RESIDENTS_ONLY), checked under the item lock at the moment of
-- waiving; otherwise the charge is PHP 0 (PAID) and purpose_type becomes
-- 'funeral' in the same UPDATE that confirms the booking. purpose_type
-- 'funeral' therefore means "the fee was waived for a funeral", never "the
-- resident said it was a funeral".
--
-- THE CHANGES.
--   rental_requests.decline_reason  text NULL, CHECK
--       rental_requests_decline_reason_length: null, or 3 to 300 characters
--       after trimming (as cancellation_reason, migration 023).
--   rental_requests.purpose_type    varchar(20) NOT NULL DEFAULT 'general',
--       CHECK rental_requests_purpose_type_check: 'general' or 'funeral'.
--       Every existing booking reads 'general'. Set to 'funeral' only by the
--       Secretary's waiver at approval (and, in a later batch, by her
--       walk-in for a resident).
--   rental_requests.requested_at    timestamptz NULL, NO default and NO
--       backfill. rental_requests never stored when a request was made (no
--       created or requested column since migration 001). place_rental_booking
--       sets it to now(); every older booking stays NULL, which means
--       "unknown", never a made-up time. (A DEFAULT now() here would stamp
--       every existing row with the moment this migration ran.)
--   rental_items.funeral_eligible   boolean NOT NULL DEFAULT false, CHECK
--       rental_items_funeral_not_facility: never true on a facility. The
--       guard on the funeral waiver: an item's fee can be waived for a
--       funeral only once it is marked. Set by the Secretary on the Rental
--       items form; this migration ticks nothing.
--
--   CREATE OR REPLACE rental_holds (SAME signature, SAME result columns): a
--       booking stored as 'pending' or 'declined' holds NOTHING, like a
--       cancelled one. Every other status is held exactly as before: confirmed
--       (and stuck), and the three return outcomes with their 24-hour rest.
--       No booking on file is pending or declined (a hard stop below), so the
--       answer for every booking on file is unchanged (checked below, slot by
--       slot).
--   CREATE OR REPLACE update_rental_booking_time (SAME signature): accepts a
--       booking stored as 'confirmed' OR 'pending' that has not started. The
--       route running today refuses a non-confirmed booking before it calls
--       this, so nothing changes for it.
--   NEW place_rental_booking(...)    the insert, for both kinds: the same lock
--       and checks as create_rental_booking, then the row with p_status
--       'pending' or 'confirmed' and p_purpose_type. A request for a slot an
--       APPROVED booking already holds is refused exactly as a booking is
--       today; two pending requests for a free slot are both accepted. A
--       'funeral' booking (the Secretary's walk-in, a later batch; the route
--       sends 'general' today) is refused for an unmarked item and for a
--       guest, as the waiver is.
--   NEW approve_rental_booking(..., p_waive_for_funeral boolean)  locks the
--       item, then the booking (the order update_rental_booking_time takes,
--       so the two cannot deadlock), refuses with BOOKING_NOT_FOUND,
--       BOOKING_NOT_PENDING, BOOKING_EXPIRED (its start has passed),
--       ITEM_INACTIVE, then, only when waiving, FUNERAL_NOT_ALLOWED and
--       FUNERAL_RESIDENTS_ONLY, then RESIDENT_ARCHIVED or the slot refusal,
--       and otherwise sets status 'confirmed' and processed_by (and
--       purpose_type 'funeral' when waiving) AND inserts the RENTAL charge in
--       the SAME transaction (PAID when the amount is 0). A refused approval
--       changes nothing: the booking stays pending and no charge exists. The
--       amount is worked out by the route and passed in, so the pricing rules
--       stay in JavaScript; a waiver with an amount other than 0 is raised.
--   create_rental_booking is NOT dropped: the code running today calls it.
--   Migration 028 drops it, once the new code is live (as 026 dropped
--   rental_settings).
--
-- STATUS, TYPE AND CHARGE WORDS ARE LITERALS HERE, as in 024.
-- constants/rentals.js is the source of truth for 'pending', 'confirmed',
-- 'declined', 'cancelled', the returns, 'general', 'funeral' and 'facility';
-- constants/charges.js for 'RENTAL', 'UNPAID' and 'PAID'. A new status owes
-- rental_holds an edit in the same change.
--
-- SECURITY. As 024: SECURITY INVOKER, a fixed search_path, EXECUTE revoked
-- from PUBLIC, anon and authenticated and granted to service_role only. A
-- CREATE OR REPLACE keeps a function's existing grants (checked below).
--
-- ORDER OF DEPLOYMENT.
--   1. Apply 027 FIRST.
--   2. Then deploy the R2a code (Render, from main).
--   3. Migration 028 (drop create_rental_booking) much later, once the code
--      that calls place_rental_booking has been live and working.
-- The code running today is SAFE on the 027 database: it never writes
-- 'pending' or 'declined', never selects the new columns (their defaults
-- fill them on its inserts; requested_at stays NULL), and still calls
-- create_rental_booking, which stays. The NEW code must NEVER reach a
-- database without 027: it calls place_rental_booking on every booking and
-- selects the new columns on every list, so every booking and every list
-- load would be a 500.
--
-- GUARDED, as 023, 025 and 026 are. Hard stops run before the change (the
-- tables and 024's functions exist, nothing new exists yet, no booking is
-- pending or declined); a snapshot is taken of every booking, every item,
-- the charges and what rental_holds answers for every booking's own slot and
-- for each item's whole span; the change runs; then a PROBE calls migration
-- 024's create_rental_booking and update_rental_booking_time and the two new
-- functions inside a sub-transaction that is always rolled back (so the
-- %ROWTYPE functions are proven to run after the columns are added, on this
-- database); the same checks run again as hard stops; and ONE result set
-- reports PASS/FAIL — the Supabase editor shows only the last one.
-- The block ends in ROLLBACK: run it, read the result set, and only then
-- change the last statement to COMMIT and run it again (CLAUDE.md, Standing
-- Rules).
--
-- The one trace the probe leaves, even on COMMIT: identity counters are not
-- transactional, so the next real rental_requests and charges ids skip the
-- few numbers the probe used (5 bookings, 1 charge). Harmless; ids were never
-- contiguous.
--
-- EXPECTED ROW COUNTS (read 28 Oct 2026, read-only):
--   rental_requests  39 rows (14 confirmed, 12 cancelled, 4 returned,
--                    6 returned_late, 3 returned_with_issue); 0 pending,
--                    0 declined. Unchanged in number, id, status and start.
--   rental_items     9 rows, unchanged in every column and hours; each gains
--                    funeral_eligible = false.
--   charges          unchanged in number (the probe's charge is rolled back).
--
-- DOCUMENTS. docs/brgyserve-database-schema.md (Tables 13 and 14) carries the
-- four columns. Chapter 3 Tables 13 and 14 and the ERD (`amoncio - erd`) owe
-- the same four columns (CLAUDE.md — a migration is not finished when it is
-- applied).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Before: hard stops.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rows text;
BEGIN
  IF to_regclass('public.rental_requests') IS NULL OR to_regclass('public.rental_items') IS NULL
     OR to_regclass('public.charges') IS NULL OR to_regclass('public.resident_records') IS NULL THEN
    RAISE EXCEPTION 'ABORT: rental_requests, rental_items, charges or resident_records is missing — wrong database?';
  END IF;
  IF to_regprocedure('public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('public.rental_availability(bigint,timestamptz,timestamptz,bigint)') IS NULL
     OR to_regprocedure('public.rental_holds(bigint,timestamptz,timestamptz,bigint)') IS NULL
     OR to_regprocedure('public.rental_slot_refusal(bigint,integer,timestamptz,timestamptz,bigint)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: migration 024''s functions are not all there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('place_rental_booking', 'approve_rental_booking')) THEN
    RAISE EXCEPTION 'ABORT: place_rental_booking or approve_rental_booking already exists — migration 027 already applied?';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND ((table_name = 'rental_requests' AND column_name IN ('decline_reason', 'purpose_type', 'requested_at'))
                  OR (table_name = 'rental_items' AND column_name = 'funeral_eligible'))) THEN
    RAISE EXCEPTION 'ABORT: a column this migration adds already exists — migration 027 already applied?';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname IN ('rental_requests_decline_reason_length', 'rental_requests_purpose_type_check',
                                'rental_items_funeral_not_facility')) THEN
    RAISE EXCEPTION 'ABORT: a constraint name this migration adds is taken';
  END IF;
  -- A booking already stored as pending or declined would stop holding its
  -- slot the moment rental_holds is replaced. None should exist.
  IF EXISTS (SELECT 1 FROM rental_requests WHERE status IN ('pending', 'declined')) THEN
    SELECT string_agg('#' || request_id || ' ' || status, ', ' ORDER BY request_id) INTO v_rows
      FROM rental_requests WHERE status IN ('pending', 'declined');
    RAISE EXCEPTION 'ABORT: bookings already stored as pending or declined: %. STOP and report this.', v_rows;
  END IF;
END $$;

-- The snapshot. rental_holds is asked for every booking's own slot and for
-- each item's whole span (ten years either side of now), before and after.
-- now() is fixed for the whole transaction, so the two readings compare.
CREATE TEMP TABLE m027_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM rental_requests) AS booking_count,
  (SELECT string_agg(status || ' ' || n, ', ' ORDER BY status)
     FROM (SELECT status, count(*) AS n FROM rental_requests GROUP BY status) s) AS booking_statuses,
  (SELECT md5(COALESCE(string_agg(request_id || ',' || status || ',' || start_datetime::text, ';' ORDER BY request_id), ''))
     FROM rental_requests) AS booking_hash,
  (SELECT count(*) FROM rental_items) AS item_count,
  (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || COALESCE(description, '') || ','
                                  || quantity_total || ',' || quantity_available || ',' || fee || ',' || is_active || ','
                                  || booking_opens_at || ',' || booking_closes_at, ';' ORDER BY item_id), ''))
     FROM rental_items) AS item_hash,
  (SELECT count(*) FROM charges) AS charge_count,
  (SELECT md5(COALESCE(string_agg(charge_id || ',' || status || ',' || amount, ';' ORDER BY charge_id), ''))
     FROM charges) AS charge_hash;

CREATE TEMP TABLE m027_windows ON COMMIT DROP AS
SELECT i.item_id, now() - interval '3650 days' AS s, now() + interval '3650 days' AS e
  FROM rental_items i
UNION ALL
SELECT rr.item_id, rr.start_datetime, rr.end_datetime
  FROM rental_requests rr;

CREATE TEMP TABLE m027_holds_before ON COMMIT DROP AS
SELECT count(*) AS windows,
       md5(COALESCE(string_agg(w.item_id || '@' || w.s || '-' || w.e || ':' || h.used_units || ',' || h.stuck_units
                               || ',' || h.resting_units || ',' || h.clashes::text, ';' ORDER BY w.item_id, w.s, w.e), '')) AS holds_hash
  FROM m027_windows w
 CROSS JOIN LATERAL public.rental_holds(w.item_id, w.s, w.e, NULL) h;

-- ---------------------------------------------------------------------------
-- The change: columns.
-- ---------------------------------------------------------------------------
ALTER TABLE rental_requests
    ADD COLUMN decline_reason text NULL
        CONSTRAINT rental_requests_decline_reason_length CHECK (
            decline_reason IS NULL
            OR char_length(btrim(decline_reason)) BETWEEN 3 AND 300
        ),
    ADD COLUMN purpose_type varchar(20) NOT NULL DEFAULT 'general'
        CONSTRAINT rental_requests_purpose_type_check CHECK (purpose_type IN ('general', 'funeral')),
    ADD COLUMN requested_at timestamptz NULL;

ALTER TABLE rental_items
    ADD COLUMN funeral_eligible boolean NOT NULL DEFAULT false
        CONSTRAINT rental_items_funeral_not_facility CHECK (NOT funeral_eligible OR type <> 'facility');

-- ---------------------------------------------------------------------------
-- rental_holds — THE availability rule, as 024 wrote it, with ONE change:
-- 'pending' and 'declined' hold nothing, like 'cancelled'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rental_holds(
    p_item_id            bigint,
    p_start              timestamptz,
    p_end                timestamptz,
    p_exclude_request_id bigint
)
RETURNS TABLE (
    item_type     text,
    capacity      integer,
    used_units    integer,
    stuck_units   integer,
    resting_units integer,
    clashes       jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    WITH item AS (
        SELECT i.type::text                       AS item_type,
               i.type IN ('equipment', 'furniture') AS returnable,
               CASE WHEN i.type = 'facility'
                    THEN LEAST(1, i.quantity_available)
                    ELSE i.quantity_available
               END                                AS capacity
          FROM rental_items i
         WHERE i.item_id = p_item_id
    ),
    wanted AS (
        SELECT p_start AS s,
               CASE WHEN item.returnable THEN p_end + interval '24 hours' ELSE p_end END AS block_end
          FROM item
    ),
    held AS (
        SELECT rr.quantity_requested AS qty,
               rr.start_datetime     AS s,
               rr.end_datetime       AS booked_end,
               item.returnable,
               (item.returnable
                AND rr.status NOT IN ('returned', 'returned_late', 'returned_with_issue')
                AND rr.end_datetime < now()) AS stuck,
               CASE
                   WHEN NOT item.returnable
                       THEN rr.end_datetime
                   WHEN rr.status IN ('returned', 'returned_late', 'returned_with_issue')
                       THEN GREATEST(rr.end_datetime, COALESCE(rr.returned_at, rr.end_datetime))
                   WHEN rr.end_datetime < now()
                       THEN 'infinity'::timestamptz
                   ELSE rr.end_datetime
               END AS use_end
          FROM rental_requests rr
         CROSS JOIN item
         WHERE rr.item_id = p_item_id
           -- Migration 027: a pending request and a declined one hold nothing.
           AND rr.status NOT IN ('cancelled', 'pending', 'declined')
           AND (p_exclude_request_id IS NULL OR rr.request_id <> p_exclude_request_id)
    ),
    blocked AS (
        SELECT held.*,
               CASE WHEN held.returnable AND NOT held.stuck
                    THEN held.use_end + interval '24 hours'
                    ELSE held.use_end
               END AS block_end
          FROM held
    ),
    hits AS (
        SELECT b.qty, b.s, b.booked_end, b.stuck,
               (b.s < w.block_end AND w.s < b.use_end) AS in_use
          FROM blocked b
         CROSS JOIN wanted w
         WHERE b.s < w.block_end
           AND w.s < b.block_end
    )
    SELECT item.item_type,
           item.capacity,
           COALESCE((SELECT sum(qty) FROM hits), 0)::integer,
           COALESCE((SELECT sum(qty) FROM hits WHERE stuck), 0)::integer,
           COALESCE((SELECT sum(qty) FROM hits WHERE NOT stuck AND NOT in_use), 0)::integer,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('start', s, 'end', booked_end) ORDER BY s, booked_end)
                       FROM hits), '[]'::jsonb)
      FROM item;
$$;

-- ---------------------------------------------------------------------------
-- update_rental_booking_time — as 024 wrote it, with ONE change: a booking
-- stored as 'pending' may be moved too (the Secretary edits a request before
-- deciding it). Still only one that has not started.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_rental_booking_time(
    p_request_id bigint,
    p_start      timestamptz,
    p_end        timestamptz,
    p_purpose    text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item_id bigint;
    v_before  rental_requests%ROWTYPE;
    v_row     rental_requests%ROWTYPE;
    v_refusal jsonb;
BEGIN
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'END_NOT_AFTER_START');
    END IF;
    IF p_start <= now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'START_NOT_IN_FUTURE');
    END IF;

    SELECT rr.item_id INTO v_item_id
      FROM rental_requests rr
     WHERE rr.request_id = p_request_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
    END IF;

    PERFORM 1 FROM rental_items i WHERE i.item_id = v_item_id FOR UPDATE;

    SELECT * INTO v_before
      FROM rental_requests rr
     WHERE rr.request_id = p_request_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
    END IF;
    IF v_before.item_id <> v_item_id THEN
        -- No route changes a booking's item; this is not a normal refusal.
        RAISE EXCEPTION 'booking % changed item while being edited', p_request_id;
    END IF;
    -- The Edit rule: stored confirmed or pending, and its start still ahead.
    IF v_before.status NOT IN ('confirmed', 'pending') OR v_before.start_datetime <= now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_STARTED', 'status', v_before.status);
    END IF;

    v_refusal := public.rental_slot_refusal(v_item_id, v_before.quantity_requested, p_start, p_end, p_request_id);
    IF v_refusal IS NOT NULL THEN
        RETURN v_refusal;
    END IF;

    UPDATE rental_requests
       SET start_datetime = p_start,
           end_datetime   = p_end,
           purpose        = p_purpose
     WHERE request_id = p_request_id
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'ok', true,
        'before', jsonb_build_object('start_datetime', v_before.start_datetime,
                                     'end_datetime',   v_before.end_datetime,
                                     'purpose',        v_before.purpose),
        'request', to_jsonb(v_row));
END;
$$;

-- ---------------------------------------------------------------------------
-- place_rental_booking — the insert for a resident's request ('pending') and
-- for a booking confirmed at once ('confirmed'). The same lock and checks as
-- create_rental_booking: the times, the item row lock, the item exists and is
-- active, then rental_slot_refusal, which counts only what rental_holds
-- holds, so a request for a slot an approved booking already holds is refused
-- and a pending request blocks nobody. p_purpose_type 'funeral' is for the
-- Secretary's walk-in for a resident (a later batch; the route sends
-- 'general' today), under the waiver's two rules: refused for an item not
-- marked funeral_eligible (FUNERAL_NOT_ALLOWED), then for a booking with no
-- resident (FUNERAL_RESIDENTS_ONLY). A status or purpose type outside the
-- lists is a programming error, raised, never a refusal. Returns
-- {"ok": true, "request": <the new row>} or a coded refusal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.place_rental_booking(
    p_item_id                  bigint,
    p_requested_by_user_id     bigint,
    p_resident_id              bigint,
    p_outside_borrower_name    text,
    p_outside_borrower_contact text,
    p_quantity                 integer,
    p_start                    timestamptz,
    p_end                      timestamptz,
    p_purpose                  text,
    p_purpose_type             text,
    p_status                   text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_active  boolean;
    v_funeral boolean;
    v_refusal jsonb;
    v_row     rental_requests%ROWTYPE;
BEGIN
    IF p_status IS NULL OR p_status NOT IN ('pending', 'confirmed') THEN
        RAISE EXCEPTION 'place_rental_booking: status must be pending or confirmed, not %', COALESCE(p_status, 'NULL');
    END IF;
    IF p_purpose_type IS NULL OR p_purpose_type NOT IN ('general', 'funeral') THEN
        RAISE EXCEPTION 'place_rental_booking: purpose type must be general or funeral, not %', COALESCE(p_purpose_type, 'NULL');
    END IF;

    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'END_NOT_AFTER_START');
    END IF;
    IF p_start <= now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'START_NOT_IN_FUTURE');
    END IF;

    -- The lock, as in create_rental_booking.
    SELECT i.is_active, i.funeral_eligible
      INTO v_active, v_funeral
      FROM rental_items i
     WHERE i.item_id = p_item_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_NOT_FOUND');
    END IF;
    IF NOT v_active THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_INACTIVE');
    END IF;
    IF p_purpose_type = 'funeral' AND NOT v_funeral THEN
        RETURN jsonb_build_object('ok', false, 'code', 'FUNERAL_NOT_ALLOWED');
    END IF;
    IF p_purpose_type = 'funeral' AND p_resident_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'FUNERAL_RESIDENTS_ONLY');
    END IF;

    v_refusal := public.rental_slot_refusal(p_item_id, p_quantity, p_start, p_end, NULL);
    IF v_refusal IS NOT NULL THEN
        RETURN v_refusal;
    END IF;

    INSERT INTO rental_requests (
        item_id, requested_by_user_id,
        resident_id, outside_borrower_name, outside_borrower_contact,
        quantity_requested, start_datetime, end_datetime, purpose,
        purpose_type, status, processed_by_user_id, requested_at
    ) VALUES (
        p_item_id, p_requested_by_user_id,
        p_resident_id, p_outside_borrower_name, p_outside_borrower_contact,
        p_quantity, p_start, p_end, p_purpose,
        p_purpose_type, p_status, NULL, now()
    )
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_row));
END;
$$;

-- ---------------------------------------------------------------------------
-- approve_rental_booking — the Secretary approves a pending request. Locks
-- the item row, then the booking row (update_rental_booking_time's order),
-- and re-checks under the lock, in this order: the booking exists, it is
-- pending, its start is still ahead (a pending request whose start has
-- passed is EXPIRED and cannot be approved), the item is active; then, only
-- when the Secretary waives the fee for a funeral (p_waive_for_funeral), the
-- item is marked funeral_eligible (FUNERAL_NOT_ALLOWED) and the booking is a
-- resident's, not a guest's (FUNERAL_RESIDENTS_ONLY); then the resident is
-- not archived (their record row is share-locked so it cannot be archived
-- mid-approval), and the slot is still free. Then, in the SAME transaction:
-- status 'confirmed', processed_by_user_id, purpose_type 'funeral' when
-- waiving (left as it is otherwise), and the RENTAL charge (p_amount, PAID
-- when 0, on p_charge_user_id). If anything fails the whole call rolls back:
-- the booking stays pending and no charge exists. A missing actor, a missing
-- or negative amount, a NULL p_waive_for_funeral, or a waiver with an amount
-- other than 0 is a programming error, raised. Returns {"ok": true,
-- "before": {"status": "pending"}, "request": <the row>, "charge":
-- {charge_id, amount, status}, "waived": <boolean>} or a coded refusal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.approve_rental_booking(
    p_request_id        bigint,
    p_processed_by      bigint,
    p_amount            numeric,
    p_charge_user_id    bigint,
    p_waive_for_funeral boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item_id  bigint;
    v_active   boolean;
    v_funeral  boolean;
    v_archived boolean;
    v_before   rental_requests%ROWTYPE;
    v_row      rental_requests%ROWTYPE;
    v_charge   charges%ROWTYPE;
    v_refusal  jsonb;
BEGIN
    IF p_processed_by IS NULL THEN
        RAISE EXCEPTION 'approve_rental_booking: the approving user is required';
    END IF;
    IF p_amount IS NULL OR p_amount < 0 THEN
        RAISE EXCEPTION 'approve_rental_booking: the amount must be 0 or more, not %', COALESCE(p_amount::text, 'NULL');
    END IF;
    IF p_waive_for_funeral IS NULL THEN
        RAISE EXCEPTION 'approve_rental_booking: waive_for_funeral must be true or false, not NULL';
    END IF;
    IF p_waive_for_funeral AND p_amount <> 0 THEN
        RAISE EXCEPTION 'approve_rental_booking: a fee waived for a funeral must be 0, not %', p_amount;
    END IF;

    SELECT rr.item_id INTO v_item_id
      FROM rental_requests rr
     WHERE rr.request_id = p_request_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
    END IF;

    SELECT i.is_active, i.funeral_eligible
      INTO v_active, v_funeral
      FROM rental_items i
     WHERE i.item_id = v_item_id
       FOR UPDATE;

    SELECT * INTO v_before
      FROM rental_requests rr
     WHERE rr.request_id = p_request_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
    END IF;
    IF v_before.item_id <> v_item_id THEN
        RAISE EXCEPTION 'booking % changed item while being approved', p_request_id;
    END IF;
    IF v_before.status <> 'pending' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_PENDING', 'status', v_before.status);
    END IF;
    IF v_before.start_datetime <= now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
    END IF;
    IF NOT v_active THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_INACTIVE');
    END IF;
    -- The funeral waiver's two rules, under the item lock, at the moment of
    -- waiving: the item is marked, and the borrower is a resident.
    IF p_waive_for_funeral THEN
        IF NOT v_funeral THEN
            RETURN jsonb_build_object('ok', false, 'code', 'FUNERAL_NOT_ALLOWED');
        END IF;
        IF v_before.resident_id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'code', 'FUNERAL_RESIDENTS_ONLY');
        END IF;
    END IF;
    IF v_before.resident_id IS NOT NULL THEN
        SELECT r.is_archived INTO v_archived
          FROM resident_records r
         WHERE r.resident_id = v_before.resident_id
           FOR SHARE;
        IF v_archived THEN
            RETURN jsonb_build_object('ok', false, 'code', 'RESIDENT_ARCHIVED');
        END IF;
    END IF;

    v_refusal := public.rental_slot_refusal(v_item_id, v_before.quantity_requested,
                                            v_before.start_datetime, v_before.end_datetime, p_request_id);
    IF v_refusal IS NOT NULL THEN
        RETURN v_refusal;
    END IF;

    UPDATE rental_requests
       SET status = 'confirmed',
           processed_by_user_id = p_processed_by,
           purpose_type = CASE WHEN p_waive_for_funeral THEN 'funeral' ELSE purpose_type END
     WHERE request_id = p_request_id
    RETURNING * INTO v_row;

    INSERT INTO charges (charge_type, amount, status, user_id, rental_request_id, created_at)
    VALUES ('RENTAL', p_amount, CASE WHEN p_amount > 0 THEN 'UNPAID' ELSE 'PAID' END,
            p_charge_user_id, p_request_id, now())
    RETURNING * INTO v_charge;

    RETURN jsonb_build_object(
        'ok', true,
        'before', jsonb_build_object('status', v_before.status),
        'request', to_jsonb(v_row),
        'charge', jsonb_build_object('charge_id', v_charge.charge_id,
                                     'amount',    v_charge.amount,
                                     'status',    v_charge.status),
        'waived', p_waive_for_funeral);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the service role only, on the two new functions. The two replaced
-- ones keep the grants 024 gave them (checked below).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.place_rental_booking(bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text, text, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_rental_booking(bigint, bigint, numeric, bigint, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_rental_booking(bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text, text, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_rental_booking(bigint, bigint, numeric, bigint, boolean)
    TO service_role;

-- PostgREST learns of the new functions and columns. Delivered only on
-- COMMIT, so the dry run sends nothing.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- The probe: migration 024's functions and the two new ones, run on this
-- database after the columns were added, inside a sub-transaction that is
-- ALWAYS rolled back (the deliberate error at its end, SQLSTATE M0027). The
-- answers are kept in variables, which survive the rollback, and written to
-- a temp table afterwards. Throwaway borrower: a guest 'TEST 027 probe',
-- filed by the lowest user_id on file (read only), on the first active
-- facility, 400, 401 and 402 days ahead. A facility is never
-- funeral_eligible (the CHECK), so a funeral waiver on it must be refused.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE m027_probe (ord int, check_name text, pass boolean, detail text) ON COMMIT DROP;

DO $$
DECLARE
  v_user   bigint;
  v_item   bigint;
  v_s1     timestamptz := now() + interval '400 days';
  v_s2     timestamptz := now() + interval '401 days';
  v_s3     timestamptz := now() + interval '402 days';
  c1 jsonb; u1 jsonb; p1 jsonb; p2 jsonb; a1 jsonb; a2 jsonb; p3 jsonb; a3 jsonb; p4 jsonb; a4 jsonb;
  v_st4    text;
  v_ch4    bigint;
  v_err    text;
BEGIN
  SELECT min(user_id) INTO v_user FROM users;
  SELECT min(item_id) INTO v_item FROM rental_items WHERE type = 'facility' AND is_active;
  IF v_user IS NULL OR v_item IS NULL THEN
    INSERT INTO m027_probe VALUES (0, 'probe could run', false, 'no user or no active facility on file');
    RETURN;
  END IF;

  BEGIN
    c1 := public.create_rental_booking(v_item, v_user, NULL, 'TEST 027 probe', '09170000027', 1,
                                       v_s1, v_s1 + interval '1 hour', 'probe');
    u1 := public.update_rental_booking_time((c1 -> 'request' ->> 'request_id')::bigint,
                                            v_s1 + interval '2 hours', v_s1 + interval '3 hours', 'probe moved');
    p1 := public.place_rental_booking(v_item, v_user, NULL, 'TEST 027 probe', '09170000027', 1,
                                      v_s2, v_s2 + interval '1 hour', 'probe', 'general', 'pending');
    p2 := public.place_rental_booking(v_item, v_user, NULL, 'TEST 027 probe', '09170000027', 1,
                                      v_s2, v_s2 + interval '1 hour', 'probe', 'general', 'pending');
    a1 := public.approve_rental_booking((p1 -> 'request' ->> 'request_id')::bigint, v_user, 0, NULL, false);
    a2 := public.approve_rental_booking((p2 -> 'request' ->> 'request_id')::bigint, v_user, 0, NULL, false);
    p3 := public.place_rental_booking(v_item, v_user, NULL, 'TEST 027 probe', '09170000027', 1,
                                      v_s2, v_s2 + interval '1 hour', 'probe', 'general', 'pending');
    a3 := public.approve_rental_booking((p1 -> 'request' ->> 'request_id')::bigint, v_user, 0, NULL, false);
    p4 := public.place_rental_booking(v_item, v_user, NULL, 'TEST 027 probe', '09170000027', 1,
                                      v_s3, v_s3 + interval '1 hour', 'probe', 'general', 'pending');
    a4 := public.approve_rental_booking((p4 -> 'request' ->> 'request_id')::bigint, v_user, 0, NULL, true);
    SELECT rr.status INTO v_st4 FROM rental_requests rr WHERE rr.request_id = (p4 -> 'request' ->> 'request_id')::bigint;
    SELECT count(*) INTO v_ch4 FROM charges ch WHERE ch.rental_request_id = (p4 -> 'request' ->> 'request_id')::bigint;
    RAISE EXCEPTION USING ERRCODE = 'M0027', MESSAGE = 'm027 probe: always rolled back';
  EXCEPTION
    WHEN SQLSTATE 'M0027' THEN NULL;
    WHEN OTHERS THEN v_err := SQLERRM;
  END;

  INSERT INTO m027_probe VALUES
    (1, 'the probe ran without an error', v_err IS NULL, COALESCE(v_err, 'no error')),
    (2, '024 create_rental_booking runs after the columns were added, its row carrying them',
        (c1 ->> 'ok')::boolean IS TRUE AND c1 -> 'request' ->> 'status' = 'confirmed'
          AND c1 -> 'request' ->> 'purpose_type' = 'general' AND (c1 -> 'request') ? 'requested_at'
          AND c1 -> 'request' -> 'requested_at' = 'null'::jsonb,
        COALESCE(left(c1::text, 160), 'no answer')),
    (3, '024 update_rental_booking_time runs after the columns were added',
        (u1 ->> 'ok')::boolean IS TRUE AND u1 -> 'request' ->> 'purpose' = 'probe moved',
        COALESCE(left(u1::text, 160), 'no answer')),
    (4, 'place_rental_booking: two pending requests for one free slot are both accepted, requested_at set',
        (p1 ->> 'ok')::boolean IS TRUE AND (p2 ->> 'ok')::boolean IS TRUE
          AND p1 -> 'request' ->> 'status' = 'pending' AND p1 -> 'request' ->> 'requested_at' IS NOT NULL,
        COALESCE(p1 ->> 'ok', 'null') || ' / ' || COALESCE(p2 ->> 'ok', 'null')),
    (5, 'approve_rental_booking: confirmed, with a PAID charge at PHP 0, in one call, not waived, purpose_type general',
        (a1 ->> 'ok')::boolean IS TRUE AND a1 -> 'request' ->> 'status' = 'confirmed'
          AND a1 -> 'charge' ->> 'status' = 'PAID' AND (a1 -> 'charge' ->> 'amount')::numeric = 0
          AND a1 -> 'waived' = 'false'::jsonb AND a1 -> 'request' ->> 'purpose_type' = 'general',
        COALESCE(left(a1::text, 160), 'no answer')),
    (6, 'the second pending request for that slot cannot be approved (FACILITY_TAKEN)',
        a2 ->> 'code' = 'FACILITY_TAKEN', COALESCE(left(a2::text, 160), 'no answer')),
    (7, 'a new request for the approved slot is refused at once (FACILITY_TAKEN)',
        p3 ->> 'code' = 'FACILITY_TAKEN', COALESCE(left(p3::text, 160), 'no answer')),
    (8, 'approving it again: BOOKING_NOT_PENDING',
        a3 ->> 'code' = 'BOOKING_NOT_PENDING', COALESCE(left(a3::text, 160), 'no answer')),
    (9, 'a funeral waiver on an unmarked item (a facility) is refused: FUNERAL_NOT_ALLOWED, still pending, no charge',
        a4 ->> 'code' = 'FUNERAL_NOT_ALLOWED' AND v_st4 = 'pending' AND v_ch4 = 0,
        COALESCE(left(a4::text, 120), 'no answer') || ' / ' || COALESCE(v_st4, 'null') || ', '
          || COALESCE(v_ch4::text, 'null') || ' charge(s)');
END $$;

-- ---------------------------------------------------------------------------
-- After: hard stops. Any failure aborts the transaction, so nothing is kept
-- even on the COMMIT copy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b m027_before%ROWTYPE;
  v_fail text;
BEGIN
  SELECT * INTO b FROM m027_before;
  SELECT string_agg(ord || ' ' || check_name || ' (' || detail || ')', '; ' ORDER BY ord) INTO v_fail
    FROM m027_probe WHERE NOT pass;
  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: the probe failed: %', v_fail;
  END IF;
  IF (SELECT count(*) FROM rental_requests) <> b.booking_count
     OR (SELECT md5(COALESCE(string_agg(request_id || ',' || status || ',' || start_datetime::text, ';' ORDER BY request_id), ''))
           FROM rental_requests) <> b.booking_hash THEN
    RAISE EXCEPTION 'ABORT: a booking changed (id, status or start), or the count did (% before)', b.booking_count;
  END IF;
  IF (SELECT count(*) FROM rental_items) <> b.item_count
     OR (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || COALESCE(description, '') || ','
                                        || quantity_total || ',' || quantity_available || ',' || fee || ',' || is_active || ','
                                        || booking_opens_at || ',' || booking_closes_at, ';' ORDER BY item_id), ''))
           FROM rental_items) <> b.item_hash THEN
    RAISE EXCEPTION 'ABORT: an item changed';
  END IF;
  IF (SELECT count(*) FROM charges) <> b.charge_count
     OR (SELECT md5(COALESCE(string_agg(charge_id || ',' || status || ',' || amount, ';' ORDER BY charge_id), ''))
           FROM charges) <> b.charge_hash THEN
    RAISE EXCEPTION 'ABORT: the charges changed — the probe''s charge was not rolled back?';
  END IF;
  IF (SELECT holds_hash FROM m027_holds_before) <>
     (SELECT md5(COALESCE(string_agg(w.item_id || '@' || w.s || '-' || w.e || ':' || h.used_units || ',' || h.stuck_units
                                     || ',' || h.resting_units || ',' || h.clashes::text, ';' ORDER BY w.item_id, w.s, w.e), ''))
        FROM m027_windows w CROSS JOIN LATERAL public.rental_holds(w.item_id, w.s, w.e, NULL) h) THEN
    RAISE EXCEPTION 'ABORT: rental_holds answers differently for a slot on file';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_requests WHERE purpose_type <> 'general' OR requested_at IS NOT NULL OR decline_reason IS NOT NULL)
     OR EXISTS (SELECT 1 FROM rental_items WHERE funeral_eligible) THEN
    RAISE EXCEPTION 'ABORT: a new column holds something other than its starting value';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('rental_requests_decline_reason_length', 'rental_requests_purpose_type_check',
                         'rental_items_funeral_not_facility') AND convalidated) <> 3 THEN
    RAISE EXCEPTION 'ABORT: a new CHECK is missing or not validated';
  END IF;
  IF to_regprocedure('public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: create_rental_booking is gone — the live code calls it';
  END IF;
  -- Design C: approve takes the Secretary's waiver flag, and only that one
  -- approve exists (the route always sends all five arguments).
  IF to_regprocedure('public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)') IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'approve_rental_booking') <> 1 THEN
    RAISE EXCEPTION 'ABORT: approve_rental_booking is not the one five-argument function (with p_waive_for_funeral)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- Expected: rows 1 to 24; rows 1 and 2 are INFO, every other verdict PASS.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'bookings on file, by status',
         (SELECT booking_count::text FROM m027_before) || ' rows (expected 39): ' || (SELECT booking_statuses FROM m027_before),
         'INFO'
  UNION ALL
  SELECT 2, 'items on file',
         (SELECT item_count::text FROM m027_before) || ' rows (expected 9)', 'INFO'
  UNION ALL
  SELECT 3, 'no booking was pending or declined before',
         (SELECT booking_statuses FROM m027_before),
         CASE WHEN (SELECT booking_statuses FROM m027_before) !~ '(pending|declined)' THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 4, 'every booking unchanged (md5 of id, status and start)',
         (SELECT booking_hash FROM m027_before),
         CASE WHEN (SELECT count(*) FROM rental_requests) = (SELECT booking_count FROM m027_before)
                AND (SELECT md5(COALESCE(string_agg(request_id || ',' || status || ',' || start_datetime::text, ';' ORDER BY request_id), ''))
                       FROM rental_requests) = (SELECT booking_hash FROM m027_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'every item unchanged, hours included (md5 of every column 026 checked)',
         (SELECT item_hash FROM m027_before),
         CASE WHEN (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || COALESCE(description, '') || ','
                                                   || quantity_total || ',' || quantity_available || ',' || fee || ',' || is_active || ','
                                                   || booking_opens_at || ',' || booking_closes_at, ';' ORDER BY item_id), ''))
                      FROM rental_items) = (SELECT item_hash FROM m027_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 6, 'charges unchanged (count and md5 of id, status, amount)',
         (SELECT charge_count::text FROM m027_before) || ' rows',
         CASE WHEN (SELECT count(*) FROM charges) = (SELECT charge_count FROM m027_before)
                AND (SELECT md5(COALESCE(string_agg(charge_id || ',' || status || ',' || amount, ';' ORDER BY charge_id), ''))
                       FROM charges) = (SELECT charge_hash FROM m027_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 7, 'decline_reason: text, nullable, its CHECK valid',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rental_requests_decline_reason_length'), '(missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rental_requests'
                             AND column_name = 'decline_reason' AND data_type = 'text' AND is_nullable = 'YES')
                AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_requests_decline_reason_length' AND convalidated)
                AND NOT EXISTS (SELECT 1 FROM rental_requests WHERE decline_reason IS NOT NULL)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 8, 'purpose_type: varchar(20) NOT NULL default general, its CHECK valid, every booking general',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rental_requests_purpose_type_check'), '(missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rental_requests'
                             AND column_name = 'purpose_type' AND character_maximum_length = 20 AND is_nullable = 'NO'
                             AND column_default LIKE '''general''%')
                AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_requests_purpose_type_check' AND convalidated)
                AND NOT EXISTS (SELECT 1 FROM rental_requests WHERE purpose_type <> 'general')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 9, 'requested_at: timestamptz, nullable, NO default, NULL on every booking on file',
         COALESCE((SELECT data_type || ', default ' || COALESCE(column_default, 'none') FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'rental_requests' AND column_name = 'requested_at'), '(missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rental_requests'
                             AND column_name = 'requested_at' AND data_type = 'timestamp with time zone'
                             AND is_nullable = 'YES' AND column_default IS NULL)
                AND NOT EXISTS (SELECT 1 FROM rental_requests WHERE requested_at IS NOT NULL)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 10, 'funeral_eligible (the waiver''s guard): boolean NOT NULL default false, never on a facility, no item ticked',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rental_items_funeral_not_facility'), '(missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rental_items'
                             AND column_name = 'funeral_eligible' AND data_type = 'boolean' AND is_nullable = 'NO'
                             AND column_default = 'false')
                AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_items_funeral_not_facility' AND convalidated)
                AND NOT EXISTS (SELECT 1 FROM rental_items WHERE funeral_eligible)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 11, 'rental_holds replaced in place: same signature, pending and declined hold nothing',
         COALESCE(to_regprocedure('public.rental_holds(bigint,timestamptz,timestamptz,bigint)')::text, '(missing)'),
         CASE WHEN to_regprocedure('public.rental_holds(bigint,timestamptz,timestamptz,bigint)') IS NOT NULL
                AND (SELECT count(*) FROM pg_proc WHERE proname = 'rental_holds') = 1
                AND (SELECT prosrc FROM pg_proc WHERE proname = 'rental_holds') LIKE '%NOT IN (''cancelled'', ''pending'', ''declined'')%'
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 12, 'rental_holds answers exactly as before for every booking''s slot and every item''s span',
         (SELECT windows::text FROM m027_holds_before) || ' slots compared',
         CASE WHEN (SELECT holds_hash FROM m027_holds_before) =
                   (SELECT md5(COALESCE(string_agg(w.item_id || '@' || w.s || '-' || w.e || ':' || h.used_units || ',' || h.stuck_units
                                                   || ',' || h.resting_units || ',' || h.clashes::text, ';' ORDER BY w.item_id, w.s, w.e), ''))
                      FROM m027_windows w CROSS JOIN LATERAL public.rental_holds(w.item_id, w.s, w.e, NULL) h)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 13, 'update_rental_booking_time replaced in place: same signature, accepts pending',
         COALESCE(to_regprocedure('public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)')::text, '(missing)'),
         CASE WHEN (SELECT count(*) FROM pg_proc WHERE proname = 'update_rental_booking_time') = 1
                AND (SELECT prosrc FROM pg_proc WHERE proname = 'update_rental_booking_time') LIKE '%NOT IN (''confirmed'', ''pending'')%'
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 14, 'the two replaced functions keep their grants: service_role only',
         'anon / authenticated / service_role',
         CASE WHEN NOT has_function_privilege('anon', 'public.rental_holds(bigint,timestamptz,timestamptz,bigint)', 'EXECUTE')
                AND NOT has_function_privilege('authenticated', 'public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)', 'EXECUTE')
                AND NOT has_function_privilege('anon', 'public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)', 'EXECUTE')
                AND has_function_privilege('service_role', 'public.rental_holds(bigint,timestamptz,timestamptz,bigint)', 'EXECUTE')
                AND has_function_privilege('service_role', 'public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)', 'EXECUTE')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 15, 'place_rental_booking exists, service_role only',
         COALESCE(to_regprocedure('public.place_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text,text,text)')::text, '(missing)'),
         CASE WHEN to_regprocedure('public.place_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text,text,text)') IS NOT NULL
                AND has_function_privilege('service_role', 'public.place_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text,text,text)', 'EXECUTE')
                AND NOT has_function_privilege('anon', 'public.place_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text,text,text)', 'EXECUTE')
                AND NOT has_function_privilege('authenticated', 'public.place_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text,text,text)', 'EXECUTE')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 16, 'approve_rental_booking exists with p_waive_for_funeral (five arguments, the only one), service_role only',
         COALESCE(to_regprocedure('public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)')::text, '(missing)'),
         CASE WHEN to_regprocedure('public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)') IS NOT NULL
                AND (SELECT count(*) FROM pg_proc WHERE proname = 'approve_rental_booking') = 1
                AND has_function_privilege('service_role', 'public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)', 'EXECUTE')
                AND NOT has_function_privilege('anon', 'public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)', 'EXECUTE')
                AND NOT has_function_privilege('authenticated', 'public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)', 'EXECUTE')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 17, 'create_rental_booking still exists (the live code calls it; 028 drops it later)',
         COALESCE(to_regprocedure('public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)')::text, '(missing)'),
         CASE WHEN to_regprocedure('public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)') IS NOT NULL
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 17 + p.ord, 'probe: ' || p.check_name, p.detail, CASE WHEN p.pass THEN 'PASS' ELSE 'FAIL' END
    FROM m027_probe p
   WHERE p.ord BETWEEN 1 AND 5
  -- 18 the probe ran; 19 create_rental_booking (%ROWTYPE); 20 update
  -- (%ROWTYPE); 21 two pending accepted; 22 approve with its charge.
  UNION ALL
  SELECT 23, 'probe: a second pending cannot be approved, a new request is refused, a repeat approve is refused',
         (SELECT string_agg(left(detail, 50), ' | ' ORDER BY ord) FROM m027_probe WHERE ord BETWEEN 6 AND 8),
         CASE WHEN (SELECT bool_and(pass) FROM m027_probe WHERE ord BETWEEN 6 AND 8) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 24, 'probe: ' || p.check_name, p.detail, CASE WHEN p.pass THEN 'PASS' ELSE 'FAIL' END
    FROM m027_probe p
   WHERE p.ord = 9
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
-- Change ROLLBACK to COMMIT once the result set above reads PASS throughout,
-- and BEFORE the R2a code is deployed (see ORDER OF DEPLOYMENT above).
