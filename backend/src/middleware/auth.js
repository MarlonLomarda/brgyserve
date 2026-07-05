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
    .select('user_id, username, email, role, is_active, must_change_password')
    .eq('user_id', payload.sub)
    .maybeSingle();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is not active' });
  }

  // Default-deny while a password change is pending: a user logged in with a
  // temporary password can reach nothing except routes that explicitly opt
  // out via allowPendingPasswordChange (the change-password route itself).
  if (user.must_change_password && !req.allowPendingPasswordChange) {
    return res.status(403).json({
      error: 'You must change your temporary password before continuing',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }

  req.user = user;
  next();
}

// Marker middleware: place BEFORE authenticate on routes that must stay
// reachable while must_change_password is true.
function allowPendingPasswordChange(req, res, next) {
  req.allowPendingPasswordChange = true;
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

module.exports = { authenticate, requireRole, allowPendingPasswordChange };
