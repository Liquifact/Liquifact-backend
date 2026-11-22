'use strict';

const http = require('http');

// Tuned above typical load-balancer / reverse-proxy idle timeouts (commonly 60s)
// to avoid premature ECONNRESET races on keep-alive connections.
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65000;
const DEFAULT_HEADERS_TIMEOUT_MS = 66000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

const activeShutdowns = new WeakMap();

/**
 * Creates an HTTP server for the given Express app with keep-alive timeouts
 * tuned above typical proxy idle limits.
 *
 * @param {import('http').RequestListener} app
 * @param {object} [options]
 * @param {number} [options.keepAliveTimeoutMs]
 * @param {number} [options.headersTimeoutMs]
 * @returns {import('http').Server}
 */
function createServer(app, options = {}) {
  const server = http.createServer(app);
  const keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  const headersTimeoutMs = options.headersTimeoutMs ?? Math.max(DEFAULT_HEADERS_TIMEOUT_MS, keepAliveTimeoutMs + 1000);

  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = headersTimeoutMs;

  return server;
}

/**
 * Gracefully shuts down an HTTP server: stops accepting new connections,
 * waits for in-flight requests to finish up to `timeoutMs`, and exits with
 * code 0 on clean drain or code 1 on timeout / close error.
 *
 * Repeated calls on the same server return the same in-flight shutdown promise.
 *
 * @param {import('http').Server} server
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {string} [options.signal='SIGTERM']
 * @param {(code: number) => void} [options.exit=process.exit]
 * @param {{ log?: Function, error?: Function }} [options.logger=console]
 * @returns {Promise<number>} resolves with the exit code (0 or 1)
 */
function shutdown(server, options = {}) {
  const existing = activeShutdowns.get(server);
  if (existing) {
    return existing;
  }

  const {
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    signal = 'SIGTERM',
    exit = process.exit,
    logger = console,
  } = options;

  const promise = new Promise((resolve) => {
    let settled = false;

    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      exit(code);
      resolve(code);
    };

    const timer = setTimeout(() => {
      if (logger && typeof logger.error === 'function') {
        logger.error(
          `[shutdown] Forced exit after ${timeoutMs}ms timeout waiting for in-flight requests (${signal})`,
        );
      }
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      finish(1);
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    if (logger && typeof logger.log === 'function') {
      logger.log(`[shutdown] Received ${signal}, draining in-flight requests (timeout ${timeoutMs}ms)...`);
    }

    server.close((err) => {
      if (settled) {
        return;
      }
      if (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('[shutdown] Error closing server:', err);
        }
        finish(1);
        return;
      }
      if (logger && typeof logger.log === 'function') {
        logger.log('[shutdown] Server closed cleanly.');
      }
      finish(0);
    });

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });

  activeShutdowns.set(server, promise);
  return promise;
}

/**
 * Installs SIGTERM and SIGINT handlers that trigger graceful shutdown.
 * Returns an unsubscribe function to remove the handlers.
 *
 * @param {import('http').Server} server
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {(code: number) => void} [options.exit=process.exit]
 * @param {{ log?: Function, error?: Function }} [options.logger=console]
 * @param {NodeJS.Process} [options.proc=process]
 * @returns {() => void}
 */
function installSignalHandlers(server, options = {}) {
  const proc = options.proc || process;

  const onSigTerm = () => {
    shutdown(server, { ...options, signal: 'SIGTERM' });
  };
  const onSigInt = () => {
    shutdown(server, { ...options, signal: 'SIGINT' });
  };

  proc.on('SIGTERM', onSigTerm);
  proc.on('SIGINT', onSigInt);

  return () => {
    proc.off('SIGTERM', onSigTerm);
    proc.off('SIGINT', onSigInt);
  };
}

module.exports = {
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createServer,
  shutdown,
  installSignalHandlers,
};
