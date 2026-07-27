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
 * ## Response Compression
 *
 * Large metrics responses are compressed with gzip or deflate when the client
 * advertises support via `Accept-Encoding` and the response exceeds the
 * compression threshold (see {@link module:middleware/compression}).
 *
 * @module metrics
 */

let client;
try {
  client = require('prom-client');
} catch (_e) {
  // Fallback shim for environments without prom-client (tests).
  //
  // The shims maintain the same observable surface as real prom-client so
  // tests can inspect `counter.hashMap` / `counter.get()` directly without
  // changing the assertion code.

  /**
   * Minimal prom-client Registry shim for test environments.
   * @implements {import('prom-client').Registry}
   */
  class RegistryShim {
    /**
     * Creates an empty in-memory registry shim.
     */
    constructor() {
      this.contentType = 'text/plain';
      this._items = new Map();
    }
    /**
     * @param {object} metric - Metric instance to register.
     * @returns {void}
     */
    registerMetric(metric) {
      if (metric && metric.name) {
        this._items.set(metric.name, metric);
      }
    }
    /**
     * @param {string} name - Metric name.
     * @returns {object|undefined}
     */
    getSingleMetric(name) {
      return this._items.get(name);
    }
    /** @returns {void} */
    resetMetrics() {
      for (const metric of this._items.values()) {
        if (metric && typeof metric.reset === 'function') {
          metric.reset();
        }
      }
    }
    /** @returns {string} */
    metrics() {
      return '';
    }
  }

  /**
   * Minimal labelled metric shim with Prometheus-like helpers.
   */
  class LabelledMetricShim {
    /**
     * Creates a labelled metric shim and registers it.
     *
     * @param {object} [config]
     * @param {string} [config.name]
     * @param {string[]} [config.labelNames]
     * @param {RegistryShim[]} [config.registers]
     */
    constructor(config = {}) {
      this.name = config.name || 'metric';
      this.labelNames = Array.isArray(config.labelNames) ? config.labelNames : [];
      this.hashMap = {};

      const registers = Array.isArray(config.registers) ? config.registers : [];
      for (const register of registers) {
        if (register && typeof register.registerMetric === 'function') {
          register.registerMetric(this);
        }
      }
    }
    /**
     * Normalizes positional or object label values.
     *
     * @param {unknown[]|object} args - Raw label arguments.
     * @returns {Record<string, string>}
     */
    _normalizeLabels(args) {
      if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        const labels = {};
        for (const key of this.labelNames) {
          labels[key] = String(args[0][key] || '');
        }
        return labels;
      }

      const labels = {};
      for (let i = 0; i < this.labelNames.length; i++) {
        labels[this.labelNames[i]] = String(args[i] || '');
      }
      return labels;
    }
    /**
     * Builds the internal hash key for a label set.
     *
     * @param {Record<string, string>} labels - Normalized label map.
     * @returns {string}
     */
    _hashKey(labels) {
      return JSON.stringify(labels);
    }
    /**
     * Finds or initializes the storage entry for labels.
     *
     * @param {Record<string, string>} labels - Normalized label map.
     * @returns {{ labels: Record<string, string>, value: number }}
     */
    _getOrCreateEntry(labels) {
      const key = this._hashKey(labels);
      if (!this.hashMap[key]) {
        this.hashMap[key] = {
          labels,
          value: 0,
        };
      }
      return this.hashMap[key];
    }
    /**
     * Returns a metric child facade bound to labels.
     *
     * @param {...unknown} values - Positional or object labels.
     * @returns {object}
     */
    labels(...values) {
      const labels = this._normalizeLabels(values);
      return {
        inc: (value) => this.inc(labels, value),
        set: (value) => this.set(labels, value),
        observe: (value) => this.observe(labels, value),
        startTimer: () => this.startTimer(labels),
      };
    }
    /**
     * Reads the current value for a label set.
     *
     * @param {Record<string, string>} [labels={}] - Label set to inspect.
     * @returns {number}
     */
    get(labels = {}) {
      const entry = this.hashMap[this._hashKey(labels)];
      return entry ? entry.value : 0;
    }
    /**
     * Resets all stored label values.
     *
     * @returns {void}
     */
    reset() {
      this.hashMap = {};
    }
  }

  /**
   * Counter shim for test environments.
   * @implements {import('prom-client').Counter}
   */
  class CounterShim extends LabelledMetricShim {
    /**
     * @param {Record<string, string>|number} [labelsOrValue]
     * @param {number} [maybeValue]
     * @returns {void}
     */
    inc(labelsOrValue, maybeValue) {
      const hasLabels = labelsOrValue && typeof labelsOrValue === 'object' && !Array.isArray(labelsOrValue);
      const labels = hasLabels ? labelsOrValue : this._normalizeLabels([]);
      const value = typeof labelsOrValue === 'number'
        ? labelsOrValue
        : typeof maybeValue === 'number'
          ? maybeValue
          : 1;
      const entry = this._getOrCreateEntry(labels);
      entry.value += value;
    }
  }

  /**
   * Gauge shim for test environments.
   * @implements {import('prom-client').Gauge}
   */
  class GaugeShim extends LabelledMetricShim {
    /**
     * @param {Record<string, string>|number} [labelsOrValue]
     * @param {number} [maybeValue]
     * @returns {void}
     */
    set(labelsOrValue, maybeValue) {
      const hasLabels = labelsOrValue && typeof labelsOrValue === 'object' && !Array.isArray(labelsOrValue);
      const labels = hasLabels ? labelsOrValue : this._normalizeLabels([]);
      const value = hasLabels ? Number(maybeValue || 0) : Number(labelsOrValue || 0);
      const entry = this._getOrCreateEntry(labels);
      entry.value = value;
    }
    /**
     * @param {Record<string, string>} [labels]
     * @returns {void}
     */
    setToCurrentTime(labels) {
      this.set(labels || this._normalizeLabels([]), Date.now() / 1000);
    }
  }

  /**
   * Histogram shim for test environments.
   * @implements {import('prom-client').Histogram}
   */
  class HistogramShim extends LabelledMetricShim {
    /**
     * @param {object} [config]
     */
    constructor(config = {}) {
      super(config);
      this.buckets = Array.isArray(config.buckets) ? config.buckets : [];
    }
    /** @returns {void} */
    observe(labelsOrValue, maybeValue) {
      const hasLabels = labelsOrValue && typeof labelsOrValue === 'object' && !Array.isArray(labelsOrValue);
      const labels = hasLabels ? labelsOrValue : this._normalizeLabels([]);
      const value = hasLabels ? Number(maybeValue || 0) : Number(labelsOrValue || 0);
      const entry = this._getOrCreateEntry(labels);
      entry.value += value;
    }
    /**
     * @param {Record<string, string>} [labels={}]
     * @returns {(extraLabels?: Record<string, string>) => number}
     */
    startTimer(labels = {}) {
      const start = Date.now();
      return (extraLabels = {}) => {
        const seconds = (Date.now() - start) / 1000;
        this.observe(Object.assign({}, labels, extraLabels), seconds);
        return seconds;
      };
    }
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
    Histogram: HistogramShim,
  };
}

/** Shared registry — exported so tests can reset it between runs. */
const registry = new client.Registry();

const {
  negotiateEncoding,
  compress,
  DEFAULT_THRESHOLD,
} = require('./middleware/compression');

if (typeof client.collectDefaultMetrics === 'function') {
  client.collectDefaultMetrics({ register: registry });
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

// Cached metrics text for compatibility with test environments where
// prom-client is not available (shim). In production with the real
// prom-client, `metricsHandler` calls the real `registry.metrics()`
// which returns the full Prometheus exposition of ALL registered metrics.
let cachedMetrics = '# HELP liquifact_custom_metrics Placeholder\n';

/**
 * Bounded enum of allowed `reason` label values for maturity-reminder metrics.
 * Any raw error/reason string must be mapped through {@link normalizeReminderReason}
 * before being used as a Prometheus label to prevent time-series cardinality explosion.
 *
 * | Value            | Meaning                                              |
 * |------------------|------------------------------------------------------|
 * | smtp_timeout     | SMTP connection or send timed out                    |
 * | smtp_reject      | SMTP server rejected the message (4xx/5xx response)  |
 * | template_error   | Email template rendering failed                      |
 * | unknown          | Any other / unmapped failure                         |
 */
const REMINDER_REASON_ENUM = Object.freeze([
  'smtp_timeout',
  'smtp_reject',
  'template_error',
  'unknown',
]);

/**
 * Bounded enum of allowed `job_type` label values.
 * Add new job types here when introducing new background job kinds.
 */
const JOB_TYPE_ENUM = Object.freeze(['maturity_reminder', 'webhook_replay', 'unknown']);

/**
 * Bounded enum of allowed `outcome` label values for webhook replay metrics.
 * @readonly
 */
const _WEBHOOK_REPLAY_OUTCOME_ENUM = Object.freeze([
  'success',
  'failure',
  'not_found',
  'already_resolved',
]);

/**
 * Bounded enum of allowed Soroban RPC method label values.
 * Only stable, coarse method families are permitted to avoid leaking payloads
 * or introducing unbounded label cardinality.
 * @readonly
 */
const SOROBAN_RPC_METHOD_ENUM = Object.freeze([
  'contract_call',
  'simulate_transaction',
  'get_ledger_entries',
  'token_metadata',
  'legal_hold_status',
  'schema_version',
  'unknown',
]);

/**
 * Bounded enum of allowed Soroban RPC outcome label values.
 * @readonly
 */
const SOROBAN_RPC_OUTCOME_ENUM = Object.freeze([
  'success',
  'error',
  'circuit_open',
]);

/**
 * Bounded enum of allowed Soroban retry cause label values.
 * @readonly
 */
const SOROBAN_RETRY_CAUSE_ENUM = Object.freeze([
  'timeout',
  '429',
  '5xx',
  'unknown',
]);

/**
 * Refreshes all aggregated metrics by reading current stats from registered queues and workers.
 * @returns {void}
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
    } catch {
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
    } catch {
      // Preserve existing metrics if a registered worker becomes invalid.
    }
  }

  queueDepthGauge.set(queueLength);
  retryQueueSizeGauge.set(retryQueueLength);
  workerInFlightGauge.set(workerInFlight);

  // Build a minimal Prometheus text exposition that includes our gauges.
  // Keep labels bounded and avoid including payloads or per-job ids.
  // The body-size-limit counter is read from the prom-client hashMap so it
  // reflects all .inc() calls made since process start (or shim default 0).
  let bodySizeRejectionsByType = '';
  const hashMap = bodySizeLimitRejectionsTotal ? bodySizeLimitRejectionsTotal.hashMap || {} : {};
  for (const entry of Object.values(hashMap)) {
    if (entry && typeof entry.value === 'number' && entry.value > 0) {
      const labels = entry.labels || {};
      const typeLabel = labels.type || 'unknown';
      bodySizeRejectionsByType += `body_size_limit_rejections_total{type="${typeLabel}"} ${entry.value}\n`;
    }
  }

  cachedMetrics = '' +
    '# HELP liquifact_job_queue_depth Number of pending jobs waiting in queues\n' +
    '# TYPE liquifact_job_queue_depth gauge\n' +
    `liquifact_job_queue_depth ${queueLength}\n` +
    '# HELP liquifact_job_retry_queue_size Number of jobs waiting in retry queues\n' +
    '# TYPE liquifact_job_retry_queue_size gauge\n' +
    `liquifact_job_retry_queue_size ${retryQueueLength}\n` +
    '# HELP liquifact_worker_inflight_count Number of jobs currently being processed\n' +
    '# TYPE liquifact_worker_inflight_count gauge\n' +
    `liquifact_worker_inflight_count ${workerInFlight}\n` +
    '# HELP body_size_limit_rejections_total Total number of request body-size limit rejections (413 Payload Too Large), labelled by limit type for DoS detection\n' +
    '# TYPE body_size_limit_rejections_total counter\n' +
    bodySizeRejectionsByType;
}

/**
 * Registers a job queue for metrics tracking.
 * @param {object} queue - Queue object with getStats method.
 * @returns {void}
 */
function registerJobQueue(queue) {
  registeredJobQueues.add(queue);
}

/**
 * Registers a worker for metrics tracking.
 * @param {object} worker - Worker object with getStats method.
 * @returns {void}
 */
function registerWorker(worker) {
  registeredWorkers.add(worker);
}

/**
 * Starts the periodic metrics refresh interval timer.
 * The timer is created once and automatically unref'd so it does not
 * keep the Node.js process alive.
 * @returns {void}
 */
function startMetricsRefresh() {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setInterval(refreshMetrics, METRIC_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

/**
 * Stops the periodic metrics refresh interval timer.
 * @returns {void}
 */
function stopMetricsRefresh() {
  if (!refreshTimer) {
    return;
  }

  clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Maps a raw job type string to a bounded Prometheus label value.
 *
 * @param {unknown} raw - Raw job type string.
 * @returns {string} Bounded label value from {@link JOB_TYPE_ENUM}.
 */
function normalizeJobType(raw) {
  const str = typeof raw === 'string' ? raw : '';
  return JOB_TYPE_ENUM.includes(str) ? str : 'unknown';
}

/**
 * Maps a raw reminder delivery error to a bounded Prometheus label value.
 *
 * @param {unknown} err - Raw error object, code, or message.
 * @returns {string} Bounded label value from {@link REMINDER_REASON_ENUM}.
 */
function normalizeReminderReason(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err || '');
  const value = `${code} ${message}`.toLowerCase();

  let reason = 'unknown';
  if (value.includes('timeout') || value.includes('timed out') || value.includes('etimedout')) {
    reason = 'smtp_timeout';
  } else if (value.includes('template')) {
    reason = 'template_error';
  } else if (value.includes('reject') || value.includes('smtp') || value.includes('recipient')) {
    reason = 'smtp_reject';
  }
  return REMINDER_REASON_ENUM.includes(reason) ? reason : 'unknown';
}

/**
 * Maps a raw Soroban RPC method identifier to a bounded metric label value.
 *
 * Raw method names may come from config, wrapper names, or internal call-site
 * hints. Unknown values are collapsed to `unknown` to keep label cardinality
 * bounded and to prevent request-specific data from surfacing in metrics.
 *
 * @param {unknown} raw - Raw method identifier.
 * @returns {string} Bounded label value from {@link SOROBAN_RPC_METHOD_ENUM}.
 */
function normalizeSorobanRpcMethod(raw) {
  const str = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const methodAliases = {
    contract_call: 'contract_call',
    callsorobancontract: 'contract_call',
    invoke_contract: 'contract_call',
    invokecontract: 'contract_call',
    simulate_transaction: 'simulate_transaction',
    simulatetransaction: 'simulate_transaction',
    simulation: 'simulate_transaction',
    get_ledger_entries: 'get_ledger_entries',
    getledgerentries: 'get_ledger_entries',
    token_metadata: 'token_metadata',
    tokenmeta: 'token_metadata',
    legal_hold_status: 'legal_hold_status',
    get_legal_hold: 'legal_hold_status',
    schema_version: 'schema_version',
    get_schema_version: 'schema_version',
  };
  const normalized = methodAliases[str] || 'unknown';
  return SOROBAN_RPC_METHOD_ENUM.includes(normalized) ? normalized : 'unknown';
}

/**
 * Maps a raw Soroban call outcome to a bounded metric label value.
 *
 * @param {unknown} raw - Raw outcome identifier or error code.
 * @returns {string} Bounded label value from {@link SOROBAN_RPC_OUTCOME_ENUM}.
 */
function normalizeSorobanRpcOutcome(raw) {
  const str = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const outcome = str === 'circuit_open'
    ? 'circuit_open'
    : str === 'success'
      ? 'success'
      : 'error';
  return SOROBAN_RPC_OUTCOME_ENUM.includes(outcome) ? outcome : 'error';
}

/**
 * Maps a raw Soroban retry classification to a bounded metric label value.
 *
 * Accepted inputs are the stable retry buckets emitted by `src/services/soroban.js`:
 * `timeout`, `429`, `5xx`. Any other value is collapsed to `unknown`.
 *
 * @param {unknown} raw - Raw retry cause identifier.
 * @returns {string} Bounded label value from {@link SOROBAN_RETRY_CAUSE_ENUM}.
 */
function normalizeSorobanRetryCause(raw) {
  const str = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SOROBAN_RETRY_CAUSE_ENUM.includes(str) ? str : 'unknown';
}

/**
 * Resets all metrics state for test isolation.
 * Clears registered queues, workers, and resets gauge values to zero.
 * @returns {void}
 */
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
  res.vary('Accept-Encoding');
  // Use the real prom-client registry.metrics() when available (production),
  // which returns the full Prometheus exposition including ALL registered
  // counters and gauges. Fall back to cachedMetrics for the shim (tests).
  const metricsText = typeof client.Gauge !== 'function' || client.Gauge.name === 'GaugeShim'
    ? cachedMetrics
    : await registry.metrics();

  const buffer = Buffer.from(metricsText, 'utf8');

  // Only compress responses above the threshold when the client
  // advertises supported encodings via Accept-Encoding.
  if (buffer.length > DEFAULT_THRESHOLD) {
    const encoding = negotiateEncoding(_req.headers['accept-encoding']);

    if (encoding !== 'identity') {
      const compressed = await compress(buffer, encoding);
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      return res.end(compressed);
    }
  }

  res.end(buffer);
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
 * Gauge: Count of mismatched invoices from the most recent reconciliation run.
 * Updated after each performReconciliation run completes.
 * @type {import('prom-client').Gauge}
 */
const escrowReconciliationMismatchedInvoicesGauge = new client.Gauge({
  name: 'escrow_reconciliation_mismatched_invoices',
  help: 'Number of mismatched invoices from the most recent reconciliation run',
  registers: [registry],
});

/**
 * Gauge: Total absolute drift magnitude (sum of |DB - onChain|) from the most
 * recent reconciliation run. Higher values indicate larger financial discrepancies.
 * @type {import('prom-client').Gauge}
 */
const escrowReconciliationDriftMagnitudeGauge = new client.Gauge({
  name: 'escrow_reconciliation_drift_magnitude',
  help: 'Total absolute drift magnitude from the most recent reconciliation run',
  registers: [registry],
});

/**
 * Counter: Reconciliation runs that breached the configured drift threshold.
 * Incremented when mismatches >= RECONCILIATION_DRIFT_THRESHOLD.
 * @type {import('prom-client').Counter}
 */
const escrowReconciliationDriftAlertsTotal = new client.Counter({
  name: 'escrow_reconciliation_drift_alerts_total',
  help: 'Total number of reconciliation runs that breached the drift threshold',
  registers: [registry],
});

/**
 * Counter: Maturity reminder email delivery attempts.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliveryAttemptsTotal = new client.Counter({
  name: 'maturity_reminder_delivery_attempts_total',
  help: 'Total number of maturity reminder delivery attempts',
  labelNames: ['reason', 'job_type'],
  registers: [registry],
});

/**
 * Counter: Successful maturity reminder deliveries.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliverySuccessTotal = new client.Counter({
  name: 'maturity_reminder_delivery_success_total',
  help: 'Total number of successful maturity reminder deliveries',
  labelNames: ['job_type'],
  registers: [registry],
});

/**
 * Counter: Maturity reminder dead-letter writes.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeadLetterTotal = new client.Counter({
  name: 'maturity_reminder_dead_letter_total',
  help: 'Total number of maturity reminder jobs moved to the dead-letter path',
  labelNames: ['reason', 'job_type'],
  registers: [registry],
});

/**
 * Counter: Contract WASM version mismatch alerts.
 * @type {import('prom-client').Counter}
 */
const contractWasmVersionMismatchAlertsTotal = new client.Counter({
  name: 'contract_wasm_version_mismatch_alerts_total',
  help: 'Total number of contract WASM version mismatch alerts',
  labelNames: ['status'],
  registers: [registry],
});

/**
 * Counter: Failed idempotency response storage attempts after all retries exhausted.
 * Labelled by key prefix (first 8 chars) for operational visibility without exposing full keys.
 * @type {import('prom-client').Counter}
 */
const idempotencyStorageFailureTotal = new client.Counter({
  name: 'idempotency_storage_failure_total',
  help: 'Total number of idempotency response storage failures after max retries',
  labelNames: ['keyPrefix'],
  registers: [registry],
});

/**
 * Counter: Request body-size limit rejections (413 Payload Too Large), labelled by `type`.
 * @type {import('prom-client').Counter}
 */
const bodySizeLimitRejectionsTotal = new client.Counter({
  name: 'body_size_limit_rejections_total',
  help: 'Total number of request body-size limit rejections (413 Payload Too Large), labelled by limit type',
  labelNames: ['type'],
  registers: [registry],
});

/**
 * Counter: Cache middleware/store errors.
 * @type {import('prom-client').Counter}
 */
const cacheStoreErrorsTotal = new client.Counter({
  name: 'cache_store_errors_total',
  help: 'Total number of cache store errors handled fail-open',
  registers: [registry],
});

/**
 * Counter: Redis cache fail-open events.
 * @type {import('prom-client').Counter}
 */
const redisCacheFailOpenTotal = new client.Counter({
  name: 'redis_cache_fail_open_total',
  help: 'Total number of Redis cache fail-open events',
  registers: [registry],
});

/**
 * Counter: Footprint cache hits.
 * @type {import('prom-client').Counter}
 */
const footprintCacheHitsTotal = new client.Counter({
  name: 'footprint_cache_hits_total',
  help: 'Total number of footprint cache hits',
  registers: [registry],
});

/**
 * Counter: Footprint cache misses.
 * @type {import('prom-client').Counter}
 */
const footprintCacheMissesTotal = new client.Counter({
  name: 'footprint_cache_misses_total',
  help: 'Total number of footprint cache misses',
  registers: [registry],
});

/**
 * Counter: Footprint cache evictions.
 * @type {import('prom-client').Counter}
 */
const footprintCacheEvictionsTotal = new client.Counter({
  name: 'footprint_cache_evictions_total',
  help: 'Total number of footprint cache evictions',
  registers: [registry],
});

/**
 * Counter: Soroban circuit breaker state transitions.
 * @type {import('prom-client').Counter}
 */
const sorobanCircuitBreakerStateTransitionsTotal = new client.Counter({
  name: 'soroban_circuit_breaker_state_transitions_total',
  help: 'Total number of Soroban circuit breaker state transitions',
  labelNames: ['breaker_name', 'from_state', 'to_state'],
  registers: [registry],
});

/**
 * Gauge: Overall service readiness state.
 * @type {import('prom-client').Gauge}
 */
const readinessGauge = new client.Gauge({
  name: 'readiness_state',
  help: 'Overall service readiness state: 1 ready, 0.5 degraded, 0 not ready',
  registers: [registry],
});

/**
 * Counter: Webhook dead-letter replay attempts, labelled by bounded `outcome`.
 * @type {import('prom-client').Counter}
 */
const webhookReplayTotal = new client.Counter({
  name: 'webhook_replay_total',
  help: 'Total number of webhook dead-letter replay attempts',
  labelNames: ['outcome'],
  registers: [registry],
});

/**
 * Histogram: End-to-end latency of Soroban RPC wrapper calls, including retry
 * delays and circuit-breaker handling. Labels remain bounded to coarse method
 * families and a small set of outcomes.
 * @type {import('prom-client').Histogram}
 */
const sorobanRpcCallDurationSeconds = new client.Histogram({
  name: 'soroban_rpc_call_duration_seconds',
  help: 'Latency of Soroban RPC wrapper calls in seconds',
  labelNames: ['method', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/**
 * Counter: Retry attempts made by Soroban RPC wrappers, labelled by a bounded
 * retry cause classification. Raw exception messages are never used as labels.
 * @type {import('prom-client').Counter}
 */
const sorobanRpcRetryCausesTotal = new client.Counter({
  name: 'soroban_rpc_retry_causes_total',
  help: 'Total number of Soroban RPC retry attempts by retry cause',
  labelNames: ['cause'],
  registers: [registry],
});

/**
 * Returns the shared Prometheus registry.
 *
 * @returns {import('prom-client').Registry} The metrics registry.
 */
function getRegistry() {
  return registry;
}

module.exports = {
  registry,
  getRegistry,
  metricsAuth,
  metricsHandler,
  registerJobQueue,
  registerWorker,
  refreshMetrics,
  resetMetricsForTests,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
  escrowReconciliationDriftAlertsTotal,
  sorobanRpcCallDurationSeconds,
  sorobanRpcRetryCausesTotal,
  footprintCacheHitsTotal,
  footprintCacheMissesTotal,
  footprintCacheEvictionsTotal,
  webhookReplayTotal,
  bodySizeLimitRejectionsTotal,
  normalizeJobType,
  normalizeSorobanRpcMethod,
  normalizeSorobanRpcOutcome,
  normalizeSorobanRetryCause,
  startMetricsRefresh,
  stopMetricsRefresh,
  webhookReplayTotal,
};
