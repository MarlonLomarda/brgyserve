-- ===========================================================================
-- Test migration 027 (rental approval) inside ONE transaction that ALWAYS
-- ends in ROLLBACK. Nothing persists: the throwaway items, resident record,
-- bookings and charges it creates exist only inside this transaction. Run it
-- after migration 027 is committed (it stops at once if the functions are
-- missing).
--
-- The one trace it leaves: identity counters are not transactional, so the
-- next real rental_items, resident_records, rental_requests and charges ids
-- skip the numbers used here. Harmless; ids were never contiguous.
--
-- now() is fixed for the whole transaction. Throwaway borrowers: a guest,
-- 'TEST 027 Guest', and a throwaway resident record 'TEST 027 Resident',
-- every booking filed by the lowest user_id on file (read only, never
-- changed).
--
-- Expected result set: row 0 'ALL CHECKS' PASS, then rows 1 to 63, each
-- PASS. Any FAIL row names the rule that broke.
-- ===========================================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.place_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text,text,text)') IS NULL
     OR to_regprocedure('public.approve_rental_booking(bigint,bigint,numeric,bigint,boolean)') IS NULL
     OR to_regprocedure('public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)') IS NULL
     OR to_regprocedure('public.rental_availability(bigint,timestamptz,timestamptz,bigint)') IS NULL
     OR to_regprocedure('public.rental_holds(bigint,timestamptz,timestamptz,bigint)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: migration 027 (or 024) is not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'ABORT: no user on file to file the test bookings';
  END IF;
END $$;

CREATE TEMP TABLE t027 (ord int, check_name text, detail text, verdict text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.ok(p_name text, p_pass boolean, p_detail text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t027
  SELECT COALESCE(max(ord), 0) + 1, p_name, p_detail,
         CASE WHEN COALESCE(p_pass, false) THEN 'PASS' ELSE 'FAIL' END
    FROM t027;
$$;

CREATE FUNCTION pg_temp.item(p_name text, p_type text, p_total int, p_available int, p_active boolean, p_fee numeric)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO rental_items (name, type, description, quantity_total, quantity_available, is_active, fee)
  VALUES (p_name, p_type, 'Throwaway item for test-027-in-transaction.sql', p_total, p_available, p_active, p_fee)
  RETURNING item_id;
$$;

-- A guest's booking through the new insert function.
CREATE FUNCTION pg_temp.place(p_item bigint, p_qty int, p_start timestamptz, p_end timestamptz,
                              p_status text, p_type text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.place_rental_booking(p_item, (SELECT min(user_id) FROM users), NULL,
                                     'TEST 027 Guest', '09170000027', p_qty, p_start, p_end,
                                     'R2A-SECRET-PURPOSE', p_type, p_status);
$$;

-- A resident's booking through the new insert function.
CREATE FUNCTION pg_temp.place_for(p_item bigint, p_resident bigint, p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.place_rental_booking(p_item, (SELECT min(user_id) FROM users), p_resident,
                                     NULL, NULL, 1, p_start, p_end, 'R2A-SECRET-PURPOSE', 'general', 'pending');
$$;

-- A booking written straight into the table, for states the functions never
-- create (a pending request whose start has passed, a declined one).
CREATE FUNCTION pg_temp.held(p_item bigint, p_qty int, p_start timestamptz, p_end timestamptz, p_status text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO rental_requests (item_id, requested_by_user_id, resident_id, outside_borrower_name,
                               outside_borrower_contact, quantity_requested, start_datetime, end_datetime,
                               purpose, status, processed_by_user_id)
  VALUES (p_item, (SELECT min(user_id) FROM users), NULL, 'TEST 027 Guest', '09170000027',
          p_qty, p_start, p_end, 'R2A-SECRET-PURPOSE', p_status, NULL)
  RETURNING request_id;
$$;

CREATE FUNCTION pg_temp.approve(p_request bigint, p_amount numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.approve_rental_booking(p_request, (SELECT min(user_id) FROM users), p_amount, NULL, false);
$$;

-- The Secretary's funeral waiver (design C): amount 0, the flag set.
CREATE FUNCTION pg_temp.waive(p_request bigint)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.approve_rental_booking(p_request, (SELECT min(user_id) FROM users), 0, NULL, true);
$$;

-- A resident's booking stored as a funeral, as the Secretary's walk-in will
-- (a later batch).
CREATE FUNCTION pg_temp.place_funeral_for(p_item bigint, p_resident bigint, p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.place_rental_booking(p_item, (SELECT min(user_id) FROM users), p_resident,
                                     NULL, NULL, 1, p_start, p_end, 'R2A-SECRET-PURPOSE', 'funeral', 'confirmed');
$$;

CREATE FUNCTION pg_temp.brief(r jsonb)
RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN r ->> 'ok' = 'true'
              THEN 'ok, request ' || COALESCE(r -> 'request' ->> 'request_id', '?')
                   || ' ' || COALESCE(r -> 'request' ->> 'status', '?')
                   || COALESCE(', charge ' || (r -> 'charge')::text, '')
              ELSE (r - 'request')::text END;
$$;

CREATE FUNCTION pg_temp.id_of(r jsonb)
RETURNS bigint LANGUAGE sql AS $$ SELECT (r -> 'request' ->> 'request_id')::bigint; $$;

CREATE FUNCTION pg_temp.status_of(p_request bigint)
RETURNS text LANGUAGE sql AS $$ SELECT status FROM rental_requests WHERE request_id = p_request; $$;

CREATE FUNCTION pg_temp.charges_of(p_request bigint)
RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM charges WHERE rental_request_id = p_request; $$;

CREATE FUNCTION pg_temp.type_of(p_request bigint)
RETURNS text LANGUAGE sql AS $$ SELECT purpose_type FROM rental_requests WHERE request_id = p_request; $$;

DO $$
DECLARE
  -- A Manila midnight ten days ahead (00:00+08:00).
  d0   timestamptz := (((now() AT TIME ZONE 'Asia/Manila')::date + 10)::timestamp) AT TIME ZONE 'Asia/Manila';
  d1   timestamptz;
  hr   interval := interval '1 hour';
  u    bigint := (SELECT min(user_id) FROM users);
  h    bigint;  c bigint;  t bigint;  k bigint;  m bigint;
  res  bigint;  res2 bigint;
  p1   bigint;  p2 bigint;  q1 bigint; q2 bigint; x bigint;
  r    jsonb;   r2 jsonb;
  n    bigint;
  st   text;
BEGIN
  d1 := d0 + interval '1 day';

  h := pg_temp.item('TEST 027 Hall', 'facility', 1, 1, true, 500);
  c := pg_temp.item('TEST 027 Chairs', 'furniture', 50, 50, true, 5);
  t := pg_temp.item('TEST 027 Tent', 'equipment', 5, 5, true, 300);
  k := pg_temp.item('TEST 027 Costume', 'equipment', 10, 10, true, 150);
  m := pg_temp.item('TEST 027 Court', 'facility', 1, 1, true, 0);

  -- -------------------------------------------------------------------------
  -- place_rental_booking: what it writes.
  -- -------------------------------------------------------------------------
  r := pg_temp.place(h, 1, d0 + 8*hr, d0 + 10*hr, 'pending', 'general');
  p1 := pg_temp.id_of(r);
  PERFORM pg_temp.ok('place pending: stored pending, general, filed by the user, nobody processed it',
    r ->> 'ok' = 'true' AND pg_temp.status_of(p1) = 'pending'
      AND (SELECT purpose_type = 'general' AND processed_by_user_id IS NULL AND requested_by_user_id = u
             FROM rental_requests WHERE request_id = p1), pg_temp.brief(r));
  PERFORM pg_temp.ok('place sets requested_at to now()',
    (SELECT requested_at = now() FROM rental_requests WHERE request_id = p1),
    (SELECT requested_at::text FROM rental_requests WHERE request_id = p1));
  PERFORM pg_temp.ok('a pending request has no charge', pg_temp.charges_of(p1) = 0, pg_temp.charges_of(p1)::text);

  -- -------------------------------------------------------------------------
  -- A pending request holds NOTHING.
  -- -------------------------------------------------------------------------
  r := pg_temp.place(h, 1, d0 + 8*hr, d0 + 10*hr, 'pending', 'general');
  p2 := pg_temp.id_of(r);
  PERFORM pg_temp.ok('a second pending request for the same free facility slot is accepted',
    r ->> 'ok' = 'true' AND pg_temp.status_of(p2) = 'pending', pg_temp.brief(r));
  r := public.rental_availability(h, d0 + 8*hr, d0 + 10*hr, NULL);
  PERFORM pg_temp.ok('with two pending, the slot reads free: used 0, left 1, nothing taken',
    (r ->> 'used')::int = 0 AND (r ->> 'left')::int = 1 AND r -> 'taken' = '[]'::jsonb, r::text);
  PERFORM pg_temp.ok('rental_holds counts no pending request',
    (SELECT used_units FROM public.rental_holds(h, d0, d1, NULL)) = 0,
    (SELECT used_units::text FROM public.rental_holds(h, d0, d1, NULL)));
  x := pg_temp.held(h, 1, d0 + 14*hr, d0 + 16*hr, 'declined');
  r := pg_temp.place(h, 1, d0 + 14*hr, d0 + 16*hr, 'confirmed', 'general');
  PERFORM pg_temp.ok('a declined booking holds nothing: the same slot can be booked',
    r ->> 'ok' = 'true', pg_temp.brief(r));
  r := pg_temp.place(h, 1, d0 + 15*hr, d0 + 16*hr, 'pending', 'general');
  PERFORM pg_temp.ok('a request overlapping a CONFIRMED booking is refused at once (FACILITY_TAKEN), nothing inserted',
    r ->> 'code' = 'FACILITY_TAKEN'
      AND (SELECT count(*) FROM rental_requests WHERE item_id = h AND start_datetime = d0 + 15*hr) = 0, pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- approve_rental_booking: the slot and the charge, in one step.
  -- -------------------------------------------------------------------------
  r := public.approve_rental_booking(p1, u, 500, NULL, false);
  PERFORM pg_temp.ok('approve: confirmed, processed_by the approver',
    r ->> 'ok' = 'true' AND pg_temp.status_of(p1) = 'confirmed'
      AND (SELECT processed_by_user_id FROM rental_requests WHERE request_id = p1) = u, pg_temp.brief(r));
  PERFORM pg_temp.ok('approve: one RENTAL charge, PHP 500, UNPAID, created now, on the account given (none)',
    pg_temp.charges_of(p1) = 1
      AND (SELECT charge_type = 'RENTAL' AND amount = 500 AND status = 'UNPAID' AND user_id IS NULL AND created_at = now()
             FROM charges WHERE rental_request_id = p1)
      AND (r -> 'charge' ->> 'status') = 'UNPAID' AND (r -> 'charge' ->> 'charge_id')::bigint
          = (SELECT charge_id FROM charges WHERE rental_request_id = p1),
    (SELECT row(charge_type, amount, status, user_id)::text FROM charges WHERE rental_request_id = p1));
  PERFORM pg_temp.ok('approve answers the status it found before',
    r -> 'before' ->> 'status' = 'pending', (r -> 'before')::text);
  r := public.rental_availability(h, d0 + 8*hr, d0 + 10*hr, NULL);
  PERFORM pg_temp.ok('the approved booking now holds the slot',
    (r ->> 'used')::int = 1 AND (r ->> 'left')::int = 0, r::text);
  r := pg_temp.approve(p2, 500);
  PERFORM pg_temp.ok('the other pending request for that slot cannot be approved: FACILITY_TAKEN',
    r ->> 'code' = 'FACILITY_TAKEN', pg_temp.brief(r));
  PERFORM pg_temp.ok('  and it stays pending, with no charge',
    pg_temp.status_of(p2) = 'pending' AND pg_temp.charges_of(p2) = 0, pg_temp.status_of(p2));
  r := pg_temp.place(h, 1, d0 + 9*hr, d0 + 11*hr, 'pending', 'general');
  PERFORM pg_temp.ok('a new request for the approved slot is refused at once: FACILITY_TAKEN',
    r ->> 'code' = 'FACILITY_TAKEN', pg_temp.brief(r));
  r := pg_temp.approve(p1, 500);
  PERFORM pg_temp.ok('approving it again: BOOKING_NOT_PENDING (confirmed), still one charge',
    r ->> 'code' = 'BOOKING_NOT_PENDING' AND r ->> 'status' = 'confirmed' AND pg_temp.charges_of(p1) = 1, pg_temp.brief(r));
  r := pg_temp.approve(-1, 0);
  PERFORM pg_temp.ok('approving a booking that does not exist: BOOKING_NOT_FOUND', r ->> 'code' = 'BOOKING_NOT_FOUND', pg_temp.brief(r));

  r := pg_temp.place(m, 1, d0 + 8*hr, d0 + 10*hr, 'pending', 'general');
  q1 := pg_temp.id_of(r);
  r := pg_temp.approve(q1, 0);
  PERFORM pg_temp.ok('approve at PHP 0: the charge is PAID',
    r ->> 'ok' = 'true' AND (SELECT status = 'PAID' AND amount = 0 FROM charges WHERE rental_request_id = q1), pg_temp.brief(r));

  -- The rest of the refusals, each leaving the booking pending and unbilled.
  x := pg_temp.held(m, 1, now() - 2*hr, now() - hr, 'pending');
  r := pg_temp.approve(x, 0);
  PERFORM pg_temp.ok('a pending request whose start has passed is EXPIRED: BOOKING_EXPIRED, still pending, no charge',
    r ->> 'code' = 'BOOKING_EXPIRED' AND pg_temp.status_of(x) = 'pending' AND pg_temp.charges_of(x) = 0, pg_temp.brief(r));
  x := pg_temp.held(m, 1, now() + interval '30 seconds', now() + hr, 'pending');
  r := pg_temp.approve(x, 0);
  PERFORM pg_temp.ok('a pending request starting 30 seconds from now can still be approved', r ->> 'ok' = 'true', pg_temp.brief(r));

  r := pg_temp.place(k, 2, d0 + 8*hr, d0 + 10*hr, 'pending', 'general');
  q1 := pg_temp.id_of(r);
  UPDATE rental_items SET is_active = false WHERE item_id = k;
  r := pg_temp.approve(q1, 300);
  PERFORM pg_temp.ok('the item was deactivated after the request: ITEM_INACTIVE, still pending, no charge',
    r ->> 'code' = 'ITEM_INACTIVE' AND pg_temp.status_of(q1) = 'pending' AND pg_temp.charges_of(q1) = 0, pg_temp.brief(r));
  UPDATE rental_items SET is_active = true WHERE item_id = k;

  INSERT INTO resident_records (first_name, last_name, address, date_registered, is_archived)
  VALUES ('TEST 027', 'Resident', 'Throwaway', now(), false) RETURNING resident_id INTO res;
  INSERT INTO resident_records (first_name, last_name, address, date_registered, is_archived)
  VALUES ('TEST 027', 'Resident Two', 'Throwaway', now(), false) RETURNING resident_id INTO res2;
  r := pg_temp.place_for(m, res, d1 + 8*hr, d1 + 9*hr);
  q1 := pg_temp.id_of(r);
  UPDATE resident_records SET is_archived = true WHERE resident_id = res;
  r := pg_temp.approve(q1, 0);
  PERFORM pg_temp.ok('the resident was archived after the request: RESIDENT_ARCHIVED, still pending, no charge',
    r ->> 'code' = 'RESIDENT_ARCHIVED' AND pg_temp.status_of(q1) = 'pending' AND pg_temp.charges_of(q1) = 0, pg_temp.brief(r));
  r := pg_temp.place_for(m, res2, d1 + 10*hr, d1 + 11*hr);
  q2 := pg_temp.id_of(r);
  r := public.approve_rental_booking(q2, u, 0, u, false);
  PERFORM pg_temp.ok('a resident''s request that is not archived is approved, the charge on the account given',
    r ->> 'ok' = 'true' AND (SELECT user_id FROM charges WHERE rental_request_id = q2) = u, pg_temp.brief(r));

  x := pg_temp.held(m, 1, d1 + 12*hr, d1 + 13*hr, 'cancelled');
  r := pg_temp.approve(x, 0);
  PERFORM pg_temp.ok('a cancelled booking cannot be approved: BOOKING_NOT_PENDING (cancelled)',
    r ->> 'code' = 'BOOKING_NOT_PENDING' AND r ->> 'status' = 'cancelled', pg_temp.brief(r));
  x := pg_temp.held(m, 1, d1 + 14*hr, d1 + 15*hr, 'declined');
  r := pg_temp.approve(x, 0);
  PERFORM pg_temp.ok('a declined booking cannot be approved: BOOKING_NOT_PENDING (declined)',
    r ->> 'code' = 'BOOKING_NOT_PENDING' AND r ->> 'status' = 'declined', pg_temp.brief(r));

  -- Quantities: two pending requests together asking for more than exist.
  r := pg_temp.place(c, 30, d0 + 8*hr, d0 + 10*hr, 'pending', 'general');   q1 := pg_temp.id_of(r);
  r2 := pg_temp.place(c, 30, d0 + 8*hr, d0 + 10*hr, 'pending', 'general');  q2 := pg_temp.id_of(r2);
  PERFORM pg_temp.ok('chairs: two pending requests of 30 of 50 are both accepted',
    r ->> 'ok' = 'true' AND r2 ->> 'ok' = 'true', pg_temp.brief(r) || ' / ' || pg_temp.brief(r2));
  r := pg_temp.approve(q1, 150);
  r2 := pg_temp.approve(q2, 150);
  PERFORM pg_temp.ok('chairs: the first is approved; the second is NOT_ENOUGH_LEFT, left 20, and stays pending unbilled',
    r ->> 'ok' = 'true' AND r2 ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r2 ->> 'left')::int = 20
      AND pg_temp.status_of(q2) = 'pending' AND pg_temp.charges_of(q2) = 0, pg_temp.brief(r2));
  r := pg_temp.place(c, 25, d1 + 9*hr, d1 + 10*hr, 'pending', 'general');
  PERFORM pg_temp.ok('an approved returnable booking still rests 24 hours: 25 the next morning -> NOT_ENOUGH_LEFT, 30 resting',
    r ->> 'code' = 'NOT_ENOUGH_LEFT' AND (r ->> 'resting')::int = 30, pg_temp.brief(r));
  r := pg_temp.place(c, 20, d1 + 9*hr, d1 + 10*hr, 'pending', 'general');
  PERFORM pg_temp.ok('  and the 20 that are free can still be asked for', r ->> 'ok' = 'true', pg_temp.brief(r));

  -- The whole approval is one transaction: a charge that cannot be written
  -- undoes the status change too.
  r := pg_temp.place(m, 1, d1 + 16*hr, d1 + 17*hr, 'pending', 'general');
  q1 := pg_temp.id_of(r);
  INSERT INTO charges (charge_type, amount, status, rental_request_id, created_at) VALUES ('RENTAL', 1, 'UNPAID', q1, now());
  st := NULL;
  BEGIN
    r := pg_temp.approve(q1, 0);
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE;
  END;
  PERFORM pg_temp.ok('if the charge cannot be inserted (unique), approve raises and the booking stays pending',
    st = '23505' AND pg_temp.status_of(q1) = 'pending' AND pg_temp.charges_of(q1) = 1, COALESCE(st, 'no error'));

  st := NULL;
  BEGIN r := public.approve_rental_booking(p2, NULL, 0, NULL, false); EXCEPTION WHEN OTHERS THEN st := SQLERRM; END;
  PERFORM pg_temp.ok('approve with no approver is raised, never a refusal', st LIKE '%approving user is required%', COALESCE(st, 'no error'));
  st := NULL;
  BEGIN r := pg_temp.approve(p2, -1); EXCEPTION WHEN OTHERS THEN st := SQLERRM; END;
  PERFORM pg_temp.ok('approve with a negative amount is raised', st LIKE '%must be 0 or more%', COALESCE(st, 'no error'));

  -- -------------------------------------------------------------------------
  -- place_rental_booking refuses as create_rental_booking does.
  -- -------------------------------------------------------------------------
  r := pg_temp.place(h, 1, d0 + 10*hr, d0 + 10*hr, 'pending', 'general');
  PERFORM pg_temp.ok('place: end equal to start -> TIME_INVALID / END_NOT_AFTER_START',
    r ->> 'code' = 'TIME_INVALID' AND r ->> 'reason' = 'END_NOT_AFTER_START', pg_temp.brief(r));
  r := pg_temp.place(h, 1, now() - hr, now() + hr, 'pending', 'general');
  PERFORM pg_temp.ok('place: a start in the past -> TIME_INVALID / START_NOT_IN_FUTURE',
    r ->> 'code' = 'TIME_INVALID' AND r ->> 'reason' = 'START_NOT_IN_FUTURE', pg_temp.brief(r));
  r := pg_temp.place(-1, 1, d0 + 18*hr, d0 + 19*hr, 'pending', 'general');
  PERFORM pg_temp.ok('place: a missing item -> ITEM_NOT_FOUND', r ->> 'code' = 'ITEM_NOT_FOUND', pg_temp.brief(r));
  UPDATE rental_items SET is_active = false WHERE item_id = k;
  r := pg_temp.place(k, 1, d0 + 18*hr, d0 + 19*hr, 'pending', 'general');
  PERFORM pg_temp.ok('place: an inactive item -> ITEM_INACTIVE', r ->> 'code' = 'ITEM_INACTIVE', pg_temp.brief(r));
  UPDATE rental_items SET is_active = true WHERE item_id = k;
  r := pg_temp.place(h, 2, d0 + 18*hr, d0 + 19*hr, 'pending', 'general');
  PERFORM pg_temp.ok('place: a facility asked for 2 -> QUANTITY_INVALID / FACILITY_WHOLE',
    r ->> 'code' = 'QUANTITY_INVALID' AND r ->> 'reason' = 'FACILITY_WHOLE', pg_temp.brief(r));
  r := pg_temp.place(c, 0, d0 + 18*hr, d0 + 19*hr, 'pending', 'general');
  PERFORM pg_temp.ok('place: quantity 0 -> QUANTITY_INVALID / BELOW_ONE',
    r ->> 'code' = 'QUANTITY_INVALID' AND r ->> 'reason' = 'BELOW_ONE', pg_temp.brief(r));
  r := pg_temp.place(h, 1, d0 + 18*hr, d0 + 19*hr, 'confirmed', 'general');
  PERFORM pg_temp.ok('place confirmed: stored confirmed, requested_at now(), and it holds the slot',
    r ->> 'ok' = 'true' AND pg_temp.status_of(pg_temp.id_of(r)) = 'confirmed'
      AND (SELECT requested_at = now() FROM rental_requests WHERE request_id = pg_temp.id_of(r))
      AND public.rental_slot_refusal(h, 1, d0 + 18*hr, d0 + 19*hr, NULL) ->> 'code' = 'FACILITY_TAKEN', pg_temp.brief(r));

  st := NULL;
  BEGIN r := pg_temp.place(h, 1, d0 + 20*hr, d0 + 21*hr, 'declined', 'general'); EXCEPTION WHEN OTHERS THEN st := SQLERRM; END;
  PERFORM pg_temp.ok('place with a status other than pending or confirmed is raised', st LIKE '%status must be pending or confirmed%', COALESCE(st, 'no error'));
  st := NULL;
  BEGIN r := pg_temp.place(h, 1, d0 + 20*hr, d0 + 21*hr, 'pending', 'party'); EXCEPTION WHEN OTHERS THEN st := SQLERRM; END;
  PERFORM pg_temp.ok('place with an unknown purpose type is raised', st LIKE '%purpose type must be general or funeral%', COALESCE(st, 'no error'));

  -- A funeral booking through place (the Secretary's walk-in, a later
  -- batch): only for an item she marked, and only for a resident.
  r := pg_temp.place(t, 1, d0 + 8*hr, d0 + 10*hr, 'pending', 'funeral');
  PERFORM pg_temp.ok('a funeral booking for an unmarked item -> FUNERAL_NOT_ALLOWED, nothing inserted',
    r ->> 'code' = 'FUNERAL_NOT_ALLOWED' AND (SELECT count(*) FROM rental_requests WHERE item_id = t) = 0, pg_temp.brief(r));
  UPDATE rental_items SET funeral_eligible = true WHERE item_id = t;
  r := pg_temp.place(t, 1, d0 + 8*hr, d0 + 10*hr, 'confirmed', 'funeral');
  PERFORM pg_temp.ok('a guest''s funeral booking on a marked item -> FUNERAL_RESIDENTS_ONLY, nothing inserted',
    r ->> 'code' = 'FUNERAL_RESIDENTS_ONLY' AND (SELECT count(*) FROM rental_requests WHERE item_id = t) = 0, pg_temp.brief(r));
  r := pg_temp.place_funeral_for(t, res2, d0 + 8*hr, d0 + 10*hr);
  PERFORM pg_temp.ok('a resident''s funeral booking on a marked item is stored with purpose_type funeral',
    r ->> 'ok' = 'true' AND pg_temp.type_of(pg_temp.id_of(r)) = 'funeral', pg_temp.brief(r));
  st := NULL;
  BEGIN UPDATE rental_items SET funeral_eligible = true WHERE item_id = h; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM pg_temp.ok('a facility can never be marked funeral_eligible (CHECK, 23514)', st = '23514', COALESCE(st, 'no error'));

  -- The new columns' CHECKs.
  st := NULL;
  BEGIN UPDATE rental_requests SET decline_reason = '  ab  ' WHERE request_id = p2; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM pg_temp.ok('decline_reason of 2 characters after trimming is refused (23514)', st = '23514', COALESCE(st, 'no error'));
  st := NULL;
  BEGIN UPDATE rental_requests SET decline_reason = repeat('a', 301) WHERE request_id = p2; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM pg_temp.ok('decline_reason of 301 characters is refused (23514)', st = '23514', COALESCE(st, 'no error'));
  st := NULL;
  BEGIN UPDATE rental_requests SET decline_reason = 'abc' WHERE request_id = p2; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM pg_temp.ok('decline_reason of 3 characters is accepted', st IS NULL, COALESCE(st, 'no error'));
  UPDATE rental_requests SET decline_reason = NULL WHERE request_id = p2;
  st := NULL;
  BEGIN UPDATE rental_requests SET purpose_type = 'wedding' WHERE request_id = p2; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM pg_temp.ok('purpose_type other than general or funeral is refused (23514)', st = '23514', COALESCE(st, 'no error'));

  -- -------------------------------------------------------------------------
  -- The Secretary's funeral waiver at approval (design C). The Tent (t) is
  -- marked by now; the Chairs (c) are not. res is archived; res2 is not.
  -- -------------------------------------------------------------------------
  r := pg_temp.place_for(t, res2, d1 + 8*hr, d1 + 9*hr);
  q1 := pg_temp.id_of(r);
  r := pg_temp.waive(q1);
  PERFORM pg_temp.ok('waiver, a resident''s request for a marked item: confirmed, purpose_type funeral, answers waived true',
    r ->> 'ok' = 'true' AND pg_temp.status_of(q1) = 'confirmed' AND pg_temp.type_of(q1) = 'funeral'
      AND r -> 'waived' = 'true'::jsonb AND r -> 'request' ->> 'purpose_type' = 'funeral', pg_temp.brief(r));
  PERFORM pg_temp.ok('  with one RENTAL charge of PHP 0, PAID',
    pg_temp.charges_of(q1) = 1 AND (SELECT amount = 0 AND status = 'PAID' FROM charges WHERE rental_request_id = q1),
    (SELECT row(charge_type, amount, status)::text FROM charges WHERE rental_request_id = q1));

  r := pg_temp.place_for(c, res2, d1 + 11*hr, d1 + 12*hr);
  q2 := pg_temp.id_of(r);
  r := pg_temp.waive(q2);
  PERFORM pg_temp.ok('waiver on an unmarked item (Chairs): FUNERAL_NOT_ALLOWED, still pending, general, no charge',
    r ->> 'code' = 'FUNERAL_NOT_ALLOWED' AND pg_temp.status_of(q2) = 'pending' AND pg_temp.type_of(q2) = 'general'
      AND pg_temp.charges_of(q2) = 0, pg_temp.brief(r));
  r := pg_temp.approve(q2, 5);
  PERFORM pg_temp.ok('  the same request approved without the waiver: confirmed, general, UNPAID PHP 5, waived false',
    r ->> 'ok' = 'true' AND pg_temp.type_of(q2) = 'general' AND r -> 'waived' = 'false'::jsonb
      AND (SELECT amount = 5 AND status = 'UNPAID' FROM charges WHERE rental_request_id = q2), pg_temp.brief(r));

  x := pg_temp.id_of(pg_temp.place(t, 1, d1 + 10*hr, d1 + 11*hr, 'pending', 'general'));
  r := pg_temp.waive(x);
  PERFORM pg_temp.ok('waiver on a guest''s request for a marked item: FUNERAL_RESIDENTS_ONLY, still pending, general, no charge',
    r ->> 'code' = 'FUNERAL_RESIDENTS_ONLY' AND pg_temp.status_of(x) = 'pending' AND pg_temp.type_of(x) = 'general'
      AND pg_temp.charges_of(x) = 0, pg_temp.brief(r));
  x := pg_temp.id_of(pg_temp.place(c, 1, d1 + 13*hr, d1 + 14*hr, 'pending', 'general'));
  r := pg_temp.waive(x);
  PERFORM pg_temp.ok('waiver on a guest''s request for an unmarked item: FUNERAL_NOT_ALLOWED comes first',
    r ->> 'code' = 'FUNERAL_NOT_ALLOWED' AND pg_temp.status_of(x) = 'pending', pg_temp.brief(r));
  x := pg_temp.id_of(pg_temp.place_for(t, res, d1 + 12*hr, d1 + 13*hr));
  r := pg_temp.waive(x);
  PERFORM pg_temp.ok('waiver for an archived resident: RESIDENT_ARCHIVED, still pending, no charge',
    r ->> 'code' = 'RESIDENT_ARCHIVED' AND pg_temp.status_of(x) = 'pending' AND pg_temp.charges_of(x) = 0, pg_temp.brief(r));

  x := pg_temp.id_of(pg_temp.place_for(t, res2, d1 + 14*hr, d1 + 15*hr));
  r := pg_temp.approve(x, 300);
  PERFORM pg_temp.ok('not waiving, a resident''s request for a marked item: purpose_type stays general, UNPAID PHP 300',
    r ->> 'ok' = 'true' AND pg_temp.type_of(x) = 'general'
      AND (SELECT amount = 300 AND status = 'UNPAID' FROM charges WHERE rental_request_id = x), pg_temp.brief(r));

  x := pg_temp.id_of(pg_temp.place_for(t, res2, d1 + 16*hr, d1 + 17*hr));
  st := NULL;
  BEGIN r := public.approve_rental_booking(x, u, 300, NULL, true); EXCEPTION WHEN OTHERS THEN st := SQLERRM; END;
  PERFORM pg_temp.ok('a waiver with an amount above 0 is raised, and the request stays pending with no charge',
    st LIKE '%waived for a funeral must be 0%' AND pg_temp.status_of(x) = 'pending' AND pg_temp.charges_of(x) = 0,
    COALESCE(st, 'no error'));
  st := NULL;
  BEGIN r := public.approve_rental_booking(x, u, 0, NULL, NULL); EXCEPTION WHEN OTHERS THEN st := SQLERRM; END;
  PERFORM pg_temp.ok('a NULL waiver flag is raised, never read as false', st LIKE '%waive_for_funeral must be true or false%',
    COALESCE(st, 'no error'));

  -- -------------------------------------------------------------------------
  -- update_rental_booking_time on a pending request.
  -- -------------------------------------------------------------------------
  r := public.update_rental_booking_time(p2, d0 + 20*hr, d0 + 21*hr, 'moved');
  PERFORM pg_temp.ok('Edit moves a pending request, which stays pending',
    r ->> 'ok' = 'true' AND pg_temp.status_of(p2) = 'pending'
      AND (SELECT start_datetime FROM rental_requests WHERE request_id = p2) = d0 + 20*hr, pg_temp.brief(r));
  r := public.update_rental_booking_time(p2, d0 + 9*hr, d0 + 10*hr, 'moved');
  PERFORM pg_temp.ok('Edit refuses a pending request into an approved slot: FACILITY_TAKEN, unchanged',
    r ->> 'code' = 'FACILITY_TAKEN' AND (SELECT start_datetime FROM rental_requests WHERE request_id = p2) = d0 + 20*hr, pg_temp.brief(r));
  x := pg_temp.held(m, 1, d1 + 18*hr, d1 + 19*hr, 'declined');
  r := public.update_rental_booking_time(x, d1 + 20*hr, d1 + 21*hr, 'moved');
  PERFORM pg_temp.ok('Edit refuses a declined booking: BOOKING_STARTED', r ->> 'code' = 'BOOKING_STARTED', pg_temp.brief(r));

  -- -------------------------------------------------------------------------
  -- 024's create_rental_booking still books, and still holds.
  -- -------------------------------------------------------------------------
  r := public.create_rental_booking(m, u, NULL, 'TEST 027 Guest', '09170000027', 1, d1 + 22*hr, d1 + 23*hr, 'R2A-SECRET-PURPOSE');
  r2 := pg_temp.place(m, 1, d1 + 22*hr, d1 + 23*hr, 'pending', 'general');
  PERFORM pg_temp.ok('create_rental_booking still books confirmed (purpose_type general, requested_at NULL), and holds',
    r ->> 'ok' = 'true' AND r -> 'request' ->> 'purpose_type' = 'general' AND r -> 'request' -> 'requested_at' = 'null'::jsonb
      AND r2 ->> 'code' = 'FACILITY_TAKEN', pg_temp.brief(r) || ' / ' || pg_temp.brief(r2));
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 0,
         'ALL CHECKS',
         (SELECT count(*) FILTER (WHERE verdict = 'PASS')::text FROM t027) || ' of '
           || (SELECT count(*)::text FROM t027) || ' passed',
         CASE WHEN (SELECT count(*) FROM t027) > 0
               AND NOT EXISTS (SELECT 1 FROM t027 WHERE verdict <> 'PASS')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT ord, check_name, detail, verdict FROM t027
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
