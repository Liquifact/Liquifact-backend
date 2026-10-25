'use strict';

/**
 * In-memory store for webhook subscriptions and delivery logs.
 *
 * Limitation: state is per-instance. In a multi-instance or serverless
 * deployment, each instance maintains its own webhook registry and delivery
 * log. A durable queue or shared database would be needed for production-grade
 * reliability across instances.
 *
 * Security note: the plaintext secret (32 random bytes, base64url) is kept in
 * memory in the internal record so the delivery engine can sign outgoing
 * requests. It is NEVER returned by any API response after the initial POST
 * /api/webhooks (where it is shown exactly once). Public-facing accessors
 * (listWebhooks, getWebhook) strip the secret field.
 */

const crypto = require('crypto');

const VALID_EVENTS = ['invoice.created', 'invoice.funding_received', 'invoice.funded'];
const MAX_DELIVERIES_PER_WEBHOOK = 50;

/**
 * Internal shape:
 * { id, url, pinnedUrl, host, events, secret (base64url), createdAt }
 *
 * @type {Map<string, object>}
 */
let webhooks = new Map();

/**
 * Delivery log: webhookId → array of delivery records (most-recent-first).
 * Each delivery record is mutated in place as attempts are appended.
 *
 * @type {Map<string, object[]>}
 */
let deliveries = new Map();

/**
 * Creates a new webhook subscription.
 *
 * @param {{ url: string, pinnedUrl: string, host: string, events: string[] }} opts
 * @returns {{ id: string, secret: string, url: string, events: string[], createdAt: string }}
 *   `secret` is present only in this return value — it is never retrievable again.
 */
function createWebhook({ url, pinnedUrl, host, events }) {
  const id = `wh_${crypto.randomBytes(8).toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('base64url');

  const record = {
    id,
    url,
    pinnedUrl,
    host,
    events: [...events],
    secret, // retained in-memory for signing; never exposed via GET
    createdAt: new Date().toISOString(),
  };

  webhooks.set(id, record);
  deliveries.set(id, []);

  // Return the secret here — this is the only time it is visible
  return { id, secret, url, events: record.events, createdAt: record.createdAt };
}

/**
 * Returns all webhook subscriptions (without secrets).
 * @returns {object[]}
 */
function listWebhooks() {
  return [...webhooks.values()].map(publicView);
}

/**
 * Returns one webhook subscription (without secret).
 * @param {string} id
 * @returns {object|undefined}
 */
function getWebhook(id) {
  const wh = webhooks.get(id);
  return wh ? publicView(wh) : undefined;
}

/**
 * Returns the full internal record (including secret, pinnedUrl, host).
 * Used ONLY by the delivery engine — never sent in any HTTP response.
 *
 * @param {string} id
 * @returns {object|undefined}
 */
function getWebhookInternal(id) {
  return webhooks.get(id);
}

/**
 * Deletes a webhook subscription and its delivery log.
 * @param {string} id
 * @returns {boolean} true if deleted, false if not found
 */
function deleteWebhook(id) {
  if (!webhooks.has(id)) { return false; }
  webhooks.delete(id);
  deliveries.delete(id);
  return true;
}

/**
 * Returns all webhooks subscribed to a given event type (internal records).
 * @param {string} eventType
 * @returns {object[]}
 */
function getWebhooksForEvent(eventType) {
  return [...webhooks.values()].filter((wh) => wh.events.includes(eventType));
}

/**
 * Appends a delivery record to the log for a webhook (capped at MAX_DELIVERIES_PER_WEBHOOK).
 *
 * @param {string} webhookId
 * @param {object} delivery
 */
function appendDelivery(webhookId, delivery) {
  const log = deliveries.get(webhookId);
  if (!log) { return; }
  log.unshift(delivery); // most recent first
  if (log.length > MAX_DELIVERIES_PER_WEBHOOK) {
    log.length = MAX_DELIVERIES_PER_WEBHOOK;
  }
}

/**
 * Returns the last 50 delivery records for a webhook.
 * @param {string} webhookId
 * @returns {object[]|undefined}
 */
function getDeliveries(webhookId) {
  return deliveries.get(webhookId);
}

/** Strips fields that must not be in API responses. */
function publicView({ secret: _s, pinnedUrl: _p, host: _h, ...pub }) {
  return pub;
}

/** Resets all state (used by tests). */
function reset() {
  webhooks = new Map();
  deliveries = new Map();
}

module.exports = {
  VALID_EVENTS,
  createWebhook,
  listWebhooks,
  getWebhook,
  getWebhookInternal,
  deleteWebhook,
  getWebhooksForEvent,
  appendDelivery,
  getDeliveries,
  reset,
};
