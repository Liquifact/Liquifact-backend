'use strict';

/**
 * @fileoverview Webhook outbox service (issue #1210).
 *
 * Implements the transactional outbox pattern: events are written to the
 * `webhook_outbox` table inside the same DB transaction as the invoice
 * mutation that produced them. A background worker polls pending rows,
 * delivers them, and tracks retries/dead-letter state.
 *
 * @module services/webhookOutbox
 */

const db = require('../db/knex');
const logger = require('../logger');

const OUTBOX_TABLE = 'webhook_outbox';
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Inserts an outbox event row. Must be called inside an existing transaction
 * (`trx`) so the event is committed atomically with the invoice mutation.
 *
 * @param {import('knex').Knex.Transaction} trx - Active transaction.
 * @param {object} params
 * @param {string} params.invoiceId
 * @param {string} params.tenantId
 * @param {string} params.event
 * @param {object} params.payload - Will be JSON-serialised.
 * @param {string} [params.correlationId]
 * @param {number} [params.maxAttempts]
 * @returns {Promise<object>} The inserted outbox row.
 */
async function insertOutboxEvent(trx, { invoiceId, tenantId, event, payload, correlationId, maxAttempts }) {
  const id = `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const row = {
    id,
    invoice_id: invoiceId,
    tenant_id: tenantId || '',
    event,
    payload: JSON.stringify(payload),
    status: 'pending',
    attempts: 0,
    max_attempts: maxAttempts || DEFAULT_MAX_ATTEMPTS,
    last_error: null,
    next_retry_at: new Date().toISOString(),
    correlation_id: correlationId || null,
    created_at: new Date().toISOString(),
    delivered_at: null,
  };

  await trx(OUTBOX_TABLE).insert(row);
  return row;
}

/**
 * Returns the next batch of deliverable outbox events (pending rows whose
 * retry window has passed). Used by the background delivery worker.
 *
 * @param {number} [limit=50] - Max rows to fetch.
 * @returns {Promise<object[]>} Outbox rows ready for delivery.
 */
async function fetchPendingEvents(limit = 50) {
  const now = new Date().toISOString();
  return db(OUTBOX_TABLE)
    .where('status', 'pending')
    .where('next_retry_at', '<=', now)
    .orderBy('created_at', 'asc')
    .limit(limit);
}

/**
 * Marks an outbox event as successfully delivered.
 *
 * @param {string} outboxId - The outbox row id.
 * @returns {Promise<void>}
 */
async function markDelivered(outboxId) {
  await db(OUTBOX_TABLE)
    .where('id', outboxId)
    .update({
      status: 'delivered',
      delivered_at: new Date().toISOString(),
    });
}

/**
 * Increments the attempt counter and schedules the next retry with
 * exponential back-off. If max attempts are exhausted, marks as 'failed'.
 *
 * @param {string} outboxId - The outbox row id.
 * @param {string} error - Error message from the failed attempt.
 * @param {object} [row] - The current outbox row (to read attempts/max).
 * @returns {Promise<void>}
 */
async function markFailed(outboxId, error, row) {
  if (!row) {
    row = await db(OUTBOX_TABLE).where('id', outboxId).first();
  }
  if (!row) return;

  const newAttempts = row.attempts + 1;
  const exhausted = newAttempts >= row.max_attempts;

  // Exponential back-off: 30s, 2m, 8m, 30m, 2h
  const backoffMs = Math.min(30000 * Math.pow(4, newAttempts - 1), 7200000);
  const nextRetry = new Date(Date.now() + backoffMs).toISOString();

  await db(OUTBOX_TABLE)
    .where('id', outboxId)
    .update({
      status: exhausted ? 'failed' : 'pending',
      attempts: newAttempts,
      last_error: error,
      next_retry_at: exhausted ? null : nextRetry,
    });

  if (exhausted) {
    logger.warn(
      { outboxId, invoiceId: row.invoice_id, event: row.event, attempts: newAttempts },
      'Outbox event exhausted retries, moved to failed',
    );
  }
}

/**
 * Returns observability counters for the outbox.
 *
 * @returns {Promise<{pending: number, delivered: number, failed: number}>}
 */
async function getOutboxStats() {
  const rows = await db(OUTBOX_TABLE)
    .select('status')
    .count('* as count')
    .groupBy('status');

  const stats = { pending: 0, delivered: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status] = Number(row.count);
    }
  }
  return stats;
}

/**
 * Purges delivered outbox events older than the given age.
 *
 * @param {number} [maxAgeMs=86400000] - Max age in ms (default 24h).
 * @returns {Promise<number>} Number of rows purged.
 */
async function purgeDelivered(maxAgeMs = 86400000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return db(OUTBOX_TABLE)
    .where('status', 'delivered')
    .where('delivered_at', '<', cutoff)
    .del();
}

module.exports = {
  insertOutboxEvent,
  fetchPendingEvents,
  markDelivered,
  markFailed,
  getOutboxStats,
  purgeDelivered,
  OUTBOX_TABLE,
};
