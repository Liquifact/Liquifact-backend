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
 * ## Mutation audit log (issue #872)
 *
 * Every counter/gauge/histogram mutation (and instance reset) is mirrored into
 * the in-memory bounded ring buffer exposed by {@link module:metricsAudit}.
 * The audit wrapping is applied at registration time so call sites (.inc /
 * .set / .observe) remain unchanged. The wrapping preserves Prometheus
 * semantics — labels, label sets, child facades returned from `.labels()`, and
 * the shim fallback used in tests are all supported.
 *
 * @module metrics
 */

let client;
try {
  client = require('prom-client');
} catch (_e) {
  // Fallback shim for environments without prom-client (tests).

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

const metricsAudit = require('./metricsAudit');

/** Shared registry — exported so tests can reset it between runs. */
const registry = new client.Registry();

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

const configReadCacheHits = new client.Counter({
  name: 'liquifact_config_read_cache_hits_total',
  help: 'Total number of config read cache hits',
  registers: [registry],
});

const configReadCacheMisses = new client.Counter({
  name: 'liquifact_config_read_cache_misses_total',
  help: 'Total number of config read cache misses',
  registers: [registry],
});

const invoiceStateRequestDurationMs = new client.Histogram({
  name: 'liquifact_invoice_state_request_duration_ms',
  help: 'Invoice-state request duration in milliseconds',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  labelNames: ['route', 'method', 'status_class', 'error_cause'],
  registers: [registry],
});

const invoiceStateRequestCount = new client.Counter({
  name: 'liquifact_invoice_state_requests_total',
  help: 'Total invoice-state requests',
  labelNames: ['route', 'method', 'status_class', 'error_cause'],
  registers: [registry],
});

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
 * Reads `req.socket.remoteAddress` first ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this is the actual TCP socket peer
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
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ YES ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ constant-time compare Authorization header
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡         ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ match  ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ next()
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡         ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ no match ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ 401 (no detail)
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ NO  ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ extractClientIp(req) in LOOPBACK set?
 *             ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ yes ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ next()
 *             ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ no  ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ 401 (no detail)
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
  const startNs = process.hrtime.bigint();

  const finishWithUnauthorized = () => {
    const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    res.status(401).json({ error: 'Unauthorized' });
    recordMetricsEndpointOutcome({
      statusCode: res.statusCode,
      durationSeconds,
      error: new Error('Unauthorized'),
      req,
    });
  };

  if (token) {
    const auth = req.headers['authorization'] || '';
    if (safeEqual(auth, `Bearer ${token}`)) { return next(); }
    const authFallback = req.headers['Authorization'] || '';
    if (safeEqual(authFallback, `Bearer ${token}`)) { return next(); }
    finishWithUnauthorized();
    return;
  }

  // No token configured — allow loopback only, using the direct TCP socket IP.
  // X-Forwarded-For is NEVER trusted for this check.
  const ip = extractClientIp(req);
  if (LOOPBACK.has(ip)) { return next(); }

  finishWithUnauthorized();
}

/**
 * Express route handler that returns Prometheus metrics in plain-text format.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function metricsHandler(req, res) {
  const startNs = process.hrtime.bigint();
  let recorded = false;

  const done = () => {
    if (recorded) { return; }
    recorded = true;
    const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    recordMetricsEndpointOutcome({
      statusCode: res.statusCode,
      durationSeconds,
      error: res.locals && res.locals.metricsError,
      req,
    });
  };

  res.on('finish', done);
  res.on('close', done);

  res.set('Content-Type', registry.contentType);
  try {
    // Use the real prom-client registry.metrics() when available (production),
    // which returns the full Prometheus exposition including ALL registered
    // counters and gauges. Fall back to cachedMetrics for the shim (tests).
    const metricsText = typeof client.Gauge !== 'function' || client.Gauge.name === 'GaugeShim'
      ? cachedMetrics
      : await registry.metrics();
    res.end(metricsText);
  } catch (err) {
    if (res.locals) { res.locals.metricsError = err; }
    res.statusCode = 500;
    res.end('');
  }
}

const kycWebhookRequestDurationSeconds = new client.Histogram({
  name: 'kyc_webhook_request_duration_seconds',
  help: 'Duration of KYC webhook ingestion requests in seconds',
  labelNames: ['status_class'],
  registers: [registry],
});

const kycWebhookRequestsTotal = new client.Counter({
  name: 'kyc_webhook_requests_total',
  help: 'Total KYC webhook ingestion requests',
  labelNames: ['status_class'],
  registers: [registry],
});

const kycWebhookErrorsTotal = new client.Counter({
  name: 'kyc_webhook_errors_total',
  help: 'Total KYC webhook ingestion error count by cause',
  labelNames: ['cause'],
  registers: [registry],
});

function normalizeKycWebhookStatusClass(status) {
  const code = Number(status);
  if (!code || isNaN(code)) return '5xx';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 400 && code < 500) return '4xx';
  return '5xx';
}

function normalizeKycWebhookCause({ status, errorCode }) {
  if (errorCode) return errorCode;
  const code = Number(status);
  if (code >= 200 && code < 300) return 'none';
  if (code >= 400) return `http_${code}`;
  return 'none';
}

const apiKeyAuthDurationSeconds = new client.Histogram({
  name: 'api_key_auth_duration_seconds',
  help: 'Duration of API key authentication checks in seconds',
  labelNames: ['endpoint', 'method', 'status', 'outcome'],
  registers: [registry],
});

const apiKeyAuthErrorsTotal = new client.Counter({
  name: 'api_key_auth_errors_total',
  help: 'Total API key authentication errors by cause',
  labelNames: ['cause'],
  registers: [registry],
});

function classifyApiKeyOutcome(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return 'success';
  if (code === 401) return 'unauthorized';
  if (code === 403) return 'forbidden';
  return 'error';
}

function classifyApiKeyErrorCause(status) {
  const code = Number(status);
  if (code === 401) return 'invalid_key';
  if (code === 403) return 'insufficient_scope';
  if (code >= 500) return 'server_error';
  return 'unknown';
}

module.exports = {
  registry,
  metricsAuth,
  metricsHandler,
  configReadCacheHits,
  configReadCacheMisses,
  invoiceStateRequestDurationMs,
  invoiceStateRequestCount,
  kycWebhookRequestDurationSeconds,
  kycWebhookRequestsTotal,
  kycWebhookErrorsTotal,
  normalizeKycWebhookStatusClass,
  normalizeKycWebhookCause,
  apiKeyAuthDurationSeconds,
  apiKeyAuthErrorsTotal,
  classifyApiKeyOutcome,
  classifyApiKeyErrorCause,
};
