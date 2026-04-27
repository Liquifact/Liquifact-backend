/**
 * @fileoverview Test suite for RFC 7807 Problem Details middleware.
 * 
 * Tests comprehensive error handling scenarios including:
 * - RFC 7807 compliance (type, title, status, detail, instance)
 * - Content-Type negotiation (application/problem+json)
 * - Request correlation and instance handling
 * - Security (no stack traces in production)
 * - AppError vs generic Error handling
 * - HTTP status code mapping
 * - Logging behavior
 * 
 * @module tests/problems.test
 */

'use strict';

const request = require('supertest');
const express = require('express');
const AppError = require('../src/errors/AppError');
const {
  problemJsonHandler,
  createProblemJsonHandler,
  notFoundHandler,
  createProblemDetails,
  getProblemType,
  DEFAULT_PROBLEM_TYPE,
  LIQUifact_PROBLEM_BASE,
} = require('../src/middleware/problemJson');

describe('Problem JSON Middleware', () => {
  let app;
  let testLogger;

  beforeEach(() => {
    // Mock logger to capture log calls
    testLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };

    // Override logger module
    jest.doMock('../src/logger', () => testLogger);
  });

  afterEach(() => {
    jest.resetModules();
  });

  describe('getProblemType', () => {
    test('returns correct problem type for known status codes', () => {
      expect(getProblemType(400)).toBe(`${LIQUifact_PROBLEM_BASE}/bad-request`);
      expect(getProblemType(401)).toBe(`${LIQUifact_PROBLEM_BASE}/unauthorized`);
      expect(getProblemType(403)).toBe(`${LIQUifact_PROBLEM_BASE}/forbidden`);
      expect(getProblemType(404)).toBe(`${LIQUifact_PROBLEM_BASE}/not-found`);
      expect(getProblemType(409)).toBe(`${LIQUifact_PROBLEM_BASE}/conflict`);
      expect(getProblemType(422)).toBe(`${LIQUifact_PROBLEM_BASE}/unprocessable-entity`);
      expect(getProblemType(429)).toBe(`${LIQUifact_PROBLEM_BASE}/too-many-requests`);
      expect(getProblemType(500)).toBe(`${LIQUifact_PROBLEM_BASE}/internal-server-error`);
      expect(getProblemType(502)).toBe(`${LIQUifact_PROBLEM_BASE}/bad-gateway`);
      expect(getProblemType(503)).toBe(`${LIQUifact_PROBLEM_BASE}/service-unavailable`);
      expect(getProblemType(504)).toBe(`${LIQUifact_PROBLEM_BASE}/gateway-timeout`);
    });

    test('returns default problem type for unknown status codes', () => {
      expect(getProblemType(418)).toBe(DEFAULT_PROBLEM_TYPE);
      expect(getProblemType(999)).toBe(DEFAULT_PROBLEM_TYPE);
    });
  });

  describe('createProblemDetails', () => {
    test('creates minimal problem details', () => {
      const problem = createProblemDetails({
        status: 400,
        title: 'Bad Request',
      });

      expect(problem).toEqual({
        type: `${LIQUifact_PROBLEM_BASE}/bad-request`,
        title: 'Bad Request',
        status: 400,
      });
    });

    test('creates complete problem details', () => {
      const problem = createProblemDetails({
        type: 'https://example.com/probs/custom-error',
        title: 'Custom Error',
        status: 422,
        detail: 'Detailed error message',
        instance: 'urn:uuid:123e4567-e89b-12d3-a456-426614174000',
        requestId: 'req-123',
      });

      expect(problem).toEqual({
        type: 'https://example.com/probs/custom-error',
        title: 'Custom Error',
        status: 422,
        detail: 'Detailed error message',
        instance: 'urn:uuid:123e4567-e89b-12d3-a456-426614174000',
      });
    });

    test('uses requestId as instance when instance not provided', () => {
      const problem = createProblemDetails({
        status: 404,
        title: 'Not Found',
        requestId: 'req-456',
      });

      expect(problem.instance).toBe('urn:uuid:req-456');
    });

    test('handles missing optional fields gracefully', () => {
      const problem = createProblemDetails({
        status: 500,
      });

      expect(problem).toEqual({
        type: `${LIQUifact_PROBLEM_BASE}/internal-server-error`,
        title: 'An error occurred',
        status: 500,
      });
      expect(problem.detail).toBeUndefined();
      expect(problem.instance).toBeUndefined();
    });
  });

  describe('problemJsonHandler', () => {
    beforeEach(() => {
      app = express();
      
      // Add request ID middleware
      app.use((req, res, next) => {
        req.id = 'test-request-id';
        next();
      });

      // Add test route that throws errors
      app.get('/test-error', (req, res, next) => {
        next(new Error('Test error'));
      });

      app.get('/test-app-error', (req, res, next) => {
        next(new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid input data',
          instance: '/test-app-error',
          code: 'VALIDATION_FAILED',
          retryable: false,
          retryHint: 'Fix the input and try again',
        }));
      });

      app.get('/test-string-error', (req, res, next) => {
        next('String error');
      });

      // Add problem JSON handler
      app.use(problemJsonHandler);
    });

    test('handles generic Error with proper problem+json format', async () => {
      const response = await request(app)
        .get('/test-error')
        .expect(500);

      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      
      const problem = response.body;
      expect(problem).toMatchObject({
        type: `${LIQUifact_PROBLEM_BASE}/internal-server-error`,
        title: 'An internal server error occurred.',
        status: 500,
        detail: 'An internal server error occurred.',
        instance: 'urn:uuid:test-request-id',
      });
    });

    test('handles AppError with custom fields', async () => {
      const response = await request(app)
        .get('/test-app-error')
        .expect(400);

      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      
      const problem = response.body;
      expect(problem).toMatchObject({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invalid input data',
        instance: '/test-app-error',
        code: 'VALIDATION_FAILED',
        retryable: false,
        retry_hint: 'Fix the input and try again',
      });
    });

    test('handles string errors', async () => {
      const response = await request(app)
        .get('/test-string-error')
        .expect(500);

      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      
      const problem = response.body;
      expect(problem).toMatchObject({
        type: `${LIQUifact_PROBLEM_BASE}/internal-server-error`,
        title: 'An internal server error occurred.',
        status: 500,
        detail: 'An internal server error occurred.',
        instance: 'urn:uuid:test-request-id',
      });
    });

    test('uses x-request-id header when request.id is missing', async () => {
      const testApp = express();
      
      testApp.get('/test', (req, res, next) => {
        req.headers['x-request-id'] = 'header-request-id';
        next(new Error('Test'));
      });
      
      testApp.use(problemJsonHandler);

      const response = await request(testApp)
        .get('/test')
        .set('X-Request-ID', 'header-request-id')
        .expect(500);

      expect(response.body.instance).toBe('urn:uuid:header-request-id');
    });

    test('falls back to unknown when no request ID available', async () => {
      const testApp = express();
      
      testApp.get('/test', (req, res, next) => {
        next(new Error('Test'));
      });
      
      testApp.use(problemJsonHandler);

      const response = await request(testApp)
        .get('/test')
        .expect(500);

      expect(response.body.instance).toBe('urn:uuid:unknown');
    });
  });

  describe('notFoundHandler', () => {
    beforeEach(() => {
      app = express();
      app.use(notFoundHandler);
      app.use(problemJsonHandler);
    });

    test('creates 404 problem details for missing routes', async () => {
      const response = await request(app)
        .get('/nonexistent-route')
        .expect(404);

      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      
      const problem = response.body;
      expect(problem).toMatchObject({
        type: `${LIQUifact_PROBLEM_BASE}/not-found`,
        title: 'Not Found',
        status: 404,
        detail: 'The requested resource GET /nonexistent-route was not found.',
        instance: '/nonexistent-route',
      });
    });
  });

  describe('createProblemJsonHandler', () => {
    test('creates handler with custom options', () => {
      const customHandler = createProblemJsonHandler({
        problemBase: 'https://custom.example.com/probs',
        includeStackInDev: false,
      });

      expect(typeof customHandler).toBe('function');
    });

    test('uses default options when none provided', () => {
      const defaultHandler = createProblemJsonHandler();
      expect(typeof defaultHandler).toBe('function');
    });
  });

  describe('Logging Behavior', () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    test('logs client errors as warnings in development', async () => {
      process.env.NODE_ENV = 'development';
      
      app = express();
      app.use((req, res, next) => {
        req.id = 'test-req-id';
        next();
      });

      app.get('/client-error', (req, res, next) => {
        next(new AppError({
          type: 'https://liquifact.com/probs/bad-request',
          title: 'Bad Request',
          status: 400,
          detail: 'Client error',
        }));
      });

      app.use(problemJsonHandler);

      await request(app).get('/client-error').expect(400);

      expect(testLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'test-req-id',
          method: 'GET',
          url: '/client-error',
          err: expect.any(Error),
          stack: expect.any(String),
        }),
        'Client error: Client error'
      );
    });

    test('logs server errors as errors in development', async () => {
      process.env.NODE_ENV = 'development';
      
      app = express();
      app.use((req, res, next) => {
        req.id = 'test-req-id';
        next();
      });

      app.get('/server-error', (req, res, next) => {
        next(new Error('Server error'));
      });

      app.use(problemJsonHandler);

      await request(app).get('/server-error').expect(500);

      expect(testLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'test-req-id',
          method: 'GET',
          url: '/server-error',
          err: expect.any(Error),
          stack: expect.any(String),
        }),
        'Server error: Server error'
      );
    });

    test('logs safely in production without sensitive data', async () => {
      process.env.NODE_ENV = 'production';
      
      app = express();
      app.use((req, res, next) => {
        req.id = 'test-req-id';
        next();
      });

      app.get('/prod-error', (req, res, next) => {
        next(new AppError({
          type: 'https://liquifact.com/probs/internal-error',
          title: 'Internal Error',
          status: 500,
          detail: 'Production error',
          code: 'PROD_ERROR',
        }));
      });

      app.use(problemJsonHandler);

      await request(app).get('/prod-error').expect(500);

      expect(testLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'test-req-id',
          method: 'GET',
          url: '/prod-error',
          errorName: 'AppError',
          errorMessage: 'Production error',
          errorCode: 'PROD_ERROR',
        }),
        'Server error: Production error'
      );

      // Ensure no sensitive data is logged
      const logCall = testLogger.error.mock.calls[0][0];
      expect(logCall.err).toBeUndefined();
      expect(logCall.stack).toBeUndefined();
    });
  });

  describe('Error Mapping Integration', () => {
    beforeEach(() => {
      app = express();
      app.use((req, res, next) => {
        req.id = 'test-req-id';
        next();
      });

      // Test different error types that mapError handles
      app.get('/json-error', (req, res, next) => {
        const error = new Error('Malformed JSON');
        error.type = 'entity.parse.failed';
        error.status = 400;
        next(error);
      });

      app.get('/connection-error', (req, res, next) => {
        const error = new Error('Connection refused');
        error.code = 'ECONNREFUSED';
        next(error);
      });

      app.use(problemJsonHandler);
    });

    test('handles JSON parsing errors', async () => {
      const response = await request(app)
        .get('/json-error')
        .expect(400);

      expect(response.body).toMatchObject({
        type: `${LIQUifact_PROBLEM_BASE}/bad-request`,
        title: 'Malformed JSON request body.',
        status: 400,
        detail: 'Malformed JSON request body.',
        instance: 'urn:uuid:test-req-id',
      });
    });

    test('handles connection errors', async () => {
      const response = await request(app)
        .get('/connection-error')
        .expect(503);

      expect(response.body).toMatchObject({
        type: `${LIQUifact_PROBLEM_BASE}/service-unavailable`,
        title: 'A dependent service is temporarily unavailable.',
        status: 503,
        detail: 'A dependent service is temporarily unavailable.',
        instance: 'urn:uuid:test-req-id',
      });
    });
  });

  describe('RFC 7807 Compliance', () => {
    beforeEach(() => {
      app = express();
      app.use((req, res, next) => {
        req.id = 'rfc-test-id';
        next();
      });

      app.get('/rfc-test', (req, res, next) => {
        next(new AppError({
          type: 'https://example.com/probs/custom-problem',
          title: 'Custom Problem',
          status: 422,
          detail: 'A detailed explanation',
          instance: 'urn:uuid:specific-occurrence',
        }));
      });

      app.use(problemJsonHandler);
    });

    test('returns all required RFC 7807 fields', async () => {
      const response = await request(app)
        .get('/rfc-test')
        .expect(422);

      const problem = response.body;
      
      // Required fields according to RFC 7807
      expect(problem).toHaveProperty('type');
      expect(problem).toHaveProperty('title');
      expect(problem).toHaveProperty('status');
      expect(problem).toHaveProperty('detail');
      
      // Optional field
      expect(problem).toHaveProperty('instance');
      
      // Verify values
      expect(problem.type).toBe('https://example.com/probs/custom-problem');
      expect(problem.title).toBe('Custom Problem');
      expect(problem.status).toBe(422);
      expect(problem.detail).toBe('A detailed explanation');
      expect(problem.instance).toBe('urn:uuid:specific-occurrence');
    });

    test('sets correct Content-Type header', async () => {
      const response = await request(app)
        .get('/rfc-test')
        .expect(422);

      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    });

    test('type field is a valid URI or about:blank', async () => {
      const response = await request(app)
        .get('/test-error')
        .expect(500);

      const problem = response.body;
      expect(problem.type).toMatch(/^https:\/\/|urn:|about:blank/);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      app = express();
      app.use((req, res, next) => {
        req.id = 'edge-test-id';
        next();
      });

      app.use(problemJsonHandler);
    });

    test('handles null errors', async () => {
      app.get('/null-error', (req, res, next) => {
        next(null);
      });

      const response = await request(app)
        .get('/null-error')
        .expect(500);

      expect(response.body.status).toBe(500);
      expect(response.body.title).toBe('An internal server error occurred.');
    });

    test('handles undefined errors', async () => {
      app.get('/undefined-error', (req, res, next) => {
        next(undefined);
      });

      const response = await request(app)
        .get('/undefined-error')
        .expect(500);

      expect(response.body.status).toBe(500);
      expect(response.body.title).toBe('An internal server error occurred.');
    });

    test('handles errors without message property', async () => {
      app.get('/no-message-error', (req, res, next) => {
        next({ customProperty: 'value' });
      });

      const response = await request(app)
        .get('/no-message-error')
        .expect(500);

      expect(response.body.status).toBe(500);
      expect(response.body.title).toBe('An internal server error occurred.');
    });

    test('handles AppError with minimal fields', async () => {
      app.get('/minimal-app-error', (req, res, next) => {
        next(new AppError({ status: 400 }));
      });

      const response = await request(app)
        .get('/minimal-app-error')
        .expect(400);

      expect(response.body).toMatchObject({
        type: `${LIQUifact_PROBLEM_BASE}/bad-request`,
        title: 'Bad Request',
        status: 400,
        instance: 'urn:uuid:edge-test-id',
      });
    });
  });
});
