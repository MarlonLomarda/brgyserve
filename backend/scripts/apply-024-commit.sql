-- ===========================================================================
-- Apply migration 024 (rental availability in one place; atomic booking and
-- editing). Two copies of this file exist and they differ in EXACTLY ONE
-- LINE, the last statement:
--   backend/scripts/apply-024-dry-run.sql  ends in ROLLBACK — nothing is kept
--   backend/scripts/apply-024-commit.sql   ends in COMMIT
-- Run the dry run first, read its result set, and run the commit copy only
-- when every verdict reads PASS or INFO. Then run apply-024-verify.sql.
--
-- What it writes: five functions and their grants. No table, no column and
-- no row is added, changed or removed, and the checks below abort if any
-- row count or row of rental_items, rental_requests, charges or payments
-- differs afterwards.
--
-- Expected result set: rows 1 to 21. Rows 1 to 18 PASS. Rows 19 to 21 are
-- INFO about the data on file and need reading, not fixing:
--   19  the smoke call of rental_availability
--   20  STUCK bookings on file now: equipment or furniture past its end and
--       never marked returned. Once the route uses these functions, each of
--       these holds its units until Staff mark it returned. If this lists old
--       test bookings, that is the moment to mark them returned.
--   21  future confirmed bookings that the new rule would itself refuse
--       today (the 24-hour gap, or a stuck booking, now overlaps them). They
--       are NOT changed or cancelled; it only means that item is already over
--       its limit for that window.
--
-- The body between the BODY markers is copied byte for byte from
-- backend/migrations/024_rental_atomic_booking.sql.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Before: hard stops.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
  v_found   text;
BEGIN
  IF to_regclass('public.rental_items') IS NULL
     OR to_regclass('public.rental_requests') IS NULL
     OR to_regclass('public.charges') IS NULL
     OR to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'ABORT: rental_items, rental_requests, charges or payments does not exist — wrong database?';
  END IF;

  SELECT string_agg(need.t || '.' || need.c, ', ')
    INTO v_missing
    FROM (VALUES
      ('rental_items', 'item_id'), ('rental_items', 'type'),
      ('rental_items', 'quantity_available'), ('rental_items', 'is_active'),
      ('rental_requests', 'request_id'), ('rental_requests', 'item_id'),
      ('rental_requests', 'requested_by_user_id'), ('rental_requests', 'resident_id'),
      ('rental_requests', 'outside_borrower_name'), ('rental_requests', 'outside_borrower_contact'),
      ('rental_requests', 'quantity_requested'), ('rental_requests', 'start_datetime'),
      ('rental_requests', 'end_datetime'), ('rental_requests', 'purpose'),
      ('rental_requests', 'status'), ('rental_requests', 'processed_by_user_id'),
      ('rental_requests', 'returned_at')
    ) AS need (t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = 'public' AND ic.table_name = need.t AND ic.column_name = need.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: missing column(s): % — migrations 011 and 022 must be applied first', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'rental_requests'
                    AND column_name = 'returned_at' AND data_type = 'timestamp with time zone') THEN
    RAISE EXCEPTION 'ABORT: rental_requests.returned_at is not timestamptz';
  END IF;

  SELECT string_agg(p.proname, ', ')
    INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('rental_holds', 'rental_slot_refusal', 'create_rental_booking',
                       'update_rental_booking_time', 'rental_availability');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: function(s) already exist: % — migration 024 has already been applied', v_found;
  END IF;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'ABORT: the roles anon, authenticated and service_role are not all present — not a Supabase database?';
  END IF;
END $$;

-- A snapshot of every row the change must not touch. Lives only inside this
-- transaction.
CREATE TEMP TABLE m024_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM rental_items)    AS items,
  (SELECT count(*) FROM rental_requests) AS bookings,
  (SELECT count(*) FROM charges)         AS charges,
  (SELECT count(*) FROM payments)        AS payments,
  (SELECT md5(COALESCE(string_agg(to_jsonb(ri)::text, ';' ORDER BY ri.item_id), ''))
     FROM rental_items ri)               AS items_hash,
  (SELECT md5(COALESCE(string_agg(to_jsonb(rr)::text, ';' ORDER BY rr.request_id), ''))
     FROM rental_requests rr)            AS bookings_hash;

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
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- After: the same checks as hard stops. Any failure aborts the transaction,
-- so nothing is kept even on the COMMIT copy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b m024_before%ROWTYPE;
  f text;
BEGIN
  SELECT * INTO b FROM m024_before;
  FOREACH f IN ARRAY ARRAY[
    'public.rental_holds(bigint,timestamptz,timestamptz,bigint)',
    'public.rental_slot_refusal(bigint,integer,timestamptz,timestamptz,bigint)',
    'public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)',
    'public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)',
    'public.rental_availability(bigint,timestamptz,timestamptz,bigint)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'ABORT: % was not created', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'ABORT: wrong grants on %', f;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM rental_items) <> b.items
     OR (SELECT count(*) FROM rental_requests) <> b.bookings
     OR (SELECT count(*) FROM charges) <> b.charges
     OR (SELECT count(*) FROM payments) <> b.payments THEN
    RAISE EXCEPTION 'ABORT: a row count changed';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(to_jsonb(ri)::text, ';' ORDER BY ri.item_id), '')) FROM rental_items ri) <> b.items_hash
     OR (SELECT md5(COALESCE(string_agg(to_jsonb(rr)::text, ';' ORDER BY rr.request_id), '')) FROM rental_requests rr) <> b.bookings_hash THEN
    RAISE EXCEPTION 'ABORT: an item or booking row changed';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- ---------------------------------------------------------------------------
WITH fn (ord, label, sig) AS (
  VALUES
    (6,  'rental_holds',               'public.rental_holds(bigint,timestamptz,timestamptz,bigint)'),
    (7,  'rental_slot_refusal',        'public.rental_slot_refusal(bigint,integer,timestamptz,timestamptz,bigint)'),
    (8,  'create_rental_booking',      'public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)'),
    (9,  'update_rental_booking_time', 'public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)'),
    (10, 'rental_availability',        'public.rental_availability(bigint,timestamptz,timestamptz,bigint)')
),
fn_info AS (
  SELECT fn.ord, fn.label, fn.sig, p.oid, p.prosecdef, p.proconfig, p.proacl
    FROM fn
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(fn.sig)
),
stuck AS (
  SELECT rr.request_id, rr.item_id, rr.quantity_requested
    FROM rental_requests rr
    JOIN rental_items ri ON ri.item_id = rr.item_id
   WHERE ri.type IN ('equipment', 'furniture')
     AND rr.status NOT IN ('cancelled', 'returned', 'returned_late', 'returned_with_issue')
     AND rr.end_datetime < now()
),
over_limit AS (
  SELECT rr.request_id
    FROM rental_requests rr
   WHERE rr.status = 'confirmed'
     AND rr.start_datetime > now()
     AND public.rental_slot_refusal(rr.item_id, rr.quantity_requested,
                                    rr.start_datetime, rr.end_datetime, rr.request_id) IS NOT NULL
),
smoke AS (
  SELECT public.rental_availability(
           (SELECT min(item_id) FROM rental_items),
           now() + interval '1 day', now() + interval '1 day 1 hour', NULL) AS r
)
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'rental_items count unchanged',
         (SELECT count(*)::text FROM rental_items) || ' now, ' || (SELECT items::text FROM m024_before) || ' before',
         CASE WHEN (SELECT count(*) FROM rental_items) = (SELECT items FROM m024_before) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 2, 'rental_requests count unchanged',
         (SELECT count(*)::text FROM rental_requests) || ' now, ' || (SELECT bookings::text FROM m024_before) || ' before',
         CASE WHEN (SELECT count(*) FROM rental_requests) = (SELECT bookings FROM m024_before) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 3, 'charges count unchanged',
         (SELECT count(*)::text FROM charges) || ' now, ' || (SELECT charges::text FROM m024_before) || ' before',
         CASE WHEN (SELECT count(*) FROM charges) = (SELECT charges FROM m024_before) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 4, 'payments count unchanged',
         (SELECT count(*)::text FROM payments) || ' now, ' || (SELECT payments::text FROM m024_before) || ' before',
         CASE WHEN (SELECT count(*) FROM payments) = (SELECT payments FROM m024_before) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'every item and booking row unchanged (md5)',
         (SELECT bookings_hash FROM m024_before),
         CASE WHEN (SELECT md5(COALESCE(string_agg(to_jsonb(ri)::text, ';' ORDER BY ri.item_id), '')) FROM rental_items ri)
                   = (SELECT items_hash FROM m024_before)
               AND (SELECT md5(COALESCE(string_agg(to_jsonb(rr)::text, ';' ORDER BY rr.request_id), '')) FROM rental_requests rr)
                   = (SELECT bookings_hash FROM m024_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT ord, label || ' exists, SECURITY INVOKER, fixed search_path',
         CASE WHEN oid IS NULL THEN '(missing)'
              ELSE CASE WHEN prosecdef THEN 'SECURITY DEFINER' ELSE 'invoker' END
                   || ', ' || COALESCE(array_to_string(proconfig, ' '), 'no search_path') END,
         CASE WHEN oid IS NOT NULL AND NOT prosecdef
               AND 'search_path=public, pg_temp' = ANY (proconfig)
              THEN 'PASS' ELSE 'FAIL' END
    FROM fn_info
  UNION ALL
  SELECT ord + 5, label || ': EXECUTE for service_role only',
         'service_role ' || has_function_privilege('service_role', sig, 'EXECUTE')
           || ', anon ' || has_function_privilege('anon', sig, 'EXECUTE')
           || ', authenticated ' || has_function_privilege('authenticated', sig, 'EXECUTE')
           || ', PUBLIC ' || (proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)),
         CASE WHEN has_function_privilege('service_role', sig, 'EXECUTE')
               AND NOT has_function_privilege('anon', sig, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', sig, 'EXECUTE')
               AND proacl IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)
              THEN 'PASS' ELSE 'FAIL' END
    FROM fn_info
  UNION ALL
  SELECT 16, 'return time read from rental_requests.returned_at (migration 011, no new column)',
         (SELECT data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'rental_requests' AND column_name = 'returned_at'),
         'PASS'
  UNION ALL
  SELECT 17, 'no column added to rental_requests or rental_items',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name IN ('rental_requests', 'rental_items')) || ' columns',
         CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name IN ('rental_requests', 'rental_items')
                                  AND column_name NOT IN (
                                    'item_id', 'name', 'type', 'description', 'quantity_total', 'quantity_available',
                                    'is_active', 'fee', 'request_id', 'requested_by_user_id', 'quantity_requested',
                                    'start_datetime', 'end_datetime', 'purpose', 'status', 'processed_by_user_id',
                                    'return_note', 'returned_at', 'returned_by_user_id', 'resident_id',
                                    'outside_borrower_name', 'outside_borrower_contact', 'cancellation_reason'))
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 18, 'availability output carries only the R5 keys',
         COALESCE((SELECT string_agg(k, ', ' ORDER BY k) FROM smoke, jsonb_object_keys(smoke.r) AS k), '(no items)'),
         CASE WHEN (SELECT min(item_id) FROM rental_items) IS NULL THEN 'PASS (no items to ask about)'
              WHEN NOT EXISTS (SELECT 1 FROM smoke, jsonb_object_keys(smoke.r) AS k
                                WHERE k NOT IN ('ok', 'item_type', 'total', 'used', 'booked', 'stuck', 'resting', 'left', 'taken'))
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 19, 'smoke: rental_availability for item #' || COALESCE((SELECT min(item_id)::text FROM rental_items), '-') || ', tomorrow',
         COALESCE((SELECT r::text FROM smoke), '(no items)'),
         'INFO'
  UNION ALL
  SELECT 20, 'STUCK bookings on file (past their end, never marked returned)',
         (SELECT count(*)::text FROM stuck) || ' booking(s), '
           || (SELECT COALESCE(sum(quantity_requested), 0)::text FROM stuck) || ' unit(s)'
           || COALESCE(': request_id ' || (SELECT string_agg(request_id || ' (item ' || item_id || ', ' || quantity_requested || ')', ', ' ORDER BY request_id) FROM stuck), ''),
         'INFO'
  UNION ALL
  SELECT 21, 'future confirmed bookings already over the new limit (left as they are)',
         (SELECT count(*)::text FROM over_limit)
           || COALESCE(': request_id ' || (SELECT string_agg(request_id::text, ', ' ORDER BY request_id) FROM over_limit), ''),
         'INFO'
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

COMMIT;
