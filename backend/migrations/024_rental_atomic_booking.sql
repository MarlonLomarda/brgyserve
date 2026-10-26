-- ===========================================================================
-- Migration 024 — rental availability in ONE place, and booking and editing
-- that cannot double-book.
--
-- DO NOT RUN THIS FILE DIRECTLY. It is the record of what 024 creates. Apply
-- it with backend/scripts/apply-024-dry-run.sql (ends in ROLLBACK), then
-- apply-024-commit.sql (the same file with COMMIT as its last line), then
-- check it with apply-024-verify.sql (read-only). The text between the BODY
-- markers below is copied byte for byte into both apply scripts.
--
-- WHY. routes/rentalRequests.js checks capacity and inserts in two separate
-- calls, because supabase-js has no multi-statement transaction. Its guard
-- for a race ("insert, then count lower ids, the loser deletes its own row")
-- is not atomic, and the PUT route's post-update re-check is the same idea.
-- Here the check AND the write happen inside one Postgres function that first
-- locks the item row (SELECT ... FROM rental_items ... FOR UPDATE), so a
-- second booking or edit for the same item waits until the first has
-- committed, and then counts it. Decided by Lon, 25 Oct 2026 (rules R1 to R5).
--
-- NO TABLE OR COLUMN CHANGES. The actual return time is already stored:
-- rental_requests.returned_at (timestamptz, nullable) was added by migration
-- 011, and POST /:id/return already sets it to the time Staff record the
-- return. A returned booking with returned_at NULL (none should exist) is
-- treated as returned at its booked end.
--
-- WHAT A BOOKING HOLDS (its "blocked interval"), rule R3:
--   facility                                  [start, end)
--   equipment / furniture, confirmed, end
--     still ahead                             [start, end + 24 hours)
--   equipment / furniture, confirmed, end
--     passed, not returned ("stuck")          [start, infinity) — until Staff
--                                             mark it returned; never released
--                                             automatically
--   equipment / furniture, returned,
--     returned_late or returned_with_issue    [start, max(end, returned_at)
--                                              + 24 hours)
--   cancelled                                 nothing
-- The 24 hours is a literal interval, not a calendar day, and it holds only
-- that booking's own quantity_requested. The REQUESTED booking is tested with
-- the same rule on its own side: [start, end + 24 hours) for equipment and
-- furniture, [start, end) for a facility. Two blocked intervals clash when
-- A.start < B.block_end AND B.start < A.block_end (strict, so touching is not
-- a clash).
--
-- CAPACITY, rule R4: used = the plain SUM of quantity_requested over every
-- booking whose blocked interval clashes with the requested one (the same
-- window behaviour as today, not per hour). Refused when used + requested >
-- rental_items.quantity_available (never quantity_total). A facility's
-- capacity is 1.
--
-- THE FUNCTIONS. One rule, one place (R2):
--   rental_holds(...)               THE availability rule. Nothing else
--                                   computes a blocked interval.
--   rental_slot_refusal(...)        the quantity rules plus the capacity
--                                   decision, on top of rental_holds. Used by
--                                   both writers, so they refuse alike.
--   create_rental_booking(...)      lock, check, insert.
--   update_rental_booking_time(...) lock, check, update date/time/purpose.
--   rental_availability(...)        read-only, for the booking page (R5).
-- A normal refusal is RETURNED as {"ok": false, "code": ...}, never raised.
-- Codes: TIME_INVALID, ITEM_NOT_FOUND, ITEM_INACTIVE, QUANTITY_INVALID (with
-- a reason: BELOW_ONE, FACILITY_WHOLE or MORE_THAN_EXIST), FACILITY_TAKEN,
-- NOT_ENOUGH_LEFT, and for an edit BOOKING_NOT_FOUND and BOOKING_STARTED.
-- The route composes the sentence the person reads from the code and its
-- numbers, as it does today.
--
-- THE CHARGE IS NOT CREATED HERE. POST creates the booking's RENTAL charge in
-- a separate insert after the booking, and deletes the booking if that
-- insert fails. That step stays in JavaScript; it does not change capacity.
--
-- STATUS AND TYPE WORDS ARE LITERALS HERE. constants/rentals.js is the source
-- of truth ('confirmed', 'cancelled', 'returned', 'returned_late',
-- 'returned_with_issue'; 'facility', 'equipment', 'furniture'). A new status
-- or item type owes this file's functions an edit in the same change. Any
-- status other than cancelled or the three return outcomes is held the way
-- 'confirmed' is, which is the cautious side.
--
-- TIME ZONE. A "Manila day" is computed with AT TIME ZONE 'Asia/Manila', the
-- zone name. Never write '+08:00' there: Postgres reads a bare offset in AT
-- TIME ZONE as POSIX, west-positive, so '+08:00' would mean UTC-8.
--
-- SECURITY. Every function is SECURITY INVOKER with a fixed search_path. The
-- backend calls them with the service role key, which bypasses RLS, so
-- invoker rights are all they need. EXECUTE is revoked from PUBLIC, anon and
-- authenticated and granted to service_role only: Supabase's default
-- privileges grant new functions in public to anon and authenticated, so the
-- REVOKE has to name them. (Migrations 021 to 023 created no functions;
-- migration 003's match_resident_candidates kept the default grants.)
--
-- ROLLING IT BACK, if ever needed: drop the five functions. No data changes.
--
-- Chapter 3 and the ERD (`amoncio - erd`) gain no table or column from this
-- migration. If Chapter 3 describes the booking conflict check, its wording
-- owes the 24-hour gap and the stuck-item rule. See CLAUDE.md, "A schema
-- change is not finished when the migration is applied".
-- ===========================================================================

-- >>> 024 BODY BEGIN

-- ---------------------------------------------------------------------------
-- rental_holds — THE availability rule (R3, R4).
-- For one item and a requested [p_start, p_end), the units held against it:
--   used_units     every clashing booking's quantity, summed
--   stuck_units    the part of used_units held by stuck bookings (equipment
--                  or furniture past its end and not returned)
--   resting_units  the part held only by a booking's 24-hour gap: its own use
--                  ([start, end), or [start, max(end, returned_at)) once
--                  returned) does not reach the requested interval, its gap
--                  does
--   clashes        the clashing bookings' booked [start, end], earliest
--                  first, and nothing else about them
-- p_exclude_request_id ignores one booking (an edit, never against itself).
-- No row comes back when the item does not exist.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.rental_holds(
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
           AND rr.status <> 'cancelled'
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
-- rental_slot_refusal — why p_quantity units of the item cannot be held for
-- [p_start, p_end), as a coded refusal, or NULL when they can. The quantity
-- rules in the order itemQuantityError() applies them, then capacity from
-- rental_holds. Both writers call this after taking the item lock.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.rental_slot_refusal(
    p_item_id            bigint,
    p_quantity           integer,
    p_start              timestamptz,
    p_end                timestamptz,
    p_exclude_request_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_type      text;
    v_available integer;
    h           record;
BEGIN
    SELECT i.type, i.quantity_available
      INTO v_type, v_available
      FROM rental_items i
     WHERE i.item_id = p_item_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_NOT_FOUND');
    END IF;

    IF p_quantity IS NULL OR p_quantity < 1 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'QUANTITY_INVALID', 'reason', 'BELOW_ONE',
                                  'requested', p_quantity);
    END IF;
    IF v_type = 'facility' AND p_quantity <> 1 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'QUANTITY_INVALID', 'reason', 'FACILITY_WHOLE',
                                  'requested', p_quantity);
    END IF;
    IF p_quantity > v_available THEN
        RETURN jsonb_build_object('ok', false, 'code', 'QUANTITY_INVALID', 'reason', 'MORE_THAN_EXIST',
                                  'requested', p_quantity, 'quantity_available', v_available);
    END IF;

    SELECT * INTO h FROM public.rental_holds(p_item_id, p_start, p_end, p_exclude_request_id);
    IF h.used_units + p_quantity > h.capacity THEN
        IF v_type = 'facility' THEN
            RETURN jsonb_build_object('ok', false, 'code', 'FACILITY_TAKEN', 'clashes', h.clashes);
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', 'NOT_ENOUGH_LEFT',
                                  'quantity_available', h.capacity,
                                  'used', h.used_units,
                                  'left', GREATEST(0, h.capacity - h.used_units),
                                  'requested', p_quantity,
                                  'stuck', h.stuck_units,
                                  'resting', h.resting_units);
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- create_rental_booking — R1. Locks the item row, checks, and inserts the
-- booking with the columns POST /api/rental-requests inserts today: status
-- confirmed, processed_by_user_id NULL (self-service, nobody approves), and
-- exactly one borrower shape, which the CHECK from migration 022 enforces.
-- The route still validates the body and resolves the borrower first.
-- Returns {"ok": true, "request": <the new row>} or a coded refusal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.create_rental_booking(
    p_item_id                  bigint,
    p_requested_by_user_id     bigint,
    p_resident_id              bigint,
    p_outside_borrower_name    text,
    p_outside_borrower_contact text,
    p_quantity                 integer,
    p_start                    timestamptz,
    p_end                      timestamptz,
    p_purpose                  text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_active  boolean;
    v_refusal jsonb;
    v_row     rental_requests%ROWTYPE;
BEGIN
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'END_NOT_AFTER_START');
    END IF;
    IF p_start <= now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'START_NOT_IN_FUTURE');
    END IF;

    -- The lock. A second booking or edit for this item waits here until this
    -- transaction ends, then counts what it wrote.
    SELECT i.is_active
      INTO v_active
      FROM rental_items i
     WHERE i.item_id = p_item_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_NOT_FOUND');
    END IF;
    IF NOT v_active THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_INACTIVE');
    END IF;

    v_refusal := public.rental_slot_refusal(p_item_id, p_quantity, p_start, p_end, NULL);
    IF v_refusal IS NOT NULL THEN
        RETURN v_refusal;
    END IF;

    INSERT INTO rental_requests (
        item_id, requested_by_user_id,
        resident_id, outside_borrower_name, outside_borrower_contact,
        quantity_requested, start_datetime, end_datetime, purpose,
        status, processed_by_user_id
    ) VALUES (
        p_item_id, p_requested_by_user_id,
        p_resident_id, p_outside_borrower_name, p_outside_borrower_contact,
        p_quantity, p_start, p_end, p_purpose,
        'confirmed', NULL
    )
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_row));
END;
$$;

-- ---------------------------------------------------------------------------
-- update_rental_booking_time — R1 for an edit. Changes start_datetime,
-- end_datetime and purpose only, the columns PUT /:id may change. Same lock
-- (the booking's item first, then the booking row), same refusal, with this
-- booking excluded so it never clashes with its own current slot. Inactive
-- items are NOT refused: deactivation only blocks new bookings. Returns
-- {"ok": true, "before": {...}, "request": <the updated row>} or a coded
-- refusal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.update_rental_booking_time(
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
    -- hasNotStarted(): stored confirmed and its start still ahead.
    IF v_before.status <> 'confirmed' OR v_before.start_datetime <= now() THEN
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
-- rental_availability — read-only (R5). Numbers only: no names, accounts,
-- purposes, contacts or booking ids.
--   item_type, total (the capacity: quantity_available, 1 for a facility),
--   used (everything held), booked (used minus stuck and resting), stuck,
--   resting, left (total minus used, never below 0),
--   and for a facility only, taken: the booked [start, end] of every booking
--   on the Manila day of p_start (00:00+08:00 to the next 00:00+08:00).
-- Does not refuse an inactive item, so Edit can ask about one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.rental_availability(
    p_item_id            bigint,
    p_start              timestamptz,
    p_end                timestamptz,
    p_exclude_request_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    h      record;
    d      record;
    v_day  timestamptz;
    v_out  jsonb;
BEGIN
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TIME_INVALID', 'reason', 'END_NOT_AFTER_START');
    END IF;

    SELECT * INTO h FROM public.rental_holds(p_item_id, p_start, p_end, p_exclude_request_id);
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEM_NOT_FOUND');
    END IF;

    v_out := jsonb_build_object(
        'ok',        true,
        'item_type', h.item_type,
        'total',     h.capacity,
        'used',      h.used_units,
        'booked',    h.used_units - h.stuck_units - h.resting_units,
        'stuck',     h.stuck_units,
        'resting',   h.resting_units,
        'left',      GREATEST(0, h.capacity - h.used_units));

    IF h.item_type = 'facility' THEN
        v_day := ((p_start AT TIME ZONE 'Asia/Manila')::date)::timestamp AT TIME ZONE 'Asia/Manila';
        SELECT * INTO d FROM public.rental_holds(p_item_id, v_day, v_day + interval '1 day', p_exclude_request_id);
        v_out := v_out || jsonb_build_object('taken', d.clashes);
    END IF;

    RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the service role only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.rental_holds(bigint, timestamptz, timestamptz, bigint)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rental_slot_refusal(bigint, integer, timestamptz, timestamptz, bigint)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_rental_booking(bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_rental_booking_time(bigint, timestamptz, timestamptz, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rental_availability(bigint, timestamptz, timestamptz, bigint)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rental_holds(bigint, timestamptz, timestamptz, bigint)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.rental_slot_refusal(bigint, integer, timestamptz, timestamptz, bigint)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.create_rental_booking(bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.update_rental_booking_time(bigint, timestamptz, timestamptz, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.rental_availability(bigint, timestamptz, timestamptz, bigint)
    TO service_role;

-- PostgREST learns of the new functions. Delivered only on COMMIT, so the
-- dry run sends nothing.
NOTIFY pgrst, 'reload schema';

-- <<< 024 BODY END
