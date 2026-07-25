'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('sqlite3', () => ({
  verbose: jest.fn(() => ({
    Database: jest.fn(() => ({
      run: jest.fn(),
      get: jest.fn(),
      close: jest.fn(),
    })),
  })),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: { fromSecret: jest.fn(), random: jest.fn() },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn(),
}), { virtual: true });

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {},
}), { virtual: true });

jest.mock('../src/services/investorCommitment', () => ({
  persistCommitment: jest.fn(),
  updateCommitment: jest.fn(),
  findCommitments: jest.fn(),
}), { virtual: true });

jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn(() => 'CA3D5K7FJ3Z5Q6Q7W8E9R0T1Y2U3I4O5P6A7S8D9F0G1H2J3K4L5Z6X7C8V9B'),
  EscrowNotFoundError: class EscrowNotFoundError extends Error {},
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

jest.mock('../src/services/escrowBatchRead', () => ({
  batchReadEscrowStates: jest.fn(),
}));

// Mount only the real authentication, tenant resolution, and invest service so
// unrelated application routes cannot affect this focused security suite.
jest.mock('../src/app', () => {
  const express = require('express');
  const { authenticatedTenantStack } = require('../src/middleware/stacks');
  const { listOpportunities } = require('../src/services/investService');

  return {
    createApp: () => {
      const app = express();
      app.get('/api/invest/opportunities', ...authenticatedTenantStack, async (req, res, next) => {
        try {
          const result = await listOpportunities({
            tenantId: req.tenantId,
            page: req.query.page,
            limit: req.query.limit,
          });
          res.json({ data: result.data, meta: result.meta });
        } catch (error) {
          next(error);
        }
      });
      app.use((error, _req, res, _next) => {
        res.status(error.status || 500).json({ error: error.message });
      });
      return app;
    },
  };
});

const { batchReadEscrowStates } = require('../src/services/escrowBatchRead');
const { getOpportunities, listInvestments, listOpportunities } = require('../src/services/investService');
const { resolveEscrowAddress } = require('../src/config/escrowMap');
const logger = require('../src/logger');

let mockData = [];
let mockTotal = { total: 0 };
let mockOwnedInvoiceIds = null;
let mockLastWhereInColumn = null;

jest.mock('../src/db/knex', () => {
  const q = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn(function whereIn(column) {
      mockLastWhereInColumn = column;
      return this;
    }),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnThis(),
    clearSelect: jest.fn().mockReturnThis(),
    clearOrder: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn(() => Promise.resolve(mockTotal)),
    then(resolve, _reject) {
      const rows = mockLastWhereInColumn === 'id'
        ? (mockOwnedInvoiceIds || mockData.map(({ id }) => id)).map(id => ({ id }))
        : mockData;
      mockLastWhereInColumn = null;
      return Promise.resolve(rows).then(resolve);
    },
    catch: jest.fn().mockReturnThis(),
  };
  const knexMock = jest.fn(() => q);
  return knexMock;
});

const { createApp } = require('../src/app');
const db = require('../src/db/knex');
const sharedQuery = db();

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT = 'tenant-batch';

const THREE_INVOICES = [
  { id: 'inv_batch_a', funded_ratio: 10.0, maturity_date: '2026-07-01', yield_bps: 500 },
  { id: 'inv_batch_b', funded_ratio: 20.0, maturity_date: '2026-08-15', yield_bps: 600 },
  { id: 'inv_batch_c', funded_ratio: 30.0, maturity_date: '2026-09-30', yield_bps: 700 },
];

describe('Invest batch on-chain read behavior (/api/invest/opportunities)', () => {
  let app;
  let validToken;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockData = THREE_INVOICES;
    mockTotal = { total: THREE_INVOICES.length };
    mockOwnedInvoiceIds = null;
    mockLastWhereInColumn = null;

    validToken = jwt.sign(
      { id: 'user_batch', role: 'investor', tenantId: TENANT },
      TEST_SECRET,
      { expiresIn: '1h' },
    );
  });

  it('enriches all invoices with on-chain data when all batch reads succeed', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_batch_a', status: 'active', fundedAmount: 10000, legal_hold: false, funding_token: null },
        { invoiceId: 'inv_batch_b', status: 'active', fundedAmount: 20000, legal_hold: true, funding_token: null },
        { invoiceId: 'inv_batch_c', status: 'pending', fundedAmount: 0, legal_hold: false, funding_token: null },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0].onChain.status).toBe('active');
    expect(res.body.data[0].onChain.fundedAmount).toBe(10000);
    expect(res.body.data[1].onChain.legal_hold).toBe(true);
    expect(res.body.data[2].onChain.status).toBe('pending');
    expect(batchReadEscrowStates).toHaveBeenCalledTimes(1);
    expect(batchReadEscrowStates).toHaveBeenCalledWith(['inv_batch_a', 'inv_batch_b', 'inv_batch_c']);
  });

  it('still returns all invoices when a single on-chain read fails', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_batch_a', status: 'active', fundedAmount: 10000, legal_hold: false },
        { invoiceId: 'inv_batch_c', status: 'active', fundedAmount: 30000, legal_hold: false },
      ],
      errors: [
        { invoiceId: 'inv_batch_b', error: 'Contract not found', code: 'NOT_FOUND' },
      ],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0].onChain.status).toBe('active');
    expect(res.body.data[1].invoiceId).toBe('inv_batch_b');
    expect(res.body.data[1].onChain.status).toBeUndefined();
    expect(res.body.data[2].onChain.status).toBe('active');
  });

  it('returns 200 with all invoices (no on-chain enrichment) when entire batch fails', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [],
      errors: [
        { invoiceId: 'inv_batch_a', error: 'RPC unavailable', code: 'ECONNREFUSED' },
        { invoiceId: 'inv_batch_b', error: 'RPC unavailable', code: 'ECONNREFUSED' },
        { invoiceId: 'inv_batch_c', error: 'RPC unavailable', code: 'ECONNREFUSED' },
      ],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);

    for (const item of res.body.data) {
      expect(item.onChain.escrowAddress).toBe('CA3D5K7FJ3Z5Q6Q7W8E9R0T1Y2U3I4O5P6A7S8D9F0G1H2J3K4L5Z6X7C8V9B');
      expect(typeof item.onChain.escrowAddress).toBe('string');
      expect(item.onChain.status).toBeUndefined();
    }

    expect(res.body.meta.total).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 3 }),
      expect.stringContaining('on-chain reads failed'),
    );
  });

  it('calls batchReadEscrowStates even when no invoices match', async () => {
    mockData = [];
    mockTotal = { total: 0 };
    batchReadEscrowStates.mockResolvedValue({ results: [], errors: [] });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    expect(batchReadEscrowStates).toHaveBeenCalledTimes(1);
  });

  it('passes all invoice IDs to batchReadEscrowStates', async () => {
    const manyInvoices = Array.from({ length: 5 }, (_, i) => ({
      id: `inv_multi_${i}`,
      funded_ratio: i * 10,
      maturity_date: '2026-12-01',
      yield_bps: 500 + i * 100,
    }));

    mockData = manyInvoices;
    mockTotal = { total: 5 };

    const batchResults = manyInvoices.map((inv, i) => ({
      invoiceId: inv.id,
      status: 'active',
      fundedAmount: i * 10000,
      legal_hold: false,
    }));
    batchReadEscrowStates.mockResolvedValue({ results: batchResults, errors: [] });

    const res = await request(app)
      .get('/api/invest/opportunities?limit=5')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(batchReadEscrowStates).toHaveBeenCalledWith(
      ['inv_multi_0', 'inv_multi_1', 'inv_multi_2', 'inv_multi_3', 'inv_multi_4'],
    );
  });

  it('scopes batch reads to the authenticated tenant only', async () => {
    await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(sharedQuery.where).toHaveBeenCalledWith('tenant_id', TENANT);
  });

  it('filters mixed foreign-tenant IDs before reading or returning escrow data', async () => {
    mockData = [
      THREE_INVOICES[0],
      { id: 'inv_foreign', funded_ratio: 90, maturity_date: '2026-10-01', yield_bps: 900 },
    ];
    mockTotal = { total: 2 };
    mockOwnedInvoiceIds = ['inv_batch_a'];
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_batch_a', status: 'active', fundedAmount: 10000 },
        { invoiceId: 'inv_foreign', status: 'active', fundedAmount: 999999 },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(batchReadEscrowStates).toHaveBeenCalledWith(['inv_batch_a']);
    expect(res.body.data.map(item => item.invoiceId)).toEqual(['inv_batch_a']);
    expect(JSON.stringify(res.body)).not.toContain('inv_foreign');
    expect(JSON.stringify(res.body)).not.toContain('999999');
    expect(logger.warn).toHaveBeenCalledWith(
      {
        tenantId: TENANT,
        invoiceIds: ['inv_foreign'],
        count: 1,
      },
      expect.stringContaining('blocked cross-tenant or unknown invoice IDs'),
    );
  });

  it('filters an unknown invoice ID without invoking an escrow read for it', async () => {
    mockData = [
      { id: 'inv_unknown', funded_ratio: 0, maturity_date: '2026-10-01', yield_bps: 400 },
    ];
    mockTotal = { total: 1 };
    mockOwnedInvoiceIds = [];
    batchReadEscrowStates.mockResolvedValue({ results: [], errors: [] });

    const res = await request(app)
      .get('/api/invest/opportunities')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(batchReadEscrowStates).toHaveBeenCalledWith([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceIds: ['inv_unknown'], count: 1 }),
      expect.stringContaining('blocked cross-tenant or unknown invoice IDs'),
    );
  });

  it('requires tenant context for every investment opportunity listing service', async () => {
    await expect(getOpportunities()).rejects.toThrow('Missing tenant context');
    await expect(listInvestments()).rejects.toThrow('Missing tenant context');
    await expect(listOpportunities()).rejects.toThrow('Missing tenant context');
  });

  it('maps defaults and clamps pagination in the non-enriched opportunity listing', async () => {
    mockData = [
      { id: 'inv_defaults' },
      { id: 'inv_invalid_ratio', funded_ratio: 'not-a-number' },
    ];
    mockTotal = { total: '2' };

    const result = await getOpportunities({
      tenantId: TENANT,
      page: 'invalid',
      limit: 1000,
    });

    expect(result.data[0]).toEqual({
      invoiceId: 'inv_defaults',
      fundedBpsOfTarget: 0,
      maturityAt: null,
      yieldBpsDisplay: null,
      onChain: { escrowAddress: null, ledgerIndex: null },
    });
    expect(result.data[1].fundedBpsOfTarget).toBe(0);
    expect(result.meta).toEqual({ total: 2, page: 1, limit: 100, totalPages: 1 });
    expect(sharedQuery.limit).toHaveBeenCalledWith(100);

    mockData = [];
    mockTotal = { total: 0 };
    const emptyResult = await getOpportunities({ tenantId: TENANT, limit: 'invalid' });
    expect(emptyResult.meta).toEqual({ total: 0, page: 1, limit: 10, totalPages: 0 });
  });

  it('preserves per-ID errors and cursor metadata for owned cursor-list invoices', async () => {
    mockData = [THREE_INVOICES[0], THREE_INVOICES[1]];
    mockTotal = { total: 2 };
    batchReadEscrowStates.mockResolvedValue({
      results: [{ invoiceId: 'inv_batch_a', status: 'active', fundedAmount: 10000 }],
      errors: [{ invoiceId: 'inv_batch_b', error: 'RPC unavailable', code: 'ECONNREFUSED' }],
    });

    const result = await listInvestments({
      tenantId: TENANT,
      cursor: 'inv_previous',
      limit: 2,
    });

    expect(sharedQuery.andWhere).toHaveBeenCalledWith('id', '>', 'inv_previous');
    expect(batchReadEscrowStates).toHaveBeenCalledWith(['inv_batch_a', 'inv_batch_b']);
    expect(result.data[0].onChain).toEqual(expect.objectContaining({
      status: 'active',
      syncError: null,
    }));
    expect(result.data[1].onChain.syncError).toBe('RPC unavailable');
    expect(result.meta).toEqual({
      limit: 2,
      next_cursor: 'inv_batch_b',
      count: 2,
      has_more: true,
    });
  });

  it('returns empty cursor metadata without querying ownership for an empty set', async () => {
    mockData = [];
    mockTotal = { total: 0 };
    batchReadEscrowStates.mockResolvedValue({ results: [], errors: [] });

    const result = await listInvestments({ tenantId: TENANT, limit: 'invalid' });

    expect(result.data).toEqual([]);
    expect(batchReadEscrowStates).toHaveBeenCalledWith([]);
    expect(result.meta).toEqual({
      limit: 10,
      next_cursor: null,
      count: 0,
      has_more: false,
    });
  });

  it('leaves escrow addresses empty when tenant-owned mappings are unavailable', async () => {
    mockData = [THREE_INVOICES[0], THREE_INVOICES[1]];
    mockTotal = { total: 2 };
    resolveEscrowAddress
      .mockImplementationOnce(() => { throw new Error('mapping unavailable'); })
      .mockReturnValueOnce('');
    batchReadEscrowStates.mockResolvedValue({ results: [], errors: [] });

    const result = await listOpportunities({
      tenantId: TENANT,
      page: 'invalid',
      limit: 'invalid',
    });

    expect(result.data.map(item => item.onChain.escrowAddress)).toEqual(['', '']);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/invest/opportunities');
    expect(res.status).toBe(401);
    expect(batchReadEscrowStates).not.toHaveBeenCalled();
  });
});
