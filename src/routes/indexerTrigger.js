'use strict';

/**
 * @fileoverview Internal indexer trigger route.
 *
 * POST /api/internal/indexer/run
 * Protected by `Authorization: Bearer <CRON_SECRET>` via the shared
 * cron-secret middleware. Returns 404 when CRON_SECRET is not configured so
 * the endpoint is unreachable without the secret — it does not advertise its
 * own existence.
 *
 * Suitable for use as a Vercel Cron target (vercel.json crons entry).
 *
 * @module routes/indexerTrigger
 */

const { Router } = require('express');
const { runOnce } = require('../indexer/escrow-indexer');
const { sendProblem } = require('../errors');
const logger = require('../logger');
const { requireCronSecret } = require('../middleware/cron-secret');

const router = Router();

/**
 * @swagger
 * /api/internal/indexer/run:
 *   post:
 *     summary: Trigger one escrow event indexer pass
 *     description: >
 *       Pull-based Soroban RPC indexer trigger. Pages through getEvents for the
 *       configured contract, decodes known events into typed records, persists a
 *       cursor, and returns a summary. Protected by a Bearer token matching
 *       CRON_SECRET. Returns 404 when CRON_SECRET is unset.
 *     tags:
 *       - Internal
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               maxPages:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 20
 *                 default: 5
 *                 description: Maximum RPC pages to fetch per run.
 *     responses:
 *       200:
 *         description: Indexer run completed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IndexerRunResult'
 *       400:
 *         description: Invalid maxPages (must be an integer between 1 and 20; VALIDATION_FAILED).
 *         content:
 *           application/problem+json:
 *             schema:
 *               $ref: '#/components/schemas/Problem'
 *       401:
 *         description: Missing or invalid Authorization header.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Problem'
 *       404:
 *         description: Endpoint not available (CRON_SECRET not configured).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       500:
 *         description: Indexer run failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Problem'
 */
// requireCronSecret is shared with the scheduled reconciliation trigger.
router.post('/run', requireCronSecret, async (req, res) => {
  const rawMaxPages = req.body?.maxPages;
  let maxPages = 5;

  if (rawMaxPages !== undefined) {
    if (
      typeof rawMaxPages !== 'number' ||
      !Number.isInteger(rawMaxPages) ||
      rawMaxPages < 1 ||
      rawMaxPages > 20
    ) {
      return sendProblem(req, res, 'VALIDATION_FAILED', {
        detail: 'maxPages must be an integer between 1 and 20.',
        errors: [
          {
            field: 'maxPages',
            message: 'maxPages must be an integer between 1 and 20',
          },
        ],
      });
    }
    maxPages = rawMaxPages;
  }

  try {
    const result = await runOnce({ maxPages });
    return res.json(result);
  } catch (err) {
    logger.error({ err }, 'Indexer trigger run failed');
    return res.status(500).json({
      type: 'https://liquifact.io/problems/indexer-error',
      title: 'Indexer Error',
      status: 500,
      detail: err?.message ?? 'Unknown indexer error',
    });
  }
});

module.exports = router;
