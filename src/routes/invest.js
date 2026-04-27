'use strict';

/**
 * @fileoverview Investment opportunity routes for the Investor portal.
 * Includes KYC gating for funding operations to ensure compliance.
 * @module routes/invest
 */

const express = require('express');
const router = express.Router();
const investService = require('../services/investService');
const { authenticateToken } = require('../middleware/auth');
const { requireKycForFunding } = require('../middleware/kycGating');
const logger = require('../logger');
const AppError = require('../errors/AppError');

/**
 * @swagger
 * /api/invest/opportunities:
 *   get:
 *     summary: Get investment opportunities
 *     description: Retrieve a paginated list of investable opportunities
 *     tags: [Invest]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Investment opportunities retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Investment opportunity object
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 */
/**
 * @swagger
 * /api/invest/list:
 *   get:
 *     summary: List investment opportunities (batched)
 *     description: Retrieve a paginated list of opportunities with fresh on-chain data using cursor pagination.
 *     tags: [Invest]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor for pagination (invoiceId from previous page)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of items to retrieve
 *     responses:
 *       200:
 *         description: Success
 *       401:
 *         description: Unauthorized
 */
router.get('/list', authenticateToken, async (req, res, next) => {
  try {
    const { cursor, limit = 10 } = req.query;

    const result = await investService.listInvestments({ cursor, limit });

    logger.info({ 
      requestId: req.id, 
      count: result.data.length,
      nextCursor: result.meta.next_cursor 
    }, 'Retrieved batched investment list');

    return res.json({
      ...result,
      message: 'Investment opportunities retrieved successfully with on-chain state.',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/opportunities', authenticateToken, async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const result = await investService.getOpportunities({ page, limit });

    logger.info({ 
      requestId: req.id, 
      count: result.data.length,
      total: result.meta.total 
    }, 'Retrieved investment opportunities');

    return res.json({
      ...result,
      message: 'Investment opportunities retrieved successfully.',
    });
  } catch (error) {
    // Standard error handling middleware will catch and format this
    next(error);
  }
});

/**
 * @swagger
 * /api/invest/fund-invoice:
 *   post:
 *     summary: Fund an invoice (initiate capital transfer)
 *     description: Submit an investment to fund an invoice. Requires KYC verification.
 *     tags: [Invest]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - invoiceId
 *               - investmentAmount
 *               - smeId
 *             properties:
 *               invoiceId:
 *                 type: string
 *                 description: Invoice to fund
 *               investmentAmount:
 *                 type: number
 *                 minimum: 0.01
 *                 description: Amount to invest
 *               smeId:
 *                 type: string
 *                 description: SME ID (must be KYC verified)
 *     responses:
 *       201:
 *         description: Investment submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     investmentId:
 *                       type: string
 *                     invoiceId:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [pending, confirmed, escrow, settled]
 *                 meta:
 *                   type: object
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: KYC verification required or failed
 *       500:
 *         description: Server error
 */
router.post(
  '/fund-invoice',
  authenticateToken,
  requireKycForFunding,
  async (req, res, next) => {
    try {
      const { invoiceId, investmentAmount, smeId } = req.body;

      // Input validation
      if (!invoiceId || typeof invoiceId !== 'string') {
        const error = new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'invoiceId is required and must be a string.',
          code: 'INVALID_INVOICE_ID',
        });
        return next(error);
      }

      if (
        investmentAmount === undefined ||
        typeof investmentAmount !== 'number' ||
        investmentAmount <= 0
      ) {
        const error = new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'investmentAmount is required and must be a positive number.',
          code: 'INVALID_INVESTMENT_AMOUNT',
        });
        return next(error);
      }

      if (!smeId || typeof smeId !== 'string') {
        const error = new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'smeId is required and must be a string.',
          code: 'INVALID_SME_ID',
        });
        return next(error);
      }

      // At this point, KYC has been verified by requireKycForFunding middleware
      logger.info(
        {
          userId: req.user.sub,
          invoiceId,
          investmentAmount,
          smeId,
          kycStatus: req.kyc.status,
          requestId: req.id,
        },
        'Funding request processing (KYC verified)'
      );

      // TODO: In production, call actual Soroban escrow contract
      // For now, mock the response
      const investmentId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      return res.status(201).json({
        data: {
          investmentId,
          invoiceId,
          smeId,
          investmentAmount,
          status: 'pending',
          onChain: {
            escrowAddress: 'CAB1234567890QWERTYU', // Mock Stellar address
            ledgerIndex: '124500',
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '0.1.0',
          kycVerified: true,
          kycStatus: req.kyc.status,
        },
        message: 'Investment submitted successfully.',
      });
    } catch (error) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          requestId: req.id,
        },
        'Error processing funding request'
      );
      next(error);
    }
  }
);

module.exports = router;
