/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const mockAuth = require('./middleware/mockAuth');
app.use(mockAuth);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'liquifact-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// API info
app.get('/api', (req, res) => {
  res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    endpoints: {
      health: 'GET /health',
      invoices: 'GET/POST /api/invoices',
      escrow: 'GET/POST /api/escrow',
    },
  });
});

const invoicesRouter = require('./routes/invoices');
const escrowRouter = require('./routes/escrow');

app.use('/api/invoices', invoicesRouter);
app.use('/api/escrow', escrowRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`LiquiFact API running at http://localhost:${PORT}`);
  });
}

module.exports = app;
