'use strict';

/**
 * @file Comprehensive tests for the health-listing endpoint and cursor pagination.
 *
 * Covers:
 *  - GET /api/health/checks — default first page
 *  - GET /api/health/checks — custom limit (clamping)
 *  - GET /api/health/checks — cursor navigation (first → next page)
 *  - GET /api/health/checks — last page (hasMore = false, nextCursor = null)
 *  - GET /api/health/checks — exact-page boundary (total divisible by limit)
 *  - GET /api/health/checks — over-limit clamp (limit > MAX_PAGE_SIZE)
 *  - GET /api/health/checks — invalid / tampered cursor → 400
 *  - GET /api/health/checks — unknown cursor (check no longer exists) → empty page
 *  - GET /api/health/checks — empty check list
 *  - healthCursorPagination utility — encodeHealthCursor / decodeHealthCursor
 *  - healthCursorPagination utility — resolveLimit edge cases
 *  - healthCursorPagination utility — TTL expiry
 */

// ── Module-level mocks must be declared before any require() ─────────────────

jest.mock('../src/services/health', () => ({
  listHealthChecks: jest.fn(),
}));

// We need to mock these so createApp() does not crash on missing env vars.
jest.mock('../src/services/storage', () => ({
  probeS3Connectivity: jest.fn().mockResolvedValue({ status: 'in_memory' }),
  runStartupStorageProbe: jest.fn().mockResolvedValue({ status: 'in_memory' }),
}));

jest.mock('../src/services/marketplaceService', () => ({
  getMarketplaceInvoices: jest.fn(),
  PUBLIC_INVESTABLE_INVOICE_STATUSES: ['verified', 'partially_funded'],
}));

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}));

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
  seedInvestorLocks: jest.fn(),
  clearInvestorLocks: jest.fn(),
  getInvestorLocksByAddress: jest.fn(),
  getAllInvestorLocks: jest.fn(),
  getInvestorLock: jest.fn(),
  paginateInvestorLocks: jest.fn(),
}));

jest.mock('../src/config/escrowVersions', () => ({
  getOnChainSchemaVersion: jest.fn(),
  compareVersions: jest.fn(),
}));

jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  readEscrowStateWithAttestations: jest.fn(),
  readFundedAmount: jest.fn(),
  fetchLegalHold: jest.fn(),
  fetchAttestationAppendLog: jest.fn(),
  validateInvoiceId: jest.fn(),
  getEscrowStateWithProjection: jest.fn(),
}));

jest.mock('../src/jobs/retentionPurge', () => ({
  scheduleRetentionPurge: jest.fn(),
  validatePiiFields: jest.fn(),
  getActivePolicies: jest.fn(),
  getEligibleInvoices: jest.fn(),
  getExecutionStatus: jest.fn(),
  getRecentExecutions: jest.fn(),
}));

jest.mock('../src/jobs/contractListRefresh', () => ({
  runContractListRefresh: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

const request = require('supertest');
const { createApp } = require('../src/app');
const { listHealthChecks } = require('../src/services/health');
const {
  encodeHealthCursor,
  decodeHealthCursor,
  resolveLimit,
  HealthCursorError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} = require('../src/utils/healthCursorPagination');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a fixed set of N mock health-check records.  All share the same
 * `timestamp` (so cursor tiebreaking via `id` is exercised in edge cases) but
 * have unique `id` values that sort in insertion order.
 *
 * @param {number} n
 * @param {string} [timestamp]
 * @returns {Array<{id: string, name: string, status: string, timestamp: string, detail: {}}>}
 */
function buildChecks(n, timestamp = '2026-07-24T07:00:00.000Z') {
  const names = [
    'soroban',
    'database',
    'kyc',
    'indexerStaleness',
    'storage',
    'reconciliation',
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: names[i] || `check-${i}`,
    name: `Check ${i}`,
    status: 'healthy',
    timestamp,
    detail: { status: 'healthy' },
  }));
}

// ── Test environment setup ───────────────────────────────────────────────────

let app;
let savedEnv;

beforeAll(() => {
  savedEnv = process.env;
  process.env = {
    ...savedEnv,
    JWT_SECRET: 'supersecret32characterlongstringforzod',
    NODE_ENV: 'test',
  };
  app = createApp();
});

afterAll(() => {
  process.env = savedEnv;
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — healthCursorPagination utility
// ─────────────────────────────────────────────────────────────────────────────

describe('healthCursorPagination utility', () => {
  const ENV_TEST = { NODE_ENV: 'test', JWT_SECRET: 'test-secret-value-for-unit-tests-32chars' };

  describe('encodeHealthCursor', () => {
    it('returns a string with exactly one dot separator', () => {
      const cursor = encodeHealthCursor({ timestamp: '2026-01-01T00:00:00.000Z', id: 'soroban', env: ENV_TEST });
      expect(typeof cursor).toBe('string');
      const parts = cursor.split('.');
      // base64url payload (may contain dots from base64) then hex sig — we
      // check for at least two segments and that the last segment looks like hex.
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const sig = parts[parts.length - 1];
      expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
    });

    it('embeds the correct timestamp and id', () => {
      const ts = '2026-03-15T12:00:00.000Z';
      const id = 'database';
      const cursor = encodeHealthCursor({ timestamp: ts, id, env: ENV_TEST });
      const decoded = decodeHealthCursor(cursor, ENV_TEST);
      expect(decoded.timestamp).toBe(ts);
      expect(decoded.id).toBe(id);
    });

    it('throws HealthCursorError when timestamp is missing', () => {
      expect(() =>
        encodeHealthCursor({ timestamp: '', id: 'soroban', env: ENV_TEST }),
      ).toThrow(HealthCursorError);
    });

    it('throws HealthCursorError when id is missing', () => {
      expect(() =>
        encodeHealthCursor({ timestamp: '2026-01-01T00:00:00.000Z', id: '', env: ENV_TEST }),
      ).toThrow(HealthCursorError);
    });
  });

  describe('decodeHealthCursor', () => {
    it('round-trips a valid cursor', () => {
      const ts = '2026-06-01T08:30:00.000Z';
      const id = 'kyc';
      const cursor = encodeHealthCursor({ timestamp: ts, id, env: ENV_TEST });
      const result = decodeHealthCursor(cursor, ENV_TEST);
      expect(result).toMatchObject({ timestamp: ts, id });
      expect(typeof result.iat).toBe('number');
    });

    it('throws on a cursor with no dot separator', () => {
      expect(() => decodeHealthCursor('nodottinhere', ENV_TEST)).toThrow(HealthCursorError);
    });

    it('throws on a tampered payload', () => {
      const cursor = encodeHealthCursor({
        timestamp: '2026-01-01T00:00:00.000Z',
        id: 'soroban',
        env: ENV_TEST,
      });
      // Flip a character in the payload portion.
      const [payload, sig] = [cursor.slice(0, cursor.lastIndexOf('.')), cursor.slice(cursor.lastIndexOf('.') + 1)];
      const tampered = `${payload.slice(0, -1)}X.${sig}`;
      expect(() => decodeHealthCursor(tampered, ENV_TEST)).toThrow(HealthCursorError);
    });

    it('throws on a tampered signature', () => {
      const cursor = encodeHealthCursor({
        timestamp: '2026-01-01T00:00:00.000Z',
        id: 'soroban',
        env: ENV_TEST,
      });
      const tamperedSig = cursor.replace(/.$/, cursor.endsWith('a') ? 'b' : 'a');
      expect(() => decodeHealthCursor(tamperedSig, ENV_TEST)).toThrow(HealthCursorError);
    });

    it('throws when cursor is not a string', () => {
      expect(() => decodeHealthCursor(null, ENV_TEST)).toThrow(HealthCursorError);
      expect(() => decodeHealthCursor(42, ENV_TEST)).toThrow(HealthCursorError);
    });

    it('throws on an expired cursor when TTL is enabled', () => {
      // Freeze time so we can craft an old cursor.
      const origDateNow = Date.now;
      // iat = (now - 7200s) → expired with 3600s TTL.
      const past = Math.floor(Date.now() / 1000) - 7200;
      jest.spyOn(Date, 'now').mockReturnValue(past * 1000);

      const oldCursor = encodeHealthCursor({
        timestamp: '2026-01-01T00:00:00.000Z',
        id: 'soroban',
        env: ENV_TEST,
      });

      Date.now.mockRestore();

      const ttlEnv = { ...ENV_TEST, CURSOR_TTL_ENABLED: 'true', CURSOR_TTL_SECONDS: '3600' };
      expect(() => decodeHealthCursor(oldCursor, ttlEnv)).toThrow(HealthCursorError);
      expect(() => decodeHealthCursor(oldCursor, ttlEnv)).toThrow(/expired/);
    });

    it('does not throw on an in-window cursor when TTL is enabled', () => {
      const env = { ...ENV_TEST, CURSOR_TTL_ENABLED: 'true', CURSOR_TTL_SECONDS: '3600' };
      const cursor = encodeHealthCursor({ timestamp: '2026-01-01T00:00:00.000Z', id: 'soroban', env });
      expect(() => decodeHealthCursor(cursor, env)).not.toThrow();
    });
  });

  describe('resolveLimit', () => {
    it(`returns DEFAULT_PAGE_SIZE (${DEFAULT_PAGE_SIZE}) when undefined`, () => {
      expect(resolveLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('returns DEFAULT_PAGE_SIZE for NaN input', () => {
      expect(resolveLimit('foo')).toBe(DEFAULT_PAGE_SIZE);
    });

    it('clamps limit below 1 to DEFAULT_PAGE_SIZE', () => {
      expect(resolveLimit('0')).toBe(DEFAULT_PAGE_SIZE);
      expect(resolveLimit('-5')).toBe(DEFAULT_PAGE_SIZE);
    });

    it(`clamps limit above MAX_PAGE_SIZE (${MAX_PAGE_SIZE}) to MAX_PAGE_SIZE`, () => {
      expect(resolveLimit(String(MAX_PAGE_SIZE + 50))).toBe(MAX_PAGE_SIZE);
      expect(resolveLimit('999')).toBe(MAX_PAGE_SIZE);
    });

    it('returns the exact value when within [1, MAX_PAGE_SIZE]', () => {
      expect(resolveLimit('1')).toBe(1);
      expect(resolveLimit('10')).toBe(10);
      expect(resolveLimit(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — GET /api/health/checks
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/health/checks', () => {
  // Six checks — matches the real check roster.
  const ALL_CHECKS = buildChecks(6);

  describe('default first page', () => {
    it('returns 200 with data, meta, and message', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.message).toBe('Health checks retrieved successfully.');
    });

    it('returns all checks when total <= default limit', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks');

      expect(res.body.data).toHaveLength(ALL_CHECKS.length);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
      expect(res.body.meta.total).toBe(ALL_CHECKS.length);
    });

    it('returns meta.limit equal to the resolved page size', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks?limit=3');

      expect(res.body.meta.limit).toBe(3);
    });

    it('each record has id, name, status, timestamp, and detail fields', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks');

      res.body.data.forEach((record) => {
        expect(record).toHaveProperty('id');
        expect(record).toHaveProperty('name');
        expect(record).toHaveProperty('status');
        expect(record).toHaveProperty('timestamp');
        expect(record).toHaveProperty('detail');
      });
    });
  });

  describe('custom limit', () => {
    it('returns only the first N checks when limit < total', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks?limit=2');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta.hasMore).toBe(true);
      expect(typeof res.body.meta.nextCursor).toBe('string');
    });
  });

  describe('cursor navigation', () => {
    it('returns the next page when a valid cursor is supplied', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      // Get first page of 2.
      const firstRes = await request(app).get('/api/health/checks?limit=2');
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.meta.hasMore).toBe(true);
      const cursor = firstRes.body.meta.nextCursor;
      expect(typeof cursor).toBe('string');

      // Get second page using the cursor.
      const secondRes = await request(app).get(`/api/health/checks?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(secondRes.status).toBe(200);
      expect(secondRes.body.data).toHaveLength(2);

      // Ensure second page has different items from the first.
      const firstIds = firstRes.body.data.map((c) => c.id);
      const secondIds = secondRes.body.data.map((c) => c.id);
      secondIds.forEach((id) => expect(firstIds).not.toContain(id));
    });

    it('pages through all records without repetition', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const seen = [];
      let cursor;

      do {
        const url = cursor
          ? `/api/health/checks?limit=2&cursor=${encodeURIComponent(cursor)}`
          : '/api/health/checks?limit=2';
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        res.body.data.forEach((c) => seen.push(c.id));
        cursor = res.body.meta.hasMore ? res.body.meta.nextCursor : null;
      } while (cursor);

      expect(seen).toHaveLength(ALL_CHECKS.length);
      expect(new Set(seen).size).toBe(ALL_CHECKS.length);
    });
  });

  describe('last page', () => {
    it('sets hasMore=false and nextCursor=null on the last page', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      // Request limit equal to total — should be a single complete page.
      const res = await request(app).get(`/api/health/checks?limit=${ALL_CHECKS.length}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(ALL_CHECKS.length);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });
  });

  describe('exact-page boundary', () => {
    it('does not emit nextCursor when total is exactly divisible by limit', async () => {
      // 4 checks, limit 2 → page 1 has 2 items + hasMore; page 2 has 2 items + no hasMore.
      const checks4 = buildChecks(4);
      listHealthChecks.mockResolvedValue(checks4);

      const page1 = await request(app).get('/api/health/checks?limit=2');
      expect(page1.body.meta.hasMore).toBe(true);

      const page2 = await request(app).get(
        `/api/health/checks?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(2);
      expect(page2.body.meta.hasMore).toBe(false);
      expect(page2.body.meta.nextCursor).toBeNull();
    });
  });

  describe('over-limit clamp', () => {
    it(`clamps limit > ${MAX_PAGE_SIZE} to ${MAX_PAGE_SIZE}`, async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks?limit=9999');

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(MAX_PAGE_SIZE);
    });
  });

  describe('invalid cursor → 400', () => {
    it('returns 400 with fieldErrors.cursor for a random string', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const res = await request(app).get('/api/health/checks?cursor=notacursor');

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors).toBeDefined();
      expect(res.body.fieldErrors.cursor).toBeDefined();
    });

    it('returns 400 for a cursor with a tampered payload', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      // Build a real cursor then corrupt the payload.
      const real = encodeHealthCursor({
        timestamp: ALL_CHECKS[0].timestamp,
        id: ALL_CHECKS[0].id,
      });
      const tampered = real.slice(0, -2) + 'ZZ';

      const res = await request(app).get(
        `/api/health/checks?cursor=${encodeURIComponent(tampered)}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.cursor).toBeDefined();
    });

    it('returns 400 for a base64url blob without a signature', async () => {
      listHealthChecks.mockResolvedValue(ALL_CHECKS);

      const nosig = Buffer.from(JSON.stringify({ timestamp: 'x', id: 'y', iat: 1 })).toString('base64url');
      const res = await request(app).get(`/api/health/checks?cursor=${encodeURIComponent(nosig)}`);

      expect(res.status).toBe(400);
    });
  });

  describe('unknown cursor (check no longer exists)', () => {
    it('returns an empty page rather than restarting', async () => {
      // First page built from one set of checks…
      const checksA = buildChecks(6);
      listHealthChecks.mockResolvedValue(checksA);

      const page1 = await request(app).get('/api/health/checks?limit=2');
      const cursor = page1.body.meta.nextCursor;

      // …then the service returns a completely different roster (no matching ids).
      const checksB = [
        { id: 'new-check-1', name: 'New 1', status: 'healthy', timestamp: '2026-07-25T00:00:00.000Z', detail: {} },
        { id: 'new-check-2', name: 'New 2', status: 'healthy', timestamp: '2026-07-25T00:00:00.000Z', detail: {} },
      ];
      listHealthChecks.mockResolvedValue(checksB);

      const res = await request(app).get(
        `/api/health/checks?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.hasMore).toBe(false);
    });
  });

  describe('empty check list', () => {
    it('returns an empty data array with hasMore=false', async () => {
      listHealthChecks.mockResolvedValue([]);

      const res = await request(app).get('/api/health/checks');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
      expect(res.body.meta.total).toBe(0);
    });
  });

  describe('upstream error handling', () => {
    it('propagates unexpected errors to the error handler', async () => {
      listHealthChecks.mockRejectedValue(new Error('Unexpected internal error'));

      const res = await request(app).get('/api/health/checks');

      expect(res.status).toBe(500);
    });
  });
});
