// Test harness for the two-stage fuzzy name-matching engine.
// Prereqs (run in the Supabase SQL Editor first):
//   1. backend/migrations/003_match_resident_candidates_fn.sql
//   2. backend/seeds/test_resident_records.sql
// Run with: npm run match:test   (from /backend)

require('dotenv').config();

const { findMatches, DEFAULTS } = require('../src/services/nameMatching');

const LOOKUPS = [
  { label: 'Exact name (control)',                       first: 'Rodrigo',   last: 'Bautista' },
  { label: 'Transposed letters: Rodirgo -> Rodrigo',     first: 'Rodirgo',   last: 'Bautista' },
  { label: 'Misspelled surname: Santoz -> Santos',       first: 'Jose',      last: 'Santoz' },
  { label: 'Abbreviated given name: Ma. -> Maria',       first: 'Ma. Elena', last: 'Santos' },
  { label: 'Enye/encoding: Nino Penaflor -> Niño Peñaflor', first: 'Nino',   last: 'Penaflor' },
  { label: 'Dropped letter: Anabele -> Anabelle',        first: 'Anabele',   last: 'Garcia' },
  { label: 'Missing given name: Juan -> Juan Miguel',    first: 'Juan',      last: 'Dela Cruz' },
  { label: 'No match expected (control)',                first: 'Zenaida',   last: 'Quisumbing' },
];

function fullName(m) {
  const name = [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ');
  return m.suffix ? `${name}, ${m.suffix}` : name;
}

function printResults(results) {
  if (results.length === 0) {
    console.log('    (no matches at or above the score threshold)');
    return;
  }
  for (const m of results) {
    console.log(
      `    ${m.score.toFixed(4)}  #${String(m.resident_id).padEnd(4)} ${fullName(m).padEnd(34)}` +
        ` trgm first=${m.trigram.first_name.toFixed(2)} last=${m.trigram.last_name.toFixed(2)}` +
        `  b. ${m.birthdate ?? '—'}`
    );
  }
}

async function main() {
  console.log('Two-stage fuzzy name matching — test harness');
  console.log(
    `Defaults: trigramThreshold=${DEFAULTS.trigramThreshold} (Stage 1 blocking), ` +
      `scoreThreshold=${DEFAULTS.scoreThreshold} (Stage 2 Jaro-Winkler), ` +
      `maxCandidates=${DEFAULTS.maxCandidates}`
  );

  for (const { label, first, last } of LOOKUPS) {
    console.log(`\n== ${label}`);
    console.log(`   query: first="${first}" last="${last}"`);
    const results = await findMatches(first, last);
    printResults(results);
  }

  // Threshold tuning demo: sweep the Stage 2 threshold on the hardest planted
  // pair (abbreviation, JW ~0.859) to show what the evaluation will explore.
  console.log('\n== Threshold sweep demo: "Ma. Elena Santos" at different scoreThresholds');
  for (const t of [0.95, 0.9, 0.85, 0.8]) {
    const results = await findMatches('Ma. Elena', 'Santos', { scoreThreshold: t });
    console.log(`   scoreThreshold=${t.toFixed(2)} -> ${results.length} match(es):` +
      ` [${results.map((m) => `${fullName(m)} @${m.score.toFixed(3)}`).join('; ')}]`);
  }

  console.log('\nDone. Tune thresholds via the options argument of findMatches().');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
