-- ===========================================================================
-- Migration 023 — rental_requests gains cancellation_reason.
--
-- WHY. From 25 Oct 2026 the Secretary must say WHY a booking is cancelled:
-- the reason is stored on the booking and sent to the borrower in the
-- cancellation notice. A resident who cancels their own booking online may
-- give one too. Nothing on rental_requests could hold it: return_note belongs
-- to a return, and purpose is the borrower's own words.
--
-- THE COLUMN. text, NULL, no default, no index, no backfill. NULL means no
-- reason was given — every booking cancelled before this migration, and a
-- resident's own cancel without one. A reason is 3 to 300 characters after
-- trimming, enforced HERE by a named CHECK as well as by the API
-- (parseReason() in routes/rentalRequests.js, which counts characters the way
-- Postgres does), so a direct write cannot store an empty or a 2,000-word
-- reason either.
--
-- ORDER OF DEPLOYMENT. Apply this BEFORE the code that writes the column is
-- deployed: the new cancel routes write cancellation_reason, and without the
-- column every cancel would fail with a 500. The column is harmless to the
-- code running today, which never selects or writes it.
--
-- THE FREE TEXT STAYS HERE. The activity log records only that a reason was
-- given (reason_given), never its text: CLAUDE.md, "Never log free text".
--
-- GUARDED. Hard stops run before the change (the table exists, the column and
-- its constraint do not, a snapshot of every booking's id, status and start),
-- the same checks run again after it, and ONE result set reports PASS/FAIL —
-- the Supabase editor shows only the last one. The block ends in ROLLBACK:
-- run it, read the result set, and only then change the last statement to
-- COMMIT and run it again (CLAUDE.md, Standing Rules).
--
-- Chapter 3 TABLE 14 (rental_requests) needs the matching manuscript edit,
-- and so does the ERD page `amoncio - erd`. See CLAUDE.md — a migration is
-- not finished when it is applied.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Before: hard stops, and a snapshot of every existing booking to compare
-- against afterwards. The snapshot table lives only inside this transaction.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.rental_requests') IS NULL THEN
    RAISE EXCEPTION 'ABORT: table public.rental_requests does not exist — wrong database?';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rental_requests'
                AND column_name = 'cancellation_reason') THEN
    RAISE EXCEPTION 'ABORT: rental_requests.cancellation_reason already exists — migration 023 has already been applied';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_requests_cancellation_reason_length') THEN
    RAISE EXCEPTION 'ABORT: constraint rental_requests_cancellation_reason_length already exists';
  END IF;
END $$;

CREATE TEMP TABLE m023_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM rental_requests) AS row_count,
  (SELECT md5(COALESCE(string_agg(request_id || ',' || status || ',' || start_datetime::text, ';' ORDER BY request_id), ''))
     FROM rental_requests) AS row_hash,
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rental_requests') AS index_count,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rental_requests') AS column_count;

-- ---------------------------------------------------------------------------
-- The change.
-- ---------------------------------------------------------------------------
ALTER TABLE rental_requests
    ADD COLUMN IF NOT EXISTS cancellation_reason text NULL
    CONSTRAINT rental_requests_cancellation_reason_length CHECK (
        cancellation_reason IS NULL
        OR char_length(btrim(cancellation_reason)) BETWEEN 3 AND 300
    );

-- ---------------------------------------------------------------------------
-- After: the same checks, as hard stops. Any failure aborts the transaction,
-- so nothing is kept even on the COMMIT copy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b m023_before%ROWTYPE;
BEGIN
  SELECT * INTO b FROM m023_before;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'rental_requests'
                    AND column_name = 'cancellation_reason' AND data_type = 'text'
                    AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'ABORT: cancellation_reason is missing, or is not a nullable text column with no default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rental_requests_cancellation_reason_length' AND convalidated) THEN
    RAISE EXCEPTION 'ABORT: the length CHECK is missing or not validated';
  END IF;
  IF (SELECT count(*) FROM rental_requests) <> b.row_count THEN
    RAISE EXCEPTION 'ABORT: the booking count changed (% before)', b.row_count;
  END IF;
  IF (SELECT md5(COALESCE(string_agg(request_id || ',' || status || ',' || start_datetime::text, ';' ORDER BY request_id), ''))
        FROM rental_requests) <> b.row_hash THEN
    RAISE EXCEPTION 'ABORT: an existing booking''s id, status or start changed';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_requests WHERE cancellation_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'ABORT: an existing booking has a cancellation_reason — there must be no backfill';
  END IF;
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rental_requests') <> b.index_count THEN
    RAISE EXCEPTION 'ABORT: the index count on rental_requests changed';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rental_requests') <> b.column_count + 1 THEN
    RAISE EXCEPTION 'ABORT: expected exactly one new column on rental_requests';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- Expected: rows 1 to 8, every verdict PASS (row 1 is INFO).
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'bookings on file',
         (SELECT row_count::text FROM m023_before) || ' rows', 'INFO'
  UNION ALL
  SELECT 2, 'cancellation_reason is nullable text with no default',
         COALESCE((SELECT data_type || ', nullable ' || is_nullable || ', default ' || COALESCE(column_default, 'none')
                     FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'rental_requests'
                      AND column_name = 'cancellation_reason'), '(column missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'rental_requests'
                              AND column_name = 'cancellation_reason' AND data_type = 'text'
                              AND is_nullable = 'YES' AND column_default IS NULL)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 3, 'the length CHECK exists and is valid',
         COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                    WHERE conname = 'rental_requests_cancellation_reason_length'), '(constraint missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conname = 'rental_requests_cancellation_reason_length' AND convalidated)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 4, 'booking count unchanged',
         (SELECT count(*)::text FROM rental_requests) || ' now, ' || (SELECT row_count::text FROM m023_before) || ' before',
         CASE WHEN (SELECT count(*) FROM rental_requests) = (SELECT row_count FROM m023_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'every booking''s id, status and start unchanged (md5)',
         (SELECT row_hash FROM m023_before),
         CASE WHEN (SELECT md5(COALESCE(string_agg(request_id || ',' || status || ',' || start_datetime::text, ';' ORDER BY request_id), ''))
                      FROM rental_requests) = (SELECT row_hash FROM m023_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 6, 'no backfill: every cancellation_reason is NULL',
         (SELECT count(*)::text FROM rental_requests WHERE cancellation_reason IS NOT NULL) || ' non-null',
         CASE WHEN NOT EXISTS (SELECT 1 FROM rental_requests WHERE cancellation_reason IS NOT NULL)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 7, 'no index added',
         (SELECT count(*)::text FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rental_requests')
           || ' now, ' || (SELECT index_count::text FROM m023_before) || ' before',
         CASE WHEN (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'rental_requests')
                 = (SELECT index_count FROM m023_before)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 8, 'exactly one column added',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'rental_requests')
           || ' now, ' || (SELECT column_count::text FROM m023_before) || ' before',
         CASE WHEN (SELECT count(*) FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'rental_requests')
                 = (SELECT column_count FROM m023_before) + 1
              THEN 'PASS' ELSE 'FAIL' END
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
-- Change ROLLBACK to COMMIT once the result set above reads PASS throughout.
