'use strict';

/**
 * @fileoverview Internal indexer trigger route.
 *
 * POST /api/internal/indexer/run
 * Protected by `Authorization: Bearer <CRON_SECRET>`.
 * Returns 404 when CRON_SECRET is not configured so the endpoint is
 * unreachable without the secret — it does not advertise its own existence.
 * Uses a constant-time comparison to prevent timing attacks.
 *
 * Suitable for use as a Vercel Cron target (vercel.json crons entry).
 *
 * @module routes/indexerTrigger
 */

const { Router } = require('express');
const { runOnce } = require('../indexer/escrow-indexer');
const logger = require('../logger');

const router = Router();

/**
 * Constant-time string comparison to prevent timing-based secret leakage.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') { return false; }
  if (a.length !== b.length) {
    // Still iterate to avoid length-based timing leakage, but always return false
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    void diff; // consumed to satisfy linter; result is intentionally discarded
    return false; // lengths differ, always false
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

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
router.post('/run', async (req, res) => {
  const secret = process.env.CRON_SECRET;

  // 404 when secret is not configured — the endpoint is invisible
  if (!secret) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Validate Bearer token
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!safeEqual(token, secret)) {
    return res.status(401).json({
      type: 'https://liquifact.io/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid or missing Authorization: Bearer <CRON_SECRET>.',
    });
  }

  const maxPages = Math.min(
    Math.max(1, parseInt(req.body?.maxPages ?? '5', 10) || 5),
    20,
  );

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
