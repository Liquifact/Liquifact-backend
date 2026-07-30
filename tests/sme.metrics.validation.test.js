/**
 * Route-level input-validation tests for the SME metrics endpoints.
 *
 * Asserts that malformed payloads are rejected at the HTTP boundary with a
 * structured 400 carrying a machine-readable error code — i.e. that the
 * hardening in `src/schemas/metrics.js` is actually wired into the routes and
 * runs before any handler logic touches the store.
 *
 * Bypasses the global knex mock to run against an in-memory SQLite database,
 * matching `tests/sme.metrics.bulk.test.js`.
 */

'use strict';

jest.mock('../src/db/knex', () => {
  const knex = jest.requireActual('knex');
  const config = jest.requireActual('../knexfile')['test'];
  return knex(config);
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const db = require('../src/db/knex');
const invoiceService = require('../src/services/invoiceService');
const {
  METRICS_VALIDATION_CODES,
  METRICS_VALIDATION_ERROR_CODE,
  MAX_BULK_OPERATIONS,
  BULK_METRICS_ID_MAX_LENGTH,
  GET_METRICS_CURSOR_MAX_LENGTH,
} = require('../src/schemas/metrics');

const JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';
const app = createApp();

const str = (n) => 'a'.repeat(n);

describe('SME metrics input validation', () => {
  const userId = 'validation_user';
  const tenantId = 'validation_tenant';
  const token = jwt.sign({ id: userId, tenantId }, JWT_SECRET);
  const validOp = { tenantId, userId };

  const postBulk = (body) =>
    request(app)
      .post('/api/sme/metrics/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const getMetrics = (query) =>
    request(app).get(`/api/sme/metrics${query}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await db.migrate.latest({ directory: './migrations' });
  });

  beforeEach(async () => {
    await db('invoices').del();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ── POST /metrics/bulk ─────────────────────────────────────────────────────

  describe('POST /api/sme/metrics/bulk', () => {
    describe('structured error contract', () => {
      test('returns a 400 problem document with a machine-readable code', async () => {
        const res = await postBulk({});

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
        expect(res.body.type).toBe('https://liquifact.io/problems/validation-error');
        expect(res.body.title).toBe('Validation Error');
        expect(res.body.status).toBe(400);
        expect(res.body.detail).toEqual(expect.any(String));
        expect(res.body.fieldErrors).toBeDefined();
        expect(res.body.fieldCodes).toBeDefined();
      });

      test('never leaks a stack trace in the error body', async () => {
        const res = await postBulk({ operations: 'nope' });

        expect(res.status).toBe(400);
        expect(res.body.stack).toBeUndefined();
      });
    });

    describe('missing fields', () => {
      test('rejects a missing operations array as FIELD_REQUIRED', async () => {
        const res = await postBulk({});

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes.operations).toContain(
          METRICS_VALIDATION_CODES.FIELD_REQUIRED
        );
      });

      test('rejects a missing tenantId with a path-qualified code', async () => {
        const res = await postBulk({ operations: [{ userId }] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.tenantId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_REQUIRED
        );
      });

      test('rejects a missing userId with a path-qualified code', async () => {
        const res = await postBulk({ operations: [{ tenantId }] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.userId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_REQUIRED
        );
      });
    });

    describe('wrong types', () => {
      test('rejects a numeric tenantId as FIELD_TYPE_INVALID', async () => {
        const res = await postBulk({ operations: [{ tenantId: 42, userId }] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.tenantId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID
        );
      });

      test('rejects a boolean userId as FIELD_TYPE_INVALID', async () => {
        const res = await postBulk({ operations: [{ tenantId, userId: true }] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.userId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID
        );
      });

      test('rejects a non-array operations value', async () => {
        const res = await postBulk({ operations: 'not-an-array' });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes.operations).toBeDefined();
      });

      test('rejects a nested object where a string id is expected', async () => {
        const res = await postBulk({ operations: [{ tenantId: { $ne: null }, userId }] });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
      });

      test('rejects a JSON array as the request body', async () => {
        const res = await postBulk([validOp]);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
      });
    });

    describe('unknown fields', () => {
      test('rejects an unknown top-level key and names it', async () => {
        const res = await postBulk({ operations: [validOp], extra: 'field' });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes.extra).toEqual([
          METRICS_VALIDATION_CODES.UNKNOWN_FIELD,
        ]);
      });

      test('rejects an unknown per-item key and names its full path', async () => {
        const res = await postBulk({ operations: [{ ...validOp, isAdmin: true }] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.isAdmin']).toEqual([
          METRICS_VALIDATION_CODES.UNKNOWN_FIELD,
        ]);
      });
    });

    describe('oversized strings', () => {
      test(`accepts an id at exactly ${BULK_METRICS_ID_MAX_LENGTH} characters`, async () => {
        const res = await postBulk({
          operations: [{ tenantId, userId: str(BULK_METRICS_ID_MAX_LENGTH) }],
        });

        expect(res.status).toBe(200);
      });

      test('rejects a userId one character over the bound as FIELD_TOO_LONG', async () => {
        const res = await postBulk({
          operations: [{ tenantId, userId: str(BULK_METRICS_ID_MAX_LENGTH + 1) }],
        });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.userId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_TOO_LONG
        );
      });

      test('rejects a grossly oversized tenantId', async () => {
        const res = await postBulk({
          operations: [{ tenantId: str(10000), userId }],
        });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.tenantId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_TOO_LONG
        );
      });

      test('rejects an empty tenantId as FIELD_TOO_SHORT', async () => {
        const res = await postBulk({ operations: [{ tenantId: '   ', userId }] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes['operations.0.tenantId']).toContain(
          METRICS_VALIDATION_CODES.FIELD_TOO_SHORT
        );
      });
    });

    describe('array boundaries', () => {
      test('rejects an empty operations array as ARRAY_TOO_SMALL', async () => {
        const res = await postBulk({ operations: [] });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes.operations).toContain(
          METRICS_VALIDATION_CODES.ARRAY_TOO_SMALL
        );
      });

      test(`accepts exactly ${MAX_BULK_OPERATIONS} operations`, async () => {
        const operations = Array.from({ length: MAX_BULK_OPERATIONS }, (_, i) => ({
          tenantId,
          userId: `user_${i}`,
        }));
        const res = await postBulk({ operations });

        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(MAX_BULK_OPERATIONS);
      });

      test('rejects one operation over the cap as ARRAY_TOO_LARGE', async () => {
        const operations = Array.from({ length: MAX_BULK_OPERATIONS + 1 }, (_, i) => ({
          tenantId,
          userId: `user_${i}`,
        }));
        const res = await postBulk({ operations });

        expect(res.status).toBe(400);
        expect(res.body.fieldCodes.operations).toContain(
          METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE
        );
      });
    });

    describe('validation runs before the store is touched', () => {
      test('does not query invoices when the body is malformed', async () => {
        const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

        const res = await postBulk({ operations: [{ tenantId: 42, userId: null }] });

        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
      });

      test('does not query invoices when an id is oversized', async () => {
        const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

        const res = await postBulk({
          operations: [{ tenantId, userId: str(BULK_METRICS_ID_MAX_LENGTH + 1) }],
        });

        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('valid payloads still succeed', () => {
      test('accepts a well-formed request and returns counts', async () => {
        await db('invoices').insert([
          {
            invoice_id: 'v1',
            sme_id: userId,
            tenant_id: tenantId,
            status: 'funded',
            amount: 100,
            customer: 'C1',
          },
        ]);

        const res = await postBulk({ operations: [validOp] });

        expect(res.status).toBe(200);
        expect(res.body.results[0].status).toBe('success');
        expect(res.body.results[0].data.funded).toBe(1);
      });

      test('trims surrounding whitespace on ids', async () => {
        const res = await postBulk({
          operations: [{ tenantId: `  ${tenantId}  `, userId: `  ${userId}  ` }],
        });

        expect(res.status).toBe(200);
        // Trimmed ids match the caller's tenant, so this is not a cross-tenant reject.
        expect(res.body.results[0].status).toBe('success');
      });
    });
  });

  // ── GET /metrics ───────────────────────────────────────────────────────────

  describe('GET /api/sme/metrics', () => {
    describe('limit validation', () => {
      test.each(['1', '20', '100'])('accepts in-range limit=%s', async (value) => {
        const res = await getMetrics(`?limit=${value}`);

        expect(res.status).toBe(200);
      });

      test('rejects limit=0 with a 400', async () => {
        const res = await getMetrics('?limit=0');

        expect(res.status).toBe(400);
      });

      test('rejects limit=101 rather than clamping it to 100', async () => {
        const res = await getMetrics('?limit=101');

        expect(res.status).toBe(400);
      });

      test('rejects a grossly oversized limit', async () => {
        const res = await getMetrics('?limit=999999');

        expect(res.status).toBe(400);
      });

      test('rejects a negative limit', async () => {
        const res = await getMetrics('?limit=-5');

        expect(res.status).toBe(400);
      });

      test.each(['abc', '20abc', '1e5', '10.5', '0x10'])(
        'rejects malformed limit=%s rather than ignoring it',
        async (value) => {
          const res = await getMetrics(`?limit=${value}`);

          expect(res.status).toBe(400);
        }
      );

      test('returns a machine-readable code on limit rejection', async () => {
        const res = await getMetrics('?limit=999');

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(METRICS_VALIDATION_ERROR_CODE);
      });

      test('does not query the store when limit is out of range', async () => {
        const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

        const res = await getMetrics('?limit=99999');

        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('cursor validation', () => {
      test('rejects an empty cursor', async () => {
        const res = await getMetrics('?cursor=');

        expect(res.status).toBe(400);
      });

      test(`accepts a cursor-shaped value at the ${GET_METRICS_CURSOR_MAX_LENGTH}-char bound`, async () => {
        const res = await getMetrics(`?cursor=${str(GET_METRICS_CURSOR_MAX_LENGTH)}`);

        // The bound is not what rejects this; an opaque-but-undecodable cursor
        // is still a 400, so assert only that it is not a 5xx.
        expect(res.status).toBeLessThan(500);
      });

      test('rejects an oversized cursor', async () => {
        const res = await getMetrics(`?cursor=${str(GET_METRICS_CURSOR_MAX_LENGTH + 1)}`);

        expect(res.status).toBe(400);
      });

      test('does not query the store when the cursor is oversized', async () => {
        const spy = jest.spyOn(invoiceService, 'getSmeInvoiceCounts');

        const res = await getMetrics(`?cursor=${str(5000)}`);

        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('unknown params', () => {
      test('ignores unknown query params rather than rejecting them', async () => {
        const res = await getMetrics('?utm_source=email&sortBy=date');

        expect(res.status).toBe(200);
      });

      test('returns the unpaginated shape when only unknown params are supplied', async () => {
        const res = await getMetrics('?utm_source=email');

        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
        expect(res.body.meta.invoices).toBeUndefined();
      });
    });
  });
});
