require('dotenv').config();

const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');

const authRoutes = require('./routes/auth');
const secretaryRoutes = require('./routes/secretary');
const residentRoutes = require('./routes/residents');
const residentRecordRoutes = require('./routes/residentRecords');
const documentTypeRoutes = require('./routes/documentTypes');
const documentRequestRoutes = require('./routes/documentRequests');
const chargeRoutes = require('./routes/charges');
const rentalItemRoutes = require('./routes/rentalItems');
const rentalRequestRoutes = require('./routes/rentalRequests');
const disputeRoutes = require('./routes/disputes');

const app = express();
const PORT = process.env.PORT || 5000;

if (!process.env.JWT_SECRET) {
  throw new Error('Missing JWT_SECRET. Set it in backend/.env (see .env.example).');
}

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
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
app.use('/api/document-types', documentTypeRoutes);
app.use('/api/document-requests', documentRequestRoutes);
app.use('/api/charges', chargeRoutes);
app.use('/api/rental-items', rentalItemRoutes);
app.use('/api/rental-requests', rentalRequestRoutes);
app.use('/api/disputes', disputeRoutes);

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
