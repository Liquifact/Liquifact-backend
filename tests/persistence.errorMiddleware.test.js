'use strict';

/**
 * @fileoverview Tests for the shared persistence error-handling middleware
 * (issue #988).
 *
 * Coverage:
 *  - Unit tests for classifyPersistenceError
 *  - Unit tests for PERSISTENCE_CODE_TO_STATUS mapping
 *  - Integration: persistence route errors flow through middleware
 *  - Each error code maps consistently (400 for client errors, 500 for server)
 *  - Unknown errors fall through to next error handler
 *  - Non-error calls pass through
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-validation-purposes';

const express = require('express');
const request = require('supertest');

const {
  persistenceErrorHandler,
  classifyPersistenceError,
  PERSISTENCE_ERROR_CODES,
  PERSISTENCE_CODE_TO_STATUS,
} = require('../src/middleware/persistenceErrorHandler');

// ---------------------------------------------------------------------------
// Unit: classifyPersistenceError
// ---------------------------------------------------------------------------

describe('classifyPersistenceError', () => {
  test('returns known code from err.code', () => {
    const err = new Error('Invalid MIME type');
    err.code = 'INVALID_MIME_TYPE';
    expect(classifyPersistenceError(err)).toBe('INVALID_MIME_TYPE');
  });

  test('returns known code for FILE_TOO_LARGE', () => {
    const err = new Error('File too large');
    err.code = 'FILE_TOO_LARGE';
    expect(classifyPersistenceError(err)).toBe('FILE_TOO_LARGE');
  });

  test('returns known code for INVALID_TENANT_ID', () => {
    const err = new Error('Invalid tenant ID');
    err.code = 'INVALID_TENANT_ID';
    expect(classifyPersistenceError(err)).toBe('INVALID_TENANT_ID');
  });

  test('returns known code for INVALID_FILENAME', () => {
    const err = new Error('Invalid filename');
    err.code = 'INVALID_FILENAME';
    expect(classifyPersistenceError(err)).toBe('INVALID_FILENAME');
  });

  test('returns known code for INVALID_INVOICE_ID', () => {
    const err = new Error('Invalid invoice ID');
    err.code = 'INVALID_INVOICE_ID';
    expect(classifyPersistenceError(err)).toBe('INVALID_INVOICE_ID');
  });

  test('returns known code for INVALID_EXPIRY', () => {
    const err = new Error('Invalid expiry');
    err.code = 'INVALID_EXPIRY';
    expect(classifyPersistenceError(err)).toBe('INVALID_EXPIRY');
  });

  test('returns INTERNAL_SERVER_ERROR for unknown code', () => {
    const err = new Error('Something random');
    err.code = 'SOME_RANDOM_CODE';
    expect(classifyPersistenceError(err)).toBe(PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR);
  });

  test('returns INTERNAL_SERVER_ERROR for non-object error', () => {
    expect(classifyPersistenceError(null)).toBe(PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR);
    expect(classifyPersistenceError('string error')).toBe(PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR);
  });

  test('returns INTERNAL_SERVER_ERROR for error without code', () => {
    const err = new Error('Plain error');
    expect(classifyPersistenceError(err)).toBe(PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR);
  });
});

// ---------------------------------------------------------------------------
// Unit: PERSISTENCE_CODE_TO_STATUS mapping
// ---------------------------------------------------------------------------

describe('PERSISTENCE_CODE_TO_STATUS', () => {
  test('maps all client errors to 400', () => {
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.INVALID_MIME_TYPE]).toBe(400);
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.FILE_TOO_LARGE]).toBe(400);
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.INVALID_TENANT_ID]).toBe(400);
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.INVALID_FILENAME]).toBe(400);
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.INVALID_INVOICE_ID]).toBe(400);
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.INVALID_EXPIRY]).toBe(400);
  });

  test('maps INTERNAL_SERVER_ERROR to 500', () => {
    expect(PERSISTENCE_CODE_TO_STATUS[PERSISTENCE_ERROR_CODES.INTERNAL_SERVER_ERROR]).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Integration: middleware mounted on an Express app
// ---------------------------------------------------------------------------

describe('persistenceErrorHandler middleware (integration)', () => {
  /**
   * Builds a minimal Express app with the persistence error middleware.
   *
   * @param {Function} routeHandler - Handler that receives (req, res, next).
   * @returns {import('express').Express}
   */
  function buildApp(routeHandler) {
    const app = express();
    app.use(express.json());

    app.post('/test', (req, res, next) => {
      routeHandler(req, res, next);
    });

    app.use(persistenceErrorHandler);

    // Catch-all for errors that fall through
    app.use((err, req, res, _next) => {
      res.status(500).json({ error: 'Fallthrough handler: ' + err.message });
    });

    return app;
  }

  test('400 for INVALID_MIME_TYPE', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('Invalid MIME type: text/html');
      err.code = 'INVALID_MIME_TYPE';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid MIME type: text/html');
  });

  test('400 for FILE_TOO_LARGE', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('File size exceeds maximum');
      err.code = 'FILE_TOO_LARGE';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File size exceeds maximum');
  });

  test('400 for INVALID_TENANT_ID', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid tenant ID');
  });

  test('400 for INVALID_FILENAME', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('Invalid filename');
      err.code = 'INVALID_FILENAME';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });

  test('400 for INVALID_INVOICE_ID', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid invoice ID');
  });

  test('400 for INVALID_EXPIRY', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('Invalid expiry');
      err.code = 'INVALID_EXPIRY';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid expiry');
  });

  test('500 for unknown code falls through to next error handler', async () => {
    const app = buildApp((req, res, next) => {
      const err = new Error('Some random unexpected error');
      err.code = 'UNKNOWN_CODE';
      next(err);
    });

    const res = await request(app).post('/test').send({});
    // Should be caught by the fallthrough handler
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Fallthrough handler/);
  });

  test('non-error call passes through', async () => {
    const app = buildApp((req, res, next) => {
      // Simulate a successful handler that calls next() with no argument
      res.status(200).json({ ok: true });
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
