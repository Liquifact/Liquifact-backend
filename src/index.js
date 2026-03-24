/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
const AppError = require('./errors/AppError');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

const { callSorobanContract } = require('./services/soroban');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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

// Example route using AppError
app.get('/api/invoices', (req, res, next) => {
  // Simulating an error scenario where the service is not ready
  return next(
    new AppError({
      type: 'https://liquifact.com/probs/service-not-implemented',
      title: 'Service Not Implemented',
      status: 501,
      detail: 'The invoice service is currently under development.',
      instance: req.originalUrl,
    })
  );
});

app.post('/api/invoices', (req, res, next) => {
  const { amount } = req.body;
  if (!amount) {
    // Example: Validation error following RFC 7807
    return next(
      new AppError({
        type: 'https://liquifact.com/probs/invalid-request',
        title: 'Validation Error',
        status: 400,
        detail: "The 'amount' field is required for invoice creation.",
        instance: req.originalUrl,
      })
    );
  }
  res.status(201).json({
    data: { id: 'placeholder', status: 'pending_verification' },
    message: 'Invoice upload will be implemented with verification and tokenization.',
  });
});

// Placeholder: Escrow (to be wired to Soroban)
app.get('/api/escrow/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;

  try {
    // Simulated remote contract call
    const operation = async () => {
      return { invoiceId, status: 'not_found', fundedAmount: 0 };
    };

    const data = await callSorobanContract(operation);
    
    res.json({
      data,
      message: 'Escrow state read from Soroban contract via robust integration wrapper.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error fetching escrow state' });
  }
});

// Handle 404
app.use((req, res, next) => {
  next(
    new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'Resource Not Found',
      status: 404,
      detail: `The path ${req.path} does not exist.`,
      instance: req.originalUrl,
    })
  );
});

// Centralized Global Error Handler
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`LiquiFact API running at http://localhost:${PORT}`);
  });
}

module.exports = app;
