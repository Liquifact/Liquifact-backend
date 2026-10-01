'use strict';

/**
 * Tests for issue #134: LiquifactEscrow wasm version registry and contract list refresh.
 *
 * Covers:
 *  - escrowVersions.js: REGISTRY, isValidContractId, compareVersions, getOnChainSchemaVersion
 *  - contractListRefresh.js: runContractListRefresh
 *  - adminEscrow routes: POST /refresh, GET /version (auth + logic)
 *  - escrowMap.js: compatibility contracts (getEscrowMap, resolveEscrow, invariants)
 */

jest.mock('../services/soroban');
jest.mock('../middleware/apiKeyAuth', () => ({
  authenticateApiKey: jest.fn(() => (req, res, next) => next()),
  API_KEY_HEADER: 'x-api-key',
  timingSafeStringEqual: (a, b) => a === b,
}));

const originalRpcUrl = process.env.SOROBAN_RPC_URL;
beforeEach(() => {
  process.env.SOROBAN_RPC_URL = 'http://localhost:8000';
});
afterAll(() => {
  if (originalRpcUrl === undefined) {
    delete process.env.SOROBAN_RPC_URL;
  } else {
    process.env.SOROBAN_RPC_URL = originalRpcUrl;
  }
});

const { callSorobanContract } = require('../services/soroban');

// Load escrowVersions defensively so a broken/partial module does not abort
// the entire Jest file at require-time. Missing exports fall back to safe
// stubs; individual tests will fail with clear assertions instead of a
// module-load SyntaxError.
let escrowVersions = {};
try {
  escrowVersions = require('../config/escrowVersions') || {};
} catch (err) {
  // Surface the load failure through a single, diagnosable test below.
  escrowVersions = { __loadError: err };
}

const {
  REGISTRY = {},
  isValidContractId = () => false,
  compareVersions = () => ({ status: 'unknown', knownVersion: null, onChainVersion: null }),
  getOnChainSchemaVersion = async () => {
    const e = new Error('escrowVersions module failed to load');
    e.code = 'RPC_ERROR';
    throw e;
  },
  getKnownVersion = () => null,
  getHighestKnownVersion = () => null,
  normalizeSchemaVersion = () => null,
  ESCROW_VERSION_ERROR_CODES = {},
} = escrowVersions;

const {
  getEscrowMap,
  resolveEscrow,
  ESCROW_MAP,
  ESCROW_MAP_INVARIANTS,
} = require('../config/escrowMap');

const { runContractListRefresh } = require('../jobs/contractListRefresh');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../index');

const SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * Creates an admin JWT token with tenant context for route-level tests.
 * The extractTenant middleware requires a tenantId claim or x-tenant-id header.
 *
 * @param {object} [overrides] - Additional JWT claims.
 * @returns {string} Signed JWT.
 */
function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { id: 1, role: 'admin', tenantId: 'test-tenant', ...overrides },
    SECRET,
    { expiresIn: '1h' }
  );
}

const adminToken = makeAdminToken();
const VALID_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_ID_2 = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// ─── module load guard ───────────────────────────────────────────────────────

describe('escrowVersions module load', () => {
  it('loads without a SyntaxError', () => {
    expect(escrowVersions.__loadError).toBeUndefined();
  });
});

// ─── escrowVersions: REGISTRY ─────────────────────────────────────────────────

describe('REGISTRY', () => {
  it('contains at least one entry', () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
  });

  it('maps semver strings to positive integers', () => {
    for (const [semver, schemaVersion] of Object.entries(REGISTRY)) {
      expect(typeof semver).toBe('string');
      expect(Number.isInteger(schemaVersion)).toBe(true);
      expect(schemaVersion).toBeGreaterThan(0);
    }
  });

  it('includes known versions 1.0.0, 1.1.0, 1.2.0', () => {
    expect(REGISTRY['1.0.0']).toBe(1);
    expect(REGISTRY['1.1.0']).toBe(2);
    expect(REGISTRY['1.2.0']).toBe(3);
  });

  it('is frozen to preserve the compatibility contract', () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true);
  });

  it('maps each schema version to exactly one semver (no duplicates)', () => {
    const seen = new Map();
    for (const [semver, schemaVersion] of Object.entries(REGISTRY)) {
      expect(seen.has(schemaVersion)).toBe(false);
      seen.set(schemaVersion, semver);
    }
  });
});

// ─── escrowVersions: getKnownVersion / getHighestKnownVersion ────────────────

describe('getKnownVersion', () => {
  it('returns the semver for a known schema version', () => {
    expect(getKnownVersion(1)).toBe('1.0.0');
    expect(getKnownVersion(2)).toBe('1.1.0');
    expect(getKnownVersion(3)).toBe('1.2.0');
  });

  it('returns null for an unknown schema version', () => {
    expect(getKnownVersion(0)).toBeNull();
    expect(getKnownVersion(99)).toBeNull();
  });

  it('returns null for non-integer input', () => {
    expect(getKnownVersion('3')).toBeNull();
    expect(getKnownVersion(3.5)).toBeNull();
    expect(getKnownVersion(null)).toBeNull();
    expect(getKnownVersion(undefined)).toBeNull();
  });
});

describe('getHighestKnownVersion', () => {
  it('returns the highest registry entry deterministically', () => {
    expect(getHighestKnownVersion()).toEqual({ semver: '1.2.0', schemaVersion: 3 });
  });
});

// ─── escrowVersions: normalizeSchemaVersion ──────────────────────────────────

describe('normalizeSchemaVersion', () => {
  it('accepts positive integers', () => {
    expect(normalizeSchemaVersion(1)).toBe(1);
    expect(normalizeSchemaVersion(3)).toBe(3);
  });

  it('accepts numeric strings', () => {
    expect(normalizeSchemaVersion('3')).toBe(3);
  });

  it('rejects non-integer, negative, and non-numeric values', () => {
    expect(normalizeSchemaVersion(0)).toBeNull();
    expect(normalizeSchemaVersion(-1)).toBeNull();
    expect(normalizeSchemaVersion(1.5)).toBeNull();
    expect(normalizeSchemaVersion('abc')).toBeNull();
    expect(normalizeSchemaVersion(null)).toBeNull();
    expect(normalizeSchemaVersion(undefined)).toBeNull();
    expect(normalizeSchemaVersion({})).toBeNull();
  });
});

// ─── escrowVersions: ESCROW_VERSION_ERROR_CODES ──────────────────────────────

describe('ESCROW_VERSION_ERROR_CODES', () => {
  it('exposes stable error codes for callers', () => {
    expect(ESCROW_VERSION_ERROR_CODES.INVALID_CONTRACT_ID).toBe('INVALID_CONTRACT_ID');
    expect(ESCROW_VERSION_ERROR_CODES.RPC_ERROR).toBe('RPC_ERROR');
  });
});

// ─── escrowVersions: isValidContractId ───────────────────────────────────────

describe('isValidContractId', () => {
  it('accepts a valid Stellar contract address', () => {
    expect(isValidContractId(VALID_ID)).toBe(true);
  });

  it('rejects an address that is too short', () => {
    expect(isValidContractId('CAAA')).toBe(false);
  });

  it('rejects an address starting with wrong letter', () => {
    expect(isValidContractId('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidContractId(null)).toBe(false);
    expect(isValidContractId(undefined)).toBe(false);
    expect(isValidContractId(123)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidContractId('')).toBe(false);
  });
});

// ─── escrowVersions: compareVersions ─────────────────────────────────────────

describe('compareVersions', () => {
  it('returns current when on-chain version matches highest registry entry', () => {
    const result = compareVersions(3); // 1.2.0 -> 3
    expect(result.status).toBe('current');
    expect(result.knownVersion).toBe('1.2.0');
  });

  it('returns ahead when on-chain version exceeds all registry entries', () => {
    const result = compareVersions(99);
    expect(result.status).toBe('ahead');
    expect(result.knownVersion).toBe('1.2.0'); // highest known
  });

  it('returns unknown with matching semver for a lower known version', () => {
    const result = compareVersions(1); // 1.0.0 -> 1
    expect(result.status).toBe('unknown');
    expect(result.knownVersion).toBe('1.0.0');
  });

  it('returns ahead for version 42 (higher than max)', () => {
    const result = compareVersions(42);
    expect(result.status).toBe('ahead');
  });

  it('returns unknown/null for version 0 (not in registry, lower than max)', () => {
    const result = compareVersions(0);
    expect(result.status).toBe('unknown');
    expect(result.knownVersion).toBeNull();
  });

  it('is deterministic for invalid input (null/undefined/NaN)', () => {
    for (const bad of [null, undefined, NaN, '3', 1.5, -1]) {
      const result = compareVersions(bad);
      expect(result.status).toBe('unknown');
      expect(result.knownVersion).toBeNull();
      expect(result.onChainVersion).toBeNull();
    }
  });

  it('accepts numeric strings for known versions', () => {
    const result = compareVersions('3');
    expect(result.status).toBe('current');
    expect(result.knownVersion).toBe('1.2.0');
  });

  it('returns a stable shape for every status', () => {
    for (const input of [0, 1, 3, 99]) {
      const result = compareVersions(input);
      expect(Object.keys(result).sort()).toEqual(
        ['knownVersion', 'onChainVersion', 'status'].sort()
      );
    }
  });
});

// ─── escrowVersions: getOnChainSchemaVersion ─────────────────────────────────

describe('getOnChainSchemaVersion', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('rejects with INVALID_CONTRACT_ID when no contractId and no env var', async () => {
    await expect(getOnChainSchemaVersion()).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('rejects with INVALID_CONTRACT_ID for a bad contract address', async () => {
    await expect(getOnChainSchemaVersion('bad-id')).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('uses ESCROW_CONTRACT_ID env var when no argument given', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockRejectedValueOnce(new Error('RPC_NOT_IMPLEMENTED'));
    await expect(getOnChainSchemaVersion()).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });

  it('wraps RPC errors as RPC_ERROR', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('network timeout'));
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
  });

  it('resolves with the value returned by callSorobanContract', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const version = await getOnChainSchemaVersion(VALID_ID);
    expect(version).toBe(3);
  });

  it('normalizes numeric-string RPC responses', async () => {
    callSorobanContract.mockResolvedValueOnce('3');
    const version = await getOnChainSchemaVersion(VALID_ID);
    expect(version).toBe(3);
  });

  it('rejects with RPC_ERROR when RPC returns a malformed value', async () => {
    callSorobanContract.mockResolvedValueOnce('not-a-version');
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
  });

  it('rejects with RPC_ERROR when RPC returns null/undefined', async () => {
    callSorobanContract.mockResolvedValueOnce(null);
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
  });

  it('does not leak the raw RPC error message in the thrown error', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('secret internal detail'));
    try {
      await getOnChainSchemaVersion(VALID_ID);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err.code).toBe('RPC_ERROR');
      expect(String(err.message)).not.toContain('secret internal detail');
    }
  });
});

// ─── contractListRefresh: runContractListRefresh ──────────────────────────────

describe('runContractListRefresh', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('returns structured result on success', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockResolvedValueOnce(3);
    const result = await runContractListRefresh();
    expect(result).toEqual({ onChainVersion: 3, knownVersion: '1.2.0', status: 'current' });
  });

  it('propagates RPC_ERROR from getOnChainSchemaVersion', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockRejectedValueOnce(new Error('timeout'));
    await expect(runContractListRefresh()).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });

  it('propagates INVALID_CONTRACT_ID when env var is missing', async () => {
    await expect(runContractListRefresh()).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('accepts an explicit contractId override', async () => {
    callSorobanContract.mockResolvedValueOnce(2);
    const result = await runContractListRefresh(VALID_ID);
    expect(result.onChainVersion).toBe(2);
    expect(result.status).toBe('unknown'); // 2 < 3 (max) and matches 1.1.0
  });

  it('returns a stable result shape on success', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockResolvedValueOnce(3);
    const result = await runContractListRefresh();
    expect(Object.keys(result).sort()).toEqual(
      ['knownVersion', 'onChainVersion', 'status'].sort()
    );
  });

  it('rejects with INVALID_CONTRACT_ID for a malformed explicit contractId', async () => {
    await expect(runContractListRefresh('bad-id')).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('is safe under concurrent invocation (no shared mutable state)', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockResolvedValue(3);
    const results = await Promise.all([
      runContractListRefresh(),
      runContractListRefresh(),
      runContractListRefresh(),
    ]);
    for (const result of results) {
      expect(result).toEqual({ onChainVersion: 3, knownVersion: '1.2.0', status: 'current' });
    }
  });
});

// ─── Admin routes: POST /api/admin/escrow/refresh ────────────────────────────

describe('POST /api/admin/escrow/refresh', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
  });

  afterAll(() => {
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('returns 401 when no auth is provided', async () => {
    const res = await request(app).post('/api/admin/escrow/refresh');
    expect(res.status).toBe(401);
  });

  it('returns 202 with result on success (JWT auth)', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    // Response goes through standardized envelope: payload is in res.body.data
    expect(res.body.data.message).toBe('Contract list refresh triggered.');
    expect(res.body.data.onChainVersion).toBe(3);
    expect(res.body.data.status).toBe('current');
  });

  it('returns 400 when ESCROW_CONTRACT_ID is invalid', async () => {
    process.env.ESCROW_CONTRACT_ID = 'bad';
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 502 on RPC failure', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('returns 502 when RPC returns a malformed value', async () => {
    callSorobanContract.mockResolvedValueOnce('not-a-version');
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('does not expose raw RPC error details in the response body', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('secret internal detail'));
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });

  it('returns 202 when authenticated via X-API-KEY', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('x-tenant-id', 'test-tenant')
      .set('X-API-KEY', 'any-key');
    expect(res.status).toBe(202);
  });
});

// ─── Admin routes: GET /api/admin/escrow/version ─────────────────────────────

describe('GET /api/admin/escrow/version', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
  });

  afterAll(() => {
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('returns 401 when no auth is provided', async () => {
    const res = await request(app).get('/api/admin/escrow/version');
    expect(res.status).toBe(401);
  });

  it('returns 200 with version info on success', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Response goes through standardized envelope: payload is in res.body.data
    expect(res.body.data).toMatchObject({
      onChainVersion: 3,
      knownVersion: '1.2.0',
      status: 'current',
    });
  });

  it('returns 400 when ESCROW_CONTRACT_ID is invalid', async () => {
    process.env.ESCROW_CONTRACT_ID = 'bad';
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 502 on RPC failure', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('rpc down'));
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('returns 502 when RPC returns a malformed value', async () => {
    callSorobanContract.mockResolvedValueOnce('not-a-version');
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('does not expose raw RPC error details in the response body', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('secret internal detail'));
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});
