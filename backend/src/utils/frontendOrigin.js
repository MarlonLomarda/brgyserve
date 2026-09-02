// The ONE browser origin this API points a resident at — the GCash return
// page, and now the password reset link.
//
// Deliberately NOT FRONTEND_URL on its own: that is a comma-separated CORS
// allowlist (server.js), so reading it directly produced a broken redirect the
// moment a second origin was added for LAN testing —
//   "http://localhost:5173,http://192.168.1.14:5173/resident/payment-result"
// Falls back to the FIRST entry of that allowlist so local dev and any
// existing .env keep working without setting a new variable.
//
// Lifted out of routes/payments.js when the reset link became a second caller.
// One implementation rather than a copy: a reset URL that disagrees with the
// payment return URL about which host the app is on would be a link nobody can
// follow, and the two are configured from the same variables.
const frontendOrigin = () => {
  const configured =
    process.env.PUBLIC_FRONTEND_URL ||
    (process.env.FRONTEND_URL || '').split(',')[0] ||
    'http://localhost:5173';
  return configured.trim().replace(/\/+$/, '');
};

module.exports = { frontendOrigin };
