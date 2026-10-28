-- ===========================================================================
-- Migration 026 — drop rental_settings (step O43).
--
-- WHY. Migration 025 added rental_settings, one row holding max_days_ahead,
-- so the Secretary could change how far ahead a booking may be made from a
-- "Booking rules" box on the Rental items page. The Secretary does not need
-- to change it. Step O43 (28 Oct 2026) removed the box and PUT
-- /api/rental-settings, and fixed the limit at 31 days in the code
-- (MAX_DAYS_AHEAD, backend/src/constants/rentalBookingRules.js). GET
-- /api/rental-settings still answers { max_days_ahead: 31 }, from that
-- constant. Nothing in the code reads the table any more, so it is dropped.
--
-- WHAT STAYS. rental_items.booking_opens_at and booking_closes_at, their
-- CHECK rental_items_booking_hours_order, and every item's hours: this
-- migration does not touch rental_items. The two activity_logs rows with
-- table_name = 'rental_settings' (UPDATEs from before step O43) stay, as
-- every log row does; table_name is text, not a foreign key, and the
-- Activity Log page still labels them "Rental booking rules".
--
-- ORDER OF DEPLOYMENT — THIS ONE IS THE REVERSE OF MIGRATION 025's.
--   1. Deploy the step O43 code FIRST (Render, from main) and confirm it is
--      live: a booking works and GET /api/rental-settings answers 31.
--   2. Only THEN apply this migration.
-- The code running before step O43 reads rental_settings on EVERY booking
-- and edit (bookingRulesRefusal in routes/rentalRequests.js) and on every
-- GET /api/rental-settings. Dropping the table under that code makes every
-- booking, walk-in and edit a 500 until the new code is deployed.
--
-- GUARDED, as migrations 023 and 025 are. Hard stops run before the drop:
-- the table exists; it holds exactly ONE row, id 1, max_days_ahead 31 (any
-- other content aborts and names what it holds — stop and report it, never
-- edit the guard to let it through); nothing depends on it (no foreign key,
-- no view, no function or procedure whose body names it, no trigger, no
-- policy). A snapshot of rental_items (every column, the hours included),
-- the bookings and the log rows is taken, the same checks run again after,
-- and ONE result set reports PASS/FAIL — the Supabase editor shows only the
-- last one. The block ends in ROLLBACK: run it, read the result set, and only
-- then change the last statement to COMMIT and run it again (CLAUDE.md,
-- Standing Rules).
--
-- EXPECTED ROW COUNTS (read 28 Oct 2026, read-only):
--   rental_settings  1 row before (id 1, max_days_ahead 31); the table is
--                    gone after
--   rental_items     9 rows, unchanged in number and in every column,
--                    booking_opens_at and booking_closes_at included (the
--                    Basketball Court closes 24:00:00, the other 8 at
--                    17:00:00, all open 07:00:00)
--   rental_requests  unchanged (not touched)
--   activity_logs    2 rows with table_name = 'rental_settings', unchanged
--
-- DOCUMENTS. docs/brgyserve-database-schema.md marks Table 21 as dropped by
-- this migration. rental_settings never needs a Chapter 3 table or an ERD
-- entity once this is applied; the two rental_items columns from migration
-- 025 still do (CLAUDE.md — a migration is not finished when it is applied).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Before: hard stops, and a snapshot to compare against afterwards. The
-- snapshot table lives only inside this transaction.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rows text;
  v_deps text;
BEGIN
  IF to_regclass('public.rental_settings') IS NULL THEN
    RAISE EXCEPTION 'ABORT: table public.rental_settings does not exist — migration 026 already applied, or wrong database?';
  END IF;
  IF to_regclass('public.rental_items') IS NULL THEN
    RAISE EXCEPTION 'ABORT: table public.rental_items does not exist — wrong database?';
  END IF;

  -- Exactly one row, id 1, max_days_ahead 31. Anything else is reported in
  -- full, so it can be told to the developer before anything is dropped.
  IF (SELECT count(*) FROM rental_settings) <> 1
     OR NOT EXISTS (SELECT 1 FROM rental_settings WHERE id = 1 AND max_days_ahead = 31) THEN
    SELECT COALESCE(string_agg('id ' || id || ', max_days_ahead ' || max_days_ahead, '; ' ORDER BY id), '(no rows)')
      INTO v_rows FROM rental_settings;
    RAISE EXCEPTION 'ABORT: rental_settings does not hold exactly one row, id 1, max_days_ahead 31. It holds: %. STOP and report this; do not drop.', v_rows;
  END IF;

  -- A foreign key from another table.
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ') INTO v_deps
    FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'public.rental_settings'::regclass
     AND conrelid <> 'public.rental_settings'::regclass;
  IF v_deps IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: a foreign key references rental_settings: %', v_deps;
  END IF;

  -- A view or materialized view built on it.
  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_deps
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
   WHERE d.classid = 'pg_rewrite'::regclass
     AND d.refobjid = 'public.rental_settings'::regclass
     AND v.oid <> 'public.rental_settings'::regclass;
  IF v_deps IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: a view depends on rental_settings: %', v_deps;
  END IF;

  -- A function or procedure whose body names it. Postgres does not track
  -- these as dependencies, so DROP TABLE would not refuse; the function would
  -- fail later, when it runs. Migration 024's functions do not name it.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_deps
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosrc ILIKE '%rental_settings%';
  IF v_deps IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: a function names rental_settings in its body: %', v_deps;
  END IF;

  -- A trigger on it, or a policy (it was created with none).
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.rental_settings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ABORT: rental_settings has a trigger';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rental_settings') THEN
    RAISE EXCEPTION 'ABORT: rental_settings has a policy';
  END IF;
END $$;

CREATE TEMP TABLE m026_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM rental_items) AS item_count,
  (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || COALESCE(description, '') || ','
                                  || quantity_total || ',' || quantity_available || ',' || fee || ',' || is_active || ','
                                  || booking_opens_at || ',' || booking_closes_at, ';' ORDER BY item_id), ''))
     FROM rental_items) AS item_hash,
  (SELECT string_agg(name || ' ' || booking_opens_at || '-' || booking_closes_at, '; ' ORDER BY item_id)
     FROM rental_items) AS item_hours,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rental_items') AS column_count,
  (SELECT count(*) FROM rental_requests) AS booking_count,
  (SELECT count(*) FROM activity_logs WHERE table_name = 'rental_settings') AS log_count;

-- ---------------------------------------------------------------------------
-- The change. RESTRICT (the default, written out): Postgres refuses the drop
-- if anything it tracks still depends on the table, rather than dropping
-- that too.
-- ---------------------------------------------------------------------------
DROP TABLE rental_settings RESTRICT;

-- PostgREST forgets the table. Delivered only on COMMIT, so the dry run
-- sends nothing.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- After: the same checks, as hard stops. Any failure aborts the transaction,
-- so nothing is kept even on the COMMIT copy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b m026_before%ROWTYPE;
BEGIN
  SELECT * INTO b FROM m026_before;
  IF to_regclass('public.rental_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: rental_settings still exists';
  END IF;
  IF (SELECT count(*) FROM rental_items) <> b.item_count THEN
    RAISE EXCEPTION 'ABORT: the item count changed (% before)', b.item_count;
  END IF;
  IF (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || COALESCE(description, '') || ','
                                     || quantity_total || ',' || quantity_available || ',' || fee || ',' || is_active || ','
                                     || booking_opens_at || ',' || booking_closes_at, ';' ORDER BY item_id), ''))
        FROM rental_items) <> b.item_hash THEN
    RAISE EXCEPTION 'ABORT: an item changed (its hours or any other column)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rental_items') <> b.column_count THEN
    RAISE EXCEPTION 'ABORT: rental_items gained or lost a column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_items_booking_hours_order' AND convalidated) THEN
    RAISE EXCEPTION 'ABORT: the hours CHECK rental_items_booking_hours_order is missing';
  END IF;
  IF (SELECT count(*) FROM rental_requests) <> b.booking_count THEN
    RAISE EXCEPTION 'ABORT: the booking count changed';
  END IF;
  IF (SELECT count(*) FROM activity_logs WHERE table_name = 'rental_settings') <> b.log_count THEN
    RAISE EXCEPTION 'ABORT: the rental_settings log rows changed (% before)', b.log_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- Expected: rows 1 to 8; rows 1 and 2 are INFO, every other verdict PASS.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'items on file, with their hours',
         (SELECT item_count::text FROM m026_before) || ' rows (expected 9): ' || (SELECT item_hours FROM m026_before), 'INFO'
  UNION ALL
  SELECT 2, 'bookings on file',
         (SELECT booking_count::text FROM m026_before) || ' rows, not touched', 'INFO'
  UNION ALL
  SELECT 3, 'rental_settings is gone',
         COALESCE(to_regclass('public.rental_settings')::text, '(no such table)'),
         CASE WHEN to_regclass('public.rental_settings') IS NULL THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 4, 'every item unchanged, hours included (md5 of every column)',
         (SELECT item_hash FROM m026_before),
         CASE WHEN (SELECT count(*) FROM rental_items) = (SELECT item_count FROM m026_before)
                AND (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || COALESCE(description, '') || ','
                                                    || quantity_total || ',' || quantity_available || ',' || fee || ',' || is_active || ','
                                                    || booking_opens_at || ',' || booking_closes_at, ';' ORDER BY item_id), ''))
                       FROM rental_items) = (SELECT item_hash FROM m026_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'both hour columns still NOT NULL time',
         (SELECT string_agg(column_name || ' ' || data_type || ' default ' || COALESCE(column_default, 'none'), '; ' ORDER BY column_name)
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'rental_items'
             AND column_name IN ('booking_opens_at', 'booking_closes_at')),
         CASE WHEN (SELECT count(*) FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'rental_items'
                       AND column_name IN ('booking_opens_at', 'booking_closes_at')
                       AND data_type = 'time without time zone' AND is_nullable = 'NO') = 2
                AND (SELECT count(*) FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'rental_items') = (SELECT column_count FROM m026_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 6, 'the hours CHECK is still there',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                    WHERE conname = 'rental_items_booking_hours_order'), '(constraint missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_items_booking_hours_order' AND convalidated)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 7, 'bookings unchanged in number',
         (SELECT count(*)::text FROM rental_requests) || ' rows',
         CASE WHEN (SELECT count(*) FROM rental_requests) = (SELECT booking_count FROM m026_before) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 8, 'the rental_settings log rows are kept',
         (SELECT count(*)::text FROM activity_logs WHERE table_name = 'rental_settings') || ' rows (expected 2)',
         CASE WHEN (SELECT count(*) FROM activity_logs WHERE table_name = 'rental_settings') = (SELECT log_count FROM m026_before)
              THEN 'PASS' ELSE 'FAIL' END
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
-- Change ROLLBACK to COMMIT once the result set above reads PASS throughout,
-- and ONLY after the step O43 code is live (see ORDER OF DEPLOYMENT above).
