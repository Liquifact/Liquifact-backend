'use strict';

/**
 * Minimal entry-point shim.
 *
 * The original src/index.js was structurally invalid (duplicated bodies and
 * unbalanced braces) and broke both `node --check` and Jest parsing. To unblock
 * the CI pipeline this file now simply re-exports the working Express app
 * factory from ./app and provides a no-op startServer helper for the legacy
 * tests that reference it.
 */

require('dotenv').config();

const app = require('./app');
const { validate, logRedactedSummary } = require('./config');
const shutdownCoordinator = require('./utils/shutdownCoordinator');

/**
 * Runs the S3 connectivity probe at startup. Failures are logged but never
 * block process start — the readiness probe (`/readyz`) surfaces storage
 * misconfiguration to orchestrators once the HTTP server is listening.
 *
 * @returns {Promise<void>}
 */
async function scheduleStartupStorageProbe() {
  try {
    const storage = require('./services/storage');
    await storage.runStartupStorageProbe();
  } catch (_err) {
    // Best-effort: a probe failure must not abort startup.
  }
}

/**
 * Validates the application configuration at startup before the server starts listening.
 * In test environment, the validation is skipped to preserve lazy loading behavior.
 * Fails fast by logging a redacted summary of errors and exiting with a non-zero code.
 * @returns {void}
 */
function runBootConfigValidation() {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  try {
    validate();
  } catch (error) {
    logRedactedSummary(error);
    process.exit(1);
  }
}

/**
 * Starts the HTTP server on the configured port.
 *
 * @returns {import('http').Server} The HTTP server instance.
 */
function startServer() {
  runBootConfigValidation();
  const port = process.env.PORT || 3001;
  // Fire-and-forget probe — do not await, so startup is not blocked.
  scheduleStartupStorageProbe();
  const server = app.listen(port);
  shutdownCoordinator.register({ server });
  shutdownCoordinator.setupSignalListeners();
  return server;
}

/**
 * Resets in-memory state (clears the shared cache store for test isolation).
 *
 * @returns {void}
 */
function resetStore() {
  try {
    const { getSharedStore } = require('./services/cacheStore');
    getSharedStore().clear();
  } catch (_) {
    // intentional no-op in environments where cacheStore is unavailable
  }
}

const originalCreateApp = app.createApp;

/**
 * Returns the underlying Express app factory.
 *
 * @returns {import('express').Express} Configured Express app.
 */
function createApp() {
  return typeof originalCreateApp === 'function' ? originalCreateApp() : app;
}


// Start background workers when running as main module (not in tests)
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  // Start the idempotency purge worker
  const { startPurgeWorker } = require('./jobs/idempotencyPurge');
  startPurgeWorker();

  startServer();
}

module.exports = app;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
module.exports.resetStore = resetStore;