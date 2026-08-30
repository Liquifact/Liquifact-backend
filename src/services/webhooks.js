'use strict';

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');
const { withRetry } = require('../utils/retry');
const { appendAuditEvent } = require('./auditLogStore');

// Lazily-resolved shared worker to avoid circular dependency at module load time.
let _sharedWorker = null;

/**
 * Injects the BackgroundWorker instance used by enqueueWebhookDelivery.
 *
 * @param {import('../workers/worker')} worker - Configured BackgroundWorker.
 * @returns {void}
 */
function setSharedWorker(worker) {
  _sharedWorker = worker;
}

let client;
try {
  client = require('prom-client');
} catch (_e) {
  client = {
    Counter: class {
      constructor() { }
      inc() { }
    },
  };
}
const { registry } = require('../metrics');

const SIGNATURE_VERSION = 'v1';
const TOLERANCE_MS = 5 * 60 * 1000;

// Signature header guards
const MAX_SIGNATURE_HEADER_LENGTH = 256;
const MAX_SIGNATURE_HEADER_PARTS = 10;

// Maximum outgoing payload size limit (Default: 128 KB)
const MAX_PAYLOAD_BYTES = Number(process.env.WEBHOOK_MAX_PAYLOAD_BYTES || 128 * 1024);

// ---- Fencing token utilities ----
const fenceStore = new Map();
const FENCE_TTL_MS = Number(process.env.WEBHOOK_FENCE_TTL_MS || 30 * 1000);

class FenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FenceError';
    this.code = 'FENCE_EXPIRED';
  }
}

function fenceKey(event, invoiceId) {
  return `${event}:${invoiceId}`;
}

function setFence(key, token) {
  fenceStore.set(key, { token, expiresAt: Date.now() + FENCE_TTL_MS });
}

function isFenceValid(key, token) {
  const entry = fenceStore.get(key);
  if (!entry || entry.token !== token) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

function assertFence(key, token) {
  if (!token) return; // no fencing required
  if (!isFenceValid(key, token)) {
    logger.warn({ key }, 'Fence token invalid or expired');
    throw new FenceError(`Fence expired or invalid for job ${key}`);
  }
}

function renewFence(key, token) {
  if (!token) return;
  if (!isFenceValid(key, token)) {
    throw new FenceError(`Cannot renew invalid fence for ${key}`);
  }
  fenceStore.get(key).expiresAt = Date.now() + FENCE_TTL_MS;
  logger.debug({ key }, 'Webhook fence renewed');
}

function clearFence(key, token) {
  if (!token) return;
  const entry = fenceStore.get(key);
  if (entry && entry.token === token) {
    fenceStore.delete(key);
    logger.debug({ key }, 'Webhook fence completed');
  }
}

/**
 * Recursively sorts keys of an object to ensure deterministic JSON serialization.
 *
 * @param {any} obj - The object to sort.
 * @returns {any} A new object with keys sorted.
 */
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  const sortedObj = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sortedObj[key] = sortKeys(obj[key]);
  }
  return sortedObj;
}

/**
 * Creates an HMAC-SHA256 signature for the given payload and timestamp.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @param {number} timestamp - Unix timestamp in seconds.
 * @returns {string} The hex-encoded signature.
 */
function createSignature(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Creates a signature header in the format t=<timestamp>,v1=<signature>.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @returns {string} The signature header string.
 */
function createSignatureHeader(secret, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createSignature(secret, rawBody, timestamp);
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Validates and enforces payload size bounds.
 *
 * @param {string} body - JSON payload string.
 * @throws {Error} If body size exceeds MAX_PAYLOAD_BYTES.
 */
function validatePayloadBounds(body) {
  const payloadBytes = Buffer.byteLength(body, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    const err = new Error(`Webhook payload size (${payloadBytes} bytes) exceeds limit of ${MAX_PAYLOAD_BYTES} bytes`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
}

/**
 * Emits a webhook for escrow events.
 *
 * @param {string} event - The event type ('escrow_funded', 'escrow_settled', etc.).
 * @param {string} invoiceId - The invoice ID.
 * @param {Object} [additionalData={}] - Additional data to include in the payload.
 * @returns {Promise<void>}
 */
async function emitWebhook(event, invoiceId, additionalData = {}, fenceToken = null) {
  const key = fenceKey(event, invoiceId);
  try {
    const invoice = await db('invoices').select('tenant_id').where('id', invoiceId).first();
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found for webhook emission');
      return;
    }

    const { tenant_id } = invoice;

    const tenant = await db('tenants').select('settings').where('id', tenant_id).first();
    if (!tenant || !tenant.settings) {
      logger.warn({ tenant_id, invoiceId }, 'Tenant settings not found for webhook');
      return;
    }

    const { webhook_url, webhook_secret } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenant_id, invoiceId }, 'Webhook URL or secret not configured');
      return;
    }

    const payload = sortKeys({
      event,
      timestamp: new Date().toISOString(),
      invoiceId,
      ...additionalData,
    });

    const body = JSON.stringify(payload);

    // Enforce payload bounding guard
    validatePayloadBounds(body);

    const signatureHeader = createSignatureHeader(webhook_secret, body);

    if (!emitWebhook._failureCounter) {
      emitWebhook._failureCounter = new client.Counter({
        name: 'webhook_delivery_failures_total',
        help: 'Total webhook deliveries that exhausted retries and were placed in dead-letter',
        registers: [registry],
      });
    }

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);

    const shouldRetry = (err) => {
      if (!err) { return false; }
      if (err && err.code === 'FENCE_EXPIRED') { return false; }
      if (err.code === 'PAYLOAD_TOO_LARGE') { return false; }
      if (err.code) {
        return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code) || err.name === 'AbortError';
      }
      if (err.status) {
        const s = Number(err.status);
        return s >= 500 && s < 600;
      }
      return false;
    };

    const operation = async () => {
      assertFence(key, fenceToken);
      const controller = new AbortController();
      const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signatureHeader,
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = new Error(`Webhook responded with ${response.status}`);
          err.status = response.status;
          throw err;
        }

        return { ok: true, status: response.status };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const onRetry = async ({ attempt, error }) => {
      assertFence(key, fenceToken);
      try {
        await appendAuditEvent({
          eventType: 'webhook_delivery',
          action: 'webhook.dispatch',
          actorType: 'system',
          actorId: tenant_id,
          targetType: 'invoice',
          targetId: invoiceId,
          statusCode: error && error.status ? Number(error.status) : null,
          metadata: {
            attempt,
            url: webhook_url,
            error: error && error.message ? error.message : String(error),
            payload,
          },
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to append audit event for webhook attempt');
      }
    };

    try {
      const result = await withRetry(operation, { maxRetries, baseDelay, maxDelay, shouldRetry, onRetry });

      assertFence(key, fenceToken);
      try {
        await appendAuditEvent({
          eventType: 'webhook_delivery',
          action: 'webhook.dispatch',
          actorType: 'system',
          actorId: tenant_id,
          targetType: 'invoice',
          targetId: invoiceId,
          statusCode: result && result.status ? Number(result.status) : 200,
          metadata: { url: webhook_url, payload, attempt: 1 },
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to append audit event for webhook success');
      }
      clearFence(key, fenceToken);

      logger.info({ event, invoiceId, tenant_id }, 'Webhook emitted successfully');
    } catch (error) {
      if (error && error.code === 'FENCE_EXPIRED') {
        logger.warn({ event, invoiceId, key, error: error.message }, 'Webhook job fenced; aborting remaining work');
        return;
      }
      assertFence(key, fenceToken);
      try {
        await writeDeadLetter({
          tenantId: tenant_id,
          invoiceId,
          event,
          payload,
          webhookUrl: webhook_url,
          attempts: maxRetries + 1,
          lastError: error && error.message ? error.message : String(error),
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to persist webhook dead-letter');
      }
      clearFence(key, fenceToken);

      try {
        emitWebhook._failureCounter.inc();
      } catch (_e) {
        // ignore metric errors
      }

      logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
    }
  } catch (error) {
    logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
  }
}

/**
 * Emits an escrow read webhook notification asynchronously.
 *
 * @param {Object} params
 * @param {string} params.eventType - Specific read event type (e.g. 'escrow.read').
 * @param {string} params.invoiceId - Invoice identifier.
 * @param {Object} params.state - Escrow state payload.
 * @returns {Promise<void>}
 */
async function emitEscrowReadWebhook({ eventType, invoiceId, state, fenceToken }) {
  return emitWebhook(eventType || 'escrow.read', invoiceId, { state }, fenceToken);
}

/**
 * Verifies a webhook signature with timestamp tolerance.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @param {string} signatureHeader - The X-Signature header value.
 * @param {number} [toleranceMs=TOLERANCE_MS] - Tolerance window in milliseconds.
 * @returns {Object} Result object with valid boolean and optional error message.
 */
function verifySignature(secret, rawBody, signatureHeader, toleranceMs = TOLERANCE_MS) {
  if (typeof signatureHeader !== 'string' || signatureHeader.length > MAX_SIGNATURE_HEADER_LENGTH) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  const parts = signatureHeader.split(',');

  if (parts.length > MAX_SIGNATURE_HEADER_PARTS) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  let timestamp = null;
  let signature = null;

  for (const part of parts) {
    if (part.startsWith('t=')) {
      timestamp = parseInt(part.slice(2), 10);
    } else if (part.startsWith('v1=')) {
      signature = part.slice(3);
    }
  }

  if (!timestamp || !signature) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  // timingSafeEqual throws when buffers have different lengths. Validate the
  // v1 digest shape first so malformed input is a normal authentication
  // failure rather than an internal server error.
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  const now = Date.now();
  const timestampMs = timestamp * 1000;
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return { valid: false, error: 'Timestamp outside tolerance window' };
  }

  const expectedSignature = createSignature(secret, rawBody, timestamp);
  const valid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );

  return { valid, error: valid ? null : 'Signature mismatch' };
}

/**
 * Writes a failed webhook delivery to the dead-letter table.
 */
async function writeDeadLetter({ tenantId, invoiceId, event, payload, webhookUrl, attempts, lastError }) {
  const [row] = await db('webhook_dead_letters')
    .insert({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      event,
      payload: JSON.stringify(payload),
      webhook_url: webhookUrl,
      attempts,
      last_error: lastError,
    })
    .returning('id');
  return row?.id ?? row;
}

/**
 * Replays a dead-letter row by re-signing and re-sending the stored payload.
 */
async function replayWebhook(deadLetterId, fenceToken = null) {
  const key = fenceKey('deadletter', String(deadLetterId));
  assertFence(key, fenceToken);
  const row = await db('webhook_dead_letters').where('id', deadLetterId).first();
  if (!row) {
    throw Object.assign(new Error(`Dead-letter row not found: ${deadLetterId}`), { code: 'NOT_FOUND' });
  }
  if (row.resolved) {
    throw Object.assign(new Error(`Dead-letter row already resolved: ${deadLetterId}`), { code: 'ALREADY_RESOLVED' });
  }

    const MAX_REPLAYS = 10;
    if (row.replay_count >= MAX_REPLAYS) {
      throw Object.assign(new Error(`Replay cap reached for dead-letter row: ${deadLetterId}`), { code: 'REPLAY_CAP_REACHED' });
    }
    if (row.is_replaying) {
      throw Object.assign(new Error(`Replay already in progress for dead-letter row: ${deadLetterId}`), { code: 'REPLAY_IN_PROGRESS' });
    }

    // Claim the row atomically so concurrent replays cannot double-send.
    await db('webhook_dead_letters')
      .where('id', deadLetterId)
      .update({
        is_replaying: true,
        replay_count: row.replay_count + 1,
        updated_at: db.fn.now(),
      });

    try {
      const tenant = await db('tenants').select('settings').where('id', row.tenant_id).first();
    const secret = tenant?.settings?.webhook_secret;
    if (!secret) {
      throw new Error(`No webhook secret configured for tenant ${row.tenant_id}`);
    }

    const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);

    // Enforce payload bounding guard on replay
    validatePayloadBounds(body);

    const signatureHeader = createSignatureHeader(secret, body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let response;
    try {
      response = await fetch(row.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signatureHeader,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Webhook replay responded with ${response.status}`);
    }

    await resolveDeadLetter(deadLetterId);
    logger.info({ deadLetterId, webhook_url: row.webhook_url }, 'Webhook replayed successfully');
  } catch (err) {
    await db('webhook_dead_letters')
      .where('id', deadLetterId)
      .update({
        is_replaying: false,
        last_error: err.message,
        updated_at: db.fn.now()
      });
    throw err;
  }
}

const MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES = 32768;

/**
 * Enqueues a webhook delivery job via the shared BackgroundWorker.
 *
 * @param {Object} params
 * @param {string} [params.invoiceId] - Related invoice ID (optional).
 * @param {string} [params.tenantId] - Target tenant ID (optional if invoiceId provided).
 * @param {string} params.event - Event type string.
 * @param {Object} [params.transition] - State transition details.
 * @param {string} [params.section] - Config section name.
 * @param {Object} [params.config] - Config object payload.
 * @param {string} [params.actor] - Actor identifier.
 * @returns {Promise<string|null>} Enqueued job ID or null.
 */
async function enqueueWebhookDelivery({ invoiceId, tenantId: explicitTenantId, event, transition = {}, section, config, actor }) {
  if (!_sharedWorker) {
    logger.info({ invoiceId, tenantId: explicitTenantId }, 'webhook: shared worker not set, skipping enqueue');
    return null;
  }

  let tenantId = explicitTenantId;
  if (!tenantId && invoiceId) {
    const invoice = await db('invoices').select('tenant_id').where('id', invoiceId).first();
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found for webhook delivery enqueue');
      return null;
    }
    tenantId = invoice.tenant_id;
  }

  if (!tenantId) {
    logger.warn({ invoiceId }, 'Tenant ID not specified or found for webhook enqueue');
    return null;
  }

  const tenant = await db('tenants').select('settings').where('id', tenantId).first();
  if (!tenant || !tenant.settings) {
    logger.warn({ tenantId, invoiceId }, 'Tenant settings not found for webhook delivery enqueue');
    return null;
  }

  const { webhook_url, webhook_secret } = tenant.settings;
  if (!webhook_url || !webhook_secret) {
    logger.info({ tenantId, invoiceId }, 'Webhook URL or secret not configured');
    return null;
  }

  const payload = {
    invoiceId,
    tenantId,
    webhookUrl: webhook_url,
    webhookSecret: webhook_secret,
    event,
    transition,
  };

  if (section) { payload.section = section; }
  if (config) { payload.config = config; }
  if (actor) { payload.actor = actor; }

  try {
    const jobId = _sharedWorker.enqueue('webhook_delivery', payload);
    return jobId;
  } catch (error) {
    logger.error({ invoiceId, tenantId, error: error.message }, 'webhook: failed to enqueue delivery job');
    return null;
  }
}

/**
 * Emits an outbound webhook callback on notable runtime config events.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Target tenant ID.
 * @param {string} params.section - Configuration section name.
 * @param {Object} params.config - Section configuration payload.
 * @param {string} [params.actor='system'] - Actor who triggered the change.
 * @param {string} [params.event='config.updated'] - Event label.
 * @returns {Promise<void>}
 */
async function emitConfigWebhook({ tenantId, section, config, actor = 'system', event = 'config.updated' }) {
  try {
    if (!tenantId) {
      logger.warn({ section }, 'Tenant ID missing for config webhook emission');
      return;
    }

    const tenant = await db('tenants').select('settings').where('id', tenantId).first();
    if (!tenant || !tenant.settings) {
      logger.info({ tenantId, section }, 'Tenant settings not found for config webhook');
      return;
    }

    const { webhook_url, webhook_secret, webhook_events } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenantId, section }, 'Webhook URL or secret not configured for config event');
      return;
    }

    if (Array.isArray(webhook_events) && webhook_events.length > 0) {
      const allowed = webhook_events.includes('*') || webhook_events.includes(event) || webhook_events.includes('config.*');
      if (!allowed) {
        logger.info({ tenantId, section, event }, 'Config webhook event filtered out by tenant settings');
        return;
      }
    }

    let boundedConfig = config;
    let truncated = false;
    const rawConfigString = JSON.stringify(config || {});
    if (rawConfigString.length > MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES) {
      truncated = true;
      boundedConfig = {
        _summary: 'Config payload exceeded maximum size limit',
        keys: Object.keys(config || {}),
      };
    }

    const payload = sortKeys({
      event,
      timestamp: new Date().toISOString(),
      tenantId,
      section,
      config: boundedConfig,
      actor,
      truncated,
    });

    const body = JSON.stringify(payload);
    const signatureHeader = createSignatureHeader(webhook_secret, body);

    if (_sharedWorker) {
      try {
        _sharedWorker.enqueue('webhook_delivery', {
          tenantId,
          webhookUrl: webhook_url,
          webhookSecret: webhook_secret,
          event,
          section,
          config: boundedConfig,
          actor,
          truncated,
          rawBody: body,
        });
        logger.info({ tenantId, section, event }, 'Config webhook enqueued via shared worker');
        return;
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to enqueue config webhook, falling back to direct delivery');
      }
    }

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);

    const shouldRetry = (err) => {
      if (!err) { return false; }
      if (err.code) {
        return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code) || err.name === 'AbortError';
      }
      if (err.status) {
        const s = Number(err.status);
        return s >= 500 && s < 600;
      }
      return false;
    };

    const operation = async () => {
      const controller = new AbortController();
      const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signatureHeader,
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = new Error(`Webhook responded with ${response.status}`);
          err.status = response.status;
          throw err;
        }

        return { ok: true, status: response.status };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const onRetry = async ({ attempt, error }) => {
      try {
        await appendAuditEvent({
          eventType: 'webhook_delivery',
          action: 'config.webhook.dispatch',
          actorType: 'system',
          actorId: tenantId,
          targetType: 'config',
          targetId: section,
          statusCode: error && error.status ? Number(error.status) : null,
          metadata: {
            attempt,
            url: webhook_url,
            error: error && error.message ? error.message : String(error),
            payload,
          },
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to append audit event for config webhook attempt');
      }
    };

    try {
      const result = await withRetry(operation, { maxRetries, baseDelay, maxDelay, shouldRetry, onRetry });
      try {
        await appendAuditEvent({
          eventType: 'webhook_delivery',
          action: 'config.webhook.dispatch',
          actorType: 'system',
          actorId: tenantId,
          targetType: 'config',
          targetId: section,
          statusCode: result && result.status ? Number(result.status) : 200,
          metadata: { url: webhook_url, payload, attempt: 1 },
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to append audit event for config webhook success');
      }

      logger.info({ event, section, tenantId }, 'Config event webhook emitted successfully');
    } catch (error) {
      try {
        await db('webhook_dead_letters').insert({
          tenant_id: tenantId,
          invoice_id: null,
          event,
          payload: JSON.stringify(payload),
          webhook_url,
          last_error: error && error.message ? error.message : String(error),
          attempts: maxRetries + 1,
          created_at: new Date(),
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to persist config webhook dead-letter');
      }

      logger.error({ event, section, tenantId, error: error.message }, 'Failed to emit config event webhook');
    }
  } catch (error) {
    logger.error({ event, section, tenantId, error: error.message }, 'Failed to emit config event webhook');
  }
}



/**
 * Maximum payload bytes for metrics and indexer webhook events.
 * Default: 64 KB — metrics snapshots can be large; bound them tightly.
 * @type {number}
 */
const MAX_METRICS_WEBHOOK_PAYLOAD_BYTES = Number(
  process.env.METRICS_WEBHOOK_MAX_PAYLOAD_BYTES || 64 * 1024,
);

/**
 * Emits a signed webhook to all subscribed tenants when a notable metrics
 * event fires (issue #970).
 *
 * Tenants are opted in by setting `webhook_events` to include `'metrics.*'`
 * or the specific event string (e.g. `'metrics.snapshot'`).  When
 * `webhook_events` is absent or `['*']`, every event is delivered.
 *
 * The payload is bounded by {@link MAX_METRICS_WEBHOOK_PAYLOAD_BYTES}.
 * If the metrics snapshot exceeds the limit the `metrics` field is replaced
 * with a `_summary` stub and `truncated: true` is set so receivers can act
 * on the truncation rather than silently losing data.
 *
 * Delivery follows the standard retry/backoff path via
 * {@link enqueueWebhookDelivery} when a shared worker is available, or
 * falls back to direct HTTP POST with exponential backoff.
 *
 * @param {Object}  params
 * @param {string}  params.tenantId  - Tenant receiving the webhook.
 * @param {string}  [params.event='metrics.snapshot'] - Specific event label.
 * @param {Object}  [params.metrics={}] - Metrics snapshot or partial payload.
 * @param {string}  [params.actor='system'] - Actor that triggered the event.
 * @returns {Promise<void>}
 */
async function emitMetricsWebhook({ tenantId, event = 'metrics.snapshot', metrics: metricsPayload = {}, actor = 'system' }) {
  try {
    if (!tenantId) {
      logger.warn({ event }, 'Tenant ID missing for metrics webhook emission');
      return;
    }

    const tenant = await db('tenants').select('settings').where('id', tenantId).first();
    if (!tenant || !tenant.settings) {
      logger.info({ tenantId, event }, 'Tenant settings not found for metrics webhook');
      return;
    }

    const { webhook_url, webhook_secret, webhook_events } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenantId, event }, 'Webhook URL or secret not configured for metrics event');
      return;
    }

    // Event filter: respect tenant-level subscription allowlist
    if (Array.isArray(webhook_events) && webhook_events.length > 0) {
      const allowed =
        webhook_events.includes('*') ||
        webhook_events.includes(event) ||
        webhook_events.includes('metrics.*');
      if (!allowed) {
        logger.info({ tenantId, event }, 'Metrics webhook event filtered out by tenant settings');
        return;
      }
    }

    // Bound payload size
    let boundedMetrics = metricsPayload;
    let truncated = false;
    const rawMetricsString = JSON.stringify(metricsPayload || {});
    if (rawMetricsString.length > MAX_METRICS_WEBHOOK_PAYLOAD_BYTES) {
      truncated = true;
      boundedMetrics = {
        _summary: 'Metrics payload exceeded maximum size limit',
        keys: Object.keys(metricsPayload || {}),
      };
    }

    const payload = sortKeys({
      event,
      timestamp: new Date().toISOString(),
      tenantId,
      metrics: boundedMetrics,
      actor,
      truncated,
    });

    const body = JSON.stringify(payload);
    validatePayloadBounds(body);
    const signatureHeader = createSignatureHeader(webhook_secret, body);

    // Prefer queued delivery via shared worker
    if (_sharedWorker) {
      try {
        _sharedWorker.enqueue('webhook_delivery', {
          tenantId,
          webhookUrl: webhook_url,
          webhookSecret: webhook_secret,
          event,
          metrics: boundedMetrics,
          actor,
          truncated,
          rawBody: body,
        });
        logger.info({ tenantId, event }, 'Metrics webhook enqueued via shared worker');
        return;
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to enqueue metrics webhook, falling back to direct delivery');
      }
    }

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);

    const shouldRetry = (err) => {
      if (!err) return false;
      if (err.code) {
        return (
          ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code) ||
          err.name === 'AbortError'
        );
      }
      if (err.status) {
        const s = Number(err.status);
        return s >= 500 && s < 600;
      }
      return false;
    };

    const operation = async () => {
      const controller = new AbortController();
      const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': signatureHeader },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          const err = new Error(`Webhook responded with ${response.status}`);
          err.status = response.status;
          throw err;
        }
        return { ok: true, status: response.status };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      await withRetry(operation, { maxRetries, baseDelay, maxDelay, shouldRetry });
      logger.info({ event, tenantId }, 'Metrics webhook emitted successfully');
    } catch (error) {
      try {
        await db('webhook_dead_letters').insert({
          tenant_id: tenantId,
          invoice_id: null,
          event,
          payload: JSON.stringify(payload),
          webhook_url,
          last_error: error && error.message ? error.message : String(error),
          attempts: maxRetries + 1,
          created_at: new Date(),
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to persist metrics webhook dead-letter');
      }
      logger.error({ event, tenantId, error: error.message }, 'Failed to emit metrics webhook');
    }
  } catch (error) {
    logger.error({ event, tenantId, error: error.message }, 'Failed to emit metrics webhook');
  }
}

/**
 * Emits a signed webhook to all subscribed tenants when a notable indexer
 * event fires (issue #980).
 *
 * Tenants are opted in by setting `webhook_events` to include `'indexer.*'`
 * or the specific event string (e.g. `'indexer.event_ingested'`).
 *
 * The payload is bounded by {@link MAX_METRICS_WEBHOOK_PAYLOAD_BYTES}.
 * Oversized `eventData` is replaced with a `_summary` stub and
 * `truncated: true` to signal receivers.
 *
 * @param {Object}  params
 * @param {string}  params.tenantId  - Tenant receiving the webhook.
 * @param {string}  [params.event='indexer.event_ingested'] - Specific event label.
 * @param {Object}  [params.eventData={}] - Indexer event data payload.
 * @param {string}  [params.actor='system'] - Actor that triggered the event.
 * @returns {Promise<void>}
 */
async function emitIndexerWebhook({ tenantId, event = 'indexer.event_ingested', eventData = {}, actor = 'system' }) {
  try {
    if (!tenantId) {
      logger.warn({ event }, 'Tenant ID missing for indexer webhook emission');
      return;
    }

    const tenant = await db('tenants').select('settings').where('id', tenantId).first();
    if (!tenant || !tenant.settings) {
      logger.info({ tenantId, event }, 'Tenant settings not found for indexer webhook');
      return;
    }

    const { webhook_url, webhook_secret, webhook_events } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenantId, event }, 'Webhook URL or secret not configured for indexer event');
      return;
    }

    // Event filter: respect tenant-level subscription allowlist
    if (Array.isArray(webhook_events) && webhook_events.length > 0) {
      const allowed =
        webhook_events.includes('*') ||
        webhook_events.includes(event) ||
        webhook_events.includes('indexer.*');
      if (!allowed) {
        logger.info({ tenantId, event }, 'Indexer webhook event filtered out by tenant settings');
        return;
      }
    }

    // Bound payload size
    let boundedEventData = eventData;
    let truncated = false;
    const rawEventDataString = JSON.stringify(eventData || {});
    if (rawEventDataString.length > MAX_METRICS_WEBHOOK_PAYLOAD_BYTES) {
      truncated = true;
      boundedEventData = {
        _summary: 'Indexer event data payload exceeded maximum size limit',
        keys: Object.keys(eventData || {}),
      };
    }

    const payload = sortKeys({
      event,
      timestamp: new Date().toISOString(),
      tenantId,
      eventData: boundedEventData,
      actor,
      truncated,
    });

    const body = JSON.stringify(payload);
    validatePayloadBounds(body);
    const signatureHeader = createSignatureHeader(webhook_secret, body);

    // Prefer queued delivery via shared worker
    if (_sharedWorker) {
      try {
        _sharedWorker.enqueue('webhook_delivery', {
          tenantId,
          webhookUrl: webhook_url,
          webhookSecret: webhook_secret,
          event,
          eventData: boundedEventData,
          actor,
          truncated,
          rawBody: body,
        });
        logger.info({ tenantId, event }, 'Indexer webhook enqueued via shared worker');
        return;
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to enqueue indexer webhook, falling back to direct delivery');
      }
    }

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);

    const shouldRetry = (err) => {
      if (!err) return false;
      if (err.code) {
        return (
          ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code) ||
          err.name === 'AbortError'
        );
      }
      if (err.status) {
        const s = Number(err.status);
        return s >= 500 && s < 600;
      }
      return false;
    };

    const operation = async () => {
      const controller = new AbortController();
      const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': signatureHeader },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          const err = new Error(`Webhook responded with ${response.status}`);
          err.status = response.status;
          throw err;
        }
        return { ok: true, status: response.status };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      await withRetry(operation, { maxRetries, baseDelay, maxDelay, shouldRetry });
      logger.info({ event, tenantId }, 'Indexer webhook emitted successfully');
    } catch (error) {
      try {
        await db('webhook_dead_letters').insert({
          tenant_id: tenantId,
          invoice_id: null,
          event,
          payload: JSON.stringify(payload),
          webhook_url,
          last_error: error && error.message ? error.message : String(error),
          attempts: maxRetries + 1,
          created_at: new Date(),
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to persist indexer webhook dead-letter');
      }
      logger.error({ event, tenantId, error: error.message }, 'Failed to emit indexer webhook');
    }
  } catch (error) {
    logger.error({ event, tenantId, error: error.message }, 'Failed to emit indexer webhook');
  }
}

/**
 * Marks a dead-letter row as resolved without re-sending.
 */
async function resolveDeadLetter(deadLetterId) {
  await db('webhook_dead_letters').where('id', deadLetterId).update({
    resolved: true,
    is_replaying: false,
    resolved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

module.exports = {
  createSignatureHeader,
  verifySignature,
  sortKeys,
  enqueueWebhookDelivery,
  setSharedWorker,
  emitWebhook,
  emitConfigWebhook,
  emitEscrowReadWebhook,
  emitMetricsWebhook,
  emitIndexerWebhook,
  enqueueWebhookDelivery,
  setSharedWorker,
  verifySignature,
  createSignature,
  createSignatureHeader,
  writeDeadLetter,
  replayWebhook,
  resolveDeadLetter,
  sortKeys,
  setSharedWorker,
  SIGNATURE_VERSION,
  TOLERANCE_MS,
  MAX_CONFIG_WEBHOOK_PAYLOAD_BYTES,
};
