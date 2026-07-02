require('dotenv').config();

const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');

const app = express();
const PORT = process.env.PORT || 5000;

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

app.listen(PORT, () => {
  console.log(`BrgyServe API running on http://localhost:${PORT}`);
});
