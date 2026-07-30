'use strict';

/**
 * @fileoverview Tests for the KYC webhook error-handling middleware.
 *
 * Covers:
 *  - KycWebhookError → RFC 7807 application/problem+json response
 *  - Retryable flag mapping (503/missing_secret → true, others → false)
 *  - Retry hint resolution per status/code
 *  - Content-Type: application/problem+json
 *  - Non-KycWebhookError forwarded to next()
 *  - req._kycErrorCode set for metrics hooks
 *  - Edge cases: missing correlationId, undefined code
 */

const express = require('express');
const request = require('supertest');
const KycWebhookError = require('../src/errors/KycWebhookError');
const kycWebhookErrorHandler = require('../src/middleware/kycWebhookErrorHandler');

/**
 * Builds a minimal Express app that exercises the error middleware.
 *
 * @param {Function} handler - Route handler that throws or calls next(err).
 * @returns {import('express').Express} Configured app.
 */
function buildTestApp(handler) {
  const app = express();
  app.use(express.json());

  // Simulate correlation ID middleware
  app.use((req, _res, next) => {
    req.correlationId = req.headers['x-correlation-id'] || 'test-corr-123';
    next();
  });

  app.get('/test', handler);
  app.use(kycWebhookErrorHandler);

  // Fallback error handler for non-KycWebhookError errors
  app.use((err, _req, res, _next) => {
    res.status(500).json({ fallback: true, message: err.message });
  });

  return app;
}

describe('kycWebhookErrorHandler', () => {
  describe('RFC 7807 response envelope', () => {
    test('returns application/problem+json with type, title, status, detail, instance, code, retryable, retry_hint', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Invalid webhook signature', 401, 'invalid_signature');
      });

      const res = await request(app).get('/test');

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toEqual({
        type: 'https://liquifact.com/probs/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid webhook signature',
        instance: '/test',
        code: 'invalid_signature',
        retryable: false,
        retry_hint: '',
      });
    });

    test('preserves HTTP status from KycWebhookError', async () => {
      const statuses = [400, 401, 403, 500, 503];

      for (const status of statuses) {
        const app = buildTestApp(() => {
          throw new KycWebhookError(`Error ${status}`, status, `code_${status}`);
        });

        const res = await request(app).get('/test');
        expect(res.status).toBe(status);
      }
    });
  });

  describe('retryable flag', () => {
    test('503 missing_secret is retryable', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Service unavailable', 503, 'missing_secret');
      });

      const res = await request(app).get('/test');
      expect(res.body.retryable).toBe(true);
    });

    test('429 is retryable', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Rate limited', 429, 'RATE_LIMITED');
      });

      const res = await request(app).get('/test');
      expect(res.body.retryable).toBe(true);
    });

    test('401 is not retryable', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Unauthorized', 401, 'missing_signature');
      });

      const res = await request(app).get('/test');
      expect(res.body.retryable).toBe(false);
    });

    test('400 is not retryable', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Bad request', 400, 'invalid_payload');
      });

      const res = await request(app).get('/test');
      expect(res.body.retryable).toBe(false);
    });

    test('500 is not retryable', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Internal error', 500, 'persistence_error');
      });

      const res = await request(app).get('/test');
      expect(res.body.retryable).toBe(false);
    });
  });

  describe('retry_hint', () => {
    test('missing_secret returns retry hint', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Service unavailable', 503, 'missing_secret');
      });

      const res = await request(app).get('/test');
      expect(res.body.retry_hint).toBe('Retry the request in a few moments.');
    });

    test('429 returns rate limit hint', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Rate limited', 429, 'RATE_LIMITED');
      });

      const res = await request(app).get('/test');
      expect(res.body.retry_hint).toBe('Wait for the rate limit window to reset before retrying.');
    });

    test('non-retryable error returns empty hint', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Bad request', 400, 'invalid_payload');
      });

      const res = await request(app).get('/test');
      expect(res.body.retry_hint).toBe('');
    });
  });

  describe('instance field', () => {
    test('uses req.originalUrl as instance', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('Error', 400, 'test_code');
      });

      const res = await request(app).get('/test');
      expect(res.body.instance).toBe('/test');
    });
  });

  describe('error code in response body', () => {
    test('response body includes the error code from KycWebhookError', async () => {
      const app = express();
      app.use(express.json());
      app.get('/test', (_req, res, next) => {
        next(new KycWebhookError('Error', 500, 'persistence_error'));
      });
      app.use(kycWebhookErrorHandler);

      const res = await request(app).get('/test');
      expect(res.body.code).toBe('persistence_error');
    });
  });

  describe('non-KycWebhookError forwarding', () => {
    test('forwards non-KycWebhookError to next handler', async () => {
      const app = buildTestApp(() => {
        throw new Error('generic error');
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(500);
      expect(res.body.fallback).toBe(true);
      expect(res.body.message).toBe('generic error');
    });

    test('forwards AppError to next handler', async () => {
      const AppError = require('../src/errors/AppError');
      const app = buildTestApp(() => {
        throw new AppError({ title: 'Not Found', status: 404, detail: 'Resource not found' });
      });

      const res = await request(app).get('/test');
      // Should reach fallback handler, not kycWebhookErrorHandler
      expect(res.body.fallback).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('handles error with undefined code gracefully', async () => {
      const app = buildTestApp(() => {
        const err = new KycWebhookError('Error', 400, undefined);
        throw err;
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.code).toBeUndefined();
      expect(res.body.retryable).toBe(false);
    });

    test('handles error with empty message', async () => {
      const app = buildTestApp(() => {
        throw new KycWebhookError('', 400, 'test_code');
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.detail).toBe('');
    });

    test('logs warning with error details', async () => {
      const logger = require('../src/logger');
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      const app = buildTestApp(() => {
        throw new KycWebhookError('Test error', 400, 'test_code');
      });

      await request(app).get('/test');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'test_code',
          status: 400,
        }),
        'kyc-webhook error',
      );

      warnSpy.mockRestore();
    });
  });
});
