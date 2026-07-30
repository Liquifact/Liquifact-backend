'use strict';

const express = require('express');
const request = require('supertest');
const requestId = require('../../src/middleware/requestId');
const { correlationIdMiddleware } = require('../../src/middleware/correlationId');
const errorHandler = require('../../src/middleware/errorHandler');
const logger = require('../../src/logger');

describe('Observability Integration', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(requestId);
    app.use(correlationIdMiddleware);
    app.use((req, _res, next) => {
      jest.spyOn(req.log, 'error').mockImplementation(() => {});
      next();
    });

    app.get('/logger', (req, res) => {
      res.json({
        requestId: req.id,
        correlationId: req.correlationId,
        loggerBindings: req.log.bindings(),
      });
    });

    app.get('/boom', () => {
      throw new Error('boom');
    });

    app.use(errorHandler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should attach a request-scoped logger with the request and correlation ids', async () => {
    const response = await request(app)
      .get('/logger')
      .set('x-correlation-id', 'corr-123');

    expect(response.status).toBe(200);
    expect(response.body.requestId).toBe('corr-123');
    expect(response.body.correlationId).toBe('corr-123');
    expect(response.body.loggerBindings).toMatchObject({
      requestId: 'corr-123',
      correlationId: 'corr-123',
    });
  });

  it('should include the correlation id in error logging context', async () => {
    const response = await request(app)
      .get('/boom')
      .set('x-correlation-id', 'corr-456');

    expect(response.status).toBe(500);
    expect(response.body.error.correlation_id).toBe('corr-456');
  });
});
