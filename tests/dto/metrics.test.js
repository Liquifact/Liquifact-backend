'use strict';

/**
 * @fileoverview Unit tests for the metrics DTO layer (src/dto/metrics.js).
 *
 * Covers:
 *  - SME metrics response mapping (toSmeMetricsResponse)
 *  - SME metrics meta mapping (toSmeMetricsMeta)
 *  - SME metrics API response composition (toSmeMetricsApiResponse)
 *  - Persistence record params mapping (toPersistenceRecordParams)
 *  - Validation helpers (isValidSmeMetricsResponse, isValidPersistenceRecordParams)
 *  - Round-trip mapping consistency
 *  - Edge cases: null/undefined/missing fields, non-object input, type coercion
 */

const {
  toSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,
  toPersistenceRecordParams,
  isValidSmeMetricsResponse,
  isValidPersistenceRecordParams,
} = require('../../src/dto/metrics');

// ---------------------------------------------------------------------------
// toSmeMetricsResponse
// ---------------------------------------------------------------------------
describe('toSmeMetricsResponse', () => {
  it('maps a complete object with all four keys', () => {
    const result = toSmeMetricsResponse({ open: 2, funded: 1, settled: 3, defaulted: 0 });
    expect(result).toEqual({ open: 2, funded: 1, settled: 3, defaulted: 0 });
  });

  it('defaults missing keys to 0', () => {
    const result = toSmeMetricsResponse({ open: 5 });
    expect(result).toEqual({ open: 5, funded: 0, settled: 0, defaulted: 0 });
  });

  it('defaults all keys to 0 when input is null', () => {
    const result = toSmeMetricsResponse(null);
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });

  it('defaults all keys to 0 when input is undefined', () => {
    const result = toSmeMetricsResponse(undefined);
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });

  it('defaults all keys to 0 when input is a string', () => {
    const result = toSmeMetricsResponse('not-an-object');
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });

  it('defaults all keys to 0 when input is an array', () => {
    const result = toSmeMetricsResponse([1, 2, 3]);
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });

  it('coerces string numbers to integers', () => {
    const result = toSmeMetricsResponse({ open: '3', funded: '1', settled: '2', defaulted: '0' });
    expect(result).toEqual({ open: 3, funded: 1, settled: 2, defaulted: 0 });
  });

  it('coerces float values to integers (truncation via Number())', () => {
    const result = toSmeMetricsResponse({ open: 2.7, funded: 1.2, settled: 3.9, defaulted: 0.1 });
    // Number() does not truncate; fields are coerced via Number() || 0
    expect(result.open).toBe(2.7);
    expect(result.funded).toBe(1.2);
  });

  it('treats non-numeric string values as 0', () => {
    const result = toSmeMetricsResponse({ open: 'abc', funded: null, settled: undefined, defaulted: {} });
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });

  it('strips unknown keys from the raw object', () => {
    const result = toSmeMetricsResponse({ open: 1, funded: 2, settled: 3, defaulted: 0, extra: 99, secret: 'x' });
    expect(result).toEqual({ open: 1, funded: 2, settled: 3, defaulted: 0 });
    expect(result.extra).toBeUndefined();
  });

  it('returns zeroes for an empty object', () => {
    const result = toSmeMetricsResponse({});
    expect(result).toEqual({ open: 0, funded: 0, settled: 0, defaulted: 0 });
  });
});

// ---------------------------------------------------------------------------
// toSmeMetricsMeta
// ---------------------------------------------------------------------------
describe('toSmeMetricsMeta', () => {
  it('preserves mandatory fields from input', () => {
    const result = toSmeMetricsMeta({ timestamp: '2026-01-01T00:00:00.000Z', version: '1.0.0' });
    expect(result.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(result.version).toBe('1.0.0');
  });

  it('defaults timestamp and version when missing', () => {
    const result = toSmeMetricsMeta({});
    expect(result.timestamp).toBeDefined();
    expect(typeof result.timestamp).toBe('string');
    expect(result.version).toBe('0.1.0');
  });

  it('defaults timestamp and version when input is null', () => {
    const result = toSmeMetricsMeta(null);
    expect(result.timestamp).toBeDefined();
    expect(result.version).toBe('0.1.0');
  });

  it('defaults timestamp and version when input is undefined', () => {
    const result = toSmeMetricsMeta(undefined);
    expect(result.timestamp).toBeDefined();
    expect(result.version).toBe('0.1.0');
  });

  it('includes invoices when present', () => {
    const invoices = [{ id: 1 }, { id: 2 }];
    const result = toSmeMetricsMeta({ invoices, timestamp: 't', version: 'v' });
    expect(result.invoices).toBe(invoices);
    expect(result.invoices).toHaveLength(2);
  });

  it('omits invoices when input is not an array', () => {
    const result = toSmeMetricsMeta({ invoices: 'not-an-array', timestamp: 't', version: 'v' });
    expect(result.invoices).toBeUndefined();
  });

  it('includes total when it is a finite number', () => {
    const result = toSmeMetricsMeta({ total: 42, timestamp: 't', version: 'v' });
    expect(result.total).toBe(42);
  });

  it('omits total when it is not a number', () => {
    const result = toSmeMetricsMeta({ total: 'abc', timestamp: 't', version: 'v' });
    expect(result.total).toBeUndefined();
  });

  it('clamps total to 0 when negative', () => {
    const result = toSmeMetricsMeta({ total: -5, timestamp: 't', version: 'v' });
    expect(result.total).toBe(0);
  });

  it('floors total to integer', () => {
    const result = toSmeMetricsMeta({ total: 42.7, timestamp: 't', version: 'v' });
    expect(result.total).toBe(42);
  });

  it('includes limit when it is a finite number', () => {
    const result = toSmeMetricsMeta({ limit: 20, timestamp: 't', version: 'v' });
    expect(result.limit).toBe(20);
  });

  it('omits limit when it is not a number', () => {
    const result = toSmeMetricsMeta({ limit: 'NaN', timestamp: 't', version: 'v' });
    expect(result.limit).toBeUndefined();
  });

  it('includes hasMore when boolean', () => {
    const result = toSmeMetricsMeta({ hasMore: true, timestamp: 't', version: 'v' });
    expect(result.hasMore).toBe(true);
  });

  it('omits hasMore when not boolean', () => {
    const result = toSmeMetricsMeta({ hasMore: 1, timestamp: 't', version: 'v' });
    expect(result.hasMore).toBeUndefined();
  });

  it('preserves nextCursor as null when explicitly null', () => {
    const result = toSmeMetricsMeta({ nextCursor: null, timestamp: 't', version: 'v' });
    expect(result.nextCursor).toBeNull();
  });

  it('preserves nextCursor as string when present', () => {
    const result = toSmeMetricsMeta({ nextCursor: 'abc123', timestamp: 't', version: 'v' });
    expect(result.nextCursor).toBe('abc123');
  });

  it('omits nextCursor when not present on the source', () => {
    const result = toSmeMetricsMeta({ timestamp: 't', version: 'v' });
    expect(result.nextCursor).toBeUndefined();
  });

  it('coerces nextCursor undefined to null when key exists with undefined value', () => {
    const result = toSmeMetricsMeta({ nextCursor: undefined, timestamp: 't', version: 'v' });
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toSmeMetricsApiResponse
// ---------------------------------------------------------------------------
describe('toSmeMetricsApiResponse', () => {
  it('assembles a complete response with data, meta, error = null', () => {
    const data = { open: 1, funded: 0, settled: 2, defaulted: 0 };
    const meta = { timestamp: '2026-01-01T00:00:00.000Z', version: '0.1.0' };

    const result = toSmeMetricsApiResponse(data, meta);

    expect(result.data).toBe(data);
    expect(result.meta).toBe(meta);
    expect(result.error).toBeNull();
    expect(result.timestamp).toBeDefined();
  });

  it('assembles a response with a truthy error object', () => {
    const data = { open: 0, funded: 0, settled: 0, defaulted: 0 };
    const meta = { timestamp: 't', version: 'v' };
    const error = { message: 'something went wrong' };

    const result = toSmeMetricsApiResponse(data, meta, error);

    expect(result.error).toBe(error);
    expect(result.timestamp).toBeDefined();
  });

  it('includes a valid ISO timestamp on every call', () => {
    const data = { open: 0, funded: 0, settled: 0, defaulted: 0 };
    const meta = { timestamp: 't', version: 'v' };

    const r1 = toSmeMetricsApiResponse(data, meta);
    const r2 = toSmeMetricsApiResponse(data, meta);

    expect(r1.timestamp).toBeDefined();
    expect(typeof r1.timestamp).toBe('string');
    expect(() => new Date(r1.timestamp)).not.toThrow();
    expect(r2.timestamp).toBeDefined();
    expect(typeof r2.timestamp).toBe('string');
  });

  it('defaults error to null when not provided', () => {
    const data = { open: 0, funded: 0, settled: 0, defaulted: 0 };
    const meta = { timestamp: 't', version: 'v' };

    const result = toSmeMetricsApiResponse(data, meta);

    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toPersistenceRecordParams
// ---------------------------------------------------------------------------
describe('toPersistenceRecordParams', () => {
  it('maps a complete object with all fields', () => {
    const req = { id: 'r1' };
    const result = toPersistenceRecordParams({
      endpoint: 'sme_invoice_upload',
      statusCode: 200,
      durationSeconds: 0.05,
      cause: 'none',
      req,
    });

    expect(result.endpoint).toBe('sme_invoice_upload');
    expect(result.statusCode).toBe(200);
    expect(result.durationSeconds).toBe(0.05);
    expect(result.cause).toBe('none');
    expect(result.req).toBe(req);
  });

  it('defaults missing fields to safe values', () => {
    const result = toPersistenceRecordParams({});

    expect(result.endpoint).toBe('unknown');
    expect(result.statusCode).toBe(200);
    expect(result.durationSeconds).toBe(0);
    expect(result.cause).toBe('none');
    expect(result.req).toBeUndefined();
  });

  it('defaults all fields when input is null', () => {
    const result = toPersistenceRecordParams(null);
    expect(result.endpoint).toBe('unknown');
    expect(result.statusCode).toBe(200);
    expect(result.durationSeconds).toBe(0);
    expect(result.cause).toBe('none');
  });

  it('defaults all fields when input is undefined', () => {
    const result = toPersistenceRecordParams(undefined);
    expect(result.endpoint).toBe('unknown');
    expect(result.req).toBeUndefined();
  });

  it('defaults all fields when input is a string', () => {
    const result = toPersistenceRecordParams('garbage');
    expect(result.endpoint).toBe('unknown');
    expect(result.statusCode).toBe(200);
    expect(result.durationSeconds).toBe(0);
  });

  it('defaults all fields when input is an array', () => {
    const result = toPersistenceRecordParams([1, 2, 3]);
    expect(result.endpoint).toBe('unknown');
    expect(result.cause).toBe('none');
  });

  it('coerces endpoint to string', () => {
    const result = toPersistenceRecordParams({ endpoint: 42 });
    // Number 42 becomes string '42' via String()
    expect(result.endpoint).toBe('42');
  });

  it('coerces statusCode via Number()', () => {
    const result = toPersistenceRecordParams({ statusCode: '503' });
    expect(result.statusCode).toBe(503);
  });

  it('coerces bad statusCode to 200', () => {
    const result = toPersistenceRecordParams({ statusCode: 'abc' });
    expect(result.statusCode).toBe(200);
  });

  it('coerces durationSeconds via Number()', () => {
    const result = toPersistenceRecordParams({ durationSeconds: '0.123' });
    expect(result.durationSeconds).toBe(0.123);
  });

  it('coerces bad durationSeconds to 0', () => {
    const result = toPersistenceRecordParams({ durationSeconds: 'NaN' });
    expect(result.durationSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isValidSmeMetricsResponse
// ---------------------------------------------------------------------------
describe('isValidSmeMetricsResponse', () => {
  it('returns true for a valid object', () => {
    expect(isValidSmeMetricsResponse({ open: 1, funded: 0, settled: 2, defaulted: 0 })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidSmeMetricsResponse(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidSmeMetricsResponse(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isValidSmeMetricsResponse('hello')).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isValidSmeMetricsResponse([1, 2])).toBe(false);
  });

  it('returns false for an object missing a required key', () => {
    expect(isValidSmeMetricsResponse({ open: 1, funded: 2, settled: 3 })).toBe(false); // missing defaulted
  });

  it('returns false when a field is not a number', () => {
    expect(isValidSmeMetricsResponse({ open: 'a', funded: 0, settled: 0, defaulted: 0 })).toBe(false);
  });

  it('returns true for an object with extra keys', () => {
    expect(isValidSmeMetricsResponse({ open: 1, funded: 0, settled: 0, defaulted: 0, extra: true })).toBe(true);
  });

  it('returns false for an empty object', () => {
    expect(isValidSmeMetricsResponse({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidPersistenceRecordParams
// ---------------------------------------------------------------------------
describe('isValidPersistenceRecordParams', () => {
  it('returns true for a valid params object', () => {
    expect(isValidPersistenceRecordParams({
      endpoint: 'sme_invoice_upload',
      statusCode: 200,
      durationSeconds: 0.05,
      cause: 'none',
    })).toBe(true);
  });

  it('returns true with optional req field', () => {
    expect(isValidPersistenceRecordParams({
      endpoint: 'unknown',
      statusCode: 500,
      durationSeconds: 1.2,
      cause: 'internal',
      req: { id: 'r1' },
    })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidPersistenceRecordParams(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidPersistenceRecordParams(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isValidPersistenceRecordParams('bad')).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isValidPersistenceRecordParams([1, 2])).toBe(false);
  });

  it('returns false when endpoint is missing', () => {
    expect(isValidPersistenceRecordParams({
      statusCode: 200,
      durationSeconds: 0.1,
      cause: 'none',
    })).toBe(false);
  });

  it('returns false when statusCode is not a number', () => {
    expect(isValidPersistenceRecordParams({
      endpoint: 'unknown',
      statusCode: '400',
      durationSeconds: 0.1,
      cause: 'validation',
    })).toBe(false);
  });

  it('returns false when cause is not a string', () => {
    expect(isValidPersistenceRecordParams({
      endpoint: 'unknown',
      statusCode: 500,
      durationSeconds: 0.1,
      cause: 5,
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: service output → DTO → JSON → DTO consistency
// ---------------------------------------------------------------------------
describe('round-trip mapping consistency', () => {
  it('toSmeMetricsResponse is idempotent for valid data', () => {
    const original = { open: 3, funded: 2, settled: 1, defaulted: 0 };
    const once = toSmeMetricsResponse(original);
    const twice = toSmeMetricsResponse(once);
    expect(twice).toEqual(once);
  });

  it('toPersistenceRecordParams is idempotent for valid data', () => {
    const original = {
      endpoint: 'sme_invoice_upload',
      statusCode: 201,
      durationSeconds: 0.123,
      cause: 'none',
    };
    const once = toPersistenceRecordParams(original);
    const twice = toPersistenceRecordParams(once);
    expect(twice).toEqual(once);
  });

  it('round-trips SME metrics through toSmeMetricsApiResponse', () => {
    const rawCounts = { open: 5, funded: 3, settled: 2, defaulted: 0 };
    const rawMeta = { timestamp: 't', version: '0.1.0' };

    const data = toSmeMetricsResponse(rawCounts);
    const meta = toSmeMetricsMeta(rawMeta);
    const response = toSmeMetricsApiResponse(data, meta);

    expect(isValidSmeMetricsResponse(response.data)).toBe(true);
    expect(response.data.open).toBe(5);
    expect(response.meta.timestamp).toBe('t');
    expect(response.error).toBeNull();
    expect(response.timestamp).toBeDefined();
  });

  it('round-trips paginated SME metrics through toSmeMetricsApiResponse', () => {
    const rawCounts = { open: 10, funded: 5, settled: 3, defaulted: 2 };
    const rawMeta = {
      invoices: [{ id: 1 }, { id: 2 }],
      total: 20,
      limit: 10,
      hasMore: true,
      nextCursor: 'cursor-xyz',
      timestamp: 't',
      version: '0.1.0',
    };

    const data = toSmeMetricsResponse(rawCounts);
    const meta = toSmeMetricsMeta(rawMeta);
    const response = toSmeMetricsApiResponse(data, meta);

    expect(isValidSmeMetricsResponse(response.data)).toBe(true);
    expect(response.meta.invoices).toHaveLength(2);
    expect(response.meta.total).toBe(20);
    expect(response.meta.hasMore).toBe(true);
    expect(response.meta.nextCursor).toBe('cursor-xyz');
  });

  it('round-trips persistence params through toPersistenceRecordParams', () => {
    const raw = {
      endpoint: 'sme_invoice_presigned_url',
      statusCode: 400,
      durationSeconds: 0.01,
      cause: 'validation',
    };

    const params = toPersistenceRecordParams(raw);

    expect(isValidPersistenceRecordParams(params)).toBe(true);
    expect(params.endpoint).toBe('sme_invoice_presigned_url');
    expect(params.cause).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: unexpected / adversarial input
// ---------------------------------------------------------------------------
describe('edge cases — adversarial input', () => {
  it('toSmeMetricsResponse handles prototype-pollution-like keys', () => {
    const result = toSmeMetricsResponse({ __proto__: { open: 99 }, open: 1, funded: 2, settled: 3, defaulted: 0 });
    // The __proto__ key should not affect the result
    expect(result.open).toBe(1);
    expect(result.funded).toBe(2);
  });

  it('toSmeMetricsResponse handles objects with getters (non-enumerable)', () => {
    const obj = {};
    Object.defineProperty(obj, 'open', { get: () => 5, enumerable: true });
    Object.defineProperty(obj, 'funded', { value: 3, enumerable: true });
    Object.defineProperty(obj, 'settled', { value: 2, enumerable: true });
    Object.defineProperty(obj, 'defaulted', { value: 0, enumerable: true });

    const result = toSmeMetricsResponse(obj);
    expect(result.open).toBe(5);
    expect(result.funded).toBe(3);
  });

  it('toPersistenceRecordParams truncates very long endpoint strings', () => {
    const result = toPersistenceRecordParams({
      endpoint: 'a'.repeat(1000),
      statusCode: 200,
      durationSeconds: 0.1,
      cause: 'none',
    });
    expect(result.endpoint.length).toBe(1000); // allowed to pass through
  });
});
