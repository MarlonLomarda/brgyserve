// Regression guard for the THREE triggers that can settle a charge.
//
// WHY THIS EXISTS: the checkout-resume interlock originally ignored
// settlePaidCharge's return value and always answered "This charge has
// already been paid" — including for the `underpaid` and `void` outcomes,
// where the money was NOT applied. Telling a resident they had paid when they
// had not is the worst failure this module can produce, so the wording is
// pinned here rather than left to a reviewer to notice.
//
// It also enforces the invariant that keeps this safe as the module grows:
// every outcome settlePaidCharge can return must have accurate wording in
// BOTH caller-facing maps. Adding a new outcome without wording fails here
// instead of silently falling back to a message that misstates what happened.
//
// Makes NO network calls — no database queries, no PayMongo, no tunnel, and
// the API does not need to be running. (It reads .env only because importing
// the route module constructs the Supabase client, like every other backend
// script.) The live behaviour of the three triggers is exercised separately
// against the sandbox.
//
// Run with: npm run gateway:test   (from /backend)
require('dotenv').config();

const { SETTLE_OUTCOME, RESUME_MESSAGES, RECONCILE_MESSAGES } = require('../src/routes/payments');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
}

const OUTCOMES = Object.values(SETTLE_OUTCOME);

// Outcomes where the charge did NOT end up paid. Wording for these must never
// tell the resident their payment went through.
const NOT_SETTLED = [SETTLE_OUTCOME.VOID, SETTLE_OUTCOME.UNDERPAID];
// Phrases that assert the money is accounted for.
const CLAIMS_PAID = [/is now paid/i, /has already been paid/i, /already recorded/i, /just been settled/i];

console.log('outcomes under test:', OUTCOMES.join(', '), '\n');

// 1. Exhaustiveness — the invariant that stops the maps drifting.
for (const outcome of OUTCOMES) {
  check(`resume wording exists for '${outcome}'`, typeof RESUME_MESSAGES[outcome] === 'string' && RESUME_MESSAGES[outcome].length > 0);
  check(`reconcile wording exists for '${outcome}'`, typeof RECONCILE_MESSAGES[outcome] === 'string' && RECONCILE_MESSAGES[outcome].length > 0);
}

// No stray keys that no longer correspond to a real outcome.
for (const [name, map] of [['RESUME_MESSAGES', RESUME_MESSAGES], ['RECONCILE_MESSAGES', RECONCILE_MESSAGES]]) {
  const stray = Object.keys(map).filter((k) => !OUTCOMES.includes(k));
  check(`${name} has no keys outside SETTLE_OUTCOME`, stray.length === 0, stray.join(', ') || 'none');
}

// 2. THE ACTUAL BUG — an unsettled outcome must not claim payment succeeded.
console.log('');
for (const outcome of NOT_SETTLED) {
  for (const [name, map] of [['resume', RESUME_MESSAGES], ['reconcile', RECONCILE_MESSAGES]]) {
    const text = map[outcome];
    const lies = CLAIMS_PAID.find((re) => re.test(text));
    check(`${name} wording for '${outcome}' does NOT claim the charge is paid`, !lies, text);
  }
}

// 3. And it must point the resident somewhere, not leave them stuck.
for (const outcome of NOT_SETTLED) {
  check(
    `resume wording for '${outcome}' tells the resident what to do`,
    /Barangay Office/i.test(RESUME_MESSAGES[outcome]),
    RESUME_MESSAGES[outcome]
  );
}

// 4. The success wording must actually state the charge is settled — the
//    resume path reports it through a 409, so vague wording would read as a
//    failure to a resident who has just paid.
console.log('');
check(
  "resume wording for 'recorded' confirms the payment landed",
  /is now paid/i.test(RESUME_MESSAGES[SETTLE_OUTCOME.RECORDED]),
  RESUME_MESSAGES[SETTLE_OUTCOME.RECORDED]
);
check(
  "reconcile wording for 'recorded' confirms the payment landed",
  /now paid/i.test(RECONCILE_MESSAGES[SETTLE_OUTCOME.RECORDED]),
  RECONCILE_MESSAGES[SETTLE_OUTCOME.RECORDED]
);

// 5. Structural check: every `outcome:` literal returned by settlePaidCharge
//    is a declared SETTLE_OUTCOME value. This is what catches a future outcome
//    added straight into the function without wording — the failure mode the
//    two maps alone cannot detect.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
const literals = [...source.matchAll(/outcome:\s*'([a-z_]+)'/g)].map((m) => m[1]);
check(
  'settlePaidCharge returns no raw outcome strings (all via SETTLE_OUTCOME)',
  literals.length === 0,
  literals.join(', ') || 'none found'
);
const referenced = [...source.matchAll(/SETTLE_OUTCOME\.([A-Z_]+)/g)].map((m) => m[1]);
const undeclared = referenced.filter((k) => !(k in SETTLE_OUTCOME));
check('every SETTLE_OUTCOME.* reference is declared', undeclared.length === 0, undeclared.join(', ') || 'none');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
