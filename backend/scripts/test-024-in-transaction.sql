-- ===========================================================================
-- Test migration 024's rules (R1 to R5) inside ONE transaction that ALWAYS
-- ends in ROLLBACK. Nothing persists: the throwaway items and bookings it
-- creates exist only inside this transaction. Run it after
-- apply-024-commit.sql (it stops at once if the functions are missing).
--
-- The one trace it leaves: identity counters are not transactional, so the
-- next real rental_items and rental_requests ids skip the numbers used here
-- (about 10 items and 35 bookings). Harmless; ids were never contiguous.
--
-- now() is fixed for the whole transaction, so every "23h59m after the
-- return" below is exact. Throwaway borrower: a guest, 'TEST C1 Guest',
-- filed by the lowest user_id on file (read only, never changed).
--
-- Expected result set: row 0 'ALL CHECKS' PASS, then rows 1 to 58, each
-- PASS. Any FAIL row names the rule that broke.
-- ===========================================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('public.rental_availability(bigint,timestamptz,timestamptz,bigint)') IS NULL
     OR to_regprocedure('public.rental_holds(bigint,timestamptz,timestamptz,bigint)') IS NULL
     OR to_regprocedure('public.rental_slot_refusal(bigint,integer,timestamptz,timestamptz,bigint)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: migration 024 is not applied — run apply-024-commit.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'ABORT: no user on file to file the test bookings';
  END IF;
END $$;

CREATE TEMP TABLE t024 (ord int, check_name text, detail text, verdict text) ON COMMIT DROP;

-- Test helpers, in this session's temporary schema; gone with the ROLLBACK.
CREATE FUNCTION pg_temp.ok(p_name text, p_pass boolean, p_detail text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t024
  SELECT COALESCE(max(ord), 0) + 1, p_name, p_detail,
         CASE WHEN p_pass THEN 'PASS' ELSE 'FAIL' END
    FROM t024;
$$;

CREATE FUNCTION pg_temp.item(p_name text, p_type text, p_total int, p_available int, p_active boolean)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO rental_items (name, type, description, quantity_total, quantity_available, is_active, fee)
  VALUES (p_name, p_type, 'Throwaway item for test-024-in-transaction.sql', p_total, p_available, p_active, 0)
  RETURNING item_id;
$$;

-- A booking written straight into the table, for states the functions never
-- create themselves (past, stuck, returned, cancelled).
CREATE FUNCTION pg_temp.held(p_item bigint, p_qty int, p_start timestamptz, p_end timestamptz,
                             p_status text, p_returned_at timestamptz)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO rental_requests (item_id, requested_by_user_id, resident_id, outside_borrower_name,
                               outside_borrower_contact, quantity_requested, start_datetime, end_datetime,
                               purpose, status, processed_by_user_id, returned_at)
  VALUES (p_item, (SELECT min(user_id) FROM users), NULL, 'TEST C1 Guest', '09170000024',
          p_qty, p_start, p_end, 'C1-SECRET-PURPOSE', p_status, NULL, p_returned_at)
  RETURNING request_id;
$$;

CREATE FUNCTION pg_temp.book(p_item bigint, p_qty int, p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.create_rental_booking(p_item, (SELECT min(user_id) FROM users), NULL,
                                      'TEST C1 Guest', '09170000024', p_qty, p_start, p_end,
                                      'C1-SECRET-PURPOSE');
$$;

-- The refusal without the row it might carry, for the detail column.
CREATE FUNCTION pg_temp.brief(r jsonb)
RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN r ->> 'ok' = 'true'
              THEN 'ok, request ' || COALESCE(r -> 'request' ->> 'request_id', '?')
              ELSE (r - 'request')::text END;
$$;

CREATE FUNCTION pg_temp.bookings_on(p_item bigint)
RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM rental_requests WHERE item_id = p_item;
$$;

DO $$
DECLARE
  -- A Manila midnight ten days ahead (00:00+08:00).
  d0   timestamptz := (((now() AT TIME ZONE 'Asia/Manila')::date + 10)::timestamp) AT TIME ZONE 'Asia/Manila';
  d1   timestamptz;
  hr   interval := interval '1 hour';
  mn   interval := interval '1 minute';
  u    bigint := (SELECT min(user_id) FROM users);
  f    bigint;  c bigint;  a bigint;  i bigint;  s bigint;
  e    bigint;  z bigint;  g bigint;  x bigint;
  b1   bigint;  b2 bigint; b_stuck bigint;
  r    jsonb;
  taken_r jsonb;
  allowed text[] := ARRAY['ok', 'item_type', 'total', 'used', 'booked', 'stuck', 'resting', 'left', 'taken'];
BEGIN
  d1 := d0 + interval '1 day';

  -- -------------------------------------------------------------------------
  -- Facility: [start, end), touching is free, no gap, capacity 1.
  -- -------------------------------------------------------------------------
  f := pg_temp.item('TEST C1 Hall', 'facility', 1, 1, true);

  r := pg_temp.book(f, 1, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('facility: 08:00-10:00 booked, stored confirmed',
    r ->> 'ok' = 'true' AND r -> 'request' ->> 'status' = 'confirmed', pg_temp.brief(r));
  b1 := (r -> 'request' ->> 'request_id')::bigint;
  PERFORM pg_temp.ok('the new row carries the columns POST inserts',
    (r -> 'request' ->> 'requested_by_user_id')::bigint = u
      AND r -> 'request' -> 'processed_by_user_id' = 'null'::jsonb
      AND r -> 'request' -> 'resident_id' = 'null'::jsonb
      AND r -> 'request' ->> 'outside_borrower_name' = 'TEST C1 Guest'
      AND r -> 'request' ->> 'outside_borrower_contact' = '09170000024'
      AND (r -> 'request' ->> 'quantity_requested')::int = 1
      AND (r -> 'request' ->> 'start_datetime')::timestamptz = d0 + 8*hr
      AND (r -> 'request' ->> 'end_datetime')::timestamptz = d0 + 10*hr
      AND r -> 'request' ->> 'purpose' = 'C1-SECRET-PURPOSE',
    'requested_by ' || (r -> 'request' ->> 'requested_by_user_id'));

  r := pg_temp.book(f, 1, d0 + 9*hr, d0 + 11*hr);
  PERFORM pg_temp.ok('facility: 09:00-11:00 clashes -> FACILITY_TAKEN',
    r ->> 'code' = 'FACILITY_TAKEN', pg_temp.brief(r));
  PERFORM pg_temp.ok('FACILITY_TAKEN names the clashing range, times only',
    jsonb_array_length(r -> 'clashes') = 1
      AND (r -> 'clashes' -> 0 ->> 'start')::timestamptz = d0 + 8*hr
      AND (r -> 'clashes' -> 0 ->> 'end')::timestamptz = d0 + 10*hr
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r -> 'clashes' -> 0) AS k) = ARRAY['end', 'start'],
    (r -> 'clashes')::text);
  PERFORM pg_temp.ok('a refusal inserts nothing', pg_temp.bookings_on(f) = 1, pg_temp.bookings_on(f) || ' booking(s)');

  r := pg_temp.book(f, 1, d0 + 10*hr, d0 + 12*hr);
  PERFORM pg_temp.ok('facility: 10:00-12:00 touches at 10:00 -> not a clash', r ->> 'ok' = 'true', pg_temp.brief(r));
  b2 := (r -> 'request' ->> 'request_id')::bigint;

  r := pg_temp.book(f, 1, d0 + 12*hr, d0 + 13*hr);
  PERFORM pg_temp.ok('facility has no 24-hour gap: 12:00 right after a 12:00 end', r ->> 'ok' = 'true', pg_temp.brief(r));

  r := pg_temp.book(f, 1, d0 + 7*hr, d0 + 8*hr);
  PERFORM pg_temp.ok('facility: 07:00-08:00 touches at 08:00 -> not a clash', r ->> 'ok' = 'true', pg_temp.brief(r));

  r := pg_temp.book(f, 2, d1 + 8*hr, d1 + 10*hr);
  PERFORM pg_temp.ok('facility quantity 2 -> QUANTITY_INVALID / FACILITY_WHOLE',
    r ->> 'code' = 'QUANTITY_INVALID' AND r ->> 'reason' = 'FACILITY_WHOLE', pg_temp.brief(r));

  PERFORM pg_temp.held(f, 1, now() - interval '3 days', now() - interval '3 days' + 2*hr, 'confirmed', NULL);
  r := public.rental_availability(f, d1 + 8*hr, d1 + 9*hr, NULL);
  PERFORM pg_temp.ok('a facility past its end is never stuck',
    (r ->> 'stuck')::int = 0 AND (r ->> 'left')::int = 1, r::text);

  -- -------------------------------------------------------------------------
  -- Edit: exclude_booking_id lets a booking ignore itself, and only itself.
  -- -------------------------------------------------------------------------
  r := public.update_rental_booking_time(b1, d0 + 8*hr + 30*mn, d0 + 10*hr, 'C1-SECRET-PURPOSE edited');
  PERFORM pg_temp.ok('edit 08:00-10:00 -> 08:30-10:00: overlaps only itself, accepted',
    r ->> 'ok' = 'true'
      AND (r -> 'request' ->> 'start_datetime')::timestamptz = d0 + 8*hr + 30*mn
      AND r -> 'request' ->> 'purpose' = 'C1-SECRET-PURPOSE edited',
    pg_temp.brief(r));
  PERFORM pg_temp.ok('edit returns the values before the change',
    (r -> 'before' ->> 'start_datetime')::timestamptz = d0 + 8*hr
      AND (r -> 'before' ->> 'end_datetime')::timestamptz = d0 + 10*hr
      AND r -> 'before' ->> 'purpose' = 'C1-SECRET-PURPOSE',
    (r -> 'before')::text);

  r := public.update_rental_booking_time(b1, d0 + 9*hr, d0 + 11*hr, 'C1-SECRET-PURPOSE edited');
  PERFORM pg_temp.ok('edit into the 10:00-12:00 booking -> FACILITY_TAKEN', r ->> 'code' = 'FACILITY_TAKEN', pg_temp.brief(r));
  PERFORM pg_temp.ok('a refused edit changes nothing',
    (SELECT start_datetime = d0 + 8*hr + 30*mn AND end_datetime = d0 + 10*hr FROM rental_requests WHERE request_id = b1),
    (SELECT start_datetime::text || ' - ' || end_datetime::text FROM rental_requests WHERE request_id = b1));

  r := public.update_rental_booking_time(-1, d0 + 9*hr, d0 + 11*hr, 'x');
  PERFORM pg_temp.ok('edit of a missing booking -> BOOKING_NOT_FOUND', r ->> 'code' = 'BOOKING_NOT_FOUND', pg_temp.brief(r));

  r := public.update_rental_booking_time(b1, d0 + 10*hr, d0 + 9*hr, 'x');
  PERFORM pg_temp.ok('edit with end before start -> TIME_INVALID', r ->> 'code' = 'TIME_INVALID', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- 50 chairs: plain window sum, and the gap of a booking not yet ended.
  -- -------------------------------------------------------------------------
  c := pg_temp.item('TEST C1 Chairs', 'furniture', 50, 50, true);
  r := pg_temp.book(c, 30, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('chairs: 30 at 08:00-10:00', r ->> 'ok' = 'true', pg_temp.brief(r));
  r := pg_temp.book(c, 20, d0 + 14*hr, d0 + 16*hr);
  PERFORM pg_temp.ok('chairs: 20 at 14:00-16:00 (30 + 20 = 50)', r ->> 'ok' = 'true', pg_temp.brief(r));
  r := pg_temp.book(c, 1, d0 + 18*hr, d0 + 20*hr);
  PERFORM pg_temp.ok('chairs: 1 more at 18:00 -> NOT_ENOUGH_LEFT, used 50, left 0',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'used')::int = 50 AND (r ->> 'left')::int = 0
      AND (r ->> 'quantity_available')::int = 50 AND (r ->> 'requested')::int = 1,
    pg_temp.brief(r));

  r := public.rental_availability(c, d1 + 15*hr, d1 + 16*hr, NULL);
  PERFORM pg_temp.ok('next day 15:00: only the 20 still resting (their gap ends 16:00)',
    (r ->> 'used')::int = 20 AND (r ->> 'resting')::int = 20 AND (r ->> 'booked')::int = 0
      AND (r ->> 'stuck')::int = 0 AND (r ->> 'left')::int = 30,
    r::text);
  r := public.rental_availability(c, d1 + 16*hr, d1 + 17*hr, NULL);
  PERFORM pg_temp.ok('next day 16:00: the gap is exactly 24 hours, all 50 free',
    (r ->> 'used')::int = 0 AND (r ->> 'left')::int = 50, r::text);
  r := public.rental_availability(c, d0 - 16*hr, d0 - 15*hr, NULL);
  PERFORM pg_temp.ok('the requested side carries its own gap: 08:00 the day before reaches the 08:00 booking, not the 14:00 one',
    (r ->> 'used')::int = 30 AND (r ->> 'booked')::int = 30 AND (r ->> 'resting')::int = 0, r::text);

  r := pg_temp.book(c, 0, d1 + 8*hr, d1 + 10*hr);
  PERFORM pg_temp.ok('quantity 0 -> QUANTITY_INVALID / BELOW_ONE',
    r ->> 'code' = 'QUANTITY_INVALID' AND r ->> 'reason' = 'BELOW_ONE', pg_temp.brief(r));
  r := pg_temp.book(c, 1, now() - hr, now() + hr);
  PERFORM pg_temp.ok('a start in the past -> TIME_INVALID / START_NOT_IN_FUTURE',
    r ->> 'code' = 'TIME_INVALID' AND r ->> 'reason' = 'START_NOT_IN_FUTURE', pg_temp.brief(r));
  r := pg_temp.book(c, 1, d1 + 10*hr, d1 + 10*hr);
  PERFORM pg_temp.ok('end equal to start -> TIME_INVALID / END_NOT_AFTER_START',
    r ->> 'code' = 'TIME_INVALID' AND r ->> 'reason' = 'END_NOT_AFTER_START', pg_temp.brief(r));
  r := pg_temp.book(-1, 1, d1 + 8*hr, d1 + 10*hr);
  PERFORM pg_temp.ok('a missing item -> ITEM_NOT_FOUND', r ->> 'code' = 'ITEM_NOT_FOUND', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- quantity_available is the limit, never quantity_total.
  -- -------------------------------------------------------------------------
  a := pg_temp.item('TEST C1 Tents', 'equipment', 50, 40, true);
  r := pg_temp.book(a, 41, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('41 of total 50 / available 40 -> QUANTITY_INVALID / MORE_THAN_EXIST (40)',
    r ->> 'code' = 'QUANTITY_INVALID' AND r ->> 'reason' = 'MORE_THAN_EXIST'
      AND (r ->> 'quantity_available')::int = 40, pg_temp.brief(r));
  r := pg_temp.book(a, 35, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('35 of available 40', r ->> 'ok' = 'true', pg_temp.brief(r));
  r := pg_temp.book(a, 6, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('6 more -> NOT_ENOUGH_LEFT against 40, though 41 <= total 50',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'quantity_available')::int = 40 AND (r ->> 'left')::int = 5,
    pg_temp.brief(r));
  r := pg_temp.book(a, 5, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('exactly the 5 left -> accepted', r ->> 'ok' = 'true', pg_temp.brief(r));
  r := public.rental_availability(a, d0 + 8*hr, d0 + 10*hr, NULL);
  PERFORM pg_temp.ok('availability total is quantity_available (40), left 0',
    (r ->> 'total')::int = 40 AND (r ->> 'left')::int = 0 AND (r ->> 'used')::int = 40, r::text);

  -- -------------------------------------------------------------------------
  -- Inactive items.
  -- -------------------------------------------------------------------------
  i := pg_temp.item('TEST C1 Inactive', 'furniture', 10, 10, false);
  r := pg_temp.book(i, 1, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('an inactive item -> ITEM_INACTIVE, nothing inserted',
    r ->> 'code' = 'ITEM_INACTIVE' AND pg_temp.bookings_on(i) = 0, pg_temp.brief(r));
  UPDATE rental_items SET is_active = true WHERE item_id = i;
  r := pg_temp.book(i, 1, d0 + 8*hr, d0 + 10*hr);
  b1 := (r -> 'request' ->> 'request_id')::bigint;
  UPDATE rental_items SET is_active = false WHERE item_id = i;
  r := public.update_rental_booking_time(b1, d0 + 9*hr, d0 + 11*hr, 'C1-SECRET-PURPOSE');
  PERFORM pg_temp.ok('an existing booking on a deactivated item can still be edited', r ->> 'ok' = 'true', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- Stuck: past its end, never returned -> holds its units with no end.
  -- -------------------------------------------------------------------------
  s := pg_temp.item('TEST C1 Speakers', 'equipment', 10, 10, true);
  b_stuck := pg_temp.held(s, 10, now() - interval '3 days', now() - interval '2 days', 'confirmed', NULL);
  r := pg_temp.book(s, 1, now() + interval '30 days', now() + interval '30 days' + hr);
  PERFORM pg_temp.ok('stuck: 10 overdue speakers block a slot 30 days later',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'stuck')::int = 10 AND (r ->> 'left')::int = 0, pg_temp.brief(r));
  r := public.rental_availability(s, now() + interval '365 days', now() + interval '365 days' + hr, NULL);
  PERFORM pg_temp.ok('stuck: no automatic release, still held a year later',
    (r ->> 'stuck')::int = 10 AND (r ->> 'booked')::int = 0 AND (r ->> 'left')::int = 0, r::text);
  r := public.update_rental_booking_time(b_stuck, now() + interval '5 days', now() + interval '5 days' + hr, 'x');
  PERFORM pg_temp.ok('a stuck booking cannot be edited -> BOOKING_STARTED',
    r ->> 'code' = 'BOOKING_STARTED' AND r ->> 'status' = 'confirmed', pg_temp.brief(r));

  -- Marked returned an hour ago, a day after its end: max(end, returned_at)
  -- is returned_at, so the units rest until returned_at + 24 hours.
  UPDATE rental_requests SET status = 'returned_late', returned_at = now() - hr WHERE request_id = b_stuck;
  r := pg_temp.book(s, 1, now() - hr + 23*hr + 59*mn, now() - hr + 24*hr + 59*mn);
  PERFORM pg_temp.ok('returned late: 23h59m after the return -> still resting, refused',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'resting')::int = 10 AND (r ->> 'stuck')::int = 0, pg_temp.brief(r));
  r := pg_temp.book(s, 10, now() - hr + 24*hr + 1*mn, now() - hr + 25*hr);
  PERFORM pg_temp.ok('returned late: 24h01m after the return -> all 10 free', r ->> 'ok' = 'true', pg_temp.brief(r));
  r := public.rental_availability(s, now() + interval '365 days', now() + interval '365 days' + hr, NULL);
  PERFORM pg_temp.ok('after the return the year-later slot is free again',
    (r ->> 'stuck')::int = 0 AND (r ->> 'left')::int = 10, r::text);

  -- Returned EARLY: max(end, returned_at) is the booked end.
  e := pg_temp.item('TEST C1 Projector', 'equipment', 5, 5, true);
  PERFORM pg_temp.held(e, 5, now() - hr, now() + interval '24 hours', 'returned', now());
  r := pg_temp.book(e, 1, now() + interval '48 hours' - mn, now() + interval '49 hours');
  PERFORM pg_temp.ok('returned early: 23h59m after the BOOKED end -> refused (resting 5)',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'resting')::int = 5, pg_temp.brief(r));
  r := pg_temp.book(e, 5, now() + interval '48 hours' + mn, now() + interval '49 hours');
  PERFORM pg_temp.ok('returned early: 24h01m after the booked end -> free', r ->> 'ok' = 'true', pg_temp.brief(r));

  -- Returned with returned_at NULL: treated as returned at the booked end.
  z := pg_temp.item('TEST C1 Fans', 'equipment', 5, 5, true);
  PERFORM pg_temp.held(z, 5, now() - hr, now() + hr, 'returned_with_issue', NULL);
  r := pg_temp.book(z, 1, now() + 25*hr - mn, now() + 26*hr);
  PERFORM pg_temp.ok('returned_at NULL: 23h59m after the booked end -> refused',
    r ->> 'code' = 'NOT_ENOUGH_LEFT', pg_temp.brief(r));
  r := pg_temp.book(z, 5, now() + 25*hr + mn, now() + 26*hr);
  PERFORM pg_temp.ok('returned_at NULL: 24h01m after the booked end -> free', r ->> 'ok' = 'true', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- The gap rests only the returned quantity.
  -- -------------------------------------------------------------------------
  g := pg_temp.item('TEST C1 Tables', 'furniture', 50, 50, true);
  PERFORM pg_temp.held(g, 30, now() - interval '1 day', now() - 2*hr, 'returned', now() - hr);
  r := pg_temp.book(g, 25, now() + 12*hr, now() + 13*hr);
  PERFORM pg_temp.ok('30 returned an hour ago rest; 25 more -> refused, left 20',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'used')::int = 30 AND (r ->> 'resting')::int = 30
      AND (r ->> 'left')::int = 20, pg_temp.brief(r));
  r := pg_temp.book(g, 20, now() + 12*hr, now() + 13*hr);
  PERFORM pg_temp.ok('the other 20 are free during the rest', r ->> 'ok' = 'true', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- Cancelled holds nothing.
  -- -------------------------------------------------------------------------
  x := pg_temp.item('TEST C1 Cancelled', 'furniture', 50, 50, true);
  PERFORM pg_temp.held(x, 50, d0 + 8*hr, d0 + 10*hr, 'cancelled', NULL);
  r := pg_temp.book(x, 50, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('a cancelled booking of all 50 holds nothing', r ->> 'ok' = 'true', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- R5: what availability says, and what it never says.
  -- -------------------------------------------------------------------------
  r := pg_temp.book(f, 1, d0 + 23*hr, d1);
  PERFORM pg_temp.ok('facility: 23:00 to midnight booked', r ->> 'ok' = 'true', pg_temp.brief(r));
  taken_r := public.rental_availability(f, d0 + 13*hr, d0 + 14*hr, NULL);
  PERFORM pg_temp.ok('facility availability: free at 13:00, taken lists the day''s 5 bookings',
    (taken_r ->> 'left')::int = 1 AND jsonb_array_length(taken_r -> 'taken') = 5
      AND (taken_r -> 'taken' -> 0 ->> 'start')::timestamptz = d0 + 7*hr,
    taken_r::text);
  PERFORM pg_temp.ok('facility availability: only the R5 keys',
    NOT EXISTS (SELECT 1 FROM jsonb_object_keys(taken_r) AS k WHERE k <> ALL (allowed))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(taken_r -> 'taken') AS t, jsonb_object_keys(t) AS k
                       WHERE k NOT IN ('start', 'end')),
    (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(taken_r) AS k));
  r := public.rental_availability(f, d0 + 8*hr, d0 + 9*hr, b2);
  PERFORM pg_temp.ok('availability with exclude leaves that booking out of taken',
    jsonb_array_length(r -> 'taken') = 4, (r -> 'taken')::text);
  r := public.rental_availability(f, d1 + 8*hr, d1 + 9*hr, NULL);
  PERFORM pg_temp.ok('the Manila day ends at 00:00+08:00: the next day does not list the booking ending at midnight',
    jsonb_array_length(r -> 'taken') = 0, (r -> 'taken')::text);

  r := public.rental_availability(c, d0 + 8*hr, d0 + 9*hr, NULL);
  PERFORM pg_temp.ok('returnable availability: R5 keys, and no taken list',
    NOT EXISTS (SELECT 1 FROM jsonb_object_keys(r) AS k WHERE k <> ALL (allowed))
      AND NOT (r ? 'taken'),
    (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(r) AS k));
  PERFORM pg_temp.ok('no name, contact, purpose, account or booking id in any availability answer',
    position('C1-SECRET' IN taken_r::text || r::text) = 0
      AND position('TEST C1 Guest' IN taken_r::text || r::text) = 0
      AND position('0917' IN taken_r::text || r::text) = 0
      AND position('request_id' IN taken_r::text || r::text) = 0
      AND position('user' IN taken_r::text || r::text) = 0
      AND position('resident' IN taken_r::text || r::text) = 0,
    'searched both answers');
  r := pg_temp.book(f, 1, d0 + 9*hr, d0 + 9*hr + 30*mn);
  PERFORM pg_temp.ok('no name, contact, purpose or id in a FACILITY_TAKEN refusal',
    r ->> 'code' = 'FACILITY_TAKEN'
      AND position('C1-SECRET' IN r::text) = 0 AND position('TEST C1 Guest' IN r::text) = 0
      AND position('0917' IN r::text) = 0 AND position('request_id' IN r::text) = 0,
    pg_temp.brief(r));
  r := public.rental_availability(f, d0 + 9*hr, d0 + 8*hr, NULL);
  PERFORM pg_temp.ok('availability with end before start -> TIME_INVALID', r ->> 'code' = 'TIME_INVALID', r::text);
  r := public.rental_availability(-1, d0 + 8*hr, d0 + 9*hr, NULL);
  PERFORM pg_temp.ok('availability of a missing item -> ITEM_NOT_FOUND', r ->> 'code' = 'ITEM_NOT_FOUND', r::text);

  -- -------------------------------------------------------------------------
  -- R2: the page and the writers can never disagree — for every request
  -- above, availability's "left" and the refusal agree.
  -- -------------------------------------------------------------------------
  PERFORM pg_temp.ok('availability left = capacity - holds.used for the chairs window',
    (public.rental_availability(c, d0 + 18*hr, d0 + 20*hr, NULL) ->> 'left')::int
      = (SELECT GREATEST(0, capacity - used_units) FROM public.rental_holds(c, d0 + 18*hr, d0 + 20*hr, NULL)),
    'chairs 18:00-20:00');
  PERFORM pg_temp.ok('slot_refusal refuses exactly when requested > availability left',
    public.rental_slot_refusal(g, 21, now() + 12*hr, now() + 13*hr, NULL) ->> 'code' = 'NOT_ENOUGH_LEFT'
      AND (public.rental_availability(g, now() + 12*hr, now() + 13*hr, NULL) ->> 'left')::int = 0
      AND public.rental_slot_refusal(x, 1, d1 + 11*hr, d1 + 12*hr, NULL) IS NULL
      AND (public.rental_availability(x, d1 + 11*hr, d1 + 12*hr, NULL) ->> 'left')::int = 50,
    'tables (full) and cancelled-test item (free)');
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 0,
         'ALL CHECKS',
         (SELECT count(*) FILTER (WHERE verdict = 'PASS')::text FROM t024) || ' of '
           || (SELECT count(*)::text FROM t024) || ' passed',
         CASE WHEN (SELECT count(*) FROM t024) > 0
               AND NOT EXISTS (SELECT 1 FROM t024 WHERE verdict <> 'PASS')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT ord, check_name, detail, verdict FROM t024
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
