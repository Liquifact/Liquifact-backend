'use strict';

/**
 * Admin routes for webhook management.
 *
 * All routes require Authorization: Bearer <ADMIN_API_TOKEN>.
 * The middleware uses a constant-time comparison to prevent timing attacks.
 *
 * Routes:
 *   POST   /api/webhooks                  Register a new subscription
 *   GET    /api/webhooks                  List all subscriptions
 *   DELETE /api/webhooks/:id              Remove a subscription
 *   GET    /api/webhooks/:id/deliveries   Last 50 delivery records
 */

const express = require('express');
const { validateWebhookUrl } = require('../webhooks/ssrf');
const webhookStore = require('../webhooks/store');

const router = express.Router();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Constant-time token check. Returns 503 if ADMIN_API_TOKEN is not configured,
 * 401 if the token is wrong or missing.
 *
 * @type {import('express').RequestHandler}
 */
function requireAdminToken(req, res, next) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Admin API not configured (ADMIN_API_TOKEN unset)' });
  }

  const authHeader = req.headers.authorization || '';
  const supplied = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // Constant-time compare using crypto.timingSafeEqual
  const crypto = require('crypto');
  const expected = Buffer.from(token, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');

  // timingSafeEqual requires equal-length buffers
  let match = false;
  if (expected.length === actual.length) {
    match = crypto.timingSafeEqual(expected, actual);
  } else {
    // Still perform a dummy comparison to avoid early exit timing leak
    crypto.timingSafeEqual(expected, expected);
  }

  if (!match) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

router.use(requireAdminToken);

// ---------------------------------------------------------------------------
// POST /api/webhooks
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { url, events } = req.body || {};

  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url is required and must be a non-empty string' });
  }

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events must be a non-empty array' });
  }

  const invalid = events.filter((e) => !webhookStore.VALID_EVENTS.includes(e));
  if (invalid.length > 0) {
    return res
      .status(400)
      .json({ error: `unknown event types: ${invalid.join(', ')}. Valid: ${webhookStore.VALID_EVENTS.join(', ')}` });
  }

  // SSRF guard + URL validation
  let urlMeta;
  try {
    urlMeta = await validateWebhookUrl(url.trim());
  } catch (err) {
    return res.status(400).json({ error: `invalid webhook URL: ${err.message}` });
  }

  const result = webhookStore.createWebhook({
    url: urlMeta.url,
    pinnedUrl: urlMeta.pinnedUrl,
    host: urlMeta.host,
    events,
  });

  // result.secret is the only place the plaintext secret is ever returned
  return res.status(201).json({ data: result });
});

// ---------------------------------------------------------------------------
// GET /api/webhooks
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  return res.json({ data: webhookStore.listWebhooks() });
});

// ---------------------------------------------------------------------------
// DELETE /api/webhooks/:id
// ---------------------------------------------------------------------------

router.delete('/:id', (req, res) => {
  const deleted = webhookStore.deleteWebhook(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/webhooks/:id/deliveries
// ---------------------------------------------------------------------------

router.get('/:id/deliveries', (req, res) => {
  const wh = webhookStore.getWebhook(req.params.id);
  if (!wh) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  const log = webhookStore.getDeliveries(req.params.id) || [];
  return res.json({ data: log });
});

module.exports = router;
module.exports.requireAdminToken = requireAdminToken;
