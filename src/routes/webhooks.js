'use strict';

/**
 * Admin routes for webhook management.
 *
 * All routes require Authorization: Bearer <ADMIN_API_TOKEN>.
 * Uses the shared admin-token middleware (constant-time digest comparison).
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
const { requireAdminToken } = require('../middleware/require-admin-token');

const router = express.Router();

// Every route below is admin-only (guard declared per route so the route table shows it).
router.use(requireAdminToken);

// ---------------------------------------------------------------------------
// POST /api/webhooks
// ---------------------------------------------------------------------------

router.post('/', requireAdminToken, async (req, res) => {
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

router.delete('/:id', requireAdminToken, (req, res) => {
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
  const { status, limit: rawLimit } = req.query;
  const validStatuses = ['pending', 'delivered', 'failed'];
  if (status !== undefined && (typeof status !== 'string' || !validStatuses.includes(status))) {
    return res.status(400).json({ error: 'status must be one of: pending, delivered, failed' });
  }

  let limit = 50;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > 50) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    }
  }

  const wh = webhookStore.getWebhook(req.params.id);
  if (!wh) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  let log = webhookStore.getDeliveries(req.params.id) || [];
  if (status !== undefined) {
    log = log.filter((delivery) => delivery.status === status);
  }
  log = log.slice(0, limit);
  return res.json({ data: log });
});

module.exports = router;
module.exports.requireAdminToken = requireAdminToken;
