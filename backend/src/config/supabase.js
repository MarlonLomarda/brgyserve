const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in backend/.env'
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
