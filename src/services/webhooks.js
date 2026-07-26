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
async function emitWebhook(event, invoiceId, additionalData = {}) {
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

      logger.info({ event, invoiceId, tenant_id }, 'Webhook emitted successfully');
    } catch (error) {
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
async function emitEscrowReadWebhook({ eventType, invoiceId, state }) {
  return emitWebhook(eventType || 'escrow.read', invoiceId, { state });
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
async function replayWebhook(deadLetterId) {
  const row = await db('webhook_dead_letters').where('id', deadLetterId).first();
  if (!row) {
    throw Object.assign(new Error(`Dead-letter row not found: ${deadLetterId}`), { code: 'NOT_FOUND' });
  }
  if (row.resolved) {
    throw Object.assign(new Error(`Dead-letter row already resolved: ${deadLetterId}`), { code: 'ALREADY_RESOLVED' });
  }

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
}

/**
 * Marks a dead-letter row as resolved without re-sending.
 */
async function resolveDeadLetter(deadLetterId) {
  await db('webhook_dead_letters').where('id', deadLetterId).update({
    resolved: true,
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
};