'use strict';

/**
 * @fileoverview Focused failure-recovery tests for `src/app.js` (issue #1259).
 *
 * The base revision cannot boot the full application graph: several unrelated
 * modules contain pre-existing ReferenceErrors/SyntaxErrors. These tests
 * therefore exercise the terminal error handlers through the same Express
 * contracts the app uses, with the broken `logger` module replaced by a mock so
 * the failure paths can be driven deterministically.
 *
 * Covered failure classes:
 *   - blocked CORS origin            → documented 403 shape, stable on repeat
 *   - oversized body                 → documented 413 shape, stable on repeat
 *   - unhandled error (production)   → generic 500, no stack/secret leakage
 *   - status-bearing 4xx / 5xx error → stable shape, 5xx detail suppressed
 *   - malformed JSON                 → legacy 400 shape
 *   - already-committed response     → forwarded to Express (idempotent)
 */

jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

const express = require('express');
const request = require('supertest');
const cors = require('cors');

const {
  handleCorsError,
  handleInternalError,
} = require('./middleware/failureRecovery');
const {
  buildCorsOptions,
  CORS_REJECTION_MESSAGE,
  CORS_REJECTION_CODE,
} = require('./config/cors');
const {
  jsonBodyLimit,
  payloadTooLargeHandler,
} = require('./middleware/bodySizeLimits');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Runs `fn` with `process.env.NODE_ENV` temporarily set, then restores it.
 *
 * @param {string} nodeEnv - Value to assign to `NODE_ENV`.
 * @param {() => Promise<unknown>} fn - Async callback to run.
 * @returns {Promise<unknown>} Result of `fn`.
 */
async function withNodeEnv(nodeEnv, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}

/**
 * Builds a minimal app whose only error middleware is the CORS handler.
 *
 * @param {Record<string, string|undefined>} env - CORS-relevant environment.
 * @returns {import('express').Express} Express app.
 */
function buildCorsApp(env) {
  const app = express();
  app.use(cors(buildCorsOptions(env)));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use(handleCorsError);
  app.use(handleInternalError);
  return app;
}

/**
 * Builds an app with a JSON body limit and the shared 413 handler.
 *
 * @param {string} [limit='1kb'] - Body size limit under test.
 * @returns {import('express').Express} Express app.
 */
function buildBodyLimitApp(limit = '1kb') {
  const app = express();
  app.use(...jsonBodyLimit(limit, 'json'));
  app.post('/upload', (req, res) => res.json({ ok: true }));
  app.use(payloadTooLargeHandler);
  app.use(handleInternalError);
  return app;
}

/**
 * Builds an app whose route fails with the supplied error.
 *
 * @param {() => Error} errorFactory - Produces the error to throw.
 * @returns {import('express').Express} Express app.
 */
function buildFailingApp(errorFactory) {
  const app = express();
  app.get('/boom', (req, res, next) => next(errorFactory()));
  app.use(handleInternalError);
  return app;
}

/**
 * Builds a minimal Express-compatible response double with `headersSent: true`.
 *
 * @returns {object} Mock response recording `status`/`json` calls.
 */
function createCommittedResponse() {
  return {
    headersSent: true,
    locals: {},
    statusCalls: [],
    jsonCalls: [],
    status(code) {
      this.statusCalls.push(code);
      return this;
    },
    json(payload) {
      this.jsonCalls.push(payload);
      return this;
    },
  };
}

// ── CORS rejection ────────────────────────────────────────────────────────────

describe('failure recovery — blocked CORS origin', () => {
  const env = {
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  };

  it('returns the documented 403 shape for a blocked origin', async () => {
    const response = await request(buildCorsApp(env))
      .get('/health')
      .set('Origin', 'https://blocked.example.com');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: CORS_REJECTION_MESSAGE,
      code: CORS_REJECTION_CODE,
    });
  });

  it('produces the same body for repeated triggers', async () => {
    const app = buildCorsApp(env);
    const send = () =>
      request(app).get('/health').set('Origin', 'https://blocked.example.com');

    const first = await send();
    const second = await send();

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });

  it('forwards non-CORS errors to the next error handler', async () => {
    const app = express();
    app.get('/boom', (req, res, next) => next(new Error('unrelated failure')));
    app.use(handleCorsError);
    app.use(handleInternalError);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  it('flags blocked origins for observability', async () => {
    const res = { headersSent: false, locals: {}, status: () => res, json: () => res };
    const next = jest.fn();

    handleCorsError(
      { message: CORS_REJECTION_MESSAGE, code: CORS_REJECTION_CODE, isCorsOriginRejected: true },
      { id: 'req-1' },
      res,
      next
    );

    expect(res.locals.isCorsOriginRejected).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── Oversized body ────────────────────────────────────────────────────────────

describe('failure recovery — oversized body (413)', () => {
  it('returns the documented 413 shape', async () => {
    const response = await request(buildBodyLimitApp('1kb'))
      .post('/upload')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(4096) }));

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: 'Payload Too Large',
      message: expect.any(String),
      path: '/upload',
    });
    expect(response.body.limit).toBeDefined();
  });

  it('produces the same body for repeated triggers', async () => {
    const app = buildBodyLimitApp('1kb');
    const send = () =>
      request(app)
        .post('/upload')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ blob: 'x'.repeat(4096) }));

    const first = await send();
    const second = await send();

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });
});

// ── Unhandled / status-bearing errors ─────────────────────────────────────────

describe('failure recovery — internal errors', () => {
  it('returns a generic 500 without leaking message or stack in production', async () => {
    await withNodeEnv('production', async () => {
      const response = await request(
        buildFailingApp(() => new Error('SECRET_INTERNAL_DETAIL /etc/passwd'))
      ).get('/boom');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
      expect(JSON.stringify(response.body)).not.toContain('SECRET_INTERNAL_DETAIL');
      expect(response.body).not.toHaveProperty('error.stack');
    });
  });

  it('does not leak 5xx detail in production', async () => {
    await withNodeEnv('production', async () => {
      const response = await request(
        buildFailingApp(() => {
          const err = new Error('raw upstream failure');
          err.status = 502;
          err.code = 'UPSTREAM_FAILURE';
          err.detail = 'postgres://user:hunter2@db.internal';
          return err;
        })
      ).get('/boom');

      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: { code: 'UPSTREAM_FAILURE', message: 'Internal server error' },
      });
      expect(JSON.stringify(response.body)).not.toContain('hunter2');
      expect(JSON.stringify(response.body)).not.toContain('db.internal');
    });
  });

  it('preserves the message for status-bearing 4xx errors', async () => {
    await withNodeEnv('production', async () => {
      const response = await request(
        buildFailingApp(() => {
          const err = new Error('duplicate invoice');
          err.status = 409;
          err.code = 'CONFLICT';
          return err;
        })
      ).get('/boom');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: { code: 'CONFLICT', message: 'duplicate invoice' },
      });
    });
  });

  it('preserves the malformed-JSON 400 shape', async () => {
    const app = express();
    app.use(express.json());
    app.post('/upload', (req, res) => res.json({ ok: true }));
    app.use(handleInternalError);

    const response = await request(app)
      .post('/upload')
      .set('Content-Type', 'application/json')
      .send('{not valid json}');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Bad Request' });
  });

  it('produces stable responses for repeated unhandled failures', async () => {
    await withNodeEnv('production', async () => {
      const app = buildFailingApp(() => new Error('boom'));
      const first = await request(app).get('/boom');
      const second = await request(app).get('/boom');

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
    });
  });

  it('exposes message and stack only in development', async () => {
    await withNodeEnv('development', async () => {
      const response = await request(
        buildFailingApp(() => new Error('dev diagnostic'))
      ).get('/boom');

      expect(response.status).toBe(500);
      expect(response.body.error.message).toBe('dev diagnostic');
      expect(typeof response.body.error.stack).toBe('string');
    });
  });
});

// ── Termination / idempotency invariants ──────────────────────────────────────

describe('failure recovery — committed-response invariants', () => {
  it('forwards CORS errors when headers are already sent', () => {
    const err = { isCorsOriginRejected: true, code: 'CORS_ORIGIN_REJECTED' };
    const res = createCommittedResponse();
    const next = jest.fn();

    handleCorsError(err, { id: 'req-1' }, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCalls).toHaveLength(0);
    expect(res.jsonCalls).toHaveLength(0);
  });

  it('forwards internal errors when headers are already sent', () => {
    const err = new Error('late failure');
    const res = createCommittedResponse();
    const next = jest.fn();

    handleInternalError(err, { id: 'req-1' }, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCalls).toHaveLength(0);
    expect(res.jsonCalls).toHaveLength(0);
  });
});
