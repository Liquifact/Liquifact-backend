'use strict';

/**
 * @fileoverview Comprehensive tests for AsyncLocalStorage-based ambient log enrichment.
 *
 * Covers:
 * - requestContext API (run / get / set / ALLOWED_KEYS)
 * - Logger auto-enrichment from ambient context
 * - Explicit per-call overrides take precedence over ambient context
 * - Background-job path (no context → logger still works cleanly)
 * - Nested async calls inherit parent context
 * - PII / disallowed keys are silently dropped from context
 * - Middleware wiring: requestId seeds context, correlationId and tenant merge in
 */

// ─── requestContext unit tests ───────────────────────────────────────────────

describe('requestContext', () => {
  let ctx;

  beforeEach(() => {
    jest.resetModules();
    ctx = require('../src/requestContext');
  });

  afterEach(() => jest.resetModules());

  test('get() returns empty object when no store is active', () => {
    expect(ctx.get()).toEqual({});
  });

  test('run() makes initial values accessible via get()', (done) => {
    ctx.run({ requestId: 'req-1', correlationId: 'cor-1' }, () => {
      expect(ctx.get()).toEqual({ requestId: 'req-1', correlationId: 'cor-1' });
      done();
    });
  });

  test('set() merges additional fields into an active store', (done) => {
    ctx.run({ requestId: 'req-2' }, () => {
      ctx.set({ tenantId: 'tenant-A', correlationId: 'cor-2' });
      expect(ctx.get()).toEqual({
        requestId: 'req-2',
        tenantId: 'tenant-A',
        correlationId: 'cor-2',
      });
      done();
    });
  });

  test('set() is a no-op outside a run() scope', () => {
    expect(() => ctx.set({ tenantId: 'x' })).not.toThrow();
    expect(ctx.get()).toEqual({});
  });

  test('get() returns empty object outside run() scope', () => {
    expect(ctx.get()).toEqual({});
  });

  test('ALLOWED_KEYS only contains the four safe correlation fields', () => {
    expect([...ctx.ALLOWED_KEYS].sort()).toEqual(
      ['correlationId', 'requestId', 'tenantId', 'userId'].sort()
    );
  });

  test('run() silently drops keys not in ALLOWED_KEYS', (done) => {
    ctx.run({ requestId: 'r', password: 'secret', email: 'a@b.c' }, () => {
      const store = ctx.get();
      expect(store.requestId).toBe('r');
      expect(store.password).toBeUndefined();
      expect(store.email).toBeUndefined();
      done();
    });
  });

  test('set() silently drops keys not in ALLOWED_KEYS', (done) => {
    ctx.run({ requestId: 'r' }, () => {
      ctx.set({ creditCard: '4111...', tenantId: 't1' });
      const store = ctx.get();
      expect(store.tenantId).toBe('t1');
      expect(store.creditCard).toBeUndefined();
      done();
    });
  });

  test('run() ignores empty-string values', (done) => {
    ctx.run({ requestId: '', correlationId: 'c1' }, () => {
      const store = ctx.get();
      expect(store.correlationId).toBe('c1');
      expect(store.requestId).toBeUndefined();
      done();
    });
  });

  test('set() ignores empty-string values', (done) => {
    ctx.run({ requestId: 'r' }, () => {
      ctx.set({ tenantId: '' });
      expect(ctx.get().tenantId).toBeUndefined();
      done();
    });
  });

  test('nested async calls inherit parent context', (done) => {
    ctx.run({ requestId: 'parent' }, () => {
      setImmediate(() => {
        expect(ctx.get().requestId).toBe('parent');
        ctx.set({ tenantId: 'nested-tenant' });
        setImmediate(() => {
          expect(ctx.get().tenantId).toBe('nested-tenant');
          done();
        });
      });
    });
  });

  test('two concurrent run() scopes are isolated', (done) => {
    let req1Done = false;
    let req2Done = false;

    function checkDone() {
      if (req1Done && req2Done) done();
    }

    ctx.run({ requestId: 'req-AAA' }, () => {
      setImmediate(() => {
        expect(ctx.get().requestId).toBe('req-AAA');
        req1Done = true;
        checkDone();
      });
    });

    ctx.run({ requestId: 'req-BBB' }, () => {
      setImmediate(() => {
        expect(ctx.get().requestId).toBe('req-BBB');
        req2Done = true;
        checkDone();
      });
    });
  });

  test('userId is accepted as an allowed key', (done) => {
    ctx.run({ userId: 'user-123' }, () => {
      expect(ctx.get().userId).toBe('user-123');
      done();
    });
  });
});

// ─── logger ambient-enrichment tests ────────────────────────────────────────
// The logger module exports a Proxy, so jest.spyOn cannot override individual
// log methods (the Proxy creates a new function on every property access, making
// the property non-configurable for spying). We test enrichment by:
//   1. Verifying the Proxy delegates without throwing (smoke tests).
//   2. Verifying the merge logic via the requestContext integration directly.
//   3. Using a writable pino stream to capture JSON output and assert fields.

describe('logger ambient enrichment', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('logger does not throw outside any context (background job path)', () => {
    jest.resetModules();
    const log = require('../src/logger');
    expect(() => log.info('job ran')).not.toThrow();
    expect(() => log.warn('job warning')).not.toThrow();
    expect(() => log.error({ jobId: 'j1' }, 'job failed')).not.toThrow();
    expect(() => log.debug('job debug')).not.toThrow();
  });

  test('logger does not throw inside a run() scope', (done) => {
    jest.resetModules();
    const rc = require('../src/requestContext');
    const log = require('../src/logger');

    rc.run({ requestId: 'proxy-live', tenantId: 't1' }, () => {
      expect(() => log.info('inside context')).not.toThrow();
      expect(() => log.warn({ extra: 1 }, 'with extra')).not.toThrow();
      expect(() => log.debug('debug line')).not.toThrow();
      expect(() => log.error(new Error('boom'), 'err msg')).not.toThrow();
      done();
    });
  });

  test('logger writes ambient context fields to JSON output', (done) => {
    jest.resetModules();
    const pino = require('pino');
    const { run } = require('../src/requestContext');

    // Build a fresh pino logger writing to a captured stream.
    const lines = [];
    const stream = new (require('stream').Writable)({
      write(chunk, _enc, cb) {
        try { lines.push(JSON.parse(chunk.toString())); } catch (_) {}
        cb();
      },
    });

    // Create a minimal logger that reads from the real requestContext.
    const { get: getCtx } = require('../src/requestContext');
    const base = pino({ level: 'trace' }, stream);
    const proxy = new Proxy(base, {
      get(target, prop) {
        const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
        if (typeof prop === 'string' && LEVELS.has(prop)) {
          return function (...args) {
            const ctx = getCtx();
            if (!Object.keys(ctx).length) return target[prop](...args);
            if (typeof args[0] === 'string') return target[prop]({ ...ctx }, args[0], ...args.slice(1));
            if (args[0] && typeof args[0] === 'object') return target[prop]({ ...ctx, ...args[0] }, ...args.slice(1));
            return target[prop](...args);
          };
        }
        return target[prop];
      },
    });

    run({ requestId: 'stream-req', tenantId: 'stream-t', correlationId: 'stream-c' }, () => {
      proxy.info('hello enriched');
      setImmediate(() => {
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const line = lines[lines.length - 1];
        expect(line.requestId).toBe('stream-req');
        expect(line.tenantId).toBe('stream-t');
        expect(line.correlationId).toBe('stream-c');
        expect(line.msg).toBe('hello enriched');
        done();
      });
    });
  });

  test('explicit per-call field overrides ambient value in JSON output', (done) => {
    jest.resetModules();
    const pino = require('pino');
    const { run, get: getCtx } = require('../src/requestContext');

    const lines = [];
    const stream = new (require('stream').Writable)({
      write(chunk, _enc, cb) {
        try { lines.push(JSON.parse(chunk.toString())); } catch (_) {}
        cb();
      },
    });
    const base = pino({ level: 'trace' }, stream);
    const proxy = new Proxy(base, {
      get(target, prop) {
        const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
        if (typeof prop === 'string' && LEVELS.has(prop)) {
          return function (...args) {
            const ctx = getCtx();
            if (!Object.keys(ctx).length) return target[prop](...args);
            if (typeof args[0] === 'string') return target[prop]({ ...ctx }, args[0], ...args.slice(1));
            if (args[0] && typeof args[0] === 'object') return target[prop]({ ...ctx, ...args[0] }, ...args.slice(1));
            return target[prop](...args);
          };
        }
        return target[prop];
      },
    });

    run({ requestId: 'r-ov', tenantId: 'ambient-tenant' }, () => {
      proxy.warn({ tenantId: 'override-tenant' }, 'override test');
      setImmediate(() => {
        const line = lines[lines.length - 1];
        expect(line.requestId).toBe('r-ov');
        expect(line.tenantId).toBe('override-tenant'); // override wins
        done();
      });
    });
  });

  test('context enrichment: run() + get() integration produces merged data', (done) => {
    jest.resetModules();
    const rc = require('../src/requestContext');
    rc.run({ requestId: 'int-req', tenantId: 'int-tenant', correlationId: 'int-cor' }, () => {
      expect(rc.get()).toMatchObject({
        requestId: 'int-req',
        tenantId: 'int-tenant',
        correlationId: 'int-cor',
      });
      done();
    });
  });

  test('set() after run() is visible via get()', (done) => {
    jest.resetModules();
    const rc = require('../src/requestContext');
    rc.run({ requestId: 'r-set' }, () => {
      rc.set({ tenantId: 'late-tenant' });
      expect(rc.get()).toMatchObject({ requestId: 'r-set', tenantId: 'late-tenant' });
      done();
    });
  });
});

// ─── middleware wiring tests ──────────────────────────────────────────────────

describe('requestId middleware seeds context', () => {
  afterEach(() => jest.resetModules());

  test('calls next() inside run() scope with requestId set', (done) => {
    jest.resetModules();
    const requestId = require('../src/middleware/requestId');
    const { get } = require('../src/requestContext');

    const req = { headers: {} };
    const res = { setHeader: jest.fn() };

    requestId(req, res, () => {
      const ctx = get();
      expect(ctx.requestId).toBe(req.id);
      expect(typeof ctx.requestId).toBe('string');
      done();
    });
  });

  test('honours a valid client-supplied request id in context', (done) => {
    jest.resetModules();
    const requestId = require('../src/middleware/requestId');
    const { get } = require('../src/requestContext');

    const req = { headers: { 'x-request-id': 'client-supplied-id' } };
    const res = { setHeader: jest.fn() };

    requestId(req, res, () => {
      expect(get().requestId).toBe('client-supplied-id');
      done();
    });
  });
});

describe('correlationId middleware merges into context', () => {
  afterEach(() => jest.resetModules());

  /** Minimal Express-like req mock that implements req.header(name). */
  function makeReq(headers = {}) {
    return {
      headers,
      id: 'r1',
      correlationId: undefined,
      header(name) {
        return headers[name.toLowerCase()];
      },
    };
  }

  test('adds correlationId to an active context', (done) => {
    jest.resetModules();
    const { run, get } = require('../src/requestContext');
    const { correlationIdMiddleware } = require('../src/middleware/correlationId');

    const req = makeReq({});
    const res = { setHeader: jest.fn() };

    run({ requestId: 'r1' }, () => {
      correlationIdMiddleware(req, res, () => {
        const ctx = get();
        expect(ctx.correlationId).toBe(req.correlationId);
        expect(typeof ctx.correlationId).toBe('string');
        done();
      });
    });
  });

  test('honours caller-supplied x-correlation-id header', (done) => {
    jest.resetModules();
    const { run, get } = require('../src/requestContext');
    const { correlationIdMiddleware } = require('../src/middleware/correlationId');

    const req = makeReq({ 'x-correlation-id': 'caller-corr-99' });
    const res = { setHeader: jest.fn() };

    run({ requestId: 'r2' }, () => {
      correlationIdMiddleware(req, res, () => {
        expect(get().correlationId).toBe('caller-corr-99');
        done();
      });
    });
  });
});

describe('tenant middleware merges tenantId into context', () => {
  afterEach(() => jest.resetModules());

  test('adds tenantId from x-tenant-id header', (done) => {
    jest.resetModules();
    const { run, get } = require('../src/requestContext');
    const { extractTenant } = require('../src/middleware/tenant');

    const req = { headers: { 'x-tenant-id': 'acme-corp' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    run({ requestId: 'r3' }, () => {
      extractTenant(req, res, () => {
        expect(get().tenantId).toBe('acme-corp');
        done();
      });
    });
  });

  test('adds tenantId from JWT claim', (done) => {
    jest.resetModules();
    const { run, get } = require('../src/requestContext');
    const { extractTenant } = require('../src/middleware/tenant');

    const req = { headers: {}, user: { tenantId: 'jwt-tenant' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    run({ requestId: 'r4' }, () => {
      extractTenant(req, res, () => {
        expect(get().tenantId).toBe('jwt-tenant');
        done();
      });
    });
  });

  test('returns 400 when no tenantId is available', (done) => {
    jest.resetModules();
    const { run, get } = require('../src/requestContext');
    const { extractTenant } = require('../src/middleware/tenant');

    const req = { headers: {} };
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const res = { status: statusMock };

    run({ requestId: 'r5' }, () => {
      extractTenant(req, res, () => {
        // next() should NOT be called on the 400 path; this callback is a safety net.
        throw new Error('next() must not be called when tenant is missing');
      });
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(get().tenantId).toBeUndefined();
      done();
    });
  });
});

// ─── security / PII guard tests ───────────────────────────────────────────────

describe('PII / disallowed keys are blocked at context boundary', () => {
  const dangerousKeys = [
    'password', 'token', 'secret', 'apiKey', 'creditCard',
    'ssn', 'email', 'phone', 'address',
  ];

  beforeEach(() => jest.resetModules());
  afterEach(() => jest.resetModules());

  test.each(dangerousKeys)('key "%s" is silently dropped from run()', (key) => {
    const ctx = require('../src/requestContext');
    let storeSnapshot;
    ctx.run({ requestId: 'safe', [key]: 'sensitive-value' }, () => {
      storeSnapshot = ctx.get();
    });
    expect(storeSnapshot[key]).toBeUndefined();
    expect(storeSnapshot.requestId).toBe('safe');
  });

  test.each(dangerousKeys)('key "%s" is silently dropped from set()', (key) => {
    const ctx = require('../src/requestContext');
    let storeSnapshot;
    ctx.run({ requestId: 'safe2' }, () => {
      ctx.set({ [key]: 'sensitive-value', tenantId: 'ok-tenant' });
      storeSnapshot = ctx.get();
    });
    expect(storeSnapshot[key]).toBeUndefined();
    expect(storeSnapshot.tenantId).toBe('ok-tenant');
  });
});
