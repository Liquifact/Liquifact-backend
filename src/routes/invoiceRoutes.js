const express = require('express');
const router = express.Router();
const invoiceService = require('../services/invoiceService');

/**
 * GET /api/invoices/:id
 * Retrieve a single invoice by its ID.
 * Performs robust validation and authorization checks.
 */
router.get('/:id', (req, res, next) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id']; // In a real app, this would be from auth/JWT middleware

  // 1. Validation for missing user info (placeholder for auth middleware)
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized', message: 'User identification required' });
  }

  // 2. Validation for input (simplified for this task)
  if (!id || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Missing or invalid invoice ID' });
  }

  try {
    const invoice = invoiceService.getInvoiceById(id, userId);

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
    // 5. Authorization / Business Logic Error Handling
    if (error.status === 403) {
        return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this invoice.' });
    }

    // Pass unexpected errors to express error handler
    next(error);
  }
});

module.exports = router;
