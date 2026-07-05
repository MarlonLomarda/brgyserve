// Evaluation harness for the two-stage fuzzy name-matching engine:
// precision / recall / F1 against a labeled ground-truth set.
//
// GROUND TRUTH — this manifest mirrors backend/seeds/test_resident_records.sql.
// The six planted duplicate pairs are the labeled POSITIVES; every other pair
// among the 36 seeded records is treated as a labeled NEGATIVE. That gives
// C(36,2) = 630 labeled pairs: 6 positive, 624 negative.
//
// NOTE: this is a small initial labeled set, to be expanded later with more
// records and manually reviewed labels. Keep the manifest in sync with the
// seed file. Records are matched to database rows by normalized
// (first_name, middle_name, last_name, birthdate), because resident_id values
// are auto-generated at seed time.
//
// METHOD
//   1. Resolve every manifest record to its resident_id in the database
//      (abort if any is missing or ambiguous — e.g. the seed was run twice).
//   2. For each labeled record, run the REAL engine
//      (findMatches, src/services/nameMatching.js) with scoreThreshold 0 so
//      every candidate that survives Stage 1 blocking comes back with its
//      Jaro-Winkler score. Results that are not labeled records (e.g. rows
//      created during app testing) are ignored; they do not affect metrics.
//   3. Each unordered labeled pair {A,B} gets score = max(score of B in
//      matches(A), score of A in matches(B)); a pair never surfaced by
//      blocking has no score and is predicted negative at every threshold —
//      so blocking misses correctly count against recall.
//   4. For each threshold t in SWEEP_THRESHOLDS, classify all 630 pairs:
//        predicted positive  = pair score exists and >= t
//        TP = predicted positive & labeled positive
//        FP = predicted positive & labeled negative
//        FN = predicted negative & labeled positive
//        TN = predicted negative & labeled negative
//      precision = TP/(TP+FP), recall = TP/(TP+FN), F1 = harmonic mean.
//
// The Stage 1 blocking threshold stays at the engine default for this sweep
// (Stage 2 sweep only); change TRIGRAM_THRESHOLD below to evaluate blocking.
//
// Run with: npm run match:eval   (from /backend)

require('dotenv').config();

const supabase = require('../src/config/supabase');
const { findMatches, DEFAULTS } = require('../src/services/nameMatching');

const SWEEP_THRESHOLDS = [0.75, 0.8, 0.85, 0.9, 0.95];
const TRIGRAM_THRESHOLD = DEFAULTS.trigramThreshold; // Stage 1 held constant
const MAX_CANDIDATES = 100; // high enough that blocking results are never truncated

// ---- Labeled records (mirrors seeds/test_resident_records.sql) -------------

const RECORDS = [
  // Planted duplicate pairs
  { key: 'p1a', first_name: 'Maria Elena', middle_name: 'Villamor', last_name: 'Santos', birthdate: '1985-03-14' },
  { key: 'p1b', first_name: 'Ma. Elena', middle_name: 'Villamor', last_name: 'Santos', birthdate: '1985-03-14' },
  { key: 'p2a', first_name: 'Jose', middle_name: 'Ramirez', last_name: 'Santos', birthdate: '1978-11-02' },
  { key: 'p2b', first_name: 'Jose', middle_name: 'Ramirez', last_name: 'Santoz', birthdate: '1978-11-02' },
  { key: 'p3a', first_name: 'Juan Miguel', middle_name: 'Torralba', last_name: 'Dela Cruz', birthdate: '1990-06-08' },
  { key: 'p3b', first_name: 'Juan', middle_name: null, last_name: 'Dela Cruz', birthdate: '1990-06-08' },
  { key: 'p4a', first_name: 'Rodrigo', middle_name: 'Cempron', last_name: 'Bautista', birthdate: '1969-01-25' },
  { key: 'p4b', first_name: 'Rodirgo', middle_name: 'Cempron', last_name: 'Bautista', birthdate: '1969-01-25' },
  { key: 'p5a', first_name: 'Anabelle', middle_name: 'Dagohoy', last_name: 'Garcia', birthdate: '1994-09-30' },
  { key: 'p5b', first_name: 'Anabele', middle_name: 'Dagohoy', last_name: 'Garcia', birthdate: '1994-09-30' },
  { key: 'p6a', first_name: 'Niño', middle_name: 'Salazar', last_name: 'Peñaflor', birthdate: '2001-12-16' },
  { key: 'p6b', first_name: 'Nino', middle_name: 'Salazar', last_name: 'Penaflor', birthdate: '2001-12-16' },
  // Fillers (labeled non-duplicates of everyone)
  { key: 'f01', first_name: 'Carmela', middle_name: 'Tan', last_name: 'Uy', birthdate: '1982-07-19' },
  { key: 'f02', first_name: 'Felipe', middle_name: 'Adlawan', last_name: 'Jumamoy', birthdate: '1955-05-01' },
  { key: 'f03', first_name: 'Rosario', middle_name: 'Bagotchay', last_name: 'Clarin', birthdate: '1948-08-27' },
  { key: 'f04', first_name: 'Andres', middle_name: 'Villamor', last_name: 'Relampagos', birthdate: '1975-02-11' },
  { key: 'f05', first_name: 'Teresita', middle_name: 'Cabrera', last_name: 'Galope', birthdate: '1963-10-05' },
  { key: 'f06', first_name: 'Manuel', middle_name: 'Dumadag', last_name: 'Tirol', birthdate: '1958-12-30' },
  { key: 'f07', first_name: 'Corazon', middle_name: 'Lagunay', last_name: 'Butalid', birthdate: '1970-04-22' },
  { key: 'f08', first_name: 'Ricardo', middle_name: 'Mendez', last_name: 'Sarabia', birthdate: '1987-06-15' },
  { key: 'f09', first_name: 'Lourdes', middle_name: 'Pacana', last_name: 'Bernido', birthdate: '1992-01-09' },
  { key: 'f10', first_name: 'Emilio', middle_name: 'Ratunil', last_name: 'Dagohoy', birthdate: '1966-09-17' },
  { key: 'f11', first_name: 'Consuelo', middle_name: 'Sabanal', last_name: 'Inting', birthdate: '1979-03-03' },
  { key: 'f12', first_name: 'Bienvenido', middle_name: 'Toribio', last_name: 'Bahian', birthdate: '1951-11-28' },
  { key: 'f13', first_name: 'Remedios', middle_name: 'Verdadero', last_name: 'Ramos', birthdate: '1984-05-24' },
  { key: 'f14', first_name: 'Crisanto', middle_name: 'Wenceslao', last_name: 'Aquino', birthdate: '1997-07-07' },
  { key: 'f15', first_name: 'Gemma', middle_name: 'Ybanez', last_name: 'Villanueva', birthdate: '1989-10-13' },
  { key: 'f16', first_name: 'Domingo', middle_name: 'Zamora', last_name: 'Pajo', birthdate: '1960-02-02' },
  { key: 'f17', first_name: 'Marites', middle_name: 'Alaba', last_name: 'Olaivar', birthdate: '1993-08-20' },
  { key: 'f18', first_name: 'Rolando', middle_name: 'Bongato', last_name: 'Bompat', birthdate: '1972-12-06' },
  { key: 'f19', first_name: 'Evangeline', middle_name: 'Curambao', last_name: 'Cabagnot', birthdate: '1981-04-18' },
  { key: 'f20', first_name: 'Norberto', middle_name: 'Digal', last_name: 'Lofranco', birthdate: '1956-06-29' },
  { key: 'f21', first_name: 'Editha', middle_name: 'Estoque', last_name: 'Maglajos', birthdate: '1968-01-31' },
  { key: 'f22', first_name: 'Wilfredo', middle_name: 'Fuentes', last_name: 'Ampoloquio', birthdate: '1976-09-08' },
  { key: 'f23', first_name: 'Perla', middle_name: 'Gutierrez', last_name: 'Tabaranza', birthdate: '1990-11-11' },
  { key: 'f24', first_name: 'Celso', middle_name: 'Horcerada', last_name: 'Doydora', birthdate: '1964-03-26' },
];

const POSITIVE_PAIRS = [
  ['p1a', 'p1b'],
  ['p2a', 'p2b'],
  ['p3a', 'p3b'],
  ['p4a', 'p4b'],
  ['p5a', 'p5b'],
  ['p6a', 'p6b'],
];

// ---- Helpers ----------------------------------------------------------------

function norm(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function identity(r) {
  const birth = r.birthdate ? String(r.birthdate).slice(0, 10) : '';
  return [norm(r.first_name), norm(r.middle_name), norm(r.last_name), birth].join('|');
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function label(r) {
  return [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
}

function fmt(x) {
  return x === null ? '  —  ' : x.toFixed(4);
}

// ---- Evaluation ---------------------------------------------------------------

async function resolveResidentIds() {
  const { data: rows, error } = await supabase
    .from('resident_records')
    .select('resident_id, first_name, middle_name, last_name, birthdate');
  if (error) throw new Error(`Failed to load resident_records: ${error.message}`);

  const byIdentity = new Map();
  for (const row of rows) {
    const id = identity(row);
    if (!byIdentity.has(id)) byIdentity.set(id, []);
    byIdentity.get(id).push(row.resident_id);
  }

  const keyByResidentId = new Map();
  const problems = [];
  for (const rec of RECORDS) {
    const matches = byIdentity.get(identity(rec)) || [];
    if (matches.length === 0) {
      problems.push(`missing: ${label(rec)} (${rec.birthdate}) — was the seed applied?`);
    } else if (matches.length > 1) {
      problems.push(`ambiguous: ${label(rec)} matches ${matches.length} rows — was the seed applied twice?`);
    } else {
      keyByResidentId.set(matches[0], rec.key);
    }
  }
  if (problems.length) {
    throw new Error(
      `Could not resolve the labeled set against the database:\n  - ${problems.join('\n  - ')}\n` +
        'Apply backend/seeds/test_resident_records.sql (once) in the Supabase SQL Editor.'
    );
  }
  return { keyByResidentId, extraDbRecords: rows.length - RECORDS.length };
}

async function collectPairScores(keyByResidentId) {
  // One engine call per labeled record with the Stage 2 filter disabled
  // (scoreThreshold 0), so we get the engine's own Jaro-Winkler score for
  // everything that survives Stage 1 blocking. Thresholds are then applied
  // offline to these engine-produced scores — identical computation, one pass.
  const pairScores = new Map();
  for (const rec of RECORDS) {
    const results = await findMatches(rec.first_name, rec.last_name, {
      trigramThreshold: TRIGRAM_THRESHOLD,
      scoreThreshold: 0,
      maxCandidates: MAX_CANDIDATES,
    });
    for (const m of results) {
      const otherKey = keyByResidentId.get(m.resident_id);
      if (!otherKey || otherKey === rec.key) continue; // unlabeled row or self
      const pk = pairKey(rec.key, otherKey);
      const prev = pairScores.get(pk);
      // max over both query directions (defensive; scores are symmetric)
      if (prev === undefined || m.score > prev) pairScores.set(pk, m.score);
    }
  }
  return pairScores;
}

function evaluateAt(threshold, pairScores, positiveSet, allPairs) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const pk of allPairs) {
    const score = pairScores.get(pk);
    const predicted = score !== undefined && score >= threshold;
    const actual = positiveSet.has(pk);
    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && actual) fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { threshold, tp, fp, fn, tn, precision, recall, f1 };
}

async function main() {
  console.log('Fuzzy name matching — precision/recall/F1 evaluation');
  console.log(
    `Engine: Stage 1 trigramThreshold=${TRIGRAM_THRESHOLD} (held constant), ` +
      `Stage 2 Jaro-Winkler swept over [${SWEEP_THRESHOLDS.join(', ')}]`
  );

  const { keyByResidentId, extraDbRecords } = await resolveResidentIds();

  const recordByKey = new Map(RECORDS.map((r) => [r.key, r]));
  const keys = RECORDS.map((r) => r.key);
  const allPairs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) allPairs.push(pairKey(keys[i], keys[j]));
  }
  const positiveSet = new Set(POSITIVE_PAIRS.map(([a, b]) => pairKey(a, b)));

  console.log(
    `\nDataset: ${RECORDS.length} labeled records -> ${allPairs.length} pairs ` +
      `(${positiveSet.size} positive, ${allPairs.length - positiveSet.size} negative). ` +
      `${extraDbRecords} unlabeled record(s) in the table are excluded from metrics.`
  );

  const pairScores = await collectPairScores(keyByResidentId);

  console.log('\nEngine scores for the labeled positive pairs:');
  for (const [a, b] of POSITIVE_PAIRS) {
    const score = pairScores.get(pairKey(a, b));
    console.log(
      `  ${score === undefined ? 'BLOCKED (not surfaced by Stage 1)' : score.toFixed(4)}` +
        `  ${label(recordByKey.get(a))}  =  ${label(recordByKey.get(b))}`
    );
  }

  const minThreshold = Math.min(...SWEEP_THRESHOLDS);
  const nearFps = [...pairScores.entries()]
    .filter(([pk, s]) => !positiveSet.has(pk) && s >= minThreshold)
    .sort((a, b) => b[1] - a[1]);
  console.log(`\nNegative pairs scoring >= ${minThreshold} (potential false positives):`);
  if (nearFps.length === 0) {
    console.log('  (none)');
  } else {
    for (const [pk, s] of nearFps) {
      const [a, b] = pk.split('|');
      console.log(`  ${s.toFixed(4)}  ${label(recordByKey.get(a))}  vs  ${label(recordByKey.get(b))}`);
    }
  }

  console.log('\nthreshold |  TP |  FP |  FN |   TN | precision | recall |     F1');
  console.log('----------+-----+-----+-----+------+-----------+--------+-------');
  for (const t of SWEEP_THRESHOLDS) {
    const r = evaluateAt(t, pairScores, positiveSet, allPairs);
    console.log(
      `   ${t.toFixed(2)}   | ${String(r.tp).padStart(3)} | ${String(r.fp).padStart(3)} |` +
        ` ${String(r.fn).padStart(3)} | ${String(r.tn).padStart(4)} |   ${fmt(r.precision)}  |` +
        ` ${fmt(r.recall)} | ${fmt(r.f1)}`
    );
  }
  console.log('\n(precision is "—" when the engine predicts no positives at that threshold)');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
