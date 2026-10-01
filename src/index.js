'use strict';

/**
 * @fileoverview Entry point for the LiquiFact API server.
 *
 * This module provides the main entry point for the application and exports
 * compatibility contracts used by tests and external consumers. All public
 * APIs are documented with explicit contracts for input validation, error
 * handling, and return types.
 *
 * @module index
 */

require('dotenv').config();

const app = require('./app');
const { validate, logRedactedSummary } = require('./config');
const { validateStellarConfig } = require('./config/stellar');
const shutdownCoordinator = require('./utils/shutdownCoordinator');
const logger = require('./logger');

/**
 * The single HTTP listener owned by this process, or `null` when nothing is
 * bound.
 *
 * Invariant: at most one live listener per process. The slot is claimed
 * synchronously before `app.listen` is awaited anywhere and is released when
 * the server closes, so a repeated or concurrent {@link startServer} call can
 * never produce two listeners (the second bind would fail asynchronously with
 * EADDRINUSE) and can never orphan a listener (which would leak the socket
 * past graceful shutdown, because the coordinator tracks a single server).
 *
 * @type {import('http').Server|null}
 */
let httpServer = null;

/**
 * Module-level startup state guards to prevent concurrent/duplicate initialization.
 * @type {{ isServerStarted: boolean, serverInstance: import('http').Server|null, fencingTokens: Map<string, string> }}
 */
const startupState = {
  isServerStarted: false,
  serverInstance: null,
  fencingTokens: new Map(),
};

/**
 * Runs the S3 connectivity probe at startup. Failures are logged but never
 * block process start - the readiness probe (`/readyz`) surfaces storage
 * misconfiguration to orchestrators once the HTTP server is listening.
 *
 * @returns {Promise<void>} Resolves when probe completes or fails silently.
 * @throws {Error} Never throws - all errors are caught and logged internally.
 */
async function scheduleStartupStorageProbe() {
  try {
    const storage = require('./services/storage');
    await storage.runStartupStorageProbe();
  } catch (err) {
    // Best-effort: a probe failure must not abort startup.
    // Log for observability without blocking startup.
    const logger = require('./logger');
    logger.warn({ err }, 'Startup storage probe failed (non-blocking)');
  }
}

/**
 * Validates the application configuration at startup before the server starts listening.
 * In test environment, the validation is skipped to preserve lazy loading behavior.
 * Fails fast by logging a redacted summary of errors and exiting with a non-zero code.
 *
 * @returns {void}
 * @throws {Error} Never throws in production - exits process on validation failure.
 *                    In test environment, returns silently without validation.
 */
function runBootConfigValidation() {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  try {
    validate();
    const stellarConfig = validateStellarConfig();
    process.env.STELLAR_NETWORK_PASSPHRASE = stellarConfig.passphrase;
    
    // Boot-time dependency validation phase
    const { validateDependencies } = require('./config/dependencyValidator');
    validateDependencies();
    return true;
  } catch (error) {
    logRedactedSummary(error);
    process.exit(1);
    return false;
  }
}

/**
 * Resolves which port the process should bind.
 *
 * An explicit argument is authoritative and short-circuits the environment, so
 * an in-process caller (tests, an embedding harness) is never blocked by a
 * `PORT` value meant for a different deployment. With no argument the
 * environment is validated at the moment of binding rather than read from the
 * cached config object, so the value that is bound is the value that was
 * checked even when boot validation was skipped.
 *
 * @param {unknown} [portOverride] - Explicit port from the caller.
 * @returns {{ port: number, source: string }} The port and where it came from.
 * @throws {PortValidationError} If the port is present but not usable.
 */
function resolveListenPort(portOverride) {
  const override = validatePortArgument(portOverride);

  if (override !== null) {
    return { port: override, source: 'argument' };
  }

  return { port: resolvePortFromEnv(process.env.PORT), source: 'env' };
}

/**
 * Wires the observability and cleanup hooks of a bound server.
 *
 * Every call is feature-detected because tests substitute duck-typed stand-ins
 * for the HTTP server; a plain object has no event API and must not make
 * startup fail.
 *
 * @param {import('http').Server} server - The server returned by `app.listen`.
 * @param {number} port - The port it was bound to, for log correlation.
 * @returns {void}
 */
function attachServerLifecycleHandlers(server, port) {
  if (!server || typeof server.once !== 'function') {
    return;
  }

  server.once('error', (err) => {
    // A listener that emitted an error never reached (or has left) the serving
    // state. Releasing the slot keeps the singleton honest even when the exit
    // below is stubbed out.
    if (httpServer === server) {
      httpServer = null;
    }
    logger.error(
      {
        component: 'entrypoint',
        event: 'http_server_error',
        port,
        errorCode: err && err.code,
        errorName: err && err.name,
      },
      'HTTP server reported an unrecoverable error; exiting so the orchestrator can restart the process.'
    );
    process.exit(1);
  });

  server.once('close', () => {
    if (httpServer === server) {
      httpServer = null;
    }
    logger.info(
      { component: 'entrypoint', event: 'http_server_closed', port },
      'HTTP server closed; the listen slot is free for a new listener.'
    );
  });
}

/**
 * Starts the HTTP server on the configured port.
 * Idempotent: if already started, returns the existing server instance.
 *
 * Performs boot-time configuration validation, schedules a non-blocking storage
 * connectivity probe, registers the server with the shutdown coordinator, and sets
 * up signal listeners for graceful shutdown.
 *
 * @param {number} [port] - Optional port override. If not provided, uses PORT
 *                          environment variable or defaults to 3001.
 * @returns {import('http').Server} The HTTP server instance.
 * @throws {Error} May throw if server fails to bind to the specified port.
 *                   Configuration validation failures exit the process instead of throwing.
 */
function startServer() {
  if (startupState.isServerStarted && startupState.serverInstance) {
    console.warn('[index] startServer called multiple times; returning existing server instance');
    return startupState.serverInstance;
  }

  runBootConfigValidation();
  const serverPort = port !== undefined ? port : process.env.PORT || 3001;
  // Fire-and-forget probe -- do not await, so startup is not blocked.
  scheduleStartupStorageProbe();
  const server = app.listen(port);
  
  startupState.isServerStarted = true;
  startupState.serverInstance = server;
  
  shutdownCoordinator.register({ server });
  shutdownCoordinator.setupSignalListeners();

  // Only after the socket exists: a rejected port must leave no background
  // work behind, and storage misconfiguration belongs in the readiness probe
  // rather than in a half-started process.
  scheduleStartupStorageProbe();

  return server;
}

function startServer() {
  runBootConfigValidation();
  return listenServer();
}

let backgroundWorkersStartPromise = null;

/**
 * Starts all process-owned workers as one startup operation.
 * Successful starts are rolled back in reverse order if a later worker fails.
 *
 * @returns {Promise<void>}
 */
function startBackgroundWorkers() {
  if (!backgroundWorkersStartPromise) {
    backgroundWorkersStartPromise = startBackgroundWorkersOnce().catch((error) => {
      backgroundWorkersStartPromise = null;
      throw error;
    });
  }
  return backgroundWorkersStartPromise;
}

async function startBackgroundWorkersOnce() {
  const startedWorkers = [];
  try {
    const idempotencyPurge = require('./jobs/idempotencyPurge');
    await idempotencyPurge.startPurgeWorker();
    startedWorkers.push(idempotencyPurge);

    const invoiceStatePurge = require('./jobs/invoiceStatePurge');
    await invoiceStatePurge.startPurgeWorker();
    startedWorkers.push(invoiceStatePurge);

    for (const job of startedWorkers) {
      shutdownCoordinator.register({ worker: job.purgeWorker });
    }
  } catch (error) {
    for (const job of startedWorkers.reverse()) {
      try {
        await job.stopPurgeWorker();
      } catch (stopError) {
        logger.error(
          { component: job.JOB_TYPE || 'idempotency_purge', errorName: stopError && stopError.name },
          'Background worker rollback failed'
        );
      }
    }
    throw error;
  }
}

async function stopBackgroundWorkers() {
  const jobs = [
    require('./jobs/invoiceStatePurge'),
    require('./jobs/idempotencyPurge'),
  ];
  for (const job of jobs) {
    try {
      await job.stopPurgeWorker();
    } catch (error) {
      logger.error(
        { component: job.JOB_TYPE || 'idempotency_purge', errorName: error && error.name },
        'Background worker shutdown failed during startup recovery'
      );
    }
  }
}

async function startApplication() {
  runBootConfigValidation();
  let workersStarted = false;
  try {
    await startBackgroundWorkers();
    workersStarted = true;
    listenServer();
  } catch (error) {
    if (workersStarted) {
      await stopBackgroundWorkers();
    }
    logger.error(
      { component: 'startup', errorName: error && error.name, errorCode: error && error.code },
      'Application startup failed'
    );
    process.exitCode = 1;
  }
}

/**
 * Reports the server this process is currently listening with, if any.
 *
 * @returns {import('http').Server|null} The live server, or `null`.
 */
function getHttpServer() {
  return httpServer;
}

/**
 * Resets in-memory state by clearing shared cache stores for test isolation.
 *
 * This function safely clears both the main cache store and metrics cache store.
 * If either store is unavailable (e.g., in environments where the modules are not
 * loaded), the function continues silently to ensure test isolation without
 * breaking tests that don't require these stores.
 *
 * @returns {void}
 * @throws {Error} Never throws - all errors are caught and logged for observability.
 */
function resetStore() {
  const logger = require('./logger');
  
  try {
    const { getSharedStore } = require('./services/cacheStore');
    getSharedStore().clear();
  } catch (err) {
    // intentional no-op in environments where cacheStore is unavailable
    logger.debug({ err }, 'cacheStore clear failed (store unavailable)');
  }

  try {
    const { getMetricsCacheStore } = require('./services/metricsCacheStore');
    getMetricsCacheStore().clear();
  } catch (err) {
    // intentional no-op in environments where metricsCacheStore is unavailable
    logger.debug({ err }, 'metricsCacheStore clear failed (store unavailable)');
  }
}

/**
 * Gets the fencing token for a specific worker type.
 * Used by workers to validate their lease fencing.
 *
 * @param {string} workerType - The worker type (e.g., 'idempotencyPurge', 'invoiceStatePurge')
 * @returns {string|undefined} The fencing token, or undefined if not set
 */
function getFencingToken(workerType) {
  return startupState.fencingTokens.get(workerType);
}

/**
 * Resets startup state for test isolation.
 * @private
 */
function _resetStartupState() {
  startupState.isServerStarted = false;
  startupState.serverInstance = null;
  startupState.fencingTokens.clear();
}

const originalCreateApp = app.createApp;

/**
 * Returns the underlying Express app factory.
 *
 * This function provides a compatibility contract for tests and external consumers
 * that need to create fresh Express app instances. Options are forwarded to the
 * underlying app factory if it exists.
 *
 * @param {Object} [options] - Optional configuration options for the app factory.
 * @param {boolean} [options.enableTestRoutes] - If true, enables test-only routes.
 * @returns {import('express').Express} Configured Express app instance.
 * @throws {Error} May throw if the underlying app factory fails to initialize.
 */
function createApp(options) {
  if (typeof originalCreateApp === 'function') {
    return originalCreateApp(options);
  }
  return app;
}

// Start background workers when running as main module (not in tests)
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  // Generate and store fencing tokens for lease fencing
  const idempotencyFencingToken = crypto.randomUUID();
  const invoiceStateFencingToken = crypto.randomUUID();
  
  startupState.fencingTokens.set('idempotencyPurge', idempotencyFencingToken);
  startupState.fencingTokens.set('invoiceStatePurge', invoiceStateFencingToken);

  // Start the idempotency purge worker with a fresh fencing token so that stale
  // workers from a previous process can no longer write after lease loss.
  const { startPurgeWorker } = require('./jobs/idempotencyPurge');
  startPurgeWorker({ fencingToken: idempotencyFencingToken });

  // Start the invoice-state retention purge worker (issue #866) with its own
  // fencing token, isolated from the idempotency worker's token.
  const { startPurgeWorker: startInvoiceStatePurgeWorker } = require('./jobs/invoiceStatePurge');
  startInvoiceStatePurgeWorker({ fencingToken: invoiceStateFencingToken });

  // Start the escrow-read tombstone purge worker (issue #31). Hard-deletes
  // soft-deleted escrow_event_projection rows whose retention window has
  // elapsed, preventing unbounded tombstone accumulation.
  const { startPurgeWorker: startEscrowReadPurgeWorker } = require('./jobs/escrowReadPurge');
  startEscrowReadPurgeWorker();

  startServer();
}

/**
 * @module index
 * @description Entry point for the LiquiFact API server.
 *
 * @property {import('express').Express} default - The Express app instance.
 * @property {Function} createApp - Factory function to create Express app instances.
 * @property {Function} startServer - Function to start the HTTP server.
 * @property {Function} resetStore - Function to clear in-memory cache stores.
 */

module.exports = app;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
module.exports.startBackgroundWorkers = startBackgroundWorkers;
module.exports.resetStore = resetStore;
module.exports.getFencingToken = getFencingToken;
module.exports._resetStartupState = _resetStartupState;
