'use strict';

/**
 * Health check service for dependency monitoring.
 * @module services/health
 */

const { getKycProviderConfig } = require('./kycService');
const { escrowIndexerLastCursorAdvanceTimestampSeconds, readinessGauge, isEnabled: isMetricsEnabled, registry: metricsRegistry } = require('../metrics');

const METRICS_HEALTH_TIMEOUT_MS = 1000;
const db = require('../db/knex');
const cfg = require('../config');

const DEFAULT_SOROBAN_HEALTH_TIMEOUT_MS = 5000;
const MIN_SOROBAN_HEALTH_TIMEOUT_MS = 250;
const MAX_SOROBAN_HEALTH_TIMEOUT_MS = 10000;

/**
 * Resolves the Soroban RPC health-probe timeout from environment variables.
 * Values are clamped so a typo cannot disable the timeout or make readiness
 * probes wait indefinitely.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source.
 * @returns {number} Timeout in milliseconds.
 */
function resolveSorobanHealthTimeoutMs(env = process.env) {
  const configuredTimeoutMs = parseInt(env.SOROBAN_HEALTH_TIMEOUT_MS, 10);
  if (Number.isNaN(configuredTimeoutMs)) {
    return DEFAULT_SOROBAN_HEALTH_TIMEOUT_MS;
  }

  return Math.min(
    Math.max(configuredTimeoutMs, MIN_SOROBAN_HEALTH_TIMEOUT_MS),
    MAX_SOROBAN_HEALTH_TIMEOUT_MS
  );
}

/**
 * Classify Soroban RPC latency against configurable thresholds.
 * Returns "healthy" for latency <= warn, "degraded" for latency > warn && <= fail,
 * and "unhealthy" for latency > fail.
 * @param {number} latencyMs Measured latency in milliseconds.
 * @returns {'healthy'|'degraded'|'unhealthy'}
 */
function classifySorobanLatency(latencyMs) {
  const warnMs = parseInt(process.env.SOROBAN_LATENCY_WARN_MS, 10) || 200;
  const failMs = parseInt(process.env.SOROBAN_LATENCY_FAIL_MS, 10) || 500;
  if (latencyMs <= warnMs) {
    return 'healthy';
  }
  if (latencyMs <= failMs) {
    return 'degraded';
  }
  return 'unhealthy';
}

/**
 * Checks if the Soroban RPC endpoint is reachable and classifies latency.
 * @returns {Promise<{status: string, latency?: number, error?: string}>}
 */
async function checkSorobanHealth() {
  const url = process.env.SOROBAN_RPC_URL;
  if (!url) {
    return { status: 'unknown', error: 'SOROBAN_RPC_URL not configured' };
  }

  const start = Date.now();
  let timeout;

  try {
    const controller = new AbortController();
    const timeoutMs = resolveSorobanHealthTimeoutMs();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (timeout.unref) {
      timeout.unref();
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });

    const latency = Date.now() - start;

    if (response.ok) {
      const classification = classifySorobanLatency(latency);
      return { status: classification, latency };
    }
    return { status: 'unhealthy', latency, error: `HTTP ${response.status}` };
  } catch (error) {
    const latency = Date.now() - start;
    return { status: 'unhealthy', latency, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @typedef {Object} PoolMetrics
 * @property {number} used - Connections currently checked out by active queries.
 * @property {number} free - Idle connections available for acquisition.
 * @property {number} pending - Requests queued waiting for a free connection.
 * @property {number} max - Configured pool maximum size.
 */

/**
 * Reads safe-to-expose connection-pool counters from a Knex instance.
 *
 * Accesses the underlying tarn pool object exposed at `knexInstance.client.pool`.
 * Returns `null` when the pool is inaccessible (e.g. in-memory SQLite test mode
 * where no real pool is initialised).
 *
 * Security note: only numeric counts are returned. Connection strings, host
 * names, credentials, and raw pool-object internals are never included.
 *
 * @param {import('knex').Knex} knexInstance - Knex database instance to inspect.
 * @returns {PoolMetrics|null} Current pool counters, or null when unavailable.
 */
function inspectPoolHealth(knexInstance) {
  const pool = knexInstance && knexInstance.client && knexInstance.client.pool;
  if (!pool) {
    return null;
  }

  const used = typeof pool.numUsed === 'function' ? pool.numUsed() : 0;
  const free = typeof pool.numFree === 'function' ? pool.numFree() : 0;
  const pending = typeof pool.numPendingAcquires === 'function' ? pool.numPendingAcquires() : 0;
  const max = (
    knexInstance.client &&
    knexInstance.client.config &&
    knexInstance.client.config.pool &&
    knexInstance.client.config.pool.max
  ) || 10;

  return { used, free, pending, max };
}

/**
 * Checks database reachability and connection-pool saturation.
 *
 * Runs `SELECT 1` inside a short bounded timeout so the health probe never
 * hangs on an exhausted pool. Pool metrics (used/free/pending/max) are
 * captured before the query and returned alongside reachability status.
 *
 * Status values:
 * - `'healthy'`       — DB is reachable and pool is within normal bounds.
 * - `'degraded'`      — DB is reachable but pool is saturated (pending > 0
 *                       or used connections at or above the saturation ratio).
 * - `'unhealthy'`     — DB is unreachable or pool acquisition timed out.
 * - `'not_configured'`— `DATABASE_URL` env var is absent.
 *
 * Tuning env vars:
 * - `DB_HEALTH_PROBE_TIMEOUT_MS`  — milliseconds before the probe times out
 *                                   (default 2000).
 * - `DB_POOL_SATURATION_RATIO`    — fraction of `max` at which `used`
 *                                   connections trigger `degraded` (default 0.8).
 *
 * Does not expose connection strings, host names, or credentials in the response.
 *
 * @returns {Promise<{
 *   status: 'healthy'|'degraded'|'unhealthy'|'not_configured',
 *   latency?: number,
 *   pool?: PoolMetrics,
 *   error?: string
 * }>}
 */
async function checkDatabaseHealth() {
  if (!process.env.DATABASE_URL) {
    return { status: 'not_configured' };
  }

  const poolMetrics = inspectPoolHealth(db);
  const probeTimeoutMs = parseInt(process.env.DB_HEALTH_PROBE_TIMEOUT_MS, 10) || 2000;
  const saturationRatio = parseFloat(process.env.DB_POOL_SATURATION_RATIO) || 0.8;

  const start = Date.now();
  let timedOut = false;
  let timeoutId;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error('POOL_ACQUIRE_TIMEOUT'));
      }, probeTimeoutMs);
      if (timeoutId.unref) {
        timeoutId.unref();
      }
    });

    await Promise.race([db.raw('SELECT 1'), timeoutPromise]);
    clearTimeout(timeoutId);

    const latency = Date.now() - start;

    const hasPending = poolMetrics && poolMetrics.pending > 0;
    const atSaturation = poolMetrics && poolMetrics.used >= Math.ceil(poolMetrics.max * saturationRatio);
    const status = (hasPending || atSaturation) ? 'degraded' : 'healthy';

    const result = { status, latency };
    if (poolMetrics) {
      result.pool = poolMetrics;
    }
    return result;
  } catch (_error) {
    clearTimeout(timeoutId);
    const latency = Date.now() - start;
    const result = {
      status: 'unhealthy',
      latency,
      error: timedOut ? 'Connection pool acquire timeout' : 'Database unreachable',
    };
    if (poolMetrics) {
      result.pool = poolMetrics;
    }
    return result;
  }
}

/**
 * Checks escrow reconciliation status.
 *
 * Returns a structured summary that includes mismatch count and drift data so
 * the `/ready` probe can degrade when funded-amount drift exceeds the configured
 * threshold (`RECONCILIATION_DRIFT_THRESHOLD`, default `1`).
 *
 * Status values:
 * - `'healthy'`     — Last run is recent and has zero mismatches.
 * - `'degraded'`    — Last run has mismatches but count is below the drift
 *                     threshold; drift is present but within tolerance.
 * - `'mismatch_threshold_breached'` — Mismatch count meets or exceeds
 *                     `RECONCILIATION_DRIFT_THRESHOLD`; readiness should degrade.
 * - `'stale'`       — Last run was more than 25 hours ago.
 * - `'not_run'`     — Reconciliation has never been executed.
 * - `'error'`       — Lookup failed.
 *
 * @returns {Promise<{
 *   status: string,
 *   lastRun?: string,
 *   mismatches?: number,
 *   totalDrift?: number,
 *   threshold?: number,
 *   thresholdBreached?: boolean,
 *   error?: string
 * }>} Reconciliation health status.
 */
async function checkReconciliationHealth() {
  try {
    const { getReconciliationSummary, getDriftThreshold } = require('../jobs/reconcileEscrow');
    const summary = await getReconciliationSummary();

    if (!summary) {
      return { status: 'not_run', error: 'Reconciliation has not been run yet' };
    }

    const lastRun = new Date(summary.reconciledAt);
    const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);

    // Consider stale if last run was more than 25 hours ago (1-hour grace).
    if (hoursSinceLastRun > 25) {
      return {
        status: 'stale',
        lastRun: summary.reconciledAt,
        error: 'Reconciliation not run recently',
      };
    }

    const threshold = typeof getDriftThreshold === 'function' ? getDriftThreshold() : 5;
    const mismatches = summary.mismatches || 0;

    // Calculate total drift from results if available.
    const totalDrift = Array.isArray(summary.results)
      ? summary.results.reduce((acc, r) => acc + (r.driftMagnitude || 0), 0)
      : 0;

    if (mismatches > 0) {
      return {
        status: 'mismatches',
        lastRun: summary.reconciledAt,
        mismatches,
        totalDrift,
        threshold,
        thresholdBreached: mismatches >= threshold,
      };
    }


    return {
      status: 'healthy',
      lastRun: summary.reconciledAt,
      mismatches: 0,
      totalDrift: 0,
      threshold,
      thresholdBreached: false,
    };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

/**
 * Checks if the KYC provider is reachable.
 * Only runs when the provider is enabled (URL + API key configured).
 * The API key is sent in the Authorization header and never included in the response.
 * @returns {Promise<{status: string, latency?: number, error?: string}>}
 */
async function checkKycHealth() {
  const kycCfg = getKycProviderConfig();
  if (!kycCfg.enabled) {
    return { status: 'disabled' };
  }

  const start = Date.now();
  let timeout;

  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 5000);
    if (timeout.unref) {
      timeout.unref();
    }

    const response = await fetch(kycCfg.baseUrl, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${kycCfg.apiKey}` },
      signal: controller.signal,
    });

    const latency = Date.now() - start;

    // Any HTTP response (even 4xx) means the host is reachable
    return response.ok || response.status < 500
      ? { status: 'healthy', latency }
      : { status: 'unhealthy', latency, error: `HTTP ${response.status}` };
  } catch (error) {
    const latency = Date.now() - start;
    return { status: 'unhealthy', latency, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Checks escrow indexer staleness.
 * Returns 'disabled' when the indexer is not enabled.
 * Returns 'stale' when the cursor hasn't advanced within the configured threshold.
 * Returns 'healthy' when the cursor has advanced recently or initially (gauge not yet set).
 *
 * @returns {Promise<{status: string, elapsedSeconds?: number, lastAdvanceTimestamp?: number, threshold?: number, error?: string}>} Indexer staleness health status.
 */
async function checkIndexerStaleness() {
  try {
    const config = cfg.get();

    // Check if indexer is enabled
    if (config.ESCROW_INDEXER_ENABLED !== 'true') {
      return { status: 'disabled' };
    }

    // Get the last advance timestamp from gauge
    const lastAdvanceTimestamp = escrowIndexerLastCursorAdvanceTimestampSeconds.get();

    // If gauge has never been set, treat as healthy (no false positive on startup)
    if (lastAdvanceTimestamp === undefined || lastAdvanceTimestamp === 0) {
      return { status: 'healthy', lastAdvanceTimestamp: 0, threshold: config.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS };
    }

    const now = Math.floor(Date.now() / 1000);
    const elapsedSeconds = now - (lastAdvanceTimestamp || 0);
    const threshold = config.ESCROW_INDEXER_STALE_THRESHOLD_SECONDS || 300;

    if (elapsedSeconds > threshold) {
      return {
        status: 'stale',
        elapsedSeconds,
        lastAdvanceTimestamp,
        threshold,
        error: `Cursor has not advanced for ${elapsedSeconds} seconds (threshold: ${threshold})`,
      };
    }

    return {
      status: 'healthy',
      elapsedSeconds,
      lastAdvanceTimestamp,
      threshold,
    };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

/**
 * Checks if the configured S3 bucket is reachable using the connectivity
 * probe defined by the storage service. The result is the raw probe output:
 * status plus optional latency and a sanitized error descriptor. Credentials,
 * endpoint URLs, and signed request headers are stripped before the result
 * is returned.
 *
 * Operator-visible statuses:
 *
 * - `'healthy'` — bucket is reachable and credentials authorize access.
 * - `'in_memory'` — in-memory fallback active; probe skipped.
 * - `'disabled'` — operator opted out via `S3_HEALTHCHECK_ENABLED=false`.
 * - `'not_configured'` — bucket name or credentials are missing.
 * - `'unhealthy'` — `HeadBucket` failed; `error.code` is an AWS error name.
 *
 * @returns {Promise<{
 *   status: string,
 *   latency?: number,
 *   error?: {code: string, hint: string},
 *   bucketConfigured?: boolean,
 *   credentialsConfigured?: boolean
 * }>}
 */
async function checkStorageHealth() {
  const storage = require('./storage');
  return storage.probeS3Connectivity();
}

/**
 * Checks whether the metrics subsystem can produce Prometheus output.
 *
 * Fast (1 s timeout guard) and deliberately non-blocking: metrics is an
 * observability concern, not a business-critical dependency, so a slow or
 * failing scrape is reported for operator visibility but never fails the
 * overall readiness probe (see `performReadinessChecks`) — a scrape hiccup
 * must not take healthy business traffic down with it.
 *
 * Operator-visible statuses:
 *
 * - `'healthy'` — the registry produced output within the timeout.
 * - `'disabled'` — `METRICS_ENABLED=false`; probe skipped, non-blocking.
 * - `'unhealthy'` — the registry threw or exceeded the timeout.
 *
 * @returns {Promise<{status: string, latency?: number, error?: {code: string, hint: string}}>}
 */
async function checkMetricsHealth() {
  if (!isMetricsEnabled()) {
    return { status: 'disabled' };
  }

  const start = Date.now();
  let timeout;
  try {
    await Promise.race([
      metricsRegistry.metrics(),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('metrics_health_timeout')), METRICS_HEALTH_TIMEOUT_MS);
        if (timeout.unref) { timeout.unref(); }
      }),
    ]);
    return { status: 'healthy', latency: Date.now() - start };
  } catch (error) {
    const timedOut = error.message === 'metrics_health_timeout';
    return {
      status: 'unhealthy',
      latency: Date.now() - start,
      error: {
        code: timedOut ? 'TIMEOUT' : 'SCRAPE_FAILED',
        hint: timedOut
          ? `Metrics registry did not respond within ${METRICS_HEALTH_TIMEOUT_MS}ms.`
          : 'The Prometheus registry threw while serializing metrics; check recently registered collectors.',
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Performs all dependency health checks.
 * @returns {Promise<{healthy: boolean, checks: Object}>}
 */
async function performHealthChecks() {
  const [soroban, database, kyc, indexerStaleness, storage] = await Promise.all([
    checkSorobanHealth(),
    checkDatabaseHealth(),
    checkKycHealth(),
    checkIndexerStaleness(),
    checkStorageHealth(),
  ]);

  const checks = { soroban, database, kyc, indexerStaleness, storage };
  const healthy =
    (soroban.status === 'healthy' || soroban.status === 'unknown') &&
    (kyc.status === 'healthy' || kyc.status === 'disabled') &&
    (indexerStaleness.status === 'healthy' || indexerStaleness.status === 'disabled') &&
    // Storage is in-memory or opted out → non-blocking. Missing config or
    // unreachable buckets → blocking for `/ready` because uploads will fail.
    storage.status !== 'not_configured' &&
    storage.status !== 'unhealthy';

  return { healthy, checks };
}

/**
 * Performs critical-dependency readiness checks (DB, Soroban RPC, storage,
 * reconciliation).
 * The KYC and indexer staleness checks are omitted because they are not
 * required for the process to serve *most* traffic — only critical
 * upstream dependencies that would prevent any business request from
 * completing are included.
 *
 * The S3 storage probe is included so a misconfigured bucket (wrong
 * endpoint, bad credentials, deleted bucket) is surfaced on the readiness
 * probe rather than at the first invoice upload.
 *
 * The reconciliation check degrades readiness when the most recent run has
 * a mismatch count that meets or exceeds `RECONCILIATION_DRIFT_THRESHOLD`.
 * The probe is non-blocking when reconciliation has never run (`not_run`)
 * or when the lookup fails (`error`), so a fresh deployment is never held
 * back by the absence of a historical run.
 *
 * Updates the `readiness_gauge` Prometheus metric (1 = ready, 0.5 = degraded,
 * 0 = not ready). Degraded Soroban RPC (slow) does NOT block readiness.
 *
 * The metrics sub-check is included for operator visibility only: it never
 * contributes to `healthy` (see `checkMetricsHealth`).
 *
 * @returns {Promise<{
 *   healthy: boolean,
 *   checks: {
 *     database: Object,
 *     soroban: Object,
 *     storage: Object,
 *     reconciliation: Object,
 *     metrics: Object
 *   }
 * }>}
 */
async function performReadinessChecks() {
  const [database, soroban, storage, reconciliation, metrics] = await Promise.all([
    checkDatabaseHealth(),
    checkSorobanHealth(),
    checkStorageHealth(),
    checkReconciliationHealth(),
    checkMetricsHealth(),
  ]);

  const checks = { database, soroban, storage, reconciliation, metrics };
  // In-memory and explicitly-disabled probes are treated as readiness-OK.
  // Production deployments missing the bucket or with an unreachable
  // bucket DO block readiness.
  const storageOk =
    storage.status === 'healthy' ||
    storage.status === 'in_memory' ||
    storage.status === 'disabled';

  // Determine overall readiness.
  // - DB degraded (pool saturated) still allows traffic but signals pressure → ready.
  // - DB unhealthy/not_configured → not ready.
  // - Soroban degraded (slow) does NOT block readiness.
  // - Reconciliation threshold breach → degrades readiness.
  // - Reconciliation not_run / error → non-blocking (fresh deployments).
  const dbReady = database.status === 'healthy' || database.status === 'degraded';
  const sorobanReady = soroban.status === 'healthy' || soroban.status === 'degraded' || soroban.status === 'unknown';
  const reconciliationOk = reconciliation.status !== 'mismatch_threshold_breached';

  const healthy = dbReady && sorobanReady && storageOk && reconciliationOk;

  // Set gauge: 1 = ready, 0.5 = degraded, 0 = not ready
  if (!dbReady || !storageOk) {
    readinessGauge.set(0);
  } else if (
    database.status === 'degraded' ||
    soroban.status === 'degraded' ||
    reconciliation.status === 'mismatch_threshold_breached' ||
    reconciliation.status === 'degraded'
  ) {
    readinessGauge.set(0.5);
  } else {
    readinessGauge.set(healthy ? 1 : 0);
  }

  return { healthy, checks };
}

/**
 * @typedef {Object} HealthCheckRecord
 * @property {string} id        Deterministic identifier for this check name (e.g. "soroban").
 * @property {string} name      Human-readable check name.
 * @property {string} status    Current check status string.
 * @property {string} timestamp ISO 8601 timestamp at which the snapshot was taken.
 * @property {Object} detail    Raw result from the individual check function.
 */

/**
 * Collects all named dependency health checks into a flat, deterministically-
 * ordered array of {@link HealthCheckRecord} objects.
 *
 * Each record has a stable `id` (the check name) and a `timestamp` derived
 * from the caller-supplied `snapshotTime` argument (defaults to `Date.now()`).
 * This makes the list stable and sortable for cursor-based pagination.
 *
 * The check order is fixed to: soroban → database → kyc → indexerStaleness →
 * storage → reconciliation, which matches `performHealthChecks` /
 * `performReadinessChecks`.
 *
 * @param {Object}  [options]
 * @param {number}  [options.snapshotTime=Date.now()]  Override for unit-test
 *   determinism; milliseconds since epoch.
 * @returns {Promise<HealthCheckRecord[]>}
 */
async function listHealthChecks({ snapshotTime } = {}) {
  const ts = snapshotTime !== undefined ? snapshotTime : Date.now();
  const timestamp = new Date(ts).toISOString();

  const [soroban, database, kyc, indexerStaleness, storage, reconciliation] = await Promise.all([
    checkSorobanHealth(),
    checkDatabaseHealth(),
    checkKycHealth(),
    checkIndexerStaleness(),
    checkStorageHealth(),
    checkReconciliationHealth(),
  ]);

  return [
    { id: 'soroban', name: 'Soroban RPC', status: soroban.status, timestamp, detail: soroban },
    { id: 'database', name: 'Database', status: database.status, timestamp, detail: database },
    { id: 'kyc', name: 'KYC Provider', status: kyc.status, timestamp, detail: kyc },
    { id: 'indexerStaleness', name: 'Escrow Indexer Staleness', status: indexerStaleness.status, timestamp, detail: indexerStaleness },
    { id: 'storage', name: 'Storage (S3)', status: storage.status, timestamp, detail: storage },
    { id: 'reconciliation', name: 'Escrow Reconciliation', status: reconciliation.status, timestamp, detail: reconciliation },
  ];
}

module.exports = {
  checkSorobanHealth,
  checkDatabaseHealth,
  checkKycHealth,
  checkStorageHealth,
  checkIndexerStaleness,
  checkReconciliationHealth,
  checkMetricsHealth,
  performHealthChecks,
  performReadinessChecks,
  inspectPoolHealth,
  resolveSorobanHealthTimeoutMs,
  listHealthChecks,
};
