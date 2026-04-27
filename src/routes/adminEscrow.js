'use strict';

/**
 * @fileoverview Admin routes for LiquifactEscrow wasm version management.
 * All routes require admin authentication (JWT or API key).
 *
 * @module routes/adminEscrow
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { apiKeyAuth } = require('../middleware/apiKey');
const { runContractListRefresh } = require('../jobs/contractListRefresh');
const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const AppError = require('../errors/AppError');
const logger = require('../logger');

/**
 * Accepts either a valid admin JWT or a valid API key.
 */
function adminAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return apiKeyAuth(req, res, next);
  }
  return authenticateToken(req, res, next);
}

/**
 * POST /api/admin/escrow/refresh
 * Manually triggers the contract list refresh job.
 */
router.post('/refresh', adminAuth, async (req, res, next) => {
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
 */
router.get('/version', adminAuth, async (req, res, next) => {
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
