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
const { defaultStore } = require('../indexer/defaultEventStore');
const { EVENT_TYPES } = require('../indexer/decode');
const { badRequest } = require('../errors');

const router = Router();
const STRICT_UINT = /^\d+$/;

/**
 * Parses a single query parameter as a strict non-negative safe integer.
 * Rejects repeated params (arrays), empty strings, signs, decimals, scientific
 * notation, and trailing characters.
 *
 * @param {unknown} raw raw query value from `req.query`
 * @returns {number | null} parsed integer, or `null` when invalid
 */
function parseStrictNonNegativeInt(raw) {
  if (typeof raw !== 'string' || !STRICT_UINT.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

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

  if (req.query.contractId !== undefined && typeof req.query.contractId !== 'string') {
    throw badRequest('VALIDATION_FAILED', '`contractId` must be a single string.');
  }
  const contractId =
    typeof req.query.contractId === 'string' && req.query.contractId.trim()
      ? req.query.contractId.trim()
      : undefined;

  if (after !== undefined && typeof after !== 'string') {
    throw badRequest('VALIDATION_FAILED', '`after` must be a single string.');
  }

  if (type !== undefined && (typeof type !== 'string' || !EVENT_TYPES.includes(type))) {
    throw badRequest('VALIDATION_FAILED', `\`type\` must be one of: ${EVENT_TYPES.join(', ')}.`);
  }

  if (investor !== undefined && (typeof investor !== 'string' || !StrKey.isValidEd25519PublicKey(investor))) {
    throw badRequest('INVALID_INVESTOR_ADDRESS');
  }

  // Validate limit (strict integer 1-200)
  const rawLimit = req.query.limit;
  let limit = 50;
  if (rawLimit !== undefined) {
    const parsed = parseStrictNonNegativeInt(rawLimit);
    if (parsed === null || parsed < 1 || parsed > 200) {
      return res.status(400).json({
        type: 'https://liquifact.io/problems/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: '`limit` must be an integer between 1 and 200.',
      });
    }
    limit = parsed;
  }

  // Validate fromLedger (strict non-negative integer)
  let fromLedger;
  if (req.query.fromLedger !== undefined) {
    const parsed = parseStrictNonNegativeInt(req.query.fromLedger);
    if (parsed === null) {
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
