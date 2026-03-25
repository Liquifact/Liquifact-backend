const express = require('express');
const cors = require('cors');
const invoiceService = require('./services/invoiceService');
const { callSorobanContract } = require('./services/soroban');


const app = express();

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
      invoices: 'GET /api/invoices',
      escrow: 'GET /api/escrow/:invoiceId',
    },
  });
});

/**
 * GET /api/invoices
 * Retrieve a paginated list of invoices.
 * Supports `page` and `limit` query parameters.
 */
app.get('/api/invoices', (req, res) => {
  const { page, limit } = req.query;

  try {
    const { invoices, meta } = invoiceService.getInvoices({ page, limit });

    // Validate that our pagination inputs resulted in data
    // If user requests a page that doesn't exist, we return an empty array with meta
    res.json({
      data: invoices,
      meta: {
        ...meta,
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  } catch (err) {
    // Basic error handling for this task
    res.status(400).json({
      data: null,
      error: {
        message: 'Bad Request',
        details: err.message,
      },
    });
  }
});

app.post('/api/invoices', (req, res) => {
  res.status(201).json({
    data: { id: 'placeholder', status: 'pending_verification' },
    message: 'Invoice upload will be implemented with verification and tokenization.',
  });
});


// Placeholder for Escrow (wired to Soroban)
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


// Error trigger for testing 500 responses
app.get('/debug/error', (req, res, next) => {
  next(new Error('Triggered Error'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handling middleware
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
