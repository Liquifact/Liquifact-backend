/**
 * LiquiFact API Gateway
 * Express server for invoice financing, auth, and Stellar integration.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { callSorobanContract } = require('./services/soroban');
const invoiceService = require('./services/invoiceService');

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

// Invoices: List all invoices with optional filtering
/**
 * GET /api/invoices
 * 
 * Returns all invoices, optionally filtered by status.
 * 
 * Query Parameters:
 *   - status (optional): Filter by invoice status
 * 
 * Response:
 *   - data: Array of invoice objects
 *   - count: Total number of invoices returned
 * 
 * @example
 * GET /api/invoices
 * GET /api/invoices?status=verified
 */
app.get('/api/invoices', async (req, res) => {
  const { status } = req.query;
  const filterOptions = {};

  if (status) {
    const validStatuses = [
      'pending_verification',
      'verified',
      'active',
      'funded',
      'completed',
      'cancelled',
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status filter',
        validStatuses,
      });
    }

    filterOptions.status = status;
  }

  const result = await invoiceService.list(filterOptions);

  if (!result.success) {
    return res.status(500).json({
      error: result.error,
    });
  }

  res.json({
    data: result.invoices,
    count: result.count,
  });
});

// Invoices: Create a new invoice
/**
 * POST /api/invoices
 * 
 * Creates a new invoice with the provided data.
 * Returns the created invoice with a generated ID and initial status.
 * 
 * Request Body:
 *   - invoiceNumber (string, required): Unique invoice identifier (1-64 chars, alphanumeric + dash/underscore)
 *   - sellerName (string, required): Name of the invoice seller (max 255 chars)
 *   - buyerName (string, required): Name of the invoice buyer (max 255 chars)
 *   - amount (number, required): Invoice amount (must be > 0)
 *   - currency (string, required): ISO 4217 3-letter currency code
 *   - dueDate (string, required): ISO 8601 due date string (must be in future)
 *   - description (string, optional): Invoice description (max 2000 chars)
 *   - status (string, optional): Initial status (default: pending_verification)
 * 
 * Responses:
 *   - 201: Invoice created successfully
 *   - 400: Validation error
 *   - 500: Server error
 * 
 * @example
 * POST /api/invoices
 * {
 *   "invoiceNumber": "INV-2026-001",
 *   "sellerName": "Acme Corp",
 *   "buyerName": "Tech LLC",
 *   "amount": 5000.50,
 *   "currency": "USD",
 *   "dueDate": "2026-12-31T23:59:59Z",
 *   "description": "Q1 2026 services"
 * }
 */
app.post('/api/invoices', async (req, res) => {
  const result = await invoiceService.create(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: result.error,
      errors: result.errors,
    });
  }

  res.status(201).json({
    data: result.invoice,
    message: 'Invoice created successfully',
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`LiquiFact API running at http://localhost:${PORT}`);
});
