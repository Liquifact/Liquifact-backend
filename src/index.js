/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */
const express = require('express');
const cors = require('cors');
const { deprecate } = require('./middleware/deprecation');
const { authenticateToken } = require('./middleware/auth');
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(globalLimiter);

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

// Placeholder: Invoices
app.get('/api/invoices', deprecate({
  sunset: '2026-12-31T23:59:59Z',
  link: 'https://docs.liquifact.com/api/v2/invoices',
}), (req, res) => {
  res.json({
    data: [],
    message: 'Invoice service will list tokenized invoices here.',
  });
});

app.post('/api/invoices', authenticateToken, sensitiveLimiter, (req, res) => {
  res.status(201).json({
    data: { id: 'placeholder', status: 'pending_verification' },
    message: 'Invoice upload will be implemented with verification and tokenization.',
  });
});

// Placeholder: Escrow
app.get('/api/escrow/:invoiceId', (req, res) => {
  const { invoiceId } = req.params;
  res.json({
    data: { invoiceId, status: 'not_found', fundedAmount: 0 },
    message: 'Escrow state will be read from Soroban contract.',
  });
});

app.post('/api/escrow', authenticateToken, (req, res) => {
  res.json({
    data: { status: 'funded' },
    message: 'Escrow operation placeholder.',
  });
});

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
