'use strict';

/**
 * Health check service for dependency monitoring.
 * @module services/health
 */

const { getKycProviderConfig } = require('./kycService');
const { escrowIndexerLastCursorAdvanceTimestampSeconds } = require('../metrics');
const cfg = require('../config');

/**
 * Checks if the Soroban RPC endpoint is reachable.
 * @returns {Promise<{status: string, latency?: number, error?: string}>}
 */
async function checkSorobanHealth() {
  const url = process.env.SOROBAN_RPC_URL;
  if (!url) {
    return { status: 'unknown', error: 'SOROBAN_RPC_URL not configured' };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    if (response.ok) {
      return { status: 'healthy', latency };
    }
    return { status: 'unhealthy', latency, error: `HTTP ${response.status}` };
  } catch (error) {
    const latency = Date.now() - start;
    return { status: 'unhealthy', latency, error: error.message };
  }
}

/**
 * Checks if the database is reachable.
 * @returns {Promise<{status: string, latency?: number, error?: string}>}
 */
async function checkDatabaseHealth() {
  if (!process.env.DATABASE_URL) {
    return { status: 'not_configured' };
  }
  return { status: 'not_implemented', error: 'Database health check pending' };
}

/**
 * Checks escrow reconciliation status.
 * 
 * @returns {Promise<{status: string, lastRun?: string, mismatches?: number, error?: string}>} Reconciliation health status.
 */
async function checkReconciliationHealth() {
  try {
    const { getReconciliationSummary } = require('../jobs/reconcileEscrow');
    const summary = await getReconciliationSummary();

    if (!summary) {
      return { status: 'not_run', error: 'Reconciliation has not been run yet' };
    }

    const lastRun = new Date(summary.reconciledAt);
    const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);

    // Consider unhealthy if last run was more than 25 hours ago (allowing 1 hour grace)
    if (hoursSinceLastRun > 25) {
      return { status: 'stale', lastRun: summary.reconciledAt, error: 'Reconciliation not run recently' };
    }

    // Unhealthy if there are mismatches
    if (summary.mismatches > 0) {
      return { status: 'mismatches', lastRun: summary.reconciledAt, mismatches: summary.mismatches };
    }

    return { status: 'healthy', lastRun: summary.reconciledAt };
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
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(kycCfg.baseUrl, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${kycCfg.apiKey}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    // Any HTTP response (even 4xx) means the host is reachable
    return response.ok || response.status < 500
      ? { status: 'healthy', latency }
      : { status: 'unhealthy', latency, error: `HTTP ${response.status}` };
  } catch (error) {
    const latency = Date.now() - start;
    return { status: 'unhealthy', latency, error: error.message };
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
 * Performs all dependency health checks.
 * @returns {Promise<{healthy: boolean, checks: Object}>}
 */
async function performHealthChecks() {
  const [soroban, database, kyc, indexerStaleness] = await Promise.all([
    checkSorobanHealth(),
    checkDatabaseHealth(),
    checkKycHealth(),
    checkIndexerStaleness(),
  ]);

  const checks = { soroban, database, kyc, indexerStaleness };
  const healthy =
    (soroban.status === 'healthy' || soroban.status === 'unknown') &&
    (kyc.status === 'healthy' || kyc.status === 'disabled') &&
    (indexerStaleness.status === 'healthy' || indexerStaleness.status === 'disabled');

  return { healthy, checks };
}

module.exports = { checkSorobanHealth, checkDatabaseHealth, checkKycHealth, checkIndexerStaleness, performHealthChecks };
