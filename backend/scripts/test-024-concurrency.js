// ===========================================================================
// MIGRATION 024 — CONCURRENCY CHECK. WRITES TO THE LIVE DATABASE.
//
//   cd backend && node scripts/test-024-concurrency.js --yes
//
// Run it only after apply-024-commit.sql, and clean up after it with
// cleanup-024-concurrency-dry-run.sql, then cleanup-024-concurrency-commit.sql.
//
// What it does: creates ONE throwaway item named exactly 'TEST C1 Concurrency'
// (furniture, 1 unit, fee 0), then in each of ROUNDS rounds fires TWO
// create_rental_booking calls for that last unit, for the same slot, at the
// same time (Promise.all, two separate PostgREST requests, so two separate
// transactions). The item-row lock in create_rental_booking must let exactly
// one of them through and refuse the other with NOT_ENOUGH_LEFT. Each round
// uses its own day, 3 days apart, so the 24-hour gap of one round never
// reaches the next. The bookings are guest bookings ('TEST C1 Concurrency
// guest'), so no resident record, account, charge, notification or activity
// log row is written; it calls the function directly, not the API.
//
// What it cannot prove: that the two requests reached Postgres at the same
// instant. It proves the outcome: whatever the timing, never two.
//
// Writes: rental_items (1 row), rental_requests (one row per round).
// Refuses to start if the item already exists with bookings on it.
// ===========================================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ITEM_NAME = 'TEST C1 Concurrency';
const GUEST_NAME = 'TEST C1 Concurrency guest';
const GUEST_CONTACT = '09170000024';
const ROUNDS = 5;
const FIRST_DAY_AHEAD = 200;

// A Manila wall-clock time `days` days from today, as an ISO string.
function manilaAt(days, hour) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+08:00`;
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.log('This writes to the LIVE database (one throwaway item and its bookings).');
    console.log('Run it as: node scripts/test-024-concurrency.js --yes');
    process.exit(1);
  }
  const supabase = require('../src/config/supabase');

  // 024 applied? A read-only call for an item that cannot exist.
  const probe = await supabase.rpc('rental_availability', {
    p_item_id: 0,
    p_start: manilaAt(1, 8),
    p_end: manilaAt(1, 9),
    p_exclude_request_id: null,
  });
  if (probe.error) {
    console.log(`STOP: rental_availability cannot be called (${probe.error.message}).`);
    console.log('Apply apply-024-commit.sql first. If it is applied, PostgREST may not have reloaded its schema yet.');
    process.exit(1);
  }

  // The throwaway item: reuse one left by an earlier run only if it is empty.
  const { data: found, error: findError } = await supabase
    .from('rental_items')
    .select('item_id, quantity_total, quantity_available, is_active')
    .eq('name', ITEM_NAME);
  if (findError) throw new Error(`Failed to look for the test item: ${findError.message}`);
  if (found.length > 1) {
    console.log(`STOP: ${found.length} items are named '${ITEM_NAME}'. Run the cleanup first.`);
    process.exit(1);
  }
  let itemId;
  if (found.length === 1) {
    itemId = found[0].item_id;
    const { count, error } = await supabase
      .from('rental_requests')
      .select('request_id', { count: 'exact', head: true })
      .eq('item_id', itemId);
    if (error) throw new Error(`Failed to count the test item's bookings: ${error.message}`);
    if (count > 0 || found[0].quantity_available !== 1 || !found[0].is_active) {
      console.log(`STOP: item #${itemId} '${ITEM_NAME}' already has ${count} booking(s) or is not 1 active unit. Run the cleanup first.`);
      process.exit(1);
    }
  } else {
    const { data: created, error } = await supabase
      .from('rental_items')
      .insert({
        name: ITEM_NAME,
        type: 'furniture',
        description: 'Throwaway item for scripts/test-024-concurrency.js. Delete with cleanup-024-concurrency.',
        quantity_total: 1,
        quantity_available: 1,
        is_active: true,
        fee: 0,
      })
      .select('item_id')
      .single();
    if (error) throw new Error(`Failed to create the test item: ${error.message}`);
    itemId = created.item_id;
  }
  console.log(`Test item #${itemId} '${ITEM_NAME}' (1 unit).`);

  // Who files the bookings: the first active Secretary (read only).
  const { data: sec, error: secError } = await supabase
    .from('users')
    .select('user_id')
    .eq('role', 'secretary')
    .eq('is_active', true)
    .order('user_id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (secError || !sec) throw new Error(`No active Secretary to file the bookings: ${secError?.message || 'none'}`);

  let allGood = true;
  for (let round = 0; round < ROUNDS; round++) {
    const day = FIRST_DAY_AHEAD + 3 * round;
    const args = {
      p_item_id: itemId,
      p_requested_by_user_id: sec.user_id,
      p_resident_id: null,
      p_outside_borrower_name: GUEST_NAME,
      p_outside_borrower_contact: GUEST_CONTACT,
      p_quantity: 1,
      p_start: manilaAt(day, 8),
      p_end: manilaAt(day, 10),
      p_purpose: 'C1 concurrency test',
    };
    const results = await Promise.all([supabase.rpc('create_rental_booking', args), supabase.rpc('create_rental_booking', args)]);
    const ok = results.filter((r) => !r.error && r.data?.ok === true);
    const refused = results.filter((r) => !r.error && r.data?.ok === false);
    const errors = results.filter((r) => r.error);
    const good = ok.length === 1 && refused.length === 1 && refused[0].data.code === 'NOT_ENOUGH_LEFT' && errors.length === 0;
    if (!good) allGood = false;
    console.log(
      `round ${round + 1} (${args.p_start}): ${ok.length} succeeded, ${refused.length} refused` +
        `${refused.length ? ` (${refused.map((r) => r.data.code).join(', ')})` : ''}` +
        `${errors.length ? `, ${errors.length} error(s): ${errors.map((r) => r.error.message).join('; ')}` : ''}` +
        ` — ${good ? 'PASS' : 'FAIL'}`
    );
  }

  console.log(allGood ? `\nPASS: exactly 1 of 2 succeeded in all ${ROUNDS} rounds.` : '\nFAIL: see the rounds above.');
  console.log('Now run cleanup-024-concurrency-dry-run.sql, then cleanup-024-concurrency-commit.sql.');
  process.exit(allGood ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
