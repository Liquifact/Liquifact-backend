'use strict';

/**
 * @fileoverview Investor-specific routes for lock and commitment data.
 * @module routes/investor
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { extractTenant } = require('../middleware/tenant');
const { cacheResponse, makeInvestorLocksKey, makeInvestorLockKey } = require('../middleware/cache');
const { getSharedStore } = require('../services/cacheStore');
const investorCommitmentService = require('../services/investorCommitment');
const {
  getBoundFunderAddress,
  isInvestorLockAdmin,
} = require('../utils/investorLockScope');
const logger = require('../logger');

const CACHE_TTL_MS = 15000;
const cacheLocks = cacheResponse({
  ttl: CACHE_TTL_MS,
  store: getSharedStore(),
  keyFn: makeInvestorLocksKey,
});
const cacheLock = cacheResponse({
  ttl: CACHE_TTL_MS,
  store: getSharedStore(),
  keyFn: makeInvestorLockKey,
});

/**
 * @swagger
 * /api/investor/locks:
 *   get:
 *     operationId: listInvestorLocks
 *     summary: Get investor commitment locks (paginated)
 *     description: |
 *       Retrieve a paginated list of investor lock records
 *       (claimNotBefore, investorEffectiveYieldBps) per funder.
 *       Returns `meta.stale=true` only when any row lacks a fresh DB refresh timestamp.
 *
 *       **Pagination**
 *       | Param | Default | Notes |
 *       |-------|---------|-------|
 *       | `limit` | 20 | Items per page (1–100) |
 *       | `page`  | 1  | 1-based page number |
 *
 *       Funder scoping is always enforced server-side. Non-admin callers can
 *       only see locks for the funder address bound to their authenticated
 *       principal. Admin or owner callers may inspect all funders in the tenant.
 *     tags: [Investor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: funderAddress
 *         schema:
 *           type: string
 *         description: Optional funder Stellar address (G... or C...). Non-admin callers may only request their own bound funder address.
 *       - in: query
 *         name: invoiceId
 *         schema:
 *           type: string
 *         description: Optional filter by invoice ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of items per page
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: 1-based page number
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
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *                     stale:
 *                       type: boolean
 *       400:
 *         description: Invalid address format or invalid pagination params
 *       403:
 *         description: Caller is not authorized for the requested funder scope
 */
router.get('/locks', authenticateToken, extractTenant, cacheLocks, async (req, res, next) => {
  try {
    const { funderAddress, invoiceId } = req.query;
    const hasFunderAddressParam = Object.prototype.hasOwnProperty.call(req.query, 'funderAddress');
    const requestedFunderAddress = hasFunderAddressParam && typeof funderAddress === 'string'
      ? funderAddress.trim()
      : undefined;

    if (hasFunderAddressParam) {
      if (typeof funderAddress !== 'string') {
        return res.status(400).json({ error: 'funderAddress must be a single string value' });
      }
      const validation = investorCommitmentService.validateAddress(requestedFunderAddress);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.reason });
      }
    }

    // Validate pagination params
    const rawLimit = req.query.limit;
    const rawPage = req.query.page;

    if (rawLimit !== undefined) {
      const v = parseInt(rawLimit, 10);
      if (isNaN(v) || v < 1 || v > 100) {
        return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
      }
    }
    if (rawPage !== undefined) {
      const v = parseInt(rawPage, 10);
      if (isNaN(v) || v < 1) {
        return res.status(400).json({ error: 'page must be an integer >= 1' });
      }
    }

    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 20;
    const page = rawPage !== undefined ? parseInt(rawPage, 10) : 1;

    const isAdmin = isInvestorLockAdmin(req.user);
    const boundFunderAddress = getBoundFunderAddress(req.user);
    let effectiveFunderAddress = requestedFunderAddress;

    if (!isAdmin) {
      if (!boundFunderAddress) {
        return res.status(403).json({ error: 'Authenticated investor is not bound to a funderAddress' });
      }

      const boundValidation = investorCommitmentService.validateAddress(boundFunderAddress);
      if (!boundValidation.valid) {
        return res.status(403).json({ error: 'Authenticated investor has an invalid bound funderAddress' });
      }

      if (requestedFunderAddress && requestedFunderAddress !== boundFunderAddress) {
        return res.status(403).json({ error: 'funderAddress is not authorized for this caller' });
      }

      effectiveFunderAddress = boundFunderAddress;
    }

    const tenantId = req.tenantId;
    const result = effectiveFunderAddress
      ? await investorCommitmentService.getInvestorLocksByAddress(effectiveFunderAddress, { tenantId, invoiceId, limit, page })
      : await investorCommitmentService.getAllInvestorLocks({ tenantId, invoiceId, limit, page });

    const anyStale = result.data.length > 0 && result.data.some((lock) => lock.stale === true);

    logger.info(
      {
        requestId: req.id,
        funderAddress: effectiveFunderAddress,
        requestedFunderAddress,
        invoiceId,
        count: result.data.length,
        total: result.meta.total,
        page: result.meta.page,
        stale: anyStale,
        adminScope: isAdmin,
      },
      'Investor locks retrieved'
    );

    return res.json({
      data: result.data,
      meta: {
        ...result.meta,
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
 *     operationId: getInvestorLockByInvoice
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
 *       400:
 *         description: Missing or invalid funderAddress
 *       403:
 *         description: Caller is not authorized for the requested funder
 *       404:
 *         description: Lock not found
 */
router.get('/locks/:invoiceId', authenticateToken, extractTenant, cacheLock, async (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    const { funderAddress } = req.query;

    if (!funderAddress) {
      return res.status(400).json({ error: 'funderAddress query parameter is required' });
    }

    const validation = investorCommitmentService.validateAddress(funderAddress);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason });
    }

    const requestedFunderAddress = funderAddress.trim();
    const isAdmin = isInvestorLockAdmin(req.user);
    const boundFunderAddress = getBoundFunderAddress(req.user);

    if (!isAdmin) {
      if (!boundFunderAddress) {
        return res.status(403).json({ error: 'Authenticated investor is not bound to a funderAddress' });
      }

      const boundValidation = investorCommitmentService.validateAddress(boundFunderAddress);
      if (!boundValidation.valid) {
        return res.status(403).json({ error: 'Authenticated investor has an invalid bound funderAddress' });
      }

      if (requestedFunderAddress !== boundFunderAddress) {
        return res.status(403).json({ error: 'funderAddress is not authorized for this caller' });
      }
    }

    const lock = await investorCommitmentService.getInvestorLock(invoiceId, requestedFunderAddress, {
      tenantId: req.tenantId,
    });

    if (!lock) {
      return res.status(404).json({ error: 'Lock not found' });
    }

    logger.info({ requestId: req.id, invoiceId, funderAddress: requestedFunderAddress, adminScope: isAdmin }, 'Investor lock retrieved');

    return res.json({ data: lock, message: 'Investor lock retrieved.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
