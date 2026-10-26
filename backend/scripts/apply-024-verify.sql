-- ===========================================================================
-- Verify migration 024 after apply-024-commit.sql has been run. READ-ONLY:
-- it calls only STABLE functions and reads catalogs and counts, and it ends
-- in ROLLBACK anyway, so it cannot keep anything even by mistake.
--
-- Expected result set: rows 1 to 16. Rows 1 to 12 PASS. Rows 13 to 16 are
-- INFO. Compare rows 13 and 14 against rows 1 to 4 of the commit run: 024
-- writes no rows, so the counts are the same unless the app has taken
-- bookings or payments since.
-- ===========================================================================

BEGIN READ ONLY;

WITH fn (ord, label, sig) AS (
  VALUES
    (1, 'rental_holds',               'public.rental_holds(bigint,timestamptz,timestamptz,bigint)'),
    (2, 'rental_slot_refusal',        'public.rental_slot_refusal(bigint,integer,timestamptz,timestamptz,bigint)'),
    (3, 'create_rental_booking',      'public.create_rental_booking(bigint,bigint,bigint,text,text,integer,timestamptz,timestamptz,text)'),
    (4, 'update_rental_booking_time', 'public.update_rental_booking_time(bigint,timestamptz,timestamptz,text)'),
    (5, 'rental_availability',        'public.rental_availability(bigint,timestamptz,timestamptz,bigint)')
),
fn_info AS (
  SELECT fn.ord, fn.label, fn.sig, p.oid, p.prosecdef, p.proconfig, p.proacl
    FROM fn
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(fn.sig)
),
smoke AS (
  SELECT CASE WHEN to_regprocedure('public.rental_availability(bigint,timestamptz,timestamptz,bigint)') IS NULL
                OR (SELECT min(item_id) FROM rental_items) IS NULL
              THEN NULL
              ELSE public.rental_availability(
                     (SELECT min(item_id) FROM rental_items),
                     now() + interval '1 day', now() + interval '1 day 1 hour', NULL)
         END AS r
)
SELECT ord, check_name, detail, verdict
FROM (
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
         CASE WHEN oid IS NULL THEN '(missing)'
              ELSE 'service_role ' || has_function_privilege('service_role', oid, 'EXECUTE')
                   || ', anon ' || has_function_privilege('anon', oid, 'EXECUTE')
                   || ', authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')
                   || ', PUBLIC ' || (proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) END,
         CASE WHEN oid IS NOT NULL
               AND has_function_privilege('service_role', oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
               AND proacl IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)
              THEN 'PASS' ELSE 'FAIL' END
    FROM fn_info
  UNION ALL
  SELECT 11, 'no other function by these names (no stray overload)',
         (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('rental_holds', 'rental_slot_refusal', 'create_rental_booking',
                               'update_rental_booking_time', 'rental_availability')) || ' function(s)',
         CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public'
                       AND p.proname IN ('rental_holds', 'rental_slot_refusal', 'create_rental_booking',
                                         'update_rental_booking_time', 'rental_availability')) = 5
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 12, 'availability answers, with only the R5 keys',
         COALESCE((SELECT string_agg(k, ', ' ORDER BY k) FROM smoke, jsonb_object_keys(smoke.r) AS k), '(no answer)'),
         CASE WHEN (SELECT r FROM smoke) IS NULL THEN 'FAIL'
              WHEN (SELECT r ->> 'ok' FROM smoke) = 'true'
               AND NOT EXISTS (SELECT 1 FROM smoke, jsonb_object_keys(smoke.r) AS k
                                WHERE k NOT IN ('ok', 'item_type', 'total', 'used', 'booked', 'stuck', 'resting', 'left', 'taken'))
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 13, 'counts now: rental_items / rental_requests',
         (SELECT count(*)::text FROM rental_items) || ' / ' || (SELECT count(*)::text FROM rental_requests),
         'INFO'
  UNION ALL
  SELECT 14, 'counts now: charges / payments',
         (SELECT count(*)::text FROM charges) || ' / ' || (SELECT count(*)::text FROM payments),
         'INFO'
  UNION ALL
  SELECT 15, 'smoke: rental_availability for item #' || COALESCE((SELECT min(item_id)::text FROM rental_items), '-') || ', tomorrow',
         COALESCE((SELECT r::text FROM smoke), '(no answer)'),
         'INFO'
  UNION ALL
  SELECT 16, 'STUCK bookings on file (past their end, never marked returned)',
         (SELECT count(*)::text || ' booking(s), ' || COALESCE(sum(rr.quantity_requested), 0)::text || ' unit(s)'
            FROM rental_requests rr JOIN rental_items ri ON ri.item_id = rr.item_id
           WHERE ri.type IN ('equipment', 'furniture')
             AND rr.status NOT IN ('cancelled', 'returned', 'returned_late', 'returned_with_issue')
             AND rr.end_datetime < now()),
         'INFO'
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
