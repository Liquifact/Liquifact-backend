const express = require('express');
const router = express.Router();
const invoiceService = require('../services/invoiceService');

/**
 * GET /api/invoices/:id
 * Retrieve a single invoice by its ID.
 * Performs robust validation and authorization checks.
 */
router.get('/:id', async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.tenantId; // From extractTenant middleware

  // 1. Validation for missing tenant info
  if (!tenantId) {
    return res.status(400).json({ error: 'Bad Request', message: 'Tenant context required' });
  }

  // 2. Validation for input
  if (!id || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Missing or invalid invoice ID' });
  }

  try {
    const invoice = await invoiceService.getInvoiceById(id, tenantId);

    // 3. Not Found Handling
    if (!invoice) {
        return res.status(404).json({ error: 'Not Found', message: `Invoice with ID '${id}' not found` });
    }

    // 4. Happy Path Response
    res.json({
        data: invoice,
        message: 'Invoice retrieved successfully',
    });
  } catch (error) {
    // 5. Error Handling
    next(error);
  }
});

module.exports = router;
