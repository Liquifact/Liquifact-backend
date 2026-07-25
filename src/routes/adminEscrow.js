'use strict';

/**
 * @fileoverview Admin routes for LiquifactEscrow wasm version management.
 * All routes require admin authentication (JWT or API key).
 *
 * @module routes/adminEscrow
 */

const express = require('express');
const router = express.Router();
const { adminStack } = require('../middleware/stacks');
const { runContractListRefresh } = require('../jobs/contractListRefresh');
const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const AppError = require('../errors/AppError');
const logger = require('../logger');

router.use(...adminStack);

/**
 * POST /api/admin/escrow/refresh
 * Manually triggers the contract list refresh job.
 *
 * @swagger
 * /api/admin/escrow/refresh:
 *   post:
 *     operationId: refreshEscrowContractList
 *     summary: Trigger a manual contract list refresh
 *     description: |
 *       Manually triggers the Soroban contract list refresh job.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       202:
 *         description: Contract list refresh triggered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       502:
 *         description: Soroban RPC read failed
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await runContractListRefresh();
    logger.info({ result, requestId: req.id }, 'Admin triggered contract list refresh');
    return res.status(202).json({
      message: 'Contract list refresh triggered.',
      ...result,
    });
  } catch (err) {
    if (err.code === 'INVALID_CONTRACT_ID') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: err.message,
      }));
    }
    if (err.code === 'RPC_ERROR') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/upstream-error',
        title: 'Upstream Error',
        status: 502,
        detail: 'Soroban RPC read failed. Retry after confirming RPC health.',
      }));
    }
    next(err);
  }
});

/**
 * GET /api/admin/escrow/version
 * Returns the current on-chain SCHEMA_VERSION and registry comparison.
 *
 * @swagger
 * /api/admin/escrow/version:
 *   get:
 *     operationId: getEscrowContractVersion
 *     summary: Get on-chain escrow contract schema version
 *     description: |
 *       Returns the current on-chain `SCHEMA_VERSION` for the LiquifactEscrow
 *       contract and compares it against the known registry version.
 *       Requires admin authentication (JWT or API key).
 *     tags: [Escrow]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Version comparison returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 onChainVersion:
 *                   type: string
 *                 knownVersion:
 *                   type: string
 *                 status:
 *                   type: string
 *                   enum: [match, mismatch, unknown]
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 *       403:
 *         $ref: '#/components/responses/Problem403'
 *       502:
 *         description: Soroban RPC read failed
 */
router.get('/version', async (req, res, next) => {
  try {
    const onChainVersion = await getOnChainSchemaVersion();
    const { status, knownVersion } = compareVersions(onChainVersion);
    return res.json({ onChainVersion, knownVersion, status });
  } catch (err) {
    if (err.code === 'INVALID_CONTRACT_ID') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: err.message,
      }));
    }
    if (err.code === 'RPC_ERROR') {
      return next(new AppError({
        type: 'https://liquifact.com/probs/upstream-error',
        title: 'Upstream Error',
        status: 502,
        detail: 'Soroban RPC read failed.',
      }));
    }
    next(err);
  }
});

module.exports = router;
