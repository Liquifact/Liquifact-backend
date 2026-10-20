const express = require('express');
const router = express.Router();
const invoiceService = require('../services/invoiceService');

/**
 * @swagger
 * /api/invoices:
 *   post:
 *     operationId: createInvoice
 *     summary: Create an invoice
 *     description: When REQUIRE_SME_VERIFICATION is true, a verified smeId is required and SME identity values come from the record.
 *     tags: [Invoices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateInvoiceRequest'
 *     responses:
 *       '201':
 *         description: Invoice created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreateInvoiceResponse'
 *       '400':
 *         description: Invalid invoice data or missing smeId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '403':
 *         description: SME is not verified
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       '404':
 *         description: SME not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */

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
