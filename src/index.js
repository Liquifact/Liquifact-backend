/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */
const express = require('express');
const cors = require('cors');
const { deprecate } = require('./middleware/deprecation');
const { authenticateToken } = require('./middleware/auth');
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

/** @type {Map<string, object>} In-memory invoice store */
let store = new Map();

/**
 * Resets the in-memory store. Used for test isolation.
 *
 * @returns {void}
 */
function resetStore() {
  store = new Map();
}

/**
 * Starts the HTTP server.
 *
 * @returns {import('http').Server} The running server instance.
 */
function startServer() {
  return app.listen(PORT, () => {
    console.log(`LiquiFact API running at http://localhost:${PORT}`);
  });
}

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

// Invoices
app.get('/api/invoices', deprecate({
  sunset: '2026-12-31T23:59:59Z',
  link: 'https://docs.liquifact.com/api/v2/invoices',
}), (req, res) => {
  const includeDeleted = req.query.includeDeleted === 'true';
  const invoices = Array.from(store.values()).filter(
    (inv) => includeDeleted || inv.deletedAt === null
  );
  res.json({ data: invoices });
});

app.post('/api/invoices', authenticateToken, sensitiveLimiter, (req, res) => {
  const { amount, customer } = req.body;
  if (!amount || !customer) {
    return res.status(400).json({ error: 'Missing required fields: amount, customer' });
  }
  const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const invoice = { id, amount, customer, deletedAt: null, createdAt: new Date().toISOString() };
  store.set(id, invoice);
  return res.status(201).json({ data: invoice });
});

app.delete('/api/invoices/:id', (req, res) => {
  const { id } = req.params;
  const invoice = store.get(id);
  if (!invoice) {return res.status(404).json({ error: 'Invoice not found' });}
  if (invoice.deletedAt !== null) {return res.status(400).json({ error: 'Invoice is already deleted' });}
  invoice.deletedAt = new Date().toISOString();
  store.set(id, invoice);
  return res.json({ data: invoice });
});

app.patch('/api/invoices/:id/restore', (req, res) => {
  const { id } = req.params;
  const invoice = store.get(id);
  if (!invoice) {return res.status(404).json({ error: 'Invoice not found' });}
  if (invoice.deletedAt === null) {return res.status(400).json({ error: 'Invoice is not deleted' });}
  invoice.deletedAt = null;
  store.set(id, invoice);
  return res.json({ data: invoice });
});

// Escrow
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

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use(errorHandler);

if (require.main === module) {
  startServer();
}

app.resetStore = resetStore;
app.startServer = startServer;
module.exports = app;
module.exports.app = app;
module.exports.resetStore = resetStore;
module.exports.startServer = startServer;
