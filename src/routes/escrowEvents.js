'use strict';

/**
 * @fileoverview GET /api/escrow/events — query decoded escrow contract events.
 *
 * Supports filtering by type, investor address, originating contract id, and
 * fromLedger; cursor-based pagination via `limit` and `after` parameters.
 *
 * @module routes/escrowEvents
 */

const { Router } = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const { defaultStore } = require('../indexer/EventStore');
const { EVENT_TYPES } = require('../indexer/decode');
const { badRequest } = require('../errors');

const router = Router();

/**
 * @swagger
 * /api/escrow/events:
 *   get:
 *     summary: List decoded escrow contract events
 *     description: >
 *       Returns decoded Soroban escrow contract events stored by the indexer.
 *       Supports filtering by type, investor address, contractId, and
 *       fromLedger. Uses cursor-based pagination.
 *     tags:
 *       - Escrow
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter events by decoded event type; allowed values are listed in the OpenAPI document.
 *       - in: query
 *         name: investor
 *         schema:
 *           type: string
 *         description: Filter events by investor Stellar address (G...).
 *       - in: query
 *         name: contractId
 *         schema:
 *           type: string
 *         description: Filter events by originating escrow contract id (C...).
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
  const contractId =
    typeof req.query.contractId === 'string' && req.query.contractId.trim()
      ? req.query.contractId.trim()
      : undefined;

  if (type !== undefined && (typeof type !== 'string' || !EVENT_TYPES.includes(type))) {
    throw badRequest('VALIDATION_FAILED', `\`type\` must be one of: ${EVENT_TYPES.join(', ')}.`);
  }

  if (investor !== undefined && (typeof investor !== 'string' || !StrKey.isValidEd25519PublicKey(investor))) {
    throw badRequest('INVALID_INVESTOR_ADDRESS');
  }

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

  const result = defaultStore.query({
    type,
    investor,
    contractId,
    fromLedger,
    limit,
    after,
  });

  if (result.error) {
    return res.status(400).json({
      type: 'https://liquifact.io/problems/invalid-cursor',
      title: 'Invalid Cursor',
      status: 400,
      code: 'INVALID_CURSOR',
      detail: result.error,
    });
  }

  return res.json(result);
});

module.exports = router;
