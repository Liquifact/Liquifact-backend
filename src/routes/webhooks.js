'use strict';

/**
 * Admin routes for webhook management.
 *
 * All routes require Authorization: Bearer <ADMIN_API_TOKEN>.
 * Uses the shared admin-token middleware (constant-time digest comparison).
 *
 * Routes:
 *   POST   /api/webhooks                                 Register a new subscription
 *   GET    /api/webhooks                                 List all subscriptions
 *   DELETE /api/webhooks/:id                             Remove a subscription
 *   GET    /api/webhooks/:id/deliveries                  Last 50 delivery records
 *   POST   /api/webhooks/:id/deliveries/:deliveryId/replay  Replay a delivery
 */

const express = require('express');
const config = require('../config');
const { validateWebhookUrl } = require('../webhooks/ssrf');
const webhookStore = require('../webhooks/store');
const { replayDelivery } = require('../webhooks/deliver');
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

  const uniqueEvents = [...new Set(events)];
  const invalid = uniqueEvents.filter((e) => !webhookStore.VALID_EVENTS.includes(e));
  if (invalid.length > 0) {
    return res
      .status(400)
      .json({ error: `unknown event types: ${invalid.join(', ')}. Valid: ${webhookStore.VALID_EVENTS.join(', ')}` });
  }

  let maxWebhooks = config.webhooksMax;
  if (process.env.WEBHOOKS_MAX !== undefined && process.env.WEBHOOKS_MAX !== '') {
    maxWebhooks = config.loadConfig({ WEBHOOKS_MAX: process.env.WEBHOOKS_MAX }).webhooksMax;
  }
  if (webhookStore.countWebhooks() >= maxWebhooks) {
    return res.status(409).json({
      error: `webhook subscription limit (${maxWebhooks}) reached`,
      code: 'WEBHOOKS_MAX_REACHED',
    });
  }

  // SSRF guard + URL validation
  let urlMeta;
  try {
    urlMeta = await validateWebhookUrl(url.trim());
  } catch (err) {
    return res.status(400).json({ error: `invalid webhook URL: ${err.message}` });
  }

  // Re-check cap after async URL validation to guard against concurrent registrations
  if (webhookStore.countWebhooks() >= maxWebhooks) {
    return res.status(409).json({
      error: `webhook subscription limit (${maxWebhooks}) reached`,
      code: 'WEBHOOKS_MAX_REACHED',
    });
  }

  const result = webhookStore.createWebhook({
    url: urlMeta.url,
    pinnedUrl: urlMeta.pinnedUrl,
    host: urlMeta.host,
    events: uniqueEvents,
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
// GET /api/webhooks/:id - Show webhook details (admin only, no secrets/URL)
// ---------------------------------------------------------------------------

router.get('/:id', requireAdminToken, (req, res) => {
  const wh = webhookStore.getWebhook(req.params.id);
  if (!wh) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  // Return only public fields: id, url, events, createdAt
  return res.json({ data: { id: wh.id, url: wh.url, events: wh.events, createdAt: wh.createdAt } });
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
  const wh = webhookStore.getWebhook(req.params.id);
  if (!wh) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  const log = (webhookStore.getDeliveries(req.params.id) || []).map(
    ({ rawBody: _rawBody, ...pub }) => pub
  );
  return res.json({ data: log });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/:id/deliveries/:deliveryId/replay
// ---------------------------------------------------------------------------

router.post('/:id/deliveries/:deliveryId/replay', requireAdminToken, (req, res) => {
  const wh = webhookStore.getWebhookInternal(req.params.id);
  if (!wh) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  const original = webhookStore.getDelivery(req.params.id, req.params.deliveryId);
  if (!original) {
    return res.status(404).json({ error: 'Delivery not found' });
  }

  if (original.status === 'pending') {
    return res.status(409).json({ error: 'Delivery is still pending' });
  }

  if (typeof original.rawBody !== 'string' || !original.rawBody) {
    return res.status(409).json({ error: 'Delivery payload is not available for replay' });
  }

  const replayed = replayDelivery(wh, original);
  return res.status(202).json({ data: replayed });
});

module.exports = router;
module.exports.requireAdminToken = requireAdminToken;
