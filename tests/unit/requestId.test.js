'use strict';

const requestId = require('../../src/middleware/requestId');
const { correlationIdMiddleware } = require('../../src/middleware/correlationId');

describe('Request ID Middleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      headers: {},
      header(name) {
        return this.headers[name.toLowerCase()];
      },
    };
    res = {
      setHeader: jest.fn(),
    };
    next = jest.fn();
  });

  it('should generate a new ID if none is present', () => {
    requestId(req, res, next);
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe('string');
    expect(req.correlationId).toBe(req.id);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(next).toHaveBeenCalled();
  });

  it('should attach a child logger scoped to the request id', () => {
    requestId(req, res, next);

    expect(req.log).toBeDefined();
    expect(req.log.bindings()).toMatchObject({ requestId: req.id, correlationId: req.id });
  });

  it('should reuse an existing X-Request-Id header', () => {
    const existingId = 'test-id-123';
    req.headers['x-request-id'] = existingId;

    requestId(req, res, next);

    expect(req.id).toBe(existingId);
    expect(req.correlationId).toBe(existingId);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', existingId);
    expect(next).toHaveBeenCalled();
  });

  it('should replace an invalid request id header with a generated id', () => {
    req.headers['x-request-id'] = 'bad id with spaces';

    requestId(req, res, next);

    expect(req.id).toBeDefined();
    expect(req.id).not.toBe('bad id with spaces');
    expect(req.correlationId).toBe(req.id);
    expect(req.log.bindings()).toMatchObject({ requestId: req.id, correlationId: req.id });
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(next).toHaveBeenCalled();
  });

  it('should reuse an existing request-id header (case insensitive/alternate)', () => {
    const existingId = 'alt-id-456';
    req.headers['request-id'] = existingId;

    requestId(req, res, next);

    expect(req.id).toBe(existingId);
    expect(req.correlationId).toBe(existingId);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', existingId);
    expect(next).toHaveBeenCalled();
  });

  it('should use a clean alternate request-id header when the primary alias is invalid', () => {
    req.headers['x-request-id'] = 'not valid';
    req.headers['request-id'] = 'alt-id-456';

    requestId(req, res, next);

    expect(req.id).toBe('alt-id-456');
    expect(req.correlationId).toBe('alt-id-456');
    expect(req.log.bindings()).toMatchObject({ requestId: 'alt-id-456', correlationId: 'alt-id-456' });
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'alt-id-456');
    expect(next).toHaveBeenCalled();
  });

  it('should propagate the correlation id into the request-scoped logger', () => {
    req.headers['x-correlation-id'] = 'corr-123';
    requestId(req, res, next);

    correlationIdMiddleware(req, res, next);

    expect(req.id).toBe('corr-123');
    expect(req.correlationId).toBe('corr-123');
    expect(req.log.bindings()).toMatchObject({ requestId: 'corr-123', correlationId: 'corr-123' });
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'corr-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'corr-123');
  });

  it('should prefer request-id aliases over a divergent correlation id', () => {
    req.headers['x-request-id'] = 'request-123';
    req.headers['x-correlation-id'] = 'correl-456';

    requestId(req, res, next);
    correlationIdMiddleware(req, res, next);

    expect(req.id).toBe('request-123');
    expect(req.correlationId).toBe('request-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'request-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'request-123');
  });

  it('should use a valid correlation id when request-id aliases are invalid', () => {
    req.headers['x-request-id'] = 'bad id with spaces';
    req.headers['request-id'] = 'bad.id.with.dots';
    req.headers['x-correlation-id'] = 'trace-789';

    requestId(req, res, next);
    correlationIdMiddleware(req, res, next);

    expect(req.id).toBe('trace-789');
    expect(req.correlationId).toBe('trace-789');
  });

  it('should reject short, dotted, oversized, and control-character ids', () => {
    const invalidValues = [
      'short',
      'id.with.dot',
      'a'.repeat(65),
      'clean-id\r\nforged',
      ['array-value'],
    ];

    for (const value of invalidValues) {
      expect(requestId.sanitizeRequestId(value)).toBeNull();
    }

    expect(requestId.sanitizeRequestId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('should let correlation middleware reuse an existing canonical correlation id', () => {
    req.id = 'invalid id with spaces';
    req.correlationId = 'correl-123';

    correlationIdMiddleware(req, res, next);

    expect(req.id).toBe('correl-123');
    expect(req.correlationId).toBe('correl-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'correl-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'correl-123');
  });

  it('should let correlation middleware generate a canonical id when none exists', () => {
    correlationIdMiddleware(req, res, next);

    expect(req.id).toMatch(/^req_[A-Za-z0-9]+$/);
    expect(req.correlationId).toBe(req.id);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', req.id);
  });

  it('should keep request-scoped loggers isolated between requests', () => {
    const firstReq = { headers: {}, header(name) { return this.headers[name.toLowerCase()]; } };
    const secondReq = { headers: {}, header(name) { return this.headers[name.toLowerCase()]; } };
    const firstRes = { setHeader: jest.fn() };
    const secondRes = { setHeader: jest.fn() };

    requestId(firstReq, firstRes, jest.fn());
    requestId(secondReq, secondRes, jest.fn());

    expect(firstReq.log).not.toBe(secondReq.log);
    expect(firstReq.log.bindings().requestId).not.toBe(secondReq.log.bindings().requestId);
  });
});
