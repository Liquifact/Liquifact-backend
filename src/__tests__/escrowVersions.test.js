'use strict';

/**
 * Tests for issue #134: LiquifactEscrow wasm version registry and contract list refresh.
 *
 * Covers:
 *  - escrowVersions.js: REGISTRY, isValidContractId, compareVersions, getOnChainSchemaVersion
 *  - contractListRefresh.js: runContractListRefresh
 *  - adminEscrow routes: POST /refresh, GET /version (auth + logic)
 */

jest.mock('../services/soroban');
jest.mock('../middleware/apiKey');

const { callSorobanContract } = require('../services/soroban');
const { apiKeyAuth } = require('../middleware/apiKey');

// apiKeyAuth always passes in tests (JWT path is used for most tests)
apiKeyAuth.mockImplementation((req, res, next) => next());

const {
  REGISTRY,
  isValidContractId,
  compareVersions,
  getOnChainSchemaVersion,
} = require('../config/escrowVersions');

const { runContractListRefresh } = require('../jobs/contractListRefresh');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../index');

const SECRET = process.env.JWT_SECRET || 'test-secret';
const adminToken = jwt.sign({ id: 1, role: 'admin' }, SECRET, { expiresIn: '1h' });
const VALID_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
    expect(res.body.message).toBe('Contract list refresh triggered.');
    expect(res.body.onChainVersion).toBe(3);
    expect(res.body.status).toBe('current');
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

  it('returns 202 when authenticated via X-API-KEY', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('X-API-KEY', 'any-key'); // apiKeyAuth is mocked to pass
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
    expect(res.body).toMatchObject({
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
});
