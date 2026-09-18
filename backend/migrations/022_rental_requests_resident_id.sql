-- ===========================================================================
-- Migration 022 — rental_requests gains resident_id, plus a second path for a
-- borrower who has no resident_records entry to point it at.
--
-- WHY resident_id AT ALL. Walk-in encoding: the Secretary files a booking for
-- a resident who is standing at the barangay hall. Today rental_requests has
-- exactly one identity column, requested_by_user_id -> users, and the
-- resident is only reachable INDIRECTLY through it: requested_by_user_id ->
-- users -> profiles -> resident_records. That chain is correct only while the
-- submitter and the subject are the same person. The moment a Secretary
-- submits on someone else's behalf it resolves to the SECRETARY -- the
-- charge, the notification and every "whose booking is this" read would name
-- barangay staff instead of the resident. No column existed that could hold
-- the difference. document_requests has carried this exact pair since
-- migration 001 (requested_by_user_id + resident_id, both NOT NULL); this
-- gives rental_requests the same resident_id column.
--
-- WHY resident_id IS NULLABLE HERE AND WAS NOT LEFT NOT NULL (this migration
-- was written once already with NOT NULL and is being revised in place before
-- ever being applied -- confirmed unapplied, so no rollback is needed).
-- Barangay practice, confirmed as real and current rather than hypothetical:
-- people from OTHER barangays rent select items, mostly costumes. They have
-- no masterlist entry, so they can never have a resident_id -- there is no
-- row in resident_records for a NOT NULL FK to point to. document_requests is
-- DELIBERATELY NOT given this treatment: Chapter 1 already restricts document
-- requests to registered residents only, so that table keeps its NOT NULL
-- resident_id exactly as migration 001 defined it, unchanged by this file.
--
-- outside_borrower_name / outside_borrower_contact hold that borrower's
-- particulars when there is no resident_id to carry them instead.
--
-- THE CHECK CONSTRAINT IS EXACTLY-ONE-PATH, NEVER BOTH, NEVER NEITHER. A row
-- is either a resident's booking (resident_id set, both outside_borrower_*
-- columns null) or an outside borrower's (resident_id null, BOTH
-- outside_borrower_* columns set) -- never a partial state, such as a name
-- with no contact number, and never both a resident_id and a typed name on
-- the same row.
--
-- THIS IS NOT THE SAME SHAPE AS dispute_parties, AND IT GOES FURTHER.
-- dispute_parties (migration 001) already carries a nullable resident_id
-- beside typed first_name/last_name for exactly this reason -- CLAUDE.md
-- documents it as "a party is EITHER a linked resident... OR a typed
-- non-resident walk-in" -- but that table has NO CHECK constraint anywhere in
-- the schema; the either/or rule lives only in routes/disputes.js and nothing
-- stops a row holding both or neither at the database level. This migration
-- is the first time that shape gets a CHECK enforcing it in the database
-- itself, not a repetition of an existing guarantee.
--
-- THE BACKFILL IS UNCHANGED IN LOGIC, ONLY IN WHAT FOLLOWS IT. Every booking
-- on file today is self-service -- there has never been another way to
-- create one, and the outside-borrower path did not exist before this
-- migration -- so every existing row resolves through the resident_id
-- branch of the CHECK and none through the outside-borrower branch. Walking
-- requested_by_user_id -> profiles -> resident_id and writing that down
-- loses nothing; it just makes explicit what was previously implied by the
-- join. The guard below still aborts, naming every unresolved row, if any
-- booking's submitter has no linked resident -- that row would satisfy
-- NEITHER branch of the CHECK (resident_id null, outside_borrower_* also
-- null) and the CHECK's creation would fail on it regardless; the guard
-- exists so the failure names the row instead of reporting a bare
-- constraint violation.
--
-- NO INDEX on resident_id, matching document_requests.resident_id, which has
-- none either. Nothing filters bookings by resident yet.
--
-- SAFETY. Additive: two new nullable columns, one now-nullable column that
-- was never NOT NULL in production (this file was written but never applied),
-- and one CHECK that only existing rows already satisfy. resident_id is
-- absent from RENTAL_FIELDS in routes/rentalRequests.js until the Part B code
-- change lands, so no existing query selects it and no response shape
-- changes when this is applied. Apply this BEFORE that code change, never
-- after.
--
-- Chapter 3 TABLE 14 (rental_requests) needs the matching manuscript edit,
-- and so does the ERD page `amoncio - erd`. See CLAUDE.md -- a migration is
-- not finished when it is applied.
-- ===========================================================================

BEGIN;

ALTER TABLE rental_requests
    ADD COLUMN resident_id             bigint REFERENCES resident_records (resident_id),
    ADD COLUMN outside_borrower_name   text,
    ADD COLUMN outside_borrower_contact text;

-- ---------------------------------------------------------------------------
-- Backfill: the resident each existing booking already belonged to, by way of
-- the submitter's profile link. Guarded with resident_id IS NULL so re-running
-- the block inside one session cannot overwrite anything already set.
-- ---------------------------------------------------------------------------
UPDATE rental_requests rr
   SET resident_id = p.resident_id
  FROM profiles p
 WHERE p.user_id = rr.requested_by_user_id
   AND p.resident_id IS NOT NULL
   AND rr.resident_id IS NULL;

-- ---------------------------------------------------------------------------
-- Refuse to continue if any booking could not be resolved to a resident. The
-- outside-borrower path did not exist before this migration, so a row that is
-- still unresolved here is not a legitimate guest booking -- it is a
-- submitter with no linked resident, and the CHECK constraint below would
-- reject it either way (resident_id null AND both outside_borrower_* columns
-- null satisfies neither branch). This names the row instead of letting that
-- happen as a bare constraint-violation error.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_orphans int;
  v_list    text;
BEGIN
  SELECT count(*), COALESCE(string_agg(
           'request_id ' || rr.request_id || ' (submitter user_id ' || rr.requested_by_user_id || ')', '; '), '')
    INTO v_orphans, v_list
    FROM rental_requests rr
   WHERE rr.resident_id IS NULL;

  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'ABORT: % booking(s) have no resident reachable through their submitter''s profile, so they satisfy neither branch of the resident/outside-borrower CHECK. Fix the data first. Unresolved: %',
      v_orphans, v_list;
  END IF;
END $$;

ALTER TABLE rental_requests
    ADD CONSTRAINT rental_requests_resident_xor_outside_borrower CHECK (
        (resident_id IS NOT NULL AND outside_borrower_name IS NULL AND outside_borrower_contact IS NULL)
        OR
        (resident_id IS NULL AND outside_borrower_name IS NOT NULL AND outside_borrower_contact IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'bookings on file',
         (SELECT count(*)::text FROM rental_requests) || ' rows', 'INFO'
  UNION ALL
  SELECT 2, 'existing rows resolved through the resident_id path',
         (SELECT count(*)::text FROM rental_requests
           WHERE resident_id IS NOT NULL AND outside_borrower_name IS NULL AND outside_borrower_contact IS NULL)
         || ' of ' || (SELECT count(*)::text FROM rental_requests),
         CASE WHEN (SELECT count(*) FROM rental_requests
                      WHERE resident_id IS NOT NULL AND outside_borrower_name IS NULL AND outside_borrower_contact IS NULL)
                 = (SELECT count(*) FROM rental_requests)
              THEN 'PASS (100% via resident_id, as expected — the outside-borrower path is new)' ELSE 'FAIL' END
  UNION ALL
  SELECT 3, 'existing rows resolved through the outside-borrower path',
         (SELECT count(*)::text FROM rental_requests
           WHERE resident_id IS NULL AND outside_borrower_name IS NOT NULL AND outside_borrower_contact IS NOT NULL),
         CASE WHEN (SELECT count(*) FROM rental_requests
                      WHERE resident_id IS NULL AND outside_borrower_name IS NOT NULL AND outside_borrower_contact IS NOT NULL) = 0
              THEN 'PASS (0%, as expected)' ELSE 'FAIL — an existing row claims to be a guest booking, which should be impossible' END
  UNION ALL
  SELECT 4, 'rows satisfying neither branch (would violate the CHECK)',
         (SELECT count(*)::text FROM rental_requests
           WHERE NOT (
             (resident_id IS NOT NULL AND outside_borrower_name IS NULL AND outside_borrower_contact IS NULL)
             OR
             (resident_id IS NULL AND outside_borrower_name IS NOT NULL AND outside_borrower_contact IS NOT NULL)
           )),
         CASE WHEN (SELECT count(*) FROM rental_requests
                      WHERE NOT (
                        (resident_id IS NOT NULL AND outside_borrower_name IS NULL AND outside_borrower_contact IS NULL)
                        OR
                        (resident_id IS NULL AND outside_borrower_name IS NOT NULL AND outside_borrower_contact IS NOT NULL)
                      )) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'backfill agrees with the old implicit join',
         (SELECT count(*)::text FROM rental_requests rr
            JOIN profiles p ON p.user_id = rr.requested_by_user_id
           WHERE p.resident_id IS DISTINCT FROM rr.resident_id) || ' row(s) disagree',
         CASE WHEN (SELECT count(*) FROM rental_requests rr
                      JOIN profiles p ON p.user_id = rr.requested_by_user_id
                     WHERE p.resident_id IS DISTINCT FROM rr.resident_id) = 0
              THEN 'PASS (no existing booking changed meaning)' ELSE 'FAIL' END
  UNION ALL
  SELECT 6, 'resident_id is nullable (not NOT NULL)',
         COALESCE((SELECT is_nullable FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'rental_requests'
                      AND column_name = 'resident_id'), '(column missing)'),
         CASE WHEN (SELECT is_nullable FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'rental_requests'
                       AND column_name = 'resident_id') = 'YES'
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 7, 'outside_borrower_name exists, nullable text',
         COALESCE((SELECT data_type || ', ' || is_nullable FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'rental_requests'
                      AND column_name = 'outside_borrower_name'), '(column missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_schema = 'public' AND table_name = 'rental_requests'
                               AND column_name = 'outside_borrower_name'
                               AND data_type = 'text' AND is_nullable = 'YES')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 8, 'outside_borrower_contact exists, nullable text',
         COALESCE((SELECT data_type || ', ' || is_nullable FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'rental_requests'
                      AND column_name = 'outside_borrower_contact'), '(column missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_schema = 'public' AND table_name = 'rental_requests'
                               AND column_name = 'outside_borrower_contact'
                               AND data_type = 'text' AND is_nullable = 'YES')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 9, 'the resident_id FK points at resident_records',
         COALESCE((SELECT ccu.table_name
                     FROM information_schema.table_constraints tc
                     JOIN information_schema.constraint_column_usage ccu
                       ON ccu.constraint_name = tc.constraint_name
                     JOIN information_schema.key_column_usage kcu
                       ON kcu.constraint_name = tc.constraint_name
                    WHERE tc.table_name = 'rental_requests'
                      AND tc.constraint_type = 'FOREIGN KEY'
                      AND kcu.column_name = 'resident_id'
                    LIMIT 1), '(no FK)'),
         CASE WHEN EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                  JOIN information_schema.constraint_column_usage ccu
                    ON ccu.constraint_name = tc.constraint_name
                  JOIN information_schema.key_column_usage kcu
                    ON kcu.constraint_name = tc.constraint_name
                 WHERE tc.table_name = 'rental_requests'
                   AND tc.constraint_type = 'FOREIGN KEY'
                   AND kcu.column_name = 'resident_id'
                   AND ccu.table_name = 'resident_records')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 10, 'CHECK constraint exists and is VALID',
         COALESCE((SELECT CASE WHEN convalidated THEN 'valid' ELSE 'NOT VALIDATED' END
                     FROM pg_constraint
                    WHERE conname = 'rental_requests_resident_xor_outside_borrower'),
                  '(constraint missing)'),
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conname = 'rental_requests_resident_xor_outside_borrower'
                              AND convalidated)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 11, 'document_requests.resident_id is untouched (still NOT NULL)',
         COALESCE((SELECT is_nullable FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'document_requests'
                      AND column_name = 'resident_id'), '(column missing)'),
         CASE WHEN (SELECT is_nullable FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'document_requests'
                       AND column_name = 'resident_id') = 'NO'
              THEN 'PASS (Chapter 1 residents-only rule unchanged)' ELSE 'FAIL' END
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
-- Change ROLLBACK to COMMIT once the result set above reads PASS throughout.
