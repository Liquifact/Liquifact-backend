'use strict';

/**
 * @fileoverview GET /api/escrow/events — query decoded escrow contract events.
 *
 * Supports filtering by type, investor address, and fromLedger; cursor-based
 * pagination via `limit` and `after` parameters.
 *
 * @module routes/escrowEvents
 */

const { Router } = require('express');
const { defaultStore } = require('../indexer/EventStore');

const router = Router();

/**
 * @swagger
 * /api/escrow/events:
 *   get:
 *     summary: List decoded escrow contract events
 *     description: >
 *       Returns decoded Soroban escrow contract events stored by the indexer.
 *       Supports filtering by type, investor address, and fromLedger.
 *       Uses cursor-based pagination.
 *     tags:
 *       - Escrow
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum:
 *             - funded
 *             - settled
 *             - investor_payout_claimed
 *             - refunded
 *             - funding_cancelled
 *             - legal_hold
 *             - sme_withdrawal
 *             - maturity
 *             - funding_target_reached
 *             - unknown
 *         description: Filter events by decoded event type.
 *       - in: query
 *         name: investor
 *         schema:
 *           type: string
 *         description: Filter events by investor Stellar address (G...).
 *       - in: query
 *         name: fromLedger
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Include only events at or after this ledger sequence.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 50
 *         description: Maximum number of events to return (1–200).
 *       - in: query
 *         name: after
 *         schema:
 *           type: string
 *         description: Return events after this event id (cursor-based pagination).
 *     responses:
 *       200:
 *         description: Paginated list of decoded escrow events.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EscrowEventListResponse'
 *       400:
 *         description: Invalid query parameter.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Problem'
 */
router.get('/', (req, res) => {
  const { type, investor, after } = req.query;

  // Validate limit
  const rawLimit = req.query.limit;
  let limit = 50;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: '`limit` must be an integer between 1 and 200.',
      });
    }
    limit = parsed;
  }

  // Validate fromLedger
  let fromLedger;
  if (req.query.fromLedger !== undefined) {
    const parsed = parseInt(req.query.fromLedger, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: '`fromLedger` must be a non-negative integer.',
      });
    }
    fromLedger = parsed;
  }

  const result = defaultStore.query({ type, investor, fromLedger, limit, after });

  return res.json(result);
});

module.exports = router;
