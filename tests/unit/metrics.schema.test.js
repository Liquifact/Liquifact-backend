'use strict';

/**
 * @fileoverview Comprehensive unit tests for src/schemas/metrics.js
 *
 * Covers:
 *  - getMetricsQuerySchema — query param validation for GET /api/sme/metrics
 *  - bulkMetricsOperationSchema — per-item bulk request validation
 *  - bulkMetricsSchema — full bulk request body validation
 *  - Response schemas: smeMetricsDataSchema, smeMetricsMetaSchema,
 *    smeMetricsApiResponseSchema, bulkMetricsResponseSchema
 *  - validateGetMetricsQuery middleware
 *  - validateBulkMetricsBody middleware
 *  - validateSmeMetricsApiResponse / validateBulkMetricsResponse helpers
 *  - Constants: MAX_BULK_OPERATIONS, GET_METRICS_LIMIT_MIN, GET_METRICS_LIMIT_MAX
 */

const {
  getMetricsQuerySchema,
  bulkMetricsOperationSchema,
  bulkMetricsSchema,
  smeMetricsDataSchema,
  smeMetricsMetaBaseSchema,
  smeMetricsMetaSchema,
  smeMetricsApiResponseSchema,
  bulkMetricsResultItemSchema,
  bulkMetricsResponseSchema,
  validateGetMetricsQuery,
  validateBulkMetricsBody,
  validateSmeMetricsApiResponse,
  validateBulkMetricsResponse,
  parseValidationErrors,
  MAX_BULK_OPERATIONS,
  GET_METRICS_LIMIT_MIN,
  GET_METRICS_LIMIT_MAX,
} = require('../../src/schemas/metrics');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _statusCode: null,
    _body: undefined,
    status: jest.fn(function (code) { this._statusCode = code; return this; }),
    json: jest.fn(function (body) { this._body = body; return this; }),
  };
  return res;
}

function makeNext() {
  return jest.fn();
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_BULK_OPERATIONS is 25', () => {
    expect(MAX_BULK_OPERATIONS).toBe(25);
  });

  it('GET_METRICS_LIMIT_MIN is 1', () => {
    expect(GET_METRICS_LIMIT_MIN).toBe(1);
  });

  it('GET_METRICS_LIMIT_MAX is 100', () => {
    expect(GET_METRICS_LIMIT_MAX).toBe(100);
  });
});

// ── getMetricsQuerySchema ─────────────────────────────────────────────────────

describe('getMetricsQuerySchema', () => {
  describe('valid inputs', () => {
    it('parses empty query object successfully', () => {
      const result = getMetricsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
    });

    it('parses cursor-only query', () => {
      const result = getMetricsQuerySchema.safeParse({ cursor: 'abc123' });
      expect(result.success).toBe(true);
      expect(result.data.cursor).toBe('abc123');
    });

    it('parses limit-only query and coerces to integer', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '10' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(10);
    });

    it('parses both cursor and limit together', () => {
      const result = getMetricsQuerySchema.safeParse({ cursor: 'tok', limit: '5' });
      expect(result.success).toBe(true);
      expect(result.data.cursor).toBe('tok');
      expect(result.data.limit).toBe(5);
    });

    it('trims whitespace from cursor', () => {
      const result = getMetricsQuerySchema.safeParse({ cursor: '  abc  ' });
      expect(result.success).toBe(true);
      expect(result.data.cursor).toBe('abc');
    });
  });

  describe('limit clamping and coercion', () => {
    it('clamps limit above max to 100', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '999' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(100);
    });

    it('clamps limit below min to 1', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '-5' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(1);
    });

    it('treats non-numeric limit as undefined (no error)', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: 'abc' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBeUndefined();
    });

    it('treats limit=0 as 1 after clamping (max(parsed, 1))', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '0' });
      expect(result.success).toBe(true);
      // 0 parsed => Math.max(0, 1) = 1
      expect(result.data.limit).toBe(1);
    });

    it('accepts limit at boundary value 1', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '1' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(1);
    });

    it('accepts limit at boundary value 100', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '100' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(100);
    });

    it('omits limit when not provided', () => {
      const result = getMetricsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.limit).toBeUndefined();
    });
  });

  describe('cursor validation', () => {
    it('rejects empty string cursor', () => {
      const result = getMetricsQuerySchema.safeParse({ cursor: '' });
      expect(result.success).toBe(false);
    });

    it('rejects whitespace-only cursor (trimmed to empty)', () => {
      const result = getMetricsQuerySchema.safeParse({ cursor: '   ' });
      expect(result.success).toBe(false);
    });

    it('omits cursor when not provided', () => {
      const result = getMetricsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.cursor).toBeUndefined();
    });
  });

  describe('unknown param stripping', () => {
    it('strips unknown query parameters without error', () => {
      const result = getMetricsQuerySchema.safeParse({ limit: '5', sortBy: 'date', page: '2' });
      expect(result.success).toBe(true);
      expect(result.data.sortBy).toBeUndefined();
      expect(result.data.page).toBeUndefined();
      expect(result.data.limit).toBe(5);
    });
  });
});

// ── bulkMetricsOperationSchema ────────────────────────────────────────────────

describe('bulkMetricsOperationSchema', () => {
  describe('valid inputs', () => {
    it('accepts valid {tenantId, userId}', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: 't1', userId: 'u1' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ tenantId: 't1', userId: 'u1' });
    });

    it('trims whitespace from tenantId and userId', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: '  t1  ', userId: '  u1  ' });
      expect(result.success).toBe(true);
      expect(result.data.tenantId).toBe('t1');
      expect(result.data.userId).toBe('u1');
    });

    it('accepts 128-character tenantId', () => {
      const result = bulkMetricsOperationSchema.safeParse({
        tenantId: 'a'.repeat(128),
        userId: 'u1',
      });
      expect(result.success).toBe(true);
    });

    it('accepts 128-character userId', () => {
      const result = bulkMetricsOperationSchema.safeParse({
        tenantId: 't1',
        userId: 'b'.repeat(128),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing tenantId', () => {
      const result = bulkMetricsOperationSchema.safeParse({ userId: 'u1' });
      expect(result.success).toBe(false);
    });

    it('rejects missing userId', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: 't1' });
      expect(result.success).toBe(false);
    });

    it('rejects empty tenantId string', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: '', userId: 'u1' });
      expect(result.success).toBe(false);
    });

    it('rejects whitespace-only tenantId', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: '   ', userId: 'u1' });
      expect(result.success).toBe(false);
    });

    it('rejects empty userId string', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: 't1', userId: '' });
      expect(result.success).toBe(false);
    });

    it('rejects tenantId exceeding 128 characters', () => {
      const result = bulkMetricsOperationSchema.safeParse({
        tenantId: 'a'.repeat(129),
        userId: 'u1',
      });
      expect(result.success).toBe(false);
    });

    it('rejects userId exceeding 128 characters', () => {
      const result = bulkMetricsOperationSchema.safeParse({
        tenantId: 't1',
        userId: 'b'.repeat(129),
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown keys (strict mode)', () => {
      const result = bulkMetricsOperationSchema.safeParse({
        tenantId: 't1',
        userId: 'u1',
        extra: 'field',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-string tenantId', () => {
      const result = bulkMetricsOperationSchema.safeParse({ tenantId: 123, userId: 'u1' });
      expect(result.success).toBe(false);
    });
  });
});

// ── bulkMetricsSchema ─────────────────────────────────────────────────────────

describe('bulkMetricsSchema', () => {
  const validOp = { tenantId: 't1', userId: 'u1' };

  describe('valid inputs', () => {
    it('accepts a single-operation array', () => {
      const result = bulkMetricsSchema.safeParse({ operations: [validOp] });
      expect(result.success).toBe(true);
      expect(result.data.operations).toHaveLength(1);
    });

    it('accepts exactly 25 operations (the cap)', () => {
      const ops = Array.from({ length: 25 }, (_, i) => ({ tenantId: 't1', userId: `u${i}` }));
      const result = bulkMetricsSchema.safeParse({ operations: ops });
      expect(result.success).toBe(true);
      expect(result.data.operations).toHaveLength(25);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty operations array', () => {
      const result = bulkMetricsSchema.safeParse({ operations: [] });
      expect(result.success).toBe(false);
    });

    it('rejects operations exceeding 25 items', () => {
      const ops = Array.from({ length: 26 }, (_, i) => ({ tenantId: 't1', userId: `u${i}` }));
      const result = bulkMetricsSchema.safeParse({ operations: ops });
      expect(result.success).toBe(false);
    });

    it('rejects missing operations field', () => {
      const result = bulkMetricsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects operations as a string', () => {
      const result = bulkMetricsSchema.safeParse({ operations: 'not-an-array' });
      expect(result.success).toBe(false);
    });

    it('rejects operations as null', () => {
      const result = bulkMetricsSchema.safeParse({ operations: null });
      expect(result.success).toBe(false);
    });

    it('rejects unknown top-level keys', () => {
      const result = bulkMetricsSchema.safeParse({ operations: [validOp], extra: true });
      expect(result.success).toBe(false);
    });

    it('rejects an operation with unknown keys inside (strict per-item)', () => {
      const result = bulkMetricsSchema.safeParse({
        operations: [{ tenantId: 't1', userId: 'u1', rogue: true }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an operation missing tenantId', () => {
      const result = bulkMetricsSchema.safeParse({ operations: [{ userId: 'u1' }] });
      expect(result.success).toBe(false);
    });

    it('propagates fieldError paths for nested operation failures', () => {
      const result = bulkMetricsSchema.safeParse({ operations: [{ userId: 'u1' }] });
      expect(result.success).toBe(false);
      // There should be an issue path referencing operations[0].tenantId
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('operations'))).toBe(true);
    });
  });
});

// ── smeMetricsDataSchema ──────────────────────────────────────────────────────

describe('smeMetricsDataSchema', () => {
  it('accepts valid counts', () => {
    const result = smeMetricsDataSchema.safeParse({ open: 2, funded: 1, settled: 3, defaulted: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts all-zero counts', () => {
    const result = smeMetricsDataSchema.safeParse({ open: 0, funded: 0, settled: 0, defaulted: 0 });
    expect(result.success).toBe(true);
  });

  it('rejects negative values', () => {
    const result = smeMetricsDataSchema.safeParse({ open: -1, funded: 0, settled: 0, defaulted: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer floats', () => {
    const result = smeMetricsDataSchema.safeParse({ open: 1.5, funded: 0, settled: 0, defaulted: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects string values', () => {
    const result = smeMetricsDataSchema.safeParse({ open: '2', funded: 0, settled: 0, defaulted: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    const result = smeMetricsDataSchema.safeParse({ open: 1, funded: 0, settled: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects empty object', () => {
    const result = smeMetricsDataSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── smeMetricsMetaBaseSchema ──────────────────────────────────────────────────

describe('smeMetricsMetaBaseSchema', () => {
  it('accepts valid timestamp and version', () => {
    const result = smeMetricsMetaBaseSchema.safeParse({
      timestamp: '2026-01-01T00:00:00.000Z',
      version: '0.1.0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing timestamp', () => {
    const result = smeMetricsMetaBaseSchema.safeParse({ version: '0.1.0' });
    expect(result.success).toBe(false);
  });

  it('rejects missing version', () => {
    const result = smeMetricsMetaBaseSchema.safeParse({ timestamp: '2026-01-01T00:00:00.000Z' });
    expect(result.success).toBe(false);
  });

  it('rejects non-ISO timestamp', () => {
    const result = smeMetricsMetaBaseSchema.safeParse({ timestamp: 'not-a-date', version: '1.0' });
    expect(result.success).toBe(false);
  });

  it('rejects empty version', () => {
    const result = smeMetricsMetaBaseSchema.safeParse({ timestamp: '2026-01-01T00:00:00.000Z', version: '' });
    expect(result.success).toBe(false);
  });
});

// ── smeMetricsMetaSchema ──────────────────────────────────────────────────────

describe('smeMetricsMetaSchema', () => {
  const base = { timestamp: '2026-01-01T00:00:00.000Z', version: '0.1.0' };

  it('accepts base-only meta (no pagination fields)', () => {
    const result = smeMetricsMetaSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data.invoices).toBeUndefined();
  });

  it('accepts full paginated meta', () => {
    const result = smeMetricsMetaSchema.safeParse({
      ...base,
      invoices: [{ id: '1' }],
      total: 10,
      limit: 5,
      hasMore: true,
      nextCursor: 'cur123',
    });
    expect(result.success).toBe(true);
    expect(result.data.invoices).toHaveLength(1);
    expect(result.data.total).toBe(10);
    expect(result.data.limit).toBe(5);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextCursor).toBe('cur123');
  });

  it('accepts nextCursor as null', () => {
    const result = smeMetricsMetaSchema.safeParse({ ...base, nextCursor: null });
    expect(result.success).toBe(true);
    expect(result.data.nextCursor).toBeNull();
  });

  it('rejects negative total', () => {
    const result = smeMetricsMetaSchema.safeParse({ ...base, total: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean hasMore', () => {
    const result = smeMetricsMetaSchema.safeParse({ ...base, hasMore: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects limit above 100', () => {
    const result = smeMetricsMetaSchema.safeParse({ ...base, limit: 101 });
    expect(result.success).toBe(false);
  });
});

// ── smeMetricsApiResponseSchema ───────────────────────────────────────────────

describe('smeMetricsApiResponseSchema', () => {
  const validResponse = {
    data: { open: 1, funded: 0, settled: 2, defaulted: 0 },
    meta: { timestamp: '2026-01-01T00:00:00.000Z', version: '0.1.0' },
    error: null,
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a valid response envelope', () => {
    const result = smeMetricsApiResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it('accepts response with error object', () => {
    const result = smeMetricsApiResponseSchema.safeParse({
      ...validResponse,
      error: { message: 'oops' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing data field', () => {
    const { data: _d, ...rest } = validResponse;
    const result = smeMetricsApiResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing meta field', () => {
    const { meta: _m, ...rest } = validResponse;
    const result = smeMetricsApiResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects invalid top-level timestamp', () => {
    const result = smeMetricsApiResponseSchema.safeParse({
      ...validResponse,
      timestamp: 'bad-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects data with invalid counts (negative)', () => {
    const result = smeMetricsApiResponseSchema.safeParse({
      ...validResponse,
      data: { open: -1, funded: 0, settled: 0, defaulted: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// ── bulkMetricsResponseSchema ─────────────────────────────────────────────────

describe('bulkMetricsResponseSchema', () => {
  const validBulkResponse = {
    results: [
      { tenantId: 't1', userId: 'u1', status: 'success', data: { open: 1, funded: 0, settled: 0, defaulted: 0 }, error: null },
      { tenantId: 't1', userId: 'u2', status: 'error', data: null, error: 'some error' },
    ],
    meta: { total: 2, succeeded: 1, failed: 1, timestamp: '2026-01-01T00:00:00.000Z' },
  };

  it('accepts a valid bulk response', () => {
    const result = bulkMetricsResponseSchema.safeParse(validBulkResponse);
    expect(result.success).toBe(true);
  });

  it('accepts empty results array', () => {
    const result = bulkMetricsResponseSchema.safeParse({
      results: [],
      meta: { total: 0, succeeded: 0, failed: 0, timestamp: '2026-01-01T00:00:00.000Z' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status enum in result item', () => {
    const result = bulkMetricsResponseSchema.safeParse({
      ...validBulkResponse,
      results: [{ ...validBulkResponse.results[0], status: 'pending' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing meta', () => {
    const { meta: _m, ...rest } = validBulkResponse;
    const result = bulkMetricsResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects negative meta.total', () => {
    const result = bulkMetricsResponseSchema.safeParse({
      ...validBulkResponse,
      meta: { ...validBulkResponse.meta, total: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-ISO meta.timestamp', () => {
    const result = bulkMetricsResponseSchema.safeParse({
      ...validBulkResponse,
      meta: { ...validBulkResponse.meta, timestamp: 'not-a-date' },
    });
    expect(result.success).toBe(false);
  });
});

// ── validateSmeMetricsApiResponse helper ──────────────────────────────────────

describe('validateSmeMetricsApiResponse', () => {
  const validResponse = {
    data: { open: 1, funded: 0, settled: 2, defaulted: 0 },
    meta: { timestamp: '2026-01-01T00:00:00.000Z', version: '0.1.0' },
    error: null,
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  it('returns success:true for a valid response', () => {
    const result = validateSmeMetricsApiResponse(validResponse);
    expect(result.success).toBe(true);
  });

  it('returns success:false with ZodError for invalid response', () => {
    const result = validateSmeMetricsApiResponse({ data: 'bad', meta: {}, error: null, timestamp: 't' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns success:false for null input', () => {
    const result = validateSmeMetricsApiResponse(null);
    expect(result.success).toBe(false);
  });

  it('returns success:false for missing required fields', () => {
    const result = validateSmeMetricsApiResponse({});
    expect(result.success).toBe(false);
  });
});

// ── validateBulkMetricsResponse helper ───────────────────────────────────────

describe('validateBulkMetricsResponse', () => {
  const validBulkResponse = {
    results: [
      { tenantId: 't1', userId: 'u1', status: 'success', data: { open: 0, funded: 0, settled: 0, defaulted: 0 }, error: null },
    ],
    meta: { total: 1, succeeded: 1, failed: 0, timestamp: '2026-01-01T00:00:00.000Z' },
  };

  it('returns success:true for a valid bulk response', () => {
    const result = validateBulkMetricsResponse(validBulkResponse);
    expect(result.success).toBe(true);
  });

  it('returns success:false for invalid bulk response', () => {
    const result = validateBulkMetricsResponse({ results: 'bad', meta: {} });
    expect(result.success).toBe(false);
  });

  it('returns success:false for null input', () => {
    const result = validateBulkMetricsResponse(null);
    expect(result.success).toBe(false);
  });
});

// ── parseValidationErrors ─────────────────────────────────────────────────────

describe('parseValidationErrors', () => {
  it('returns empty object for no issues', () => {
    const fakeError = { issues: [] };
    expect(parseValidationErrors(fakeError)).toEqual({});
  });

  it('groups messages by field path', () => {
    const fakeError = {
      issues: [
        { path: ['operations', '0', 'tenantId'], message: 'tenantId must not be empty' },
        { path: ['operations', '0', 'tenantId'], message: 'Another error' },
        { path: ['operations'], message: 'array error' },
      ],
    };
    const result = parseValidationErrors(fakeError);
    expect(result['operations.0.tenantId']).toContain('tenantId must not be empty');
    expect(result['operations.0.tenantId']).toContain('Another error');
    expect(result['operations']).toContain('array error');
  });

  it('handles top-level (empty path) issues', () => {
    const fakeError = {
      issues: [{ path: [], message: 'root error' }],
    };
    const result = parseValidationErrors(fakeError);
    expect(result['']).toContain('root error');
  });
});

// ── validateBulkMetricsBody middleware ────────────────────────────────────────

describe('validateBulkMetricsBody middleware', () => {
  it('calls next() and sets req.validated on valid body', () => {
    const req = { body: { operations: [{ tenantId: 't1', userId: 'u1' }] } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.validated).toEqual({ operations: [{ tenantId: 't1', userId: 'u1' }] });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('trims tenantId/userId in req.validated', () => {
    const req = { body: { operations: [{ tenantId: '  t1  ', userId: '  u1  ' }] } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validated.operations[0].tenantId).toBe('t1');
    expect(req.validated.operations[0].userId).toBe('u1');
  });

  it('returns 400 with fieldErrors for empty operations array', () => {
    const req = { body: { operations: [] } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
    expect(res._body.fieldErrors).toBeDefined();
  });

  it('returns 400 for missing operations field', () => {
    const req = { body: {} };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
    expect(res._body.fieldErrors).toBeDefined();
  });

  it('returns 400 for over-cap array (26 items)', () => {
    const ops = Array.from({ length: 26 }, (_, i) => ({ tenantId: 't1', userId: `u${i}` }));
    const req = { body: { operations: ops } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
  });

  it('returns 400 for unknown top-level key', () => {
    const req = { body: { operations: [{ tenantId: 't1', userId: 'u1' }], rogue: true } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
  });

  it('returns 400 for unknown per-item key', () => {
    const req = { body: { operations: [{ tenantId: 't1', userId: 'u1', extra: 'x' }] } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
  });

  it('error response has RFC 7807 shape', () => {
    const req = { body: {} };
    const res = makeRes();
    validateBulkMetricsBody(req, res, makeNext());

    expect(res._body.type).toBe('https://liquifact.io/problems/validation-error');
    expect(res._body.title).toBe('Validation Error');
    expect(res._body.status).toBe(400);
    expect(res._body.detail).toBeDefined();
    expect(res._body.fieldErrors).toBeDefined();
  });

  it('returns 400 for non-array operations', () => {
    const req = { body: { operations: 'not-an-array' } };
    const res = makeRes();
    const next = makeNext();

    validateBulkMetricsBody(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
  });
});

// ── validateGetMetricsQuery middleware ────────────────────────────────────────

describe('validateGetMetricsQuery middleware', () => {
  it('calls next() and sets req.validatedQuery on valid empty query', () => {
    const req = { query: {} };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.validatedQuery).toBeDefined();
    expect(req.validatedQuery.cursor).toBeUndefined();
    expect(req.validatedQuery.limit).toBeUndefined();
  });

  it('coerces limit string to integer in validatedQuery', () => {
    const req = { query: { limit: '20' } };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery.limit).toBe(20);
  });

  it('passes cursor through in validatedQuery', () => {
    const req = { query: { cursor: 'abc123' } };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery.cursor).toBe('abc123');
  });

  it('strips unknown query params from validatedQuery', () => {
    const req = { query: { limit: '5', page: '2', sort: 'asc' } };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery.page).toBeUndefined();
    expect(req.validatedQuery.sort).toBeUndefined();
    expect(req.validatedQuery.limit).toBe(5);
  });

  it('returns 400 for empty cursor string', () => {
    const req = { query: { cursor: '' } };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
    expect(res._body.fieldErrors).toBeDefined();
  });

  it('does not error for non-numeric limit (yields undefined)', () => {
    const req = { query: { limit: 'abc' } };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    // non-numeric limit is coerced to undefined rather than erroring
    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery.limit).toBeUndefined();
  });

  it('clamps oversized limit to 100 in validatedQuery', () => {
    const req = { query: { limit: '999' } };
    const res = makeRes();
    const next = makeNext();

    validateGetMetricsQuery(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery.limit).toBe(100);
  });
});

// ── bulkMetricsResultItemSchema ───────────────────────────────────────────────

describe('bulkMetricsResultItemSchema', () => {
  it('accepts a success item', () => {
    const result = bulkMetricsResultItemSchema.safeParse({
      tenantId: 't1', userId: 'u1', status: 'success',
      data: { open: 1, funded: 0, settled: 0, defaulted: 0 }, error: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an error item with null data', () => {
    const result = bulkMetricsResultItemSchema.safeParse({
      tenantId: 't1', userId: 'u1', status: 'error', data: null, error: 'boom',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown status value', () => {
    const result = bulkMetricsResultItemSchema.safeParse({
      tenantId: 't1', userId: 'u1', status: 'pending', data: null, error: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing status', () => {
    const result = bulkMetricsResultItemSchema.safeParse({
      tenantId: 't1', userId: 'u1', data: null, error: null,
    });
    expect(result.success).toBe(false);
  });
});
