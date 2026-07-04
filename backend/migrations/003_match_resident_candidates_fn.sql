-- ============================================================================
-- BrgyServe — Migration 003: Stage 1 blocking function for the fuzzy
-- name-matching research component.
--
-- match_resident_candidates(first, last, threshold, limit) returns resident
-- records whose first_name OR last_name is trigram-similar to the query name.
-- The backend calls it via RPC (supabase-js cannot run raw SQL), and Stage 2
-- (Jaro-Winkler) scores the rows it returns in Node.
--
-- How it uses the GIN indexes from migration 001:
--   * The % operator ("similar enough") is pg_trgm's index-aware operator.
--     It decomposes the query string into trigrams and uses the GIN index to
--     fetch only rows sharing enough trigrams — a bitmap index scan, so the
--     table is never sequentially scanned per lookup.
--   * % compares against the session GUC pg_trgm.similarity_threshold, not a
--     literal, so the function first calls set_limit(p_trgm_threshold) to make
--     the caller's blocking threshold take effect. (This is why it's plpgsql.)
--   * The OR across first_name/last_name uses both GIN indexes (BitmapOr),
--     keeping recall high: a candidate survives blocking if EITHER name part
--     is roughly similar.
--   * similarity() in the ORDER BY / select list is only computed for the few
--     rows that survive the index scan.
--
-- pg_trgm lower-cases text before extracting trigrams, so Stage 1 is
-- case-insensitive by construction.
-- ============================================================================

CREATE OR REPLACE FUNCTION match_resident_candidates(
    p_first_name     text,
    p_last_name      text,
    p_trgm_threshold real    DEFAULT 0.3,
    p_limit          integer DEFAULT 50
)
RETURNS TABLE (
    resident_id           bigint,
    first_name            varchar(100),
    middle_name           varchar(100),
    last_name             varchar(100),
    suffix                varchar(20),
    birthdate             date,
    address               varchar(255),
    first_name_similarity real,
    last_name_similarity  real
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- % reads pg_trgm.similarity_threshold; scope the caller's blocking
    -- threshold to this session so the GIN index scan honors it
    PERFORM set_limit(p_trgm_threshold);

    RETURN QUERY
    SELECT
        r.resident_id,
        r.first_name,
        r.middle_name,
        r.last_name,
        r.suffix,
        r.birthdate,
        r.address,
        similarity(r.first_name, p_first_name) AS first_name_similarity,
        similarity(r.last_name,  p_last_name)  AS last_name_similarity
    FROM resident_records r
    WHERE r.is_archived = false
      AND (r.first_name % p_first_name OR r.last_name % p_last_name)
    ORDER BY greatest(
        similarity(r.first_name, p_first_name),
        similarity(r.last_name,  p_last_name)
    ) DESC
    LIMIT p_limit;
END;
$$;
