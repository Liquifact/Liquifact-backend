'use strict';

/**
 * @fileoverview Coordinated graceful shutdown manager for the LiquiFact API.
 * Orchestrates the tear-down of external connections, services, and listeners.
 * 
 * Order of shutdown:
 * 1. Stop accepting new HTTP connections via server.close()
 * 2. Wait for in-flight requests to complete (naturally via close callback/active socket tracking)
 * 3. Call the registered worker.stop() to drain any in-flight background jobs
 * 4. Close the Knex DB connection pool from src/db/knex.js
 * 5. Exit cleanly with status 0 (or status 1 on timeout/failure)
 * 
 * @module utils/shutdownCoordinator
 */

const logger = require('../logger');
const db = require('../db/knex');

/**
 * @type {import('http').Server|null}
 * @private
 */
let serverInstance = null;

/**
 * @type {Object|null}
 * @private
 */
let registeredWorker = null;

/**
 * @type {boolean}
 * @private
 */
let isShuttingDown = false;

/**
 * @type {boolean}
 * @private
 */
let listenersRegistered = false;

/**
 * Registers the HTTP server and optional background worker for graceful shutdown.
 * 
 * @param {Object} params - The components to register.
 * @param {import('http').Server} [params.server] - The HTTP server instance to stop.
 * @param {Object} [params.worker] - Background worker instance to stop.
 * @returns {void}
 */
function register({ server, worker }) {
  if (server) {
    serverInstance = server;
  }
  if (worker) {
    registeredWorker = worker;
  }
}

/**
 * Triggers the coordinated graceful shutdown sequence.
 * This runs exactly once; subsequent invocations are ignored as duplicates.
 * 
 * @param {string} reason - The signal or event that initiated the shutdown (e.g. SIGTERM, SIGINT, timeout).
 * @returns {Promise<void>}
 */
async function executeShutdown(reason) {
  if (isShuttingDown) {
    logger.info({ reason }, '[shutdown] Shutdown already in progress. Ignoring duplicate request.');
    return;
  }

  isShuttingDown = true;
  logger.info({ reason }, `[shutdown] Starting coordinated graceful shutdown. Reason: ${reason}`);

  // Fetch timeout config
  let shutdownTimeoutMs = 10000;
  try {
    const config = require('../config');
    // Ensure we handle config that hasn't been initialized yet
    const currentConfig = config.get();
    shutdownTimeoutMs = currentConfig.SHUTDOWN_TIMEOUT_MS ?? 10000;
  } catch (_err) {
    // Fall back to env var directly or default to 10s
    shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10000;
  }

  // Set up a fail-safe forced exit timeout to prevent hanging indefinitely
  const forceExitTimeout = setTimeout(() => {
    logger.warn({ timeoutMs: shutdownTimeoutMs }, '[shutdown] Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, shutdownTimeoutMs);

  // Unref so the timer doesn't keep the Node.js event loop alive by itself
  if (typeof forceExitTimeout.unref === 'function') {
    forceExitTimeout.unref();
  }

  try {
    // Phase 1: Stop accepting new HTTP connections
    if (serverInstance) {
      logger.info('[shutdown] Phase 1: Closing HTTP server...');
      
      // Node 18.2+ allows closing idle HTTP keep-alive connections immediately
      if (typeof serverInstance.closeIdleConnections === 'function') {
        logger.info('[shutdown] Closing idle keep-alive connections...');
        serverInstance.closeIdleConnections();
      }

      await new Promise((resolve) => {
        serverInstance.close((err) => {
          if (err) {
            logger.error({ err }, '[shutdown] Error during HTTP server close');
          } else {
            logger.info('[shutdown] HTTP server stopped accepting connections.');
          }
          resolve();
        });
      });
    } else {
      logger.info('[shutdown] Phase 1: No HTTP server registered to close.');
    }

    // Phase 2: Wait for existing HTTP requests to finish (handled implicitly by serverInstance.close callback)
    logger.info('[shutdown] Phase 2: In-flight HTTP requests completed/drained.');

    // Phase 3: Call background worker stop
    if (registeredWorker && typeof registeredWorker.stop === 'function') {
      logger.info('[shutdown] Phase 3: Stopping registered background worker...');
      await registeredWorker.stop();
      logger.info('[shutdown] Background worker stopped successfully.');
    } else {
      logger.info('[shutdown] Phase 3: No background worker registered.');
    }

    // Phase 4: Close Knex pool
    if (db && typeof db.destroy === 'function') {
      logger.info('[shutdown] Phase 4: Closing Knex database connection pool...');
      await db.destroy();
      logger.info('[shutdown] Knex database connection pool closed successfully.');
    } else {
      logger.info('[shutdown] Phase 4: No Knex database connection pool to close.');
    }

    // Clear the fail-safe timeout
    clearTimeout(forceExitTimeout);

    logger.info('[shutdown] Coordinated graceful shutdown completed successfully.');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[shutdown] Error occurred during graceful shutdown');
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

/**
 * Registers signal listeners for SIGTERM and SIGINT on the process.
 * Does not register listeners when running under tests (NODE_ENV=test).
 * 
 * @returns {void}
 */
function setupSignalListeners() {
  if (listenersRegistered) {
    return;
  }

  // Do not automatically listen/intercept signals in test environment
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  process.on('SIGTERM', () => {
    executeShutdown('SIGTERM');
  });

  process.on('SIGINT', () => {
    executeShutdown('SIGINT');
  });

  listenersRegistered = true;
  logger.info('[shutdown] Coordinated shutdown signal listeners registered.');
}

/**
 * Helper to query the current shutdown state.
 * 
 * @returns {boolean} True if graceful shutdown is in progress.
 */
function getIsShuttingDown() {
  return isShuttingDown;
}

/**
 * Helper to reset state inside test suites.
 * @private
 */
function _resetState() {
  serverInstance = null;
  registeredWorker = null;
  isShuttingDown = false;
  listenersRegistered = false;
}

module.exports = {
  register,
  executeShutdown,
  setupSignalListeners,
  getIsShuttingDown,
  _resetState,
};
