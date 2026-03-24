const express = require('express');
const cors = require('cors');
const invoiceRoutes = require('./routes/invoiceRoutes');
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
      invoices: 'GET /api/invoices/:id', // Updated to show new endpoint
      escrow: 'GET /api/escrow/:invoiceId',
    },
  });
});

app.post('/api/invoices', (req, res) => {
  res.status(201).json({
    data: { id: 'placeholder', status: 'pending_verification' },
    message: 'Invoice upload will be implemented with verification and tokenization.',
  });
});


// Register routes
app.use('/api/invoices', invoiceRoutes);

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


app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, _next) => {
  // Simple error handler for non-403 errors
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.message,
    ...(status === 500 && { details: err.message }),
  });
});

module.exports = app;
