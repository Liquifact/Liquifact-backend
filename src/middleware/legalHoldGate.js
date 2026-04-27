/**
 * @fileoverview Legal-hold gating middleware.
 *
 * Checks the `legal_hold` flag on an escrow before any funding action is
 * allowed to proceed.  Must be placed after the invoiceId has been resolved
 * (i.e. after route params are available) and before the handler that submits
 * a transaction.
 *
 * Usage:
 *   router.post('/api/escrow/:invoiceId/fund', legalHoldGate(), fundHandler);
 *
 * @module middleware/legalHoldGate
 */

'use strict';

const { fetchLegalHold } = require('../services/escrowRead');
const logger = require('../logger');

/**
 * Express middleware factory that blocks the request with HTTP 502 when the
 * escrow identified by `req.params.invoiceId` is under legal hold.
 *
 * @param {object}   [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter for tests.
 * @returns {import('express').RequestHandler}
 */
function legalHoldGate(options = {}) {
  const { legalHoldAdapter } = options;

  return async function checkLegalHold(req, res, next) {
    const invoiceId = req.params && req.params.invoiceId;

    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim() === '') {
      return res.status(400).json({ error: 'invoiceId is required' });
    }

    try {
      let held;
      if (legalHoldAdapter) {
        // Use adapter directly so errors propagate to next(err)
        const result = await legalHoldAdapter(invoiceId.trim());
        held = result === true || result === 1 || result === 'true';
      } else {
        held = await fetchLegalHold(invoiceId.trim());
      }

      if (held) {
        logger.warn(
          { invoiceId: invoiceId.trim() },
          'legalHoldGate: funding blocked — escrow is under legal hold',
        );
        return res.status(502).json({ error: 'Escrow is under legal hold' });
      }

      return next();
    } catch (err) {
      logger.error(
        { errCode: err && err.code },
        'legalHoldGate: unexpected error during legal-hold check',
      );
      return next(err);
    }
  };
}

module.exports = { legalHoldGate };
