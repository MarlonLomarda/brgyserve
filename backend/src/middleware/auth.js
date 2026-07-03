const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

// Verifies the Bearer token and loads the user fresh from the database,
// so deactivation takes effect immediately even for already-issued tokens.
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('user_id, username, email, role, is_active')
    .eq('user_id', payload.sub)
    .maybeSingle();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is not active' });
  }

  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
