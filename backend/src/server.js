require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const supabase = require('./config/supabase');

const authRoutes = require('./routes/auth');
const secretaryRoutes = require('./routes/secretary');
const residentRoutes = require('./routes/residents');
const residentRecordRoutes = require('./routes/residentRecords');
const householdRoutes = require('./routes/households');
const myHouseholdRoutes = require('./routes/myHousehold');
const notificationRoutes = require('./routes/notifications');
const documentTypeRoutes = require('./routes/documentTypes');
const documentRequestRoutes = require('./routes/documentRequests');
const chargeRoutes = require('./routes/charges');
const rentalItemRoutes = require('./routes/rentalItems');
const rentalRequestRoutes = require('./routes/rentalRequests');
const disputeRoutes = require('./routes/disputes');
const eventRoutes = require('./routes/events');
const reportRoutes = require('./routes/reports');
const { router: paymentRoutes, webhookHandler } = require('./routes/payments');

const app = express();
const PORT = process.env.PORT || 5000;

if (!process.env.JWT_SECRET) {
  throw new Error('Missing JWT_SECRET. Set it in backend/.env (see .env.example).');
}

// Security response headers. Before this, the API sent NONE — no CSP, no
// X-Content-Type-Options, no Referrer-Policy, no X-Frame-Options — and
// advertised `X-Powered-By: Express` on every single response, which
// fingerprints the stack for free and is the first line of any scanner's
// report. Verified live on the deployed instance before this was added.
//
// MOUNTED FIRST, ahead of cors() and ahead of the raw-body PayMongo webhook,
// so the headers are on EVERY response — including the CORS preflight, which
// cors() short-circuits with a 204 before any router runs, and including the
// 500s from the error handler at the bottom of this file.
//
// Helmet only sets response headers and calls next(); it never reads the
// request body or stream, so express.raw() on the webhook below is unaffected
// and the PayMongo HMAC still covers the exact bytes sent.
app.use(helmet());

// FRONTEND_URL is a comma-separated allowlist of browser origins. Production
// sets exactly one; local device testing (a phone reaching the dev server over
// the LAN) adds a second there rather than here, so the temporary address
// lives in the gitignored .env and never enters the repo.
//
// Deliberately NEVER a wildcard, and deliberately not widened by a NODE_ENV
// check: NODE_ENV is unset in this project, so "not production" would be the
// default state and the relaxed branch would be live on any server that
// forgot to set it. An allowlist that has to be named is the safer default.
//
// This is a LIST and nothing else. The single origin residents are redirected
// back to after a GCash payment is PUBLIC_FRONTEND_URL (routes/payments.js) —
// splitting them is what stops a second allowlist entry from corrupting the
// redirect URL.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));

// PayMongo's webhook is verified by an HMAC computed over the EXACT bytes it
// sent, so it needs the raw body and must be registered BEFORE express.json()
// — once that middleware parses and the handler re-serialises, the signature
// can no longer be reproduced and every genuine call would be rejected.
// It is deliberately unauthenticated: PayMongo cannot log in, so the signature
// is the authentication (see routes/payments.js).
app.post('/api/payments/gcash/webhook', express.raw({ type: '*/*' }), webhookHandler);

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'BrgyServe API',
    supabase: supabase ? 'client initialized' : 'not connected',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/secretary', secretaryRoutes);
app.use('/api/residents', residentRoutes);
app.use('/api/resident-records', residentRecordRoutes);
app.use('/api/households', householdRoutes);
// Separate from /api/households on purpose: that router is Secretary/Staff
// only, while this one is resident-only and derives the household from the
// session rather than taking an id.
app.use('/api/my-household', myHouseholdRoutes);
app.use('/api/document-types', documentTypeRoutes);
app.use('/api/document-requests', documentRequestRoutes);
app.use('/api/charges', chargeRoutes);
app.use('/api/rental-items', rentalItemRoutes);
app.use('/api/rental-requests', rentalRequestRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);

// Express 5 forwards rejected async handlers here automatically
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`BrgyServe API running on http://localhost:${PORT}`);
});
