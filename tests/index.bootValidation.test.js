'use strict';

/**
 * @fileoverview Validation-boundary tests for the process entry point (issue #1382).
 *
 * `src/index.js` is the only place where operator-controlled input becomes a
 * bound socket. `net.Server.listen()` treats a string that is not a valid
 * decimal port as a Unix socket path, so these tests pin the boundary that
 * turns that silent misbinding into a deterministic, diagnosable rejection.
 *
 * Coverage map:
 * - accepted input   : valid env values, valid explicit arguments, defaults
 * - rejected input   : malformed, out-of-range, wrong-typed, and hostile values
 * - duplicate submit : repeated/concurrent start, and slot release on close
 * - boundary values  : 1, 65535, 65536, 0, blank, leading zeros
 * - regression       : the four historical `PORT` misbindings, the fail-closed
 *                      boot gate, the previously-ignored `startServer(0)`
 *                      argument, and the absence of stray socket files
 * - compatibility    : `ConfigSchema.PORT` is never more permissive than the
 *                      entry-point boundary, and `src/server.js` shares it
 *
 * Run with: npx jest tests/index.bootValidation.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const indexModule = require('../src/index');
const logger = require('../src/logger');
const shutdownCoordinator = require('../src/utils/shutdownCoordinator');
const { ConfigSchema } = require('../src/config');
const {
  DEFAULT_PORT,
  MAX_LISTEN_PORT,
  PortValidationError,
  PORT_VALIDATION_CODES,
  describeValue,
  resolvePortFromEnv,
  validatePortArgument,
} = require('../src/config/listenPort');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

/** Servers handed out by the `app.listen` stub, so each test can release the slot. */
let createdServers = [];

/**
 * Builds a duck-typed stand-in for an `http.Server`.
 *
 * Tests substitute this for the real listener so no socket is bound, while the
 * `once` API is present so the production lifecycle hooks still attach.
 *
 * @returns {EventEmitter & { close: jest.Mock }} A fake server.
 */
function createFakeServer() {
  const server = new EventEmitter();
  server.close = jest.fn((cb) => {
    if (typeof cb === 'function') {
      cb();
    }
  });
  server.unref = jest.fn();
  createdServers.push(server);
  return server;
}

/**
 * Installs an `app.listen` stub and returns it.
 *
 * @param {Object} [impl] - Optional override implementation.
 * @returns {jest.SpyInstance} The `listen` spy.
 */
function stubListen(impl) {
  return jest
    .spyOn(indexModule, 'listen')
    .mockImplementation(impl || ((port) => {
      void port;
      return createFakeServer();
    }));
}

/**
 * Captures structured log calls for a level.
 *
 * @param {string} level - pino level to intercept.
 * @returns {jest.SpyInstance} The logger spy.
 */
function spyLog(level) {
  return jest.spyOn(logger, level).mockImplementation(() => {});
}

/**
 * Finds the first log payload carrying an event name.
 *
 * @param {jest.SpyInstance} spy - Logger spy.
 * @param {string} event - Expected `event` field.
 * @returns {Object|undefined} The matching payload.
 */
function payloadFor(spy, event) {
  const call = spy.mock.calls.find((args) => args[0] && args[0].event === event);
  return call ? call[0] : undefined;
}

beforeEach(() => {
  process.env = { ...originalEnv };
  // The suites must not inherit an ambient PORT (CI runners often set one).
  delete process.env.PORT;
  createdServers = [];
});

afterEach(() => {
  // Emitting 'close' is what a real server does on shutdown; it releases the
  // entry point's single-listener slot so the next test starts from scratch.
  createdServers.splice(0).forEach((server) => server.emit('close'));
  jest.restoreAllMocks();
  shutdownCoordinator._resetState();
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// 1. Environment boundary: accepted input
// ---------------------------------------------------------------------------

describe('resolvePortFromEnv — accepted input', () => {
  const accepted = [
    { value: undefined, expected: DEFAULT_PORT, why: 'absent variable uses the default' },
    { value: null, expected: DEFAULT_PORT, why: 'null uses the default' },
    { value: '', expected: DEFAULT_PORT, why: 'empty variable uses the default' },
    { value: '   ', expected: DEFAULT_PORT, why: 'blank variable uses the default' },
    { value: '3001', expected: 3001, why: 'the documented default, spelled out' },
    { value: '8080', expected: 8080, why: 'ordinary override' },
    { value: ' 8080 ', expected: 8080, why: 'surrounding blanks from shell quoting are tolerated' },
    { value: '03001', expected: 3001, why: 'leading zeros are unambiguous decimal, not an octal literal' },
  ];

  it.each(accepted)('$why — $value', ({ value, expected }) => {
    expect(resolvePortFromEnv(value)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. Environment boundary: rejected input
// ---------------------------------------------------------------------------

describe('resolvePortFromEnv — rejected input', () => {
  const rejected = [
    // The four values that used to bind the wrong thing silently.
    { value: 'not-a-port', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'typo would bind a Unix socket at ./not-a-port' },
    { value: '8080abc', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'trailing junk would bind a Unix socket at ./8080abc' },
    { value: '-1', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'negative would bind a Unix socket at ./-1' },
    { value: '0x1f', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'hex would silently move the service to TCP port 31' },
    { value: '+8080', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'explicit plus sign is not accepted' },
    { value: '3001.5', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'a fractional port is not a port' },
    { value: '1e3', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'exponent notation is not accepted' },
    { value: '0b11', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'binary literal is not accepted' },
    { value: '8 0 0 0', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'inner whitespace is not a port' },
    { value: 'undefined', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'the string "undefined" is not a port' },
    { value: 'null', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'the string "null" is not a port' },
    { value: 'Infinity', code: PORT_VALIDATION_CODES.PORT_FORMAT_INVALID, why: 'the string "Infinity" is not a port' },
    { value: '0', code: PORT_VALIDATION_CODES.PORT_BELOW_MINIMUM, why: 'an ephemeral port is never a valid deployment target' },
    { value: '65536', code: PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM, why: 'one above the last assignable port' },
    { value: '99999', code: PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM, why: 'clearly out of range' },
    { value: '9'.repeat(400), code: PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM, why: 'pathological length is rejected, not hung on' },
  ];

  it.each(rejected)('$why', ({ value, code }) => {
    expect(() => resolvePortFromEnv(value)).toThrow(PortValidationError);
    try {
      resolvePortFromEnv(value);
    } catch (err) {
      expect(err.code).toBe(code);
      expect(err.source).toBe('env');
    }
  });

  it('rejects a non-string injected into the environment position', () => {
    expect(() => resolvePortFromEnv(8080)).toThrow(PortValidationError);
    try {
      resolvePortFromEnv(8080);
    } catch (err) {
      expect(err.code).toBe(PORT_VALIDATION_CODES.PORT_TYPE_INVALID);
    }
  });

  it('never coerces: no rejected value resolves to a usable port', () => {
    for (const { value } of rejected) {
      let result;
      try {
        result = resolvePortFromEnv(value);
      } catch (_err) {
        result = undefined;
      }
      expect(result).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Explicit argument boundary
// ---------------------------------------------------------------------------

describe('validatePortArgument — explicit argument', () => {
  it('treats no override as no override', () => {
    expect(validatePortArgument(undefined)).toBeNull();
    expect(validatePortArgument(null)).toBeNull();
  });

  it('accepts 0 so callers can request an ephemeral port', () => {
    expect(validatePortArgument(0)).toBe(0);
  });

  it.each([1, 80, 3001, MAX_LISTEN_PORT])('accepts the valid port %i', (port) => {
    expect(validatePortArgument(port)).toBe(port);
  });

  const rejectedArgs = [
    { value: -1, code: PORT_VALIDATION_CODES.PORT_BELOW_MINIMUM, why: 'below the argument minimum' },
    { value: 1.5, code: PORT_VALIDATION_CODES.PORT_NOT_AN_INTEGER, why: 'fractional' },
    { value: 3001.0001, code: PORT_VALIDATION_CODES.PORT_NOT_AN_INTEGER, why: 'fractional below an integer' },
    { value: MAX_LISTEN_PORT + 1, code: PORT_VALIDATION_CODES.PORT_ABOVE_MAXIMUM, why: 'one above the last assignable port' },
    { value: NaN, code: PORT_VALIDATION_CODES.PORT_NOT_A_NUMBER, why: 'NaN' },
    { value: Infinity, code: PORT_VALIDATION_CODES.PORT_NOT_A_NUMBER, why: 'positive infinity' },
    { value: -Infinity, code: PORT_VALIDATION_CODES.PORT_NOT_A_NUMBER, why: 'negative infinity' },
    { value: '3001', code: PORT_VALIDATION_CODES.PORT_TYPE_INVALID, why: 'a string argument is a call-site bug, not an override' },
    { value: true, code: PORT_VALIDATION_CODES.PORT_TYPE_INVALID, why: 'boolean' },
    { value: [3001], code: PORT_VALIDATION_CODES.PORT_TYPE_INVALID, why: 'array' },
    { value: { port: 3001 }, code: PORT_VALIDATION_CODES.PORT_TYPE_INVALID, why: 'object' },
  ];

  it.each(rejectedArgs)('rejects $why', ({ value, code }) => {
    expect(() => validatePortArgument(value)).toThrow(PortValidationError);
    try {
      validatePortArgument(value);
    } catch (err) {
      expect(err.code).toBe(code);
      expect(err.source).toBe('argument');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Redaction and log-forging protection
// ---------------------------------------------------------------------------

describe('rejected values are safe to log', () => {
  it('strips newlines so a hostile PORT cannot forge a log line', () => {
    const hostile = '3001\r\nINFO forged log line';
    let message = '';
    try {
      resolvePortFromEnv(hostile);
    } catch (err) {
      message = err.message;
    }

    expect(message).not.toMatch(/[\r\n]/);
    expect(message).toContain('\\r\\n');
    expect(message).toContain('PORT');
  });

  it('truncates long values instead of echoing them whole', () => {
    const description = describeValue('a'.repeat(5000));
    expect(description.length).toBeLessThan(120);
    expect(description).toContain('…');
  });

  it('describes non-strings by type only, never by value', () => {
    const secret = { password: 'do-not-log-me' };
    expect(describeValue(secret)).toBe('object');
    expect(describeValue(secret)).not.toContain('do-not-log-me');
    expect(describeValue(() => secret)).toBe('function');
    expect(describeValue(Symbol('x'))).toBe('Symbol(x)');
    expect(describeValue(8080n)).toBe('8080');
    expect(describeValue(true)).toBe('true');
    expect(describeValue(null)).toBe('null');
    expect(describeValue(undefined)).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// 5. Compatibility invariant: never more permissive than ConfigSchema
// ---------------------------------------------------------------------------

describe('ConfigSchema.PORT compatibility', () => {
  /**
   * Runs the config schema over one PORT value.
   *
   * @param {string} value - Candidate PORT value.
   * @returns {boolean} Whether the schema accepts it.
   */
  function schemaAccepts(value) {
    const result = ConfigSchema.safeParse({
      NODE_ENV: 'test',
      JWT_SECRET: 'x'.repeat(32),
      PORT: value,
    });
    return result.success;
  }

  const values = ['1', '80', '3001', '65535', '0', '65536', '99999', '-1', '1.5', 'not-a-port', '0x1f', ' 8080 ', '03001'];

  it('accepts no value the schema would reject', () => {
    for (const value of values) {
      let accepted = true;
      try {
        resolvePortFromEnv(value);
      } catch (_err) {
        accepted = false;
      }
      if (accepted) {
        expect({ value, acceptedBySchema: schemaAccepts(value) }).toEqual({ value, acceptedBySchema: true });
      }
    }
  });

  it('treats a blank variable as unset, which the schema rejects as port 0', () => {
    // The one documented divergence: the entry point reads a blank PORT as
    // "unset" (preserving `process.env.PORT || 3001`), while
    // `z.coerce.number()` turns '' into 0 and fails the min(1) bound. In
    // production the schema rejects it at boot validation, so the default is
    // only reachable where that gate is skipped.
    expect(resolvePortFromEnv('')).toBe(DEFAULT_PORT);
    expect(schemaAccepts('')).toBe(false);
  });

  it('agrees with the schema on the numeric range it accepts', () => {
    for (const value of ['1', '3001', '65535']) {
      expect(schemaAccepts(value)).toBe(true);
    }
    for (const value of ['0', '65536', '99999']) {
      expect(schemaAccepts(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. startServer: accepted input
// ---------------------------------------------------------------------------

describe('startServer — accepted input', () => {
  it('binds the default port when PORT is absent', () => {
    const listen = stubListen();

    const server = indexModule.startServer();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(DEFAULT_PORT);
    expect(server).toBeTruthy();
  });

  it('binds a valid PORT from the environment', () => {
    process.env.PORT = '8080';
    const listen = stubListen();

    indexModule.startServer();

    expect(listen).toHaveBeenCalledWith(8080);
  });

  it('logs the resolved port with its source', () => {
    process.env.PORT = '8080';
    const info = spyLog('info');
    stubListen();

    indexModule.startServer();

    const payload = payloadFor(info, 'http_server_starting');
    expect(payload).toMatchObject({ component: 'entrypoint', port: 8080, source: 'env' });
  });

  it('registers the server with the shutdown coordinator', () => {
    const register = jest.spyOn(shutdownCoordinator, 'register');
    stubListen();

    const server = indexModule.startServer();

    expect(register).toHaveBeenCalledWith({ server });
  });

  it('exposes the running server as the process single listener', () => {
    expect(indexModule.getHttpServer()).toBeNull();
    stubListen();

    const server = indexModule.startServer();

    expect(indexModule.getHttpServer()).toBe(server);
  });

  it('accepts the highest assignable port', () => {
    const listen = stubListen();

    indexModule.startServer(MAX_LISTEN_PORT);

    expect(listen).toHaveBeenCalledWith(MAX_LISTEN_PORT);
  });

  it('lets an explicit argument override an unusable PORT', () => {
    // The argument is authoritative: a PORT meant for another deployment must
    // not block an in-process caller that asked for a specific port.
    process.env.PORT = 'not-a-port';
    const listen = stubListen();

    indexModule.startServer(0);

    expect(listen).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// 7. startServer: rejected input
// ---------------------------------------------------------------------------

describe('startServer — rejected input', () => {
  it('refuses to bind and leaves no stray socket file behind', () => {
    process.env.PORT = 'not-a-port';
    const listen = stubListen();

    expect(() => indexModule.startServer()).toThrow(PortValidationError);
    expect(listen).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(process.cwd(), 'not-a-port'))).toBe(false);
  });

  it('rejects PORT=0 because no proxy or health check can target it', () => {
    process.env.PORT = '0';
    const listen = stubListen();

    expect(() => indexModule.startServer()).toThrow(/at least 1/);
    expect(listen).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range PORT before binding', () => {
    process.env.PORT = '65536';
    const listen = stubListen();

    expect(() => indexModule.startServer()).toThrow(/between 1 and 65535/);
    expect(listen).not.toHaveBeenCalled();
  });

  it('rejects a string argument instead of coercing it', () => {
    const listen = stubListen();

    expect(() => indexModule.startServer('3001')).toThrow(PortValidationError);
    expect(listen).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range argument', () => {
    const listen = stubListen();

    expect(() => indexModule.startServer(70000)).toThrow(/between 0 and 65535/);
    expect(listen).not.toHaveBeenCalled();
  });

  it('leaves no side effect at all: no storage probe is scheduled', () => {
    process.env.PORT = 'not-a-port';
    stubListen();
    const storage = require('../src/services/storage');
    const probe = jest.spyOn(storage, 'runStartupStorageProbe');

    expect(() => indexModule.startServer()).toThrow(PortValidationError);

    expect(probe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. startServer: duplicate and concurrent submission
// ---------------------------------------------------------------------------

describe('startServer — duplicate submission', () => {
  it('binds once and returns the running server on a repeat call', () => {
    const listen = stubListen();
    const warn = spyLog('warn');

    const first = indexModule.startServer(0);
    const second = indexModule.startServer(8080);

    expect(listen).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(payloadFor(warn, 'http_server_start_ignored')).toMatchObject({ port: 8080 });
  });

  it('keeps the first server registered so shutdown can still close it', () => {
    const register = jest.spyOn(shutdownCoordinator, 'register');
    stubListen();

    const first = indexModule.startServer(0);
    indexModule.startServer(0);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ server: first });
  });

  it('releases the slot when the server closes, so a restart is possible', () => {
    const listen = stubListen();
    const first = indexModule.startServer(0);

    createdServers[0].emit('close');
    expect(indexModule.getHttpServer()).toBeNull();

    const second = indexModule.startServer(0);

    expect(listen).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 9. startServer: boundary values on a real socket
// ---------------------------------------------------------------------------

describe('startServer — real socket boundaries', () => {
  /**
   * Closes a server and waits for the close to settle.
   *
   * @param {import('http').Server} server - Server to close.
   * @returns {Promise<void>} Resolves once closed.
   */
  function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it('honours startServer(0) instead of silently binding the default port', async () => {
    // Regression: the argument used to be discarded, so this call bound 3001 and
    // collided with any other suite holding that port. Asserted end to end
    // because in-process callers depend on getting a usable listener back.
    const server = indexModule.startServer(0);
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      expect(address.port).toBeGreaterThan(0);
      expect(address.port).not.toBe(DEFAULT_PORT);

      // A real request over the bound socket. `/api` rather than `/health`,
      // whose instrumentation expects metric helpers that the test-wide
      // metrics mock does not provide.
      const response = await fetch(`http://127.0.0.1:${address.port}/api`);
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
    expect(indexModule.getHttpServer()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. startServer: failure-mode handling
// ---------------------------------------------------------------------------

describe('startServer — failure modes', () => {
  it('exits with a diagnosable log when the bind fails asynchronously', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const error = spyLog('error');
    stubListen();

    const server = indexModule.startServer(0);
    const bindError = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

    server.emit('error', bindError);

    expect(payloadFor(error, 'http_server_error')).toMatchObject({
      component: 'entrypoint',
      port: 0,
      errorCode: 'EADDRINUSE',
    });
    expect(exit).toHaveBeenCalledWith(1);
    // The slot is released so the process state matches reality.
    expect(indexModule.getHttpServer()).toBeNull();
  });

  it('does not log the raw bind error message', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const error = spyLog('error');
    stubListen();

    const server = indexModule.startServer(0);
    server.emit('error', new Error('listen EADDRINUSE 0.0.0.0:3001 with a very long trailing detail'));

    const serialized = JSON.stringify(error.mock.calls);
    expect(serialized).not.toContain('very long trailing detail');
  });

  it('rethrows a synchronous listen failure and stays retryable', () => {
    const boom = new Error('listen failed synchronously');
    const listen = stubListen(() => {
      throw boom;
    });
    const error = spyLog('error');

    expect(() => indexModule.startServer(0)).toThrow(boom);
    expect(payloadFor(error, 'http_server_bind_failed')).toMatchObject({ port: 0 });

    // The slot was never claimed, so a later attempt is still possible.
    listen.mockImplementation(() => createFakeServer());
    expect(indexModule.startServer(0)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 11. Boot gate: fail closed
// ---------------------------------------------------------------------------

describe('startServer — boot configuration gate', () => {
  /**
   * Boots a fresh copy of the entry point with a primed config module.
   *
   * `jest.isolateModules` gives the block its own module registry, so
   * `src/config` starts unvalidated. It is primed first, because
   * `src/app.js` reads the validated config while building the app.
   *
   * @param {Object} env - Environment applied after priming.
   * @param {Function} body - Receives `{ index, app, listen }`.
   * @returns {void}
   */
  function withIsolatedEntrypoint(env, body) {
    jest.isolateModules(() => {
      process.env = { ...originalEnv };
      delete process.env.PORT;

      const isolatedConfig = require('../src/config');
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'x'.repeat(32);
      isolatedConfig.validate();

      Object.assign(process.env, env);

      const app = require('../src/app');
      const listen = jest.spyOn(app, 'listen').mockImplementation(() => createFakeServer());
      const index = require('../src/index');

      body({ index, app, listen });
    });
  }

  it('does not listen when configuration is rejected', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    withIsolatedEntrypoint(
      { NODE_ENV: 'production', JWT_SECRET: 'too-short', PUBLIC_API_BASE_URL: 'https://api.example.com' },
      ({ index, listen }) => {
        // Regression: process.exit() was the only barrier, so a stubbed exit
        // let a rejected configuration reach app.listen().
        const server = index.startServer();

        expect(server).toBeUndefined();
        expect(exit).toHaveBeenCalledWith(1);
        expect(listen).not.toHaveBeenCalled();
      }
    );
  });

  it('redacts the offending value from the boot failure summary', () => {
    jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    withIsolatedEntrypoint(
      { NODE_ENV: 'production', JWT_SECRET: 'sup3r-s3cret-value', PUBLIC_API_BASE_URL: 'https://api.example.com' },
      ({ index }) => {
        index.startServer();
      }
    );

    const logged = consoleError.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('JWT_SECRET');
    expect(logged).not.toContain('sup3r-s3cret-value');
  });

  it('binds when configuration is accepted', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});

    withIsolatedEntrypoint(
      {
        NODE_ENV: 'production',
        JWT_SECRET: 'y'.repeat(32),
        PUBLIC_API_BASE_URL: 'https://api.liquifact.com',
        DATABASE_URL: 'postgres://user:pass@db.internal:5432/liquifact',
        PORT: '8080',
      },
      ({ index, listen }) => {
        expect(index.startServer()).toBeTruthy();
        expect(exit).not.toHaveBeenCalled();
        expect(listen).toHaveBeenCalledWith(8080);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Legacy entry point shares the same boundary
// ---------------------------------------------------------------------------

describe('src/server.js shares the listen boundary', () => {
  /**
   * Loads `src/server.js` in isolation with a stubbed listener.
   *
   * @param {Object} body - Receives the `listen` spy.
   * @returns {void}
   */
  function withLegacyServer(body) {
    jest.isolateModules(() => {
      process.env = { ...originalEnv };
      delete process.env.PORT;

      const isolatedConfig = require('../src/config');
      isolatedConfig.validate();

      const app = require('../src/app');
      const listen = jest.spyOn(app, 'listen').mockImplementation(() => createFakeServer());

      body({ app, listen });
    });
  }

  it('binds a valid PORT', () => {
    withLegacyServer(({ listen }) => {
      process.env.PORT = '8080';
      jest.spyOn(console, 'log').mockImplementation(() => {});

      expect(() => require('../src/server')).not.toThrow();
      expect(listen).toHaveBeenCalledTimes(1);
      expect(listen.mock.calls[0][0]).toBe(8080);
    });
  });

  it('refuses to bind an invalid PORT instead of creating a socket file', () => {
    withLegacyServer(({ listen }) => {
      process.env.PORT = 'not-a-port';

      // The error is asserted by name and code: `jest.isolateModules` builds a
      // second copy of listenPort.js, so class identity differs by design.
      let thrown;
      try {
        require('../src/server');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(thrown.name).toBe('PortValidationError');
      expect(thrown.code).toBe(PORT_VALIDATION_CODES.PORT_FORMAT_INVALID);
      expect(thrown.source).toBe('env');
      expect(listen).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(process.cwd(), 'not-a-port'))).toBe(false);
    });
  });

  it('uses the documented default when PORT is absent', () => {
    withLegacyServer(({ listen }) => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      require('../src/server');

      expect(listen.mock.calls[0][0]).toBe(DEFAULT_PORT);
    });
  });
});

// ---------------------------------------------------------------------------
// 13. No stray socket files, and the working tree is untouched
// ---------------------------------------------------------------------------

describe('filesystem safety', () => {
  it('creates no socket file for any rejected PORT value', () => {
    const cwd = process.cwd();
    for (const value of ['not-a-port', '8080abc', '-1', '0x1f']) {
      process.env.PORT = value;
      stubListen();
      expect(() => indexModule.startServer()).toThrow(PortValidationError);
      expect(fs.existsSync(path.join(cwd, value))).toBe(false);
    }
  });

  it('proves the underlying hazard: a raw net listener does create the file', () => {
    // Documents why the entry point must never hand an unvalidated string to
    // listen(): net treats a non-numeric string as a Unix socket path and
    // creates it in the working directory, with no error. Node removes the file
    // again when the server closes.
    const net = require('net');
    const target = path.join(os.tmpdir(), `liquifact-boundary-${process.pid}`);
    const raw = net.createServer();

    return new Promise((resolve, reject) => {
      raw.listen(target, () => {
        try {
          expect(fs.existsSync(target)).toBe(true);
        } catch (err) {
          reject(err);
          return;
        }
        raw.close(() => {
          try {
            expect(fs.existsSync(target)).toBe(false);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  });
});
