-- ===========================================================================
-- Migration 021 — users.email must be unique, case-insensitively.
--
-- WHY. users.email is the key password reset matches on
-- (eligibleResidentByEmail in routes/auth.js). Until now the column carried
-- only NOT NULL — migration 001 gave UNIQUE to username and not to email —
-- so two accounts could share an address. When they did, the lookup's
-- Array.find() returned whichever row PostgREST happened to order first, with
-- NO ORDER BY anywhere in that query: one account silently received every
-- reset link and the other could never recover its password, with nothing
-- reporting the collision. This database has already held duplicate emails
-- (rod, rods and rad all shared one before two of them were deleted).
--
-- A FUNCTIONAL INDEX ON lower(email), NOT A PLAIN UNIQUE (email). The
-- application compares addresses case-insensitively (routes/auth.js, the
-- exact comparison after the ilike prefilter), so a plain column constraint
-- would happily store Marlon@x.com alongside marlon@x.com — two rows that the
-- code then treats as the same address, which is precisely the ambiguity this
-- index exists to remove. lower() is IMMUTABLE, which is what makes it
-- indexable; note this must be CREATE UNIQUE INDEX, because ALTER TABLE ...
-- ADD CONSTRAINT ... UNIQUE accepts only a column list, not an expression.
--
-- SAFE TO APPLY AS-IS: measured before writing this, all 18 accounts hold
-- distinct addresses when lowercased and trimmed, none carries surrounding
-- whitespace, and none contains an uppercase letter. No data fix is needed
-- first. The review block below re-checks that at run time rather than
-- trusting this paragraph.
--
-- LOCKING: CREATE UNIQUE INDEX takes an ACCESS EXCLUSIVE lock on users for
-- the duration of the build, blocking reads and writes. At 18 rows that is
-- microseconds and irrelevant. It would NOT be irrelevant against the full
-- barangay masterlist (~5,564 residents, most of whom would eventually have
-- accounts) or against a live system taking traffic — there the form is
-- CREATE UNIQUE INDEX CONCURRENTLY, which takes a weaker lock but CANNOT run
-- inside a transaction block, so it could not be wrapped and reviewed the way
-- this one is. Recorded so the trade is a decision rather than a surprise.
--
-- Chapter 3 TABLE 9 (users) needs the matching manuscript edit, and so does
-- the ERD page `amoncio - erd`. See CLAUDE.md — a migration is not finished
-- when it is applied.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Refuse to create the index if the data would not support it. CREATE UNIQUE
-- INDEX would fail on its own with a duplicate-key error, but it names one
-- colliding pair and stops; this reports every collision at once, which is
-- what someone fixing the data actually needs.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dupes int;
  v_list  text;
BEGIN
  SELECT count(*), COALESCE(string_agg(d.addr || ' x' || d.n, '; '), '')
    INTO v_dupes, v_list
    FROM (
      SELECT lower(btrim(email)) AS addr, count(*) AS n
        FROM users
       GROUP BY lower(btrim(email))
      HAVING count(*) > 1
    ) AS d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'ABORT: % address(es) are held by more than one account, so a unique index cannot be created. Fix the data first. Collisions: %',
      v_dupes, v_list;
  END IF;
END $$;

CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));

-- ---------------------------------------------------------------------------
-- ONE result set — the Supabase editor shows only the last one.
-- ---------------------------------------------------------------------------
SELECT ord, check_name, detail, verdict
FROM (
  SELECT 1, 'accounts on file',
         (SELECT count(*)::text FROM users) || ' rows', 'INFO'
  UNION ALL
  SELECT 2, 'distinct addresses (lowercased, trimmed)',
         (SELECT count(DISTINCT lower(btrim(email)))::text FROM users) || ' of ' ||
         (SELECT count(*)::text FROM users),
         CASE WHEN (SELECT count(DISTINCT lower(btrim(email))) FROM users)
                 = (SELECT count(*) FROM users)
              THEN 'PASS (no collisions)' ELSE 'FAIL' END
  UNION ALL
  SELECT 3, 'addresses carrying surrounding whitespace',
         (SELECT count(*)::text FROM users WHERE email <> btrim(email)),
         CASE WHEN (SELECT count(*) FROM users WHERE email <> btrim(email)) = 0
              THEN 'PASS' ELSE 'CHECK — the index normalises case, NOT whitespace' END
  UNION ALL
  SELECT 4, 'index users_email_lower_unique exists',
         COALESCE((SELECT indexdef FROM pg_indexes
                    WHERE schemaname = 'public' AND indexname = 'users_email_lower_unique'),
                  '(not created)'),
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                            WHERE schemaname = 'public' AND indexname = 'users_email_lower_unique')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 5, 'it is UNIQUE',
         CASE WHEN EXISTS (
                SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                 WHERE c.relname = 'users_email_lower_unique' AND i.indisunique)
              THEN 'indisunique = true' ELSE 'NOT unique' END,
         CASE WHEN EXISTS (
                SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                 WHERE c.relname = 'users_email_lower_unique' AND i.indisunique)
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL
  SELECT 6, 'username uniqueness is untouched',
         COALESCE((SELECT 'users_username_key still present' FROM pg_indexes
                    WHERE schemaname = 'public' AND indexname = 'users_username_key'),
                  '*** MISSING ***'),
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                            WHERE schemaname = 'public' AND indexname = 'users_username_key')
              THEN 'PASS' ELSE 'FAIL' END
) AS x (ord, check_name, detail, verdict)
ORDER BY ord;

ROLLBACK;
-- Change ROLLBACK to COMMIT once the result set above reads PASS throughout.
