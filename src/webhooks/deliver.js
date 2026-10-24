'use strict';

/**
 * Webhook delivery engine.
 *
 * Delivers event envelopes to registered subscribers with:
 *  - 5 s per-attempt timeout
 *  - Exponential backoff + jitter: delays ~1s, 4s, 16s, 64s, 256s
 *  - Max 5 attempts
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

const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 5;
// Base delays in ms: 1s, 4s, 16s, 64s, 256s
const BASE_DELAYS = [1000, 4000, 16000, 64000, 256000];

/**
 * Adds up to 25% jitter to a delay.
 * @param {number} delayMs
 * @returns {number}
 */
function withJitter(delayMs) {
  return Math.floor(delayMs * (1 + Math.random() * 0.25));
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
 * @returns {Promise<{ status: number|null, durationMs: number, error?: string }>}
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
    return { status: res.status, durationMs: Date.now() - start };
  } catch (err) {
    return { status: null, durationMs: Date.now() - start, error: err.message };
  }
}

/**
 * Derives a per-delivery signing secret from the stored secret hash.
 *
 * We cannot recover the original secret once created (it is shown once and
 * hashed). Instead we sign using the stored hash bytes as the HMAC key.
 * Receivers verify using the original secret; this function is not used by
 * consumers — see signature.js#sign.
 *
 * Implementation note: the secretHash is sha256(originalSecretBytes) stored as
 * hex. We use those 32 raw bytes as the HMAC key. This is a different key from
 * what the external verifySignature uses (which re-encodes the original
 * base64url secret). To bridge this: we store the raw 32-byte secret as
 * base64url alongside secretHash, but ONLY in memory and ONLY for signing.
 * The raw secret is never exposed via API responses.
 */

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
  const eventId = envelope.id;

  // Sign once with the stored plaintext secret (kept in memory only)
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

  // Append initial record immediately so it's visible
  webhookStore.appendDelivery(wh.id, deliveryRecord);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) {
      const delay = withJitter(BASE_DELAYS[i - 1]);
      await sleep(delay);
    }

    const result = await attempt(wh, rawBody, eventId, signatureHeader);
    const attemptLog = { attempt: i + 1, ...result };
    deliveryRecord.attempts.push(attemptLog);

    const success = result.status !== null && result.status >= 200 && result.status < 300;
    if (success) {
      deliveryRecord.status = 'delivered';
      return;
    }
  }

  deliveryRecord.status = 'failed';
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
}

// Exported for tests
module.exports = { dispatch, startListening, buildEnvelope, deliverToWebhook, sleep };
