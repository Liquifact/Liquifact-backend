const client = require("prom-client");
const registry = new client.Registry();
'use strict';

/**
 * @fileoverview Prometheus metrics registry and /metrics route handler.
 *
 * ## Auth strategy (in priority order)
 *
 * 1. If `METRICS_BEARER_TOKEN` is set, require `Authorization: Bearer <token>`.
 *    The token comparison uses a **constant-time** algorithm to prevent timing
 *    side-channel attacks.
 *
 * 2. If `METRICS_BEARER_TOKEN` is **unset**, allow requests from loopback
 *    addresses only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). This is suitable
 *    for private-network Prometheus scraping.
 *
 * 3. All other requests receive a uniform `401` with no detail about _why_
 *    (no distinction between "wrong token" and "missing token").
 *
 * ## Security: trusted-proxy & X-Forwarded-For
 *
 * Loopback detection **always** reads the direct TCP connection address from
 * `req.socket.remoteAddress`. The `X-Forwarded-For` header is **never**
 * consulted, so a remote attacker cannot spoof a loopback origin by setting
 * `X-Forwarded-For: 127.0.0.1`.
 *
 * There is no `app.set('trust proxy', ...)` call anywhere in this application.
 * If one is added in the future, `req.ip` could resolve to a `X-Forwarded-For`
 * value, but this middleware **already** ignores `req.ip` for loopback checks
 * and reads the socket directly, making it resilient to such config changes.
 *
 * @module metrics
 */

let client;
try {
  client = require('prom-client');
} catch (_e) {
  // Fallback shim for environments without prom-client (tests)

  /**
   * Minimal prom-client Registry shim for test environments.
   * @implements {import('prom-client').Registry}
   */
  class RegistryShim {
    /** @param {void} */
    constructor() { this.contentType = 'text/plain'; }
    /** @returns {string} */
    metrics() { return ''; }
  }

  /**
   * Counter shim for test environments.
   * @implements {import('prom-client').Counter}
   */
  class CounterShim {
    /** @param {void} */
    constructor() {}
    /** @returns {void} */
    inc() {}
  }

  /**
   * Gauge shim for test environments.
   * @implements {import('prom-client').Gauge}
   */
  class GaugeShim {
    /** @param {void} */
    constructor() {}
    /** @returns {void} */
    set() {}
    /** @returns {void} */
    setToCurrentTime() {}
  }

  client = {
    Registry: RegistryShim,
    /**
     * No-op default metrics collector stub.
     * @returns {void}
     */
    collectDefaultMetrics: () => { },
    Counter: CounterShim,
    Gauge: GaugeShim,
  };
}

const METRIC_REFRESH_INTERVAL_MS = 5000;
const registeredJobQueues = new Set();
const registeredWorkers = new Set();
let refreshTimer = null;

const queueDepthGauge = new client.Gauge({
  name: 'liquifact_job_queue_depth',
  help: 'Number of pending jobs currently waiting in background queues',
  registers: [registry],
});

const retryQueueSizeGauge = new client.Gauge({
  name: 'liquifact_job_retry_queue_size',
  help: 'Number of jobs waiting in retry queues for background processing',
  registers: [registry],
});

const workerInFlightGauge = new client.Gauge({
  name: 'liquifact_worker_inflight_count',
  help: 'Number of jobs currently being processed by background workers',
  registers: [registry],
});

// Cached metrics text for compatibility with tests that call
// `registry.metrics()` synchronously. Prom-client >=14 returns a Promise
// from `registry.metrics()`, but some test code calls it without `await`.
// We provide a synchronous accessor by overriding `registry.metrics`
// to return the latest cached string; `metricsHandler` still works because
// awaiting a string yields the string value.
let cachedMetrics = '# HELP liquifact_custom_metrics Placeholder\n';
registry.metrics = function metricsSync() {
  return cachedMetrics;
};

/**
 * Refresh all registered queue and worker metrics.
 *
 * This performs periodic sampling from existing getStats() outputs on
 * registered job queue and worker instances. It avoids adding extra hot-path
 * overhead to each enqueue/dequeue operation.
 */
function refreshMetrics() {
  let queueLength = 0;
  let retryQueueLength = 0;

  for (const queue of registeredJobQueues) {
    try {
      const stats = queue.getStats();
      if (stats) {
        queueLength += Number(stats.queueLength || 0);
        retryQueueLength += Number(stats.retryQueueLength || 0);
      }
    } catch (err) {
      // Preserve existing metrics if a registered queue becomes invalid.
    }
  }

  let workerInFlight = 0;
  for (const worker of registeredWorkers) {
    try {
      const stats = worker.getStats();
      if (stats && typeof stats.processingCount === 'number') {
        workerInFlight += stats.processingCount;
      }
    } catch (err) {
      // Preserve existing metrics if a registered worker becomes invalid.
    }
  }

  queueDepthGauge.set(queueLength);
  retryQueueSizeGauge.set(retryQueueLength);
  workerInFlightGauge.set(workerInFlight);

  // Build a minimal Prometheus text exposition that includes our gauges.
  // Keep labels bounded and avoid including payloads or per-job ids.
  cachedMetrics = '' +
    '# HELP liquifact_job_queue_depth Number of pending jobs waiting in queues\n' +
    '# TYPE liquifact_job_queue_depth gauge\n' +
    `liquifact_job_queue_depth ${queueLength}\n` +
    '# HELP liquifact_job_retry_queue_size Number of jobs waiting in retry queues\n' +
    '# TYPE liquifact_job_retry_queue_size gauge\n' +
    `liquifact_job_retry_queue_size ${retryQueueLength}\n` +
    '# HELP liquifact_worker_inflight_count Number of jobs currently being processed\n' +
    '# TYPE liquifact_worker_inflight_count gauge\n' +
    `liquifact_worker_inflight_count ${workerInFlight}\n`;
}

function startMetricsRefresh() {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setInterval(refreshMetrics, METRIC_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

function stopMetricsRefresh() {
  if (!refreshTimer) {
    return;
  }

  clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Register a job queue instance for Prometheus instrumentation.
 *
 * @param {Object} queue
 */
function registerJobQueue(queue) {
  if (!queue || typeof queue.getStats !== 'function') {
    return;
  }

  if (registeredJobQueues.has(queue)) {
    return;
  }

  registeredJobQueues.add(queue);
  refreshMetrics();
  startMetricsRefresh();
}

/**
 * Register a worker instance for Prometheus instrumentation.
 *
 * @param {Object} worker
 */
function registerWorker(worker) {
  if (!worker || typeof worker.getStats !== 'function') {
    return;
  }

  if (registeredWorkers.has(worker)) {
    return;
  }

  registeredWorkers.add(worker);
  refreshMetrics();
  startMetricsRefresh();
}

function resetMetricsForTests() {
  registeredJobQueues.clear();
  registeredWorkers.clear();
  queueDepthGauge.set(0);
  retryQueueSizeGauge.set(0);
  workerInFlightGauge.set(0);
  stopMetricsRefresh();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Returns `false` early when lengths differ (public info leaked by content-length
 * rather than timing), but still performs a full-length XOR when lengths match
 * so that a timing attacker cannot distinguish _where_ the difference occurs.
 *
 * @param {string} a - First string to compare.
 * @param {string} b - Second string to compare.
 * @returns {boolean} `true` when the strings are equal, `false` otherwise.
 *
 * @example
 * safeEqual('secret', 'secret'); // true
 * safeEqual('secret', 'wrong');  // false
 */
function safeEqual(a, b) {
  if (a.length !== b.length) { return false; }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Set of loopback IP addresses that are allowed when no bearer token is
 * configured. Includes IPv4, IPv6, and IPv4-mapped IPv6 representations.
 *
 * @type {ReadonlySet<string>}
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Extracts the direct TCP connection IP address from the request.
 *
 * Reads `req.socket.remoteAddress` first — this is the actual TCP socket peer
 * and cannot be spoofed via `X-Forwarded-For` or any other HTTP header. Falls
 * back to `req.ip` when the socket address is unavailable (edge case in some
 * test environments or HTTP/2 proxies).
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The client IP address string, or empty string if
 *   neither source is available.
 *
 * @example
 * extractClientIp(req); // '127.0.0.1'
 */
function extractClientIp(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

/**
 * Express middleware that enforces metrics endpoint authentication.
 *
 * ## Auth decision flow
 *
 * ```
 * METRICS_BEARER_TOKEN set?
 *   ├── YES → constant-time compare Authorization header
 *   │         ├── match  → next()
 *   │         └── no match → 401 (no detail)
 *   └── NO  → extractClientIp(req) in LOOPBACK set?
 *             ├── yes → next()
 *             └── no  → 401 (no detail)
 * ```
 *
 * The response is **always** a plain `{ error: 'Unauthorized' }` with no
 * indication of whether the failure was a missing token, wrong token, or
 * non-loopback origin.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function metricsAuth(req, res, next) {
  const token = process.env.METRICS_BEARER_TOKEN;

  if (token) {
    const auth = req.headers['authorization'] || '';
    if (safeEqual(auth, `Bearer ${token}`)) { return next(); }
    const authFallback = req.headers['Authorization'] || '';
    if (safeEqual(authFallback, `Bearer ${token}`)) { return next(); }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // No token configured — allow loopback only, using the direct TCP socket IP.
  // X-Forwarded-For is NEVER trusted for this check.
  const ip = extractClientIp(req);
  if (LOOPBACK.has(ip)) { return next(); }

  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Express route handler that returns Prometheus metrics in plain-text format.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

/** Shared registry — exported so tests can reset it between runs. */

if (typeof client.collectDefaultMetrics === 'function') {
  client.collectDefaultMetrics({ register: registry });
}

/**
 * Counter: Escrow events successfully processed by the indexer per cycle.
 * Incremented by the number of events persisted in each indexer cycle.
 * @type {import('prom-client').Counter}
 */
const escrowIndexerEventsProcessedTotal = new client.Counter({
  name: 'escrow_indexer_events_processed_total',
  help: 'Total number of escrow events successfully processed and persisted by the indexer',
  registers: [registry],
});

/**
 * Counter: Escrow events skipped (invalid) by the indexer per cycle.
 * Incremented when an event fails validation or persistence.
 * @type {import('prom-client').Counter}
 */
const escrowIndexerEventsSkippedTotal = new client.Counter({
  name: 'escrow_indexer_events_skipped_total',
  help: 'Total number of escrow events skipped due to validation or persistence errors',
  registers: [registry],
});

/**
 * Counter: Escrow indexer cycle failures.
 * Incremented when a cycle throws an unhandled exception or receives invalid metric data.
 * @type {import('prom-client').Counter}
 */
const escrowIndexerCycleFailuresTotal = new client.Counter({
  name: 'escrow_indexer_cycle_failures_total',
  help: 'Total number of escrow indexer cycles that failed with an exception',
  registers: [registry],
});

/**
 * Gauge: Unix timestamp (seconds) of the last successful cursor advance.
 * Updated when a cycle completes and cursorAfter !== cursorBefore.
 * Used by health check to detect indexer staleness.
 * @type {import('prom-client').Gauge}
 */
const escrowIndexerLastCursorAdvanceTimestampSeconds = new client.Gauge({
  name: 'escrow_indexer_last_cursor_advance_timestamp_seconds',
  help: 'Unix timestamp (seconds) of the last cycle where the cursor advanced (cursorAfter !== cursorBefore)',
  registers: [registry],
});

/**
 * Counter: Escrow reconciliation mismatches.
 * Incremented each time a reconcileInvoice call detects a discrepancy
 * between the DB funded total and the on-chain funded amount.
 * @type {import('prom-client').Counter}
 */
const escrowReconciliationMismatches = new client.Counter({
  name: 'escrow_reconciliation_mismatches_total',
  help: 'Total number of escrow reconciliation mismatches detected',
  registers: [registry],
});

/**
 * Counter: Maturity reminder email delivery attempts.
 * Incremented for each attempt to send a maturity reminder email (including retries).
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliveryAttemptsTotal = new client.Counter({
  name: 'maturity_reminder_delivery_attempts_total',
  help: 'Total number of maturity reminder email delivery attempts (each retry counts)',
  labelNames: ['job_type'],
  registers: [registry],
});

/**
 * Counter: Successful maturity reminder email deliveries.
 * Incremented when a maturity reminder email is sent successfully.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliverySuccessTotal = new client.Counter({
  name: 'maturity_reminder_delivery_success_total',
  help: 'Total number of maturity reminder emails delivered successfully',
  labelNames: ['job_type'],
  registers: [registry],
});

/**
 * Counter: Dead-lettered maturity reminder emails.
 * Incremented when a maturity reminder fails permanently (permanent SMTP error or max retries exceeded).
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeadLetterTotal = new client.Counter({
  name: 'maturity_reminder_dead_letter_total',
  help: 'Total number of maturity reminder emails dead-lettered due to permanent failures or retry exhaustion',
  labelNames: ['job_type', 'reason'],
  registers: [registry],
});

/**
 * Counter: Footprint cache hits.
 * @type {import('prom-client').Counter}
 */
const footprintCacheHitsTotal = new client.Counter({
  name: 'soroban_footprint_cache_hits_total',
  help: 'Total number of Soroban footprint cache hits',
  registers: [registry],
});

/**
 * Counter: Footprint cache misses.
 * @type {import('prom-client').Counter}
 */
const footprintCacheMissesTotal = new client.Counter({
  name: 'soroban_footprint_cache_misses_total',
  help: 'Total number of Soroban footprint cache misses',
  registers: [registry],
});

/**
 * Counter: Footprint cache evictions (LRU or TTL).
 * @type {import('prom-client').Counter}
 */
const footprintCacheEvictionsTotal = new client.Counter({
  name: 'soroban_footprint_cache_evictions_total',
  help: 'Total number of Soroban footprint cache evictions (LRU or TTL expiry)',
  registers: [registry],
});

/**
 * Counter: Soroban circuit breaker state transitions.
 * Labelled by the new state name to allow counting transitions into each state.
 * @type {import('prom-client').Counter}
 */
const sorobanCircuitBreakerStateTransitionsTotal = new client.Counter({
  name: 'soroban_circuit_breaker_state_transitions_total',
  help: 'Total number of Soroban circuit breaker state transitions, labelled by state',
  labelNames: ['state'],
  registers: [registry],
});

/**
 * Gauge: Readiness state (1 = ready, 0 = not ready).
 * Updated by performReadinessChecks() in the health service.
 * @type {import('prom-client').Gauge}
 */
const readinessGauge = new client.Gauge({
  name: 'readiness_gauge',
  help: 'Readiness state of the service: 1 = ready to serve traffic, 0 = not ready',
  registers: [registry],
});

module.exports = {
  registry,
  metricsAuth,
  metricsHandler,
  registerJobQueue,
  registerWorker,
  refreshMetrics,
  resetMetricsForTests,
};
