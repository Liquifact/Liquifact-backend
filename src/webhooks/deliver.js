'use strict';

/**
 * Webhook delivery engine.
 *
 * Delivers event envelopes to registered subscribers with:
 *  - 5 s per-attempt timeout
 *  - Exponential backoff + jitter: delays ~1s, 4s, 16s, 64s, 256s
 *  - Max 5 attempts
 *  - Permanent 4xx (except 408/425/429) stops immediately
 *  - Retry-After on 408/425/429/5xx overrides the backoff, capped at 256 s
 *  - No redirect following
 *  - Per-delivery attempt log (in-memory, capped per webhook)
 *
 * Delivery runs fully asynchronously — it never blocks or throws to the
 * originating request.
 *
 * Limitation: delivery state is in-memory per instance. In a multi-instance or
 * serverless deployment, retries do not survive process restarts.
 */

const crypto = require('crypto');
const { sign } = require('./signature');
const webhookStore = require('./store');
const emitter = require('./emitter');
const webhookQueue = require('./queue');

const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 5;
const RECONCILIATION_DRIFT_EVENT = 'invoice.reconciliation_drift';
// Base delays in ms: 1s, 4s, 16s, 64s, 256s
const BASE_DELAYS = [1000, 4000, 16000, 64000, 256000];

// Statuses where retrying will never succeed: 4xx except 408 (timeout),
// 425 (too early) and 429 (rate-limited). Everything else retries.
const RETRYABLE_4XX = new Set([408, 425, 429]);
const MAX_RETRY_AFTER_MS = BASE_DELAYS[BASE_DELAYS.length - 1];

/**
 * Adds up to 25% jitter to a delay.
 * @param {number} delayMs
 * @returns {number}
 */
function withJitter(delayMs) {
  return Math.floor(delayMs * (1 + Math.random() * 0.25));
}

/**
 * Parses a Retry-After header (seconds or HTTP-date). Returns milliseconds,
 * or undefined when absent/unparseable. Clamped to MAX_RETRY_AFTER_MS.
 *
 * @param {string|undefined|null} header
 * @returns {number|undefined}
 */
function parseRetryAfter(header) {
  if (header == null) { return undefined; }
  const raw = String(header).trim();
  if (raw === '') { return undefined; }
  // delta-seconds
  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  }
  // HTTP-date
  const when = Date.parse(raw);
  if (Number.isNaN(when)) { return undefined; }
  const delta = when - Date.now();
  if (delta <= 0) { return 0; }
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

/**
 * Whether a status code is worth retrying.
 *  - null (network error) → retry
 *  - 5xx → retry
 *  - 4xx in {408, 425, 429} → retry
 *  - everything else (2xx, 3xx, other 4xx) → do not retry
 *
 * @param {number|null} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  if (status === null) { return true; }
  if (status >= 500) { return true; }
  if (status >= 400 && status < 500) {
    return RETRYABLE_4XX.has(status);
  }
  return false;
}

/**
 * Builds the event envelope.
 *
 * @param {string} type event type
 * @param {object} invoice invoice data
 * @returns {{ envelope: object, rawBody: string }}
 */
function buildEnvelope(type, invoice) {
  const envelope = {
    id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    type,
    createdAt: new Date().toISOString(),
    data: { invoice },
  };
  const rawBody = JSON.stringify(envelope);
  return { envelope, rawBody };
}

/**
 * Attempts a single delivery to a webhook endpoint.
 *
 * @param {{ id, pinnedUrl, host, secretHash }} wh internal webhook record
 * @param {string} rawBody serialised event envelope
 * @param {string} eventId event envelope id
 * @param {string} signatureHeader signed header value
 * @returns {Promise<{ status: number|null, durationMs: number, retryAfterMs?: number, error?: string }>}
 */
async function attempt(wh, rawBody, eventId, signatureHeader) {
  const start = Date.now();
  try {
    const res = await fetch(wh.pinnedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'LiquiFact-Signature': signatureHeader,
        'LiquiFact-Event-Id': eventId,
        Host: wh.host,
      },
      body: rawBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual', // do not follow redirects
    });
    const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
    return { status: res.status, durationMs: Date.now() - start, retryAfterMs };
  } catch (err) {
    return { status: null, durationMs: Date.now() - start, error: err.message };
  }
}

/**
 * Executes delivery with retries scheduled through the bounded queue.
 *
 * Behaviour:
 *  - 2xx → status 'delivered', stop.
 *  - Permanent 4xx (anything 4xx not in {408, 425, 429}) → status 'failed',
 *    reason 'permanent_4xx', stop after exactly one attempt.
 *  - Retryable (5xx, 408/425/429, network error) → wait (Retry-After if
 *    present, else the standard backoff at this index), retry.
 *  - All retries exhausted → status 'failed', reason 'attempts_exhausted'.
 *
 * @param {object} wh internal webhook record
 * @param {object} deliveryRecord delivery record already appended to store
 * @param {string} rawBody serialised event envelope
 * @param {string} signatureHeader signed header value
 * @returns {Promise<void>}
 */
  let pendingDelayMs;

      const base = pendingDelayMs !== undefined ? pendingDelayMs : BASE_DELAYS[i - 1];
      pendingDelayMs = undefined;
      await sleep(withJitter(base));
function executeDelivery(wh, deliveryRecord, rawBody, signatureHeader) {
  let attemptCount = 0;

    delete attemptLog.retryAfterMs; // internal hint, don't persist it
  return webhookQueue.enqueue({
    webhookId: wh.id,
    deliveryRecord,
    task: async () => {
      attemptCount++;
      const result = await attempt(wh, rawBody, deliveryRecord.eventId, signatureHeader);
      const attemptLog = { attempt: attemptCount, ...result };
      deliveryRecord.attempts.push(attemptLog);


    if (!isRetryableStatus(result.status)) {
      deliveryRecord.status = 'failed';
      deliveryRecord.reason = 'permanent_4xx';
      return;
    }

    if (result.retryAfterMs !== undefined) {
      pendingDelayMs = result.retryAfterMs;
    }
      const success = result.status !== null && result.status >= 200 && result.status < 300;
      if (success) {
        deliveryRecord.status = 'delivered';
        return { success: true, retryable: false };
      }

  if (!deliveryRecord.reason) {
    deliveryRecord.reason = 'attempts_exhausted';
  }
      if (attemptCount < MAX_ATTEMPTS) {
        const delay = withJitter(BASE_DELAYS[attemptCount - 1]);
        return { success: false, retryable: true, delayMs: delay };
      }

      deliveryRecord.status = 'failed';
      return { success: false, retryable: false };
    },
  });
}

/**
 * Creates a delivery record, persists a bounded rawBody, and appends it to the store.
 *
 * @param {object} wh internal webhook record
 * @param {{ eventId: string, eventType: string, rawBody: string, replayedFrom?: string }} opts
 * @returns {{ deliveryRecord: object, signatureHeader: string }}
 */
function prepareDelivery(wh, { eventId, eventType, rawBody, replayedFrom }) {
  // Sign with a fresh timestamp using the stored plaintext secret (kept in memory only)
  const signatureHeader = sign(wh.secret, rawBody);

  const deliveryRecord = {
    deliveryId: `dlv_${crypto.randomBytes(6).toString('hex')}`,
    eventId,
    eventType,
    webhookId: wh.id,
    url: wh.url,
    attempts: [],
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  if (typeof rawBody === 'string' && Buffer.byteLength(rawBody, 'utf8') <= webhookStore.MAX_RAW_BODY_BYTES) {
    deliveryRecord.rawBody = rawBody;
  }

  if (replayedFrom) {
    deliveryRecord.replayedFrom = replayedFrom;
  }

  // Append initial record immediately so it's visible
  webhookStore.appendDelivery(wh.id, deliveryRecord);

  return { deliveryRecord, signatureHeader };
}

/**
 * Runs delivery with retries for one webhook+event pair.
 *
 * @param {object} wh internal webhook record (must contain .secret for signing)
 * @param {string} eventType
 * @param {object} invoice
 * @returns {Promise<void>}
 */
async function deliverToWebhook(wh, eventType, invoice) {
  const { envelope, rawBody } = buildEnvelope(eventType, invoice);
  const { deliveryRecord, signatureHeader } = prepareDelivery(wh, {
    eventId: envelope.id,
    eventType,
    rawBody,
  });

  await executeDelivery(wh, deliveryRecord, rawBody, signatureHeader);
}

/**
 * Replays a previously recorded delivery with a fresh signature timestamp
 * while preserving the original eventId so receivers can deduplicate.
 *
 * Appends the new delivery record synchronously and runs delivery asynchronously.
 *
 * @param {object} wh internal webhook record (must contain .secret for signing)
 * @param {object} originalDelivery stored delivery record with rawBody
 * @returns {{ deliveryId: string, eventId: string, replayedFrom: string, status: string }}
 */
function replayDelivery(wh, originalDelivery) {
  const { deliveryRecord, signatureHeader } = prepareDelivery(wh, {
    eventId: originalDelivery.eventId,
    eventType: originalDelivery.eventType,
    rawBody: originalDelivery.rawBody,
    replayedFrom: originalDelivery.deliveryId,
  });

  // Fire and forget — errors are caught so the HTTP handler never rejects
  executeDelivery(wh, deliveryRecord, originalDelivery.rawBody, signatureHeader).catch((err) => {
    console.error(`[webhook-deliver] unhandled replay error for ${wh.id}:`, err);
  });

  return {
    deliveryId: deliveryRecord.deliveryId,
    eventId: deliveryRecord.eventId,
    replayedFrom: deliveryRecord.replayedFrom,
    status: deliveryRecord.status,
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  // unref: pending retries must not keep the process (or a test run) alive.
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Dispatches an event to all matching webhook subscribers.
 * Runs fully async — never throws.
 *
 * @param {string} eventType
 * @param {object} invoice
 */
function dispatch(eventType, invoice) {
  const subscribers = webhookStore.getWebhooksForEvent(eventType);
  for (const wh of subscribers) {
    // Fire and forget — errors are caught inside deliverToWebhook
    deliverToWebhook(wh, eventType, invoice).catch((err) => {
      console.error(`[webhook-deliver] unhandled error for ${wh.id}:`, err);
    });
  }
}

/**
 * Starts listening to the event emitter and dispatching to subscribers.
 * Should be called once at application startup.
 */
let listening = false;
function startListening() {
  if (listening) {
    return;
  }
  listening = true;
  emitter.on('invoice.created', (invoice) => dispatch('invoice.created', invoice));
  emitter.on('invoice.funding_received', (invoice) => dispatch('invoice.funding_received', invoice));
  emitter.on('invoice.funded', (invoice) => dispatch('invoice.funded', invoice));
  emitter.on('invoice.settled', (invoice) => dispatch('invoice.settled', invoice));
  emitter.on('invoice.cancelled', (invoice) => dispatch('invoice.cancelled', invoice));
  emitter.on(RECONCILIATION_DRIFT_EVENT, (invoice) =>
    dispatch(RECONCILIATION_DRIFT_EVENT, invoice));
}

// Exported for tests
module.exports = {
  dispatch,
  startListening,
  buildEnvelope,
  deliverToWebhook,
  replayDelivery,
  sleep,
  queue: webhookQueue,
  drain: (timeoutMs) => webhookQueue.drain(timeoutMs),
};
