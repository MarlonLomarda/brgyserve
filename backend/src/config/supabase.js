const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;

// The SERVICE ROLE key is REQUIRED. There is deliberately no fallback to the
// anon key, and adding one back would be a bug.
//
// RLS is enabled on all 19 tables with ZERO policies written, so the anon key
// can read nothing. Authorization in this system lives in the Express layer
// (authenticate + requireRole), never in the database, and the server is
// expected to reach the data unrestricted — the service role key bypassing RLS
// is the only reason any query here returns rows at all.
//
// A fallback fails in the worst possible way: the process boots, /api/health
// answers, and then every query returns an EMPTY RESULT SET rather than an
// error. A login reads as "invalid credentials", a resident list reads as "no
// records". A system that looks healthy while showing nothing is far harder to
// diagnose than one that refuses to start.
//
// Same reasoning as the VITE_API_URL guard in frontend/vite.config.js, which
// throws rather than let a build fall back to localhost. One difference: that
// guard is keyed on `command` so the dev server keeps its fallback, while this
// one is unconditional — no environment legitimately wants the anon key.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env. ' +
      'The service role key is required, not optional: RLS is enabled with no policies, so the anon ' +
      'key reads nothing and every query would silently return no rows.'
  );
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // The server holds no user session; tokens are validated per-request instead
    autoRefreshToken: false,
    persistSession: false,
  },
});

module.exports = supabase;
