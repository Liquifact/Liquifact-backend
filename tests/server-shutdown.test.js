'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const { loadConfig, ConfigError } = require('../src/config');
const {
  createServer,
  shutdown,
  installSignalHandlers,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
} = require('../src/server');

/**
 * Helper to listen on an ephemeral port (0) and return the assigned port.
 * @param {import('http').Server} server
 * @returns {Promise<number>}
 */
function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

/**
 * Helper to perform an HTTP GET request to localhost.
 * @param {number} port
 * @param {string} path
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { Connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
  });
}

describe('Graceful server shutdown', () => {
  const silentLogger = { log: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    silentLogger.log.mockClear();
    silentLogger.error.mockClear();
  });

  describe('config validation for SHUTDOWN_TIMEOUT_MS', () => {
    it('defaults to 10000ms when unset', () => {
      const cfg = loadConfig({});
      expect(cfg.shutdownTimeoutMs).toBe(10000);
    });

    it('accepts a valid positive integer', () => {
      const cfg = loadConfig({ SHUTDOWN_TIMEOUT_MS: '2500' });
      expect(cfg.shutdownTimeoutMs).toBe(2500);
    });

    it.each(['0', '-100', 'abc', '12.5'])('rejects invalid SHUTDOWN_TIMEOUT_MS=%s', (val) => {
      expect(() => loadConfig({ SHUTDOWN_TIMEOUT_MS: val })).toThrow(ConfigError);
    });
  });

  describe('createServer', () => {
    it('configures keepAliveTimeout above typical 60s proxy idle and headersTimeout above keepAliveTimeout', () => {
      const app = express();
      const server = createServer(app);
      expect(server.keepAliveTimeout).toBe(DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
      expect(server.keepAliveTimeout).toBeGreaterThan(60000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    });
  });

  describe('SIGTERM draining and timeout enforcement', () => {
    it('closes the listener, drains an in-flight slow request, and exits 0 on SIGTERM', async () => {
      let releaseSlowRequest;
      let requestStartedResolve;
      const requestStarted = new Promise((r) => {
        requestStartedResolve = r;
      });

      const app = express();
      app.get('/slow', (_req, res) => {
        requestStartedResolve();
        releaseSlowRequest = () => {
          res.status(200).json({ ok: true });
        };
      });

      const server = createServer(app);
      const port = await listenEphemeral(server);

      const fakeProc = new EventEmitter();
      const exit = jest.fn();
      const uninstall = installSignalHandlers(server, {
        timeoutMs: 5000,
        exit,
        logger: silentLogger,
        proc: fakeProc,
      });

      // Start an in-flight slow request
      const slowReqPromise = httpGet(port, '/slow');
      await requestStarted;

      // Trigger SIGTERM while the request is still in-flight
      fakeProc.emit('SIGTERM');

      // New connections should be rejected once server.close() has been called
      await expect(httpGet(port, '/slow')).rejects.toThrow();

      // Server has not exited yet because the slow request is still active
      expect(exit).not.toHaveBeenCalled();

      // Finish the slow request and verify it completes cleanly
      releaseSlowRequest();
      const response = await slowReqPromise;
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });

      // Wait for shutdown to complete with exit code 0
      const code = await shutdown(server, { timeoutMs: 5000, exit, logger: silentLogger });
      expect(code).toBe(0);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);

      uninstall();
    });

    it('forces exit with code 1 when in-flight request exceeds SHUTDOWN_TIMEOUT_MS', async () => {
      let requestStartedResolve;
      const requestStarted = new Promise((r) => {
        requestStartedResolve = r;
      });

      const app = express();
      app.get('/hang', (_req, _res) => {
        // Intentionally never responds to simulate a stalled in-flight request
        requestStartedResolve();
      });

      const server = createServer(app);
      const port = await listenEphemeral(server);

      const hangReqPromise = httpGet(port, '/hang').catch((err) => err);
      await requestStarted;

      const exit = jest.fn();
      const code = await shutdown(server, {
        timeoutMs: 120,
        signal: 'SIGTERM',
        exit,
        logger: silentLogger,
      });

      expect(code).toBe(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);

      // Ensure the hanging client socket was closed/aborted by closeAllConnections
      const err = await hangReqPromise;
      expect(err).toBeTruthy();
      expect(err.code).toBe('ECONNRESET');
    });

    it('deduplicates repeated signals so exit is only called once', async () => {
      const app = express();
      const server = createServer(app);
      await listenEphemeral(server);

      const exit = jest.fn();
      const p1 = shutdown(server, { timeoutMs: 2000, signal: 'SIGTERM', exit, logger: silentLogger });
      const p2 = shutdown(server, { timeoutMs: 2000, signal: 'SIGINT', exit, logger: silentLogger });

      expect(p1).toBe(p2);
      const code = await p1;
      expect(code).toBe(0);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });

  describe('module import safety', () => {
    it('does not install SIGTERM or SIGINT handlers when src/index.js is imported', () => {
      const sigTermBefore = process.listenerCount('SIGTERM');
      const sigIntBefore = process.listenerCount('SIGINT');

      const importedApp = require('../src/index');
      expect(typeof importedApp).toBe('function');

      expect(process.listenerCount('SIGTERM')).toBe(sigTermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigIntBefore);
    });
  });
});
