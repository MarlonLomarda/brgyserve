-- ===========================================================================
-- Clean up after scripts/test-024-concurrency.js. Two copies of this file
-- exist and they differ in EXACTLY ONE LINE, the last statement:
--   backend/scripts/cleanup-024-concurrency-dry-run.sql  ends in ROLLBACK
--   backend/scripts/cleanup-024-concurrency-commit.sql   ends in COMMIT
-- Run the dry run first and read its result set.
--
-- Deletes ONLY the item named exactly 'TEST C1 Concurrency' and the bookings
-- on it. Expected: 1 item and 5 bookings (one per round; fewer if the script
-- stopped early, never more than 10). It aborts, deleting nothing, if:
--   - there is not exactly one item with that name, or it does not look like
--     the throwaway (1 unit, fee 0);
--   - any booking on it is not a test guest booking ('TEST C1 Concurrency
--     guest', no resident_id), or names one of the protected resident
--     records (1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18);
--   - any charge, payment, notification or activity log row points at the
--     item or its bookings (the script writes none, so one means somebody
--     used the item for real);
--   - more than 10 bookings are on it;
--   - afterwards, anything other than those rows changed in rental_items,
--     rental_requests, charges or payments.
-- ===========================================================================

BEGIN;

CREATE TEMP TABLE c024_target ON COMMIT DROP AS
SELECT ri.item_id,
       (SELECT array_agg(rr.request_id ORDER BY rr.request_id)
          FROM rental_requests rr WHERE rr.item_id = ri.item_id) AS request_ids
  FROM rental_items ri
 WHERE ri.name = 'TEST C1 Concurrency';

DO $$
DECLARE
  v_items int;
  v_item  bigint;
  v_ids   bigint[];
BEGIN
  SELECT count(*) INTO v_items FROM c024_target;
  IF v_items <> 1 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 1 item named ''TEST C1 Concurrency'', found %', v_items;
  END IF;
  SELECT item_id, COALESCE(request_ids, '{}') INTO v_item, v_ids FROM c024_target;

  IF NOT EXISTS (SELECT 1 FROM rental_items
                  WHERE item_id = v_item AND quantity_total = 1 AND quantity_available = 1 AND fee = 0) THEN
    RAISE EXCEPTION 'ABORT: item #% does not look like the throwaway (1 unit, fee 0)', v_item;
  END IF;
  IF cardinality(v_ids) > 10 THEN
    RAISE EXCEPTION 'ABORT: item #% has % bookings; the script makes at most 5', v_item, cardinality(v_ids);
  END IF;
  IF EXISTS (SELECT 1 FROM rental_requests
              WHERE item_id = v_item
                AND (resident_id IS NOT NULL
                     OR outside_borrower_name IS DISTINCT FROM 'TEST C1 Concurrency guest')) THEN
    RAISE EXCEPTION 'ABORT: item #% has a booking that is not a test guest booking', v_item;
  END IF;
  IF EXISTS (SELECT 1 FROM rental_requests
              WHERE item_id = v_item
                AND resident_id IN (1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)) THEN
    RAISE EXCEPTION 'ABORT: a booking on item #% names a protected resident record', v_item;
  END IF;
  IF EXISTS (SELECT 1 FROM charges WHERE rental_request_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'ABORT: a charge points at a booking on item #%', v_item;
  END IF;
  IF EXISTS (SELECT 1 FROM payments p JOIN charges c ON c.charge_id = p.charge_id
              WHERE c.rental_request_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'ABORT: a payment points at a booking on item #%', v_item;
  END IF;
  IF EXISTS (SELECT 1 FROM notifications
              WHERE related_type = 'RENTAL_REQUEST' AND related_to = ANY (v_ids)) THEN
    RAISE EXCEPTION 'ABORT: a notification points at a booking on item #%', v_item;
  END IF;
  IF EXISTS (SELECT 1 FROM activity_logs
              WHERE (table_name = 'rental_requests' AND record_id = ANY (v_ids))
                 OR (table_name = 'rental_items' AND record_id = v_item)) THEN
    RAISE EXCEPTION 'ABORT: an activity log row points at item #% or its bookings', v_item;
  END IF;
END $$;

CREATE TEMP TABLE c024_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM rental_items)    AS items,
  (SELECT count(*) FROM rental_requests) AS bookings,
  (SELECT count(*) FROM charges)         AS charges,
  (SELECT count(*) FROM payments)        AS payments,
  (SELECT cardinality(COALESCE(request_ids, '{}')) FROM c024_target) AS target_bookings,
  (SELECT md5(COALESCE(string_agg(to_jsonb(ri)::text, ';' ORDER BY ri.item_id), ''))
     FROM rental_items ri WHERE ri.item_id <> (SELECT item_id FROM c024_target)) AS other_items_hash,
  (SELECT md5(COALESCE(string_agg(to_jsonb(rr)::text, ';' ORDER BY rr.request_id), ''))
     FROM rental_requests rr WHERE rr.item_id <> (SELECT item_id FROM c024_target)) AS other_bookings_hash;

-- The deletes. Bookings first: rental_requests.item_id references the item.
DELETE FROM rental_requests
 WHERE item_id = (SELECT item_id FROM c024_target)
   AND outside_borrower_name = 'TEST C1 Concurrency guest'
   AND resident_id IS NULL;

DELETE FROM rental_items
 WHERE item_id = (SELECT item_id FROM c024_target)
   AND name = 'TEST C1 Concurrency';

DO $$
DECLARE
  b c024_before%ROWTYPE;
BEGIN
  SELECT * INTO b FROM c024_before;
  IF (SELECT count(*) FROM rental_items) <> b.items - 1 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 1 item deleted';
  END IF;
  IF (SELECT count(*) FROM rental_requests) <> b.bookings - b.target_bookings THEN
    RAISE EXCEPTION 'ABORT: expected exactly % booking(s) deleted', b.target_bookings;
  END IF;
  IF (SELECT count(*) FROM charges) <> b.charges OR (SELECT count(*) FROM payments) <> b.payments THEN
    RAISE EXCEPTION 'ABORT: a charge or payment count changed';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(to_jsonb(ri)::text, ';' ORDER BY ri.item_id), '')) FROM rental_items ri) <> b.other_items_hash
     OR (SELECT md5(COALESCE(string_agg(to_jsonb(rr)::text, ';' ORDER BY rr.request_id), '')) FROM rental_requests rr) <> b.other_bookings_hash THEN
    RAISE EXCEPTION 'ABORT: a row other than the test item and its bookings changed';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- Expected: rows 1 to 5, verdicts PASS.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'test item deleted',
         'item #' || (SELECT item_id::text FROM c024_target),
         CASE WHEN NOT EXISTS (SELECT 1 FROM rental_items WHERE name = 'TEST C1 Concurrency') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 2, 'its bookings deleted (expected 5)',
         (SELECT target_bookings::text FROM c024_before) || ' deleted: request_id '
           || COALESCE((SELECT array_to_string(request_ids, ', ') FROM c024_target), 'none'),
         CASE WHEN (SELECT count(*) FROM rental_requests) = (SELECT bookings - target_bookings FROM c024_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 3, 'every other item and booking unchanged (md5)',
         (SELECT other_bookings_hash FROM c024_before),
         CASE WHEN (SELECT md5(COALESCE(string_agg(to_jsonb(ri)::text, ';' ORDER BY ri.item_id), '')) FROM rental_items ri)
                   = (SELECT other_items_hash FROM c024_before)
               AND (SELECT md5(COALESCE(string_agg(to_jsonb(rr)::text, ';' ORDER BY rr.request_id), '')) FROM rental_requests rr)
                   = (SELECT other_bookings_hash FROM c024_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 4, 'charges and payments unchanged',
         (SELECT count(*)::text FROM charges) || ' charges, ' || (SELECT count(*)::text FROM payments) || ' payments',
         CASE WHEN (SELECT count(*) FROM charges) = (SELECT charges FROM c024_before)
               AND (SELECT count(*) FROM payments) = (SELECT payments FROM c024_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'protected resident records 1, 7-18 all still present',
         (SELECT count(*)::text FROM resident_records
           WHERE resident_id IN (1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)) || ' of 13',
         CASE WHEN (SELECT count(*) FROM resident_records
                     WHERE resident_id IN (1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)) = 13
              THEN 'PASS' ELSE 'FAIL' END
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

COMMIT;
