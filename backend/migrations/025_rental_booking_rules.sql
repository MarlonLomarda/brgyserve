-- ===========================================================================
-- Migration 025 — rental booking hours per item, and how far ahead a booking
-- may be made.
--
-- WHY. The Secretary gave the real rules (28 Oct 2026): the barangay hall
-- closes at 5:00 PM and is open every day, a booking may be made on the same
-- day, and no more than one month ahead. The covered court is the exception:
-- it can be booked until 12:00 midnight. Nothing stored any of it. Hours are
-- set PER ITEM, because the court differs from the rest; the limit on how far
-- ahead is one number for the whole barangay.
--
-- THE CHANGES.
--   rental_items.booking_opens_at   time NOT NULL DEFAULT '07:00'
--   rental_items.booking_closes_at  time NOT NULL DEFAULT '17:00'
--       CHECK (booking_opens_at < booking_closes_at)
--       Every existing item gets 07:00 to 17:00 from the DEFAULT. Which item
--       is the covered court is NOT guessed here: the Secretary sets its
--       close to 12:00 midnight on the Rental items page.
--   rental_settings (one row)      id smallint PRIMARY KEY DEFAULT 1
--                                  CHECK (id = 1), the singleton;
--                                  max_days_ahead integer NOT NULL DEFAULT 31
--                                  CHECK (1 to 366). The row is inserted here.
--   RLS enabled on rental_settings with ZERO policies, like every other table
--   (CLAUDE.md, Outstanding work): the backend's service role key bypasses
--   it, and the anon key reads nothing.
--
-- WHY `time` AND NOT MINUTES. Postgres's `time` holds 24:00:00 (its range is
-- 00:00:00 to 24:00:00), so a close at midnight is stored as itself, compares
-- correctly ('24:00' > '23:59'), and reads as a time in the SQL editor and in
-- PostgREST ("24:00:00"). Minutes since midnight would need a CHECK to keep
-- the range and a conversion everywhere the value is shown. A booking that
-- ends at midnight ends at 00:00 of the next day, which the route reads as
-- 24:00 (routes/rentalRequests.js); it is allowed only for an item whose
-- close is 24:00:00.
--
-- NO MINIMUM LEAD. Same-day bookings are allowed; the start must only be in
-- the future, which migration 024's functions and the route already check.
--
-- THE RULES ARE ENFORCED IN THE ROUTE, NOT HERE. Migration 024's functions
-- are not changed and decide only whether a slot is free. POST
-- /api/rental-requests (resident and walk-in) and PUT /:id (the Secretary's
-- edit) refuse a booking outside its item's hours or more than
-- max_days_ahead days after today in Manila. Bookings already stored are not
-- checked again.
--
-- ORDER OF DEPLOYMENT. Apply this BEFORE the code that reads the columns is
-- deployed: the new code selects booking_opens_at, booking_closes_at and
-- rental_settings on every booking, and without them every booking would
-- fail with a 500. The new columns and table are harmless to the code
-- running today, which never selects them.
--
-- GUARDED, as migration 023 is. Hard stops run before the change (the tables
-- exist, the new names do not), a snapshot of every item is taken, the same
-- checks run again after it, and ONE result set reports PASS/FAIL — the
-- Supabase editor shows only the last one. The block ends in ROLLBACK: run
-- it, read the result set, and only then change the last statement to COMMIT
-- and run it again (CLAUDE.md, Standing Rules).
--
-- EXPECTED ROW COUNTS (read 28 Oct 2026, read-only):
--   rental_items     9 rows, unchanged in number; every one reads 07:00:00
--                    to 17:00:00 afterwards (no UPDATE statement: the
--                    DEFAULT fills them as the columns are added)
--   rental_settings  0 rows before (the table does not exist), exactly 1
--                    after: id 1, max_days_ahead 31
--   rental_requests  unchanged (not touched)
--
-- Chapter 3 needs a NEW TABLE for rental_settings and two new rows in TABLE
-- for rental_items, and the ERD page `amoncio - erd` needs both. They are
-- owed alongside migrations 020 and 021. See CLAUDE.md — a migration is not
-- finished when it is applied.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Before: hard stops, and a snapshot of every item to compare against
-- afterwards. The snapshot table lives only inside this transaction.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.rental_items') IS NULL THEN
    RAISE EXCEPTION 'ABORT: table public.rental_items does not exist — wrong database?';
  END IF;
  IF to_regclass('public.rental_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: table public.rental_settings already exists — migration 025 has already been applied';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rental_items'
                AND column_name IN ('booking_opens_at', 'booking_closes_at')) THEN
    RAISE EXCEPTION 'ABORT: rental_items already has booking_opens_at or booking_closes_at';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_items_booking_hours_order') THEN
    RAISE EXCEPTION 'ABORT: constraint rental_items_booking_hours_order already exists';
  END IF;
END $$;

CREATE TEMP TABLE m025_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM rental_items) AS item_count,
  (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || quantity_total || ','
                                  || quantity_available || ',' || fee || ',' || is_active, ';' ORDER BY item_id), ''))
     FROM rental_items) AS item_hash,
  (SELECT count(*) FROM rental_requests) AS booking_count,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rental_items') AS column_count;

-- ---------------------------------------------------------------------------
-- The change.
-- ---------------------------------------------------------------------------
ALTER TABLE rental_items
    ADD COLUMN booking_opens_at  time NOT NULL DEFAULT '07:00',
    ADD COLUMN booking_closes_at time NOT NULL DEFAULT '17:00',
    ADD CONSTRAINT rental_items_booking_hours_order CHECK (booking_opens_at < booking_closes_at);

CREATE TABLE rental_settings (
    id             smallint PRIMARY KEY DEFAULT 1
                   CONSTRAINT rental_settings_singleton CHECK (id = 1),
    max_days_ahead integer  NOT NULL DEFAULT 31
                   CONSTRAINT rental_settings_max_days_ahead_range CHECK (max_days_ahead BETWEEN 1 AND 366)
);

INSERT INTO rental_settings (id, max_days_ahead) VALUES (1, 31);

ALTER TABLE rental_settings ENABLE ROW LEVEL SECURITY;

-- PostgREST learns of the new table and columns. Delivered only on COMMIT, so
-- the dry run sends nothing.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- After: the same checks, as hard stops. Any failure aborts the transaction,
-- so nothing is kept even on the COMMIT copy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b m025_before%ROWTYPE;
BEGIN
  SELECT * INTO b FROM m025_before;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rental_items'
         AND column_name IN ('booking_opens_at', 'booking_closes_at')
         AND data_type = 'time without time zone' AND is_nullable = 'NO') <> 2 THEN
    RAISE EXCEPTION 'ABORT: booking_opens_at and booking_closes_at are not both NOT NULL time columns';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_items_booking_hours_order' AND convalidated) THEN
    RAISE EXCEPTION 'ABORT: the hours CHECK is missing or not validated';
  END IF;
  IF (SELECT count(*) FROM rental_items) <> b.item_count THEN
    RAISE EXCEPTION 'ABORT: the item count changed (% before)', b.item_count;
  END IF;
  IF (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || quantity_total || ','
                                     || quantity_available || ',' || fee || ',' || is_active, ';' ORDER BY item_id), ''))
        FROM rental_items) <> b.item_hash THEN
    RAISE EXCEPTION 'ABORT: an existing item''s id, name, type, quantities, fee or status changed';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_items
              WHERE booking_opens_at <> '07:00' OR booking_closes_at <> '17:00') THEN
    RAISE EXCEPTION 'ABORT: an existing item did not get 07:00 to 17:00';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rental_items') <> b.column_count + 2 THEN
    RAISE EXCEPTION 'ABORT: expected exactly two new columns on rental_items';
  END IF;
  IF (SELECT count(*) FROM rental_requests) <> b.booking_count THEN
    RAISE EXCEPTION 'ABORT: the booking count changed';
  END IF;
  IF (SELECT count(*) FROM rental_settings) <> 1
     OR NOT EXISTS (SELECT 1 FROM rental_settings WHERE id = 1 AND max_days_ahead = 31) THEN
    RAISE EXCEPTION 'ABORT: rental_settings does not hold exactly one row, id 1, max_days_ahead 31';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rental_settings'::regclass) THEN
    RAISE EXCEPTION 'ABORT: RLS is not enabled on rental_settings';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rental_settings') THEN
    RAISE EXCEPTION 'ABORT: rental_settings has a policy; it must have none';
  END IF;
END $$;

-- The singleton and the range, proven by trying them. Each attempt runs in a
-- savepoint and is rolled back; only its refusal is kept, as a line in the
-- result set below.
CREATE TEMP TABLE m025_probes (ord int, detail text, verdict text) ON COMMIT DROP;
DO $$
DECLARE
  v_stored time; -- survives the probe's own rollback, which a row would not
BEGIN
  BEGIN
    INSERT INTO rental_settings (id, max_days_ahead) VALUES (2, 31);
    INSERT INTO m025_probes VALUES (9, 'a second row (id 2) was ACCEPTED', 'FAIL');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO m025_probes VALUES (9, 'a second row (id 2) is refused: ' || SQLERRM, 'PASS');
  END;
  BEGIN
    UPDATE rental_settings SET max_days_ahead = 0 WHERE id = 1;
    INSERT INTO m025_probes VALUES (10, 'max_days_ahead 0 was ACCEPTED', 'FAIL');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO m025_probes VALUES (10, 'max_days_ahead 0 is refused: ' || SQLERRM, 'PASS');
  END;
  BEGIN
    UPDATE rental_items SET booking_closes_at = '24:00' WHERE item_id = (SELECT min(item_id) FROM rental_items);
    SELECT booking_closes_at INTO v_stored FROM rental_items WHERE item_id = (SELECT min(item_id) FROM rental_items);
    -- Undo the write: the savepoint rolls back, v_stored keeps what was read.
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'undo the 24:00 probe';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
  INSERT INTO m025_probes VALUES (11,
    'a close of 24:00 reads back as ' || COALESCE(v_stored::text, '(nothing)') || ' (then undone)',
    CASE WHEN v_stored = '24:00' THEN 'PASS' ELSE 'FAIL' END);
  BEGIN
    UPDATE rental_items SET booking_opens_at = '17:00', booking_closes_at = '07:00'
     WHERE item_id = (SELECT min(item_id) FROM rental_items);
    INSERT INTO m025_probes VALUES (12, 'an open after the close was ACCEPTED', 'FAIL');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO m025_probes VALUES (12, 'an open after the close is refused: ' || SQLERRM, 'PASS');
  END;
END $$;

-- A probe that was ACCEPTED left its write in place, so it is a hard stop
-- too: the whole transaction aborts, even on the COMMIT copy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM m025_probes WHERE verdict <> 'PASS') THEN
    RAISE EXCEPTION 'ABORT: %', (SELECT string_agg(detail, '; ' ORDER BY ord) FROM m025_probes WHERE verdict <> 'PASS');
  END IF;
  IF (SELECT count(*) FROM m025_probes) <> 4 THEN
    RAISE EXCEPTION 'ABORT: expected 4 probe results, got %', (SELECT count(*) FROM m025_probes);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- Expected: rows 1 to 12, every verdict PASS (rows 1 and 2 are INFO).
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'items on file',
         (SELECT item_count::text FROM m025_before) || ' rows (expected 9)', 'INFO'
  UNION ALL
  SELECT 2, 'bookings on file',
         (SELECT booking_count::text FROM m025_before) || ' rows, not touched', 'INFO'
  UNION ALL
  SELECT 3, 'both hour columns are NOT NULL time',
         (SELECT string_agg(column_name || ' ' || data_type || ' default ' || COALESCE(column_default, 'none'), '; ' ORDER BY column_name)
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'rental_items'
             AND column_name IN ('booking_opens_at', 'booking_closes_at')),
         CASE WHEN (SELECT count(*) FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'rental_items'
                       AND column_name IN ('booking_opens_at', 'booking_closes_at')
                       AND data_type = 'time without time zone' AND is_nullable = 'NO') = 2
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 4, 'every item reads 07:00 to 17:00',
         (SELECT count(*)::text FROM rental_items WHERE booking_opens_at = '07:00' AND booking_closes_at = '17:00')
           || ' of ' || (SELECT count(*)::text FROM rental_items),
         CASE WHEN NOT EXISTS (SELECT 1 FROM rental_items WHERE booking_opens_at <> '07:00' OR booking_closes_at <> '17:00')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'item count and every item''s other columns unchanged (md5)',
         (SELECT item_hash FROM m025_before),
         CASE WHEN (SELECT count(*) FROM rental_items) = (SELECT item_count FROM m025_before)
                AND (SELECT md5(COALESCE(string_agg(item_id || ',' || name || ',' || type || ',' || quantity_total || ','
                                                    || quantity_available || ',' || fee || ',' || is_active, ';' ORDER BY item_id), ''))
                       FROM rental_items) = (SELECT item_hash FROM m025_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 6, 'the hours CHECK exists and is valid',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                    WHERE conname = 'rental_items_booking_hours_order'), '(constraint missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_items_booking_hours_order' AND convalidated)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 7, 'rental_settings holds exactly one row: id 1, max_days_ahead 31',
         (SELECT count(*)::text FROM rental_settings) || ' row(s); '
           || COALESCE((SELECT 'id ' || id || ', max_days_ahead ' || max_days_ahead FROM rental_settings WHERE id = 1), '(no id 1)'),
         CASE WHEN (SELECT count(*) FROM rental_settings) = 1
                AND EXISTS (SELECT 1 FROM rental_settings WHERE id = 1 AND max_days_ahead = 31)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 8, 'RLS enabled on rental_settings, zero policies',
         'rls ' || (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.rental_settings'::regclass)
           || ', ' || (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rental_settings')
           || ' policies',
         CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rental_settings'::regclass)
                AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rental_settings')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT p.ord, CASE p.ord WHEN 9 THEN 'singleton: a second row is refused'
                           WHEN 10 THEN 'range: max_days_ahead 0 is refused'
                           WHEN 11 THEN 'a close of 24:00 can be stored'
                           ELSE 'an open after the close is refused' END,
         p.detail, p.verdict
    FROM m025_probes p
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
-- Change ROLLBACK to COMMIT once the result set above reads PASS throughout.
