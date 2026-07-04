// Two-stage fuzzy name-matching engine (thesis research contribution).
//
// Stage 1 — candidate blocking, in PostgreSQL: the match_resident_candidates
//   function (migration 003) uses pg_trgm's % operator against the GIN trigram
//   indexes on resident_records.first_name/last_name (migration 001) to narrow
//   the whole table to a small candidate set without a sequential scan.
// Stage 2 — fine scoring, in Node: Jaro-Winkler similarity on the normalized
//   "first last" full name of each candidate, filtered and ranked.
//
// Blocking is tuned for recall (missing a true duplicate here is
// unrecoverable); scoring is tuned for precision (its job is to reject the
// same-surname-different-person pairs that blocking lets through).

const supabase = require('../config/supabase');
const jaroWinkler = require('jaro-winkler');

// Tunable pipeline parameters. The precision/recall/F1 evaluation will sweep
// these; any of them can be overridden per call via findMatches() options.
const DEFAULTS = {
  // Stage 1: minimum pg_trgm similarity() between the query and a stored
  // first_name OR last_name. 0.3 is pg_trgm's own default and is deliberately
  // permissive — on the planted test pairs, blocking similarities run well
  // above it, but rarer heavy misspellings should still survive to Stage 2.
  trigramThreshold: 0.3,
  // Stage 2: minimum Jaro-Winkler score on the full name. On the seeded test
  // data the planted duplicate pairs score 0.859–0.987 while non-duplicate
  // controls peak at ~0.64, so 0.85 separates them with margin on both sides.
  scoreThreshold: 0.85,
  // Cap on Stage 1 candidates (defense against very common names).
  maxCandidates: 50,
};

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find resident records whose name is a likely match for the given name.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {object} [options] - overrides for DEFAULTS
 *   (trigramThreshold, scoreThreshold, maxCandidates)
 * @returns {Promise<Array>} candidates sorted by score (highest first), each:
 *   { resident_id, first_name, middle_name, last_name, suffix, birthdate,
 *     address, trigram: { first_name, last_name }, score }
 */
async function findMatches(firstName, lastName, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const first = normalize(firstName);
  const last = normalize(lastName);
  if (!first || !last) {
    throw new Error('findMatches requires both a first name and a last name');
  }

  // Stage 1 — trigram blocking inside PostgreSQL
  const { data: candidates, error } = await supabase.rpc('match_resident_candidates', {
    p_first_name: first,
    p_last_name: last,
    p_trgm_threshold: opts.trigramThreshold,
    p_limit: opts.maxCandidates,
  });
  if (error) {
    const hint = error.message.includes('match_resident_candidates')
      ? ' (apply backend/migrations/003_match_resident_candidates_fn.sql in the Supabase SQL Editor)'
      : '';
    throw new Error(`Stage 1 blocking query failed: ${error.message}${hint}`);
  }

  const query = `${first} ${last}`;

  // Stage 2 — Jaro-Winkler scoring, filter, rank
  return candidates
    .map((c) => ({
      resident_id: c.resident_id,
      first_name: c.first_name,
      middle_name: c.middle_name,
      last_name: c.last_name,
      suffix: c.suffix,
      birthdate: c.birthdate,
      address: c.address,
      trigram: {
        first_name: c.first_name_similarity,
        last_name: c.last_name_similarity,
      },
      score: jaroWinkler(query, normalize(`${c.first_name} ${c.last_name}`)),
    }))
    .filter((c) => c.score >= opts.scoreThreshold)
    .sort((a, b) => b.score - a.score);
}

module.exports = { findMatches, DEFAULTS };
