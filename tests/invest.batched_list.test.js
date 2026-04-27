'use strict';

const request = require('supertest');
const { createApp } = require('../src/index');
const { opportunities } = require('../src/services/investService');
const { batchReadEscrowStates } = require('../src/services/escrowBatchRead');
const jwt = require('jsonwebtoken');

// Mock batch read
jest.mock('../src/services/escrowBatchRead', () => ({
  batchReadEscrowStates: jest.fn(),
}));

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
const validToken = jwt.sign({ id: 'user_investor', role: 'investor' }, TEST_SECRET, { expiresIn: '1h' });

describe('Invest Batched List API (/api/invest/list)', () => {
  let app;

  beforeAll(() => {
    app = createApp({ enableTestRoutes: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return paginated opportunities with on-chain enrichment', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_7788', status: 'active', fundedAmount: 5000, legal_hold: false },
        { invoiceId: 'inv_2244', status: 'pending', fundedAmount: 0, legal_hold: true },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/list')
      .set('Authorization', `Bearer ${validToken}`)
      .query({ limit: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.next_cursor).toBe('inv_2244');
    expect(res.body.meta.has_more).toBe(true);
    
    // Check enrichment
    expect(res.body.data[0].onChain.status).toBe('active');
    expect(res.body.data[1].onChain.legal_hold).toBe(true);
  });

  it('should handle pagination via cursor', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_9900', status: 'active', fundedAmount: 0, legal_hold: false },
      ],
      errors: [],
    });

    const res = await request(app)
      .get('/api/invest/list')
      .set('Authorization', `Bearer ${validToken}`)
      .query({ cursor: 'inv_2244', limit: 1 })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].invoiceId).toBe('inv_9900');
    expect(res.body.meta.next_cursor).toBeNull();
    expect(res.body.meta.has_more).toBe(false);
  });

  it('should include error messages when on-chain read fails for some items', async () => {
    batchReadEscrowStates.mockResolvedValue({
      results: [
        { invoiceId: 'inv_7788', status: 'active', fundedAmount: 5000, legal_hold: false },
      ],
      errors: [
        { invoiceId: 'inv_2244', error: 'RPC Timeout', code: 'ETIMEDOUT' },
      ],
    });

    const res = await request(app)
      .get('/api/invest/list')
      .set('Authorization', `Bearer ${validToken}`)
      .query({ limit: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[1].onChain.syncError).toBe('RPC Timeout');
  });
});
