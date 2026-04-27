'use strict';

/**
 * @fileoverview Investor-specific routes for lock and commitment data.
 * @module routes/investor
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const investorCommitmentService = require('../services/investorCommitment');
const logger = require('../logger');

/**
 * @swagger
 * /api/investor/locks:
 *   get:
 *     summary: Get investor commitment locks
 *     description: Retrieve investor lock data (claimNotBefore, investorEffectiveYieldBps) per funder. Returns stale=true for DB-mirrored data.
 *     tags: [Investor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: funderAddress
 *         schema:
 *           type: string
 *         description: Funder Stellar address (G... or C...)
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *         description: Optional filter by invoice ID
 *     responses:
 *       200:
 *         description: Investor locks retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       funderAddress:
 *                         type: string
 *                       claimNotBefore:
 *                         type: string
 *                       investorEffectiveYieldBps:
 *                         type: integer
 *                       invoiceId:
 *                         type: string
 *                       stale:
 *                         type: boolean
 *                 meta:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     stale:
 *                       type: boolean
 *       400:
 *         description: Invalid address format
 */
router.get('/locks', authenticateToken, async (req, res, next) => {
  try {
    const { funderAddress, invoiceId } = req.query;

    if (funderAddress) {
      const validation = investorCommitmentService.validateAddress(funderAddress);
      if (!validation.valid) {
        return res.status(400).json({
          error: validation.reason,
        });
      }
    }

    const hasFunderAddress = funderAddress && typeof funderAddress === 'string';

    const data = hasFunderAddress
      ? investorCommitmentService.getInvestorLocksByAddress(funderAddress.trim(), { invoiceId })
      : investorCommitmentService.getAllInvestorLocks({ invoiceId });

    const anyStale = data.length > 0 && data.some((lock) => lock.stale === true);

    logger.info(
      {
        requestId: req.id,
        funderAddress,
        invoiceId,
        count: data.length,
        stale: anyStale,
      },
      'Investor locks retrieved'
    );

    return res.json({
      data,
      meta: {
        count: data.length,
        stale: anyStale,
      },
      message: 'Investor locks retrieved.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/investor/locks/{invoiceId}:
 *   get:
 *     summary: Get investor lock for specific invoice
 *     description: Get lock details for a specific invoice and funder
 *     tags: [Investor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         schema:
 *           type: string
 *         required: true
 *         description: Invoice ID
 *       - in: query
 *         name: funderAddress
 *         schema:
 *           type: string
 *         required: true
 *         description: Funder Stellar address
 *     responses:
 *       200:
 *         description: Lock record found
 *       404:
 *         description: Lock not found
 */
router.get('/locks/:invoiceId', authenticateToken, async (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    const { funderAddress } = req.query;

    if (!funderAddress) {
      return res.status(400).json({
        error: 'funderAddress query parameter is required',
      });
    }

    const validation = investorCommitmentService.validateAddress(funderAddress);
    if (!validation.valid) {
      return res.status(400).json({
        error: validation.reason,
      });
    }

    const lock = investorCommitmentService.getInvestorLock(invoiceId, funderAddress.trim());

    if (!lock) {
      return res.status(404).json({
        error: 'Lock not found',
      });
    }

    logger.info(
      {
        requestId: req.id,
        invoiceId,
        funderAddress,
      },
      'Investor lock retrieved'
    );

    return res.json({
      data: lock,
      message: 'Investor lock retrieved.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;