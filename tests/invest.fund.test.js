'use strict';

/**
 * tests/invest.fund.test.js
 *
 * Covers POST /api/invest/fund-invoice:
 *   - validateFundInvoiceBody: all invalid-input branches
 *   - KYC gate: unverified principal is blocked; smeId from body is ignored
 *   - Happy path: stubbed/delegated/submitted status mapping, error paths
 */

// ─── Knex mock ─────────────────────────────────────────────────────────────
// Override the global setup mock so kyc_records always returns null (no DB
// record → service falls back to in-memory mockKycRecords).
jest.mock('../src/db/knex', () => {
  const chain = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null), // no DB record → use in-memory mock
    insert: jest.fn().mockResolvedValue([{ id: 'mock-id' }]),
    returning: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
  };
  const knex = jest.fn(() => chain);
  knex.fn = { now: jest.fn() };
  return knex;
});

// ─── Service mocks ─────────────────────────────────────────────────────────

jest.mock('../src/services/escrowSubmit', () => ({
  submitFundEscrow: jest.fn(),
  EscrowSubmitError: class EscrowSubmitError extends Error {
    constructor(msg) { super(msg); this.name = 'EscrowSubmitError'; }
  },
}));

jest.mock('../src/config/escrowMap', () => ({
  resolveEscrowAddress: jest.fn(),
  EscrowNotFoundError: class EscrowNotFoundError extends Error {
    constructor(id) { super(`No escrow for ${id}`); this.name = 'EscrowNotFoundError'; }
  },
}));

jest.mock('../src/services/investorCommitment', () => {
  const actual = jest.requireActual('../src/services/investorCommitment');
  return {
    ...actual,
    persistCommitment: jest.fn(),
  };
});

jest.mock('../src/middleware/idempotency', () => (req, res, next) => next());

// ─── Imports (after mocks) ─────────────────────────────────────────────────

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const kycService = require('../src/services/kycService');
const { submitFundEscrow } = require('../src/services/escrowSubmit');
const { resolveEscrowAddress, EscrowNotFoundError } = require('../src/config/escrowMap');
const { persistCommitment } = require('../src/services/investorCommitment');

// ─── Constants ─────────────────────────────────────────────────────────────

const JWT_SECRET   = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long-string-for-jest';
// Valid Stellar G-prefixed public key: exactly 56 chars matching ^[CG][A-Z2-7]{55}$
const VALID_ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const VALID_INVOICE = 'inv-001';
const VALID_ESCROW  = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const TENANT_ID     = 'tenant-test';

const VERIFIED_SME = 'sme-fund-verified';
const PENDING_SME  = 'sme-fund-pending';   // never registered → status = pending

/** Sign a JWT for the fund-invoice endpoint */
function makeToken(smeId) {
  return jwt.sign(
    { sub: `user-${smeId}`, smeId, tenantId: TENANT_ID },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** GET a supertest agent against the real app (auth goes through properly) */
function agent() {
  return request(createApp());
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  await kycService.verifySmeSafe(VERIFIED_SME);
  // PENDING_SME is intentionally never registered → returns { status:'pending' }
});

beforeEach(() => {
  jest.clearAllMocks();
  resolveEscrowAddress.mockReturnValue(VALID_ESCROW);
  submitFundEscrow.mockResolvedValue({ status: 'stubbed', unsignedXdr: null, txHash: null, ledger: null });
  persistCommitment.mockResolvedValue({ id: 'cmt-1' });
});

// ─── validateFundInvoiceBody ───────────────────────────────────────────────

describe('POST /api/invest/fund-invoice — body validation (400)', () => {
  const token = () => makeToken(VERIFIED_SME);

  it('rejects a non-object body', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .set('Content-Type', 'application/json')
      .send([]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing invoiceId', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some(d => /invoiceId/.test(d))).toBe(true);
  });

  it.each([
    ['too short (2 chars)', 'ab'],
    ['leading slash', '/invoice/1'],
    ['spaces inside', 'inv oice'],
    ['dot in name', 'inv.001'],
    ['over 64 chars', 'a'.repeat(65)],
  ])('rejects invoiceId that is %s', async (_label, badId) => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: badId, investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing investorAddress', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, amountStroops: '1000' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /investorAddress/.test(d))).toBe(true);
  });

  it.each([
    ['starts with digit', '1AAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'],
    ['too short (55 chars)', 'G' + 'A'.repeat(54)],
    ['too long (57 chars)', 'G' + 'A'.repeat(56)],
    ['lowercase', 'gaazi4tcr3ty5ojhctjc2a4qsy6cjwjh5iajtgkin2er7lbnvkoccwn'],
    ['contains digit 0', 'G0AZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'],
  ])('rejects Stellar address that is %s', async (_label, badAddr) => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: badAddr, amountStroops: '1000' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /investorAddress/.test(d))).toBe(true);
  });

  it('accepts valid G-prefix Stellar address (56 chars base32)', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    // Should not fail on investorAddress validation (may succeed or fail for other reasons)
    if (res.status === 400) {
      expect(res.body.error.details.every(d => !/investorAddress/.test(d))).toBe(true);
    }
  });

  it('rejects missing amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects zero amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects negative amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '-500' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects float amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '100.5' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects non-numeric string amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects scientific-notation string amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1e7' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects decimal string amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '100.0' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects leading-zero string amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '007' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('rejects unsafe integer number amountStroops', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({
        invoiceId: VALID_INVOICE,
        investorAddress: VALID_ADDRESS,
        amountStroops: Number.MAX_SAFE_INTEGER + 1,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some(d => /amountStroops/.test(d))).toBe(true);
  });

  it('returns all field errors when all three fields are invalid', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: '', investorAddress: 'not-an-address', amountStroops: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── KYC gate ─────────────────────────────────────────────────────────────

describe('POST /api/invest/fund-invoice — KYC gate', () => {
  it('returns 403 when principal has pending KYC', async () => {
    const token = makeToken(PENDING_SME);
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('returns 403 when principal has rejected KYC', async () => {
    const rejectedSme = 'sme-fund-rejected';
    await kycService.rejectSmeKyc(rejectedSme, 'test rejection');
    const token = makeToken(rejectedSme);
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });

  it('returns 400 when JWT has no smeId claim', async () => {
    // JWT without smeId
    const token = jwt.sign({ sub: 'u-nosme', tenantId: TENANT_ID }, JWT_SECRET, { expiresIn: '1h' });
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SME_ID');
  });

  it('ignores smeId in request body — JWT smeId (pending) still blocks', async () => {
    // JWT: PENDING_SME (blocked). Body: VERIFIED_SME (should not help).
    const token = makeToken(PENDING_SME);
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_ID)
      .send({
        invoiceId: VALID_INVOICE,
        investorAddress: VALID_ADDRESS,
        amountStroops: '1000',
        smeId: VERIFIED_SME, // attacker-supplied
      });
    // Middleware reads JWT smeId, so PENDING_SME is used → blocked
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KYC_GATE_FAILED');
  });
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('POST /api/invest/fund-invoice — happy path', () => {
  const token = () => makeToken(VERIFIED_SME);

  it('returns 200 with stubbed status for a verified principal', async () => {
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '5000' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stubbed');
    expect(res.body.invoiceId).toBe(VALID_INVOICE);
    expect(res.body.escrowAddress).toBe(VALID_ESCROW);
    expect(res.body.commitmentId).toBe('cmt-1');
    // Internal idempotency key must NOT be leaked
    expect(res.body.idempotencyKey).toBeUndefined();
  });

  it('returns 200 with exempted principal', async () => {
    const exemptSme = 'sme-fund-exempt';
    await kycService.exemptSmeFromKyc(exemptSme);
    const token = makeToken(exemptSme);
    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stubbed');
  });

  it('returns unsignedXdr when status is requires_signature (delegated mode)', async () => {
    submitFundEscrow.mockResolvedValueOnce({
      status: 'requires_signature',
      unsignedXdr: 'AAAA==',
      txHash: null,
      ledger: null,
    });
    persistCommitment.mockResolvedValueOnce({ id: 'cmt-delegated' });

    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '1000' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('requires_signature');
    expect(res.body.unsignedXdr).toBe('AAAA==');
  });

  it('returns txHash and ledger when status is submitted (custodial mode)', async () => {
    submitFundEscrow.mockResolvedValueOnce({
      status: 'submitted',
      unsignedXdr: null,
      txHash: 'abc123',
      ledger: '1234567',
    });
    persistCommitment.mockResolvedValueOnce({ id: 'cmt-submitted' });

    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '999' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.txHash).toBe('abc123');
    expect(res.body.ledger).toBe('1234567');
  });

  it('returns 422 when escrow address is not mapped', async () => {
    resolveEscrowAddress.mockImplementationOnce(() => { throw new EscrowNotFoundError('inv-missing'); });

    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: 'inv-missing', investorAddress: VALID_ADDRESS, amountStroops: '100' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ESCROW_NOT_FOUND');
  });

  it('returns 502 when escrowSubmit throws EscrowSubmitError', async () => {
    const { EscrowSubmitError: ESE } = require('../src/services/escrowSubmit');
    submitFundEscrow.mockRejectedValueOnce(new ESE('RPC timeout'));

    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '100' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ESCROW_SUBMIT_FAILED');
    // RPC detail must not leak to the client
    expect(JSON.stringify(res.body)).not.toContain('RPC timeout');
  });

  it('calls submitFundEscrow with the correct arguments', async () => {
    await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '7777' });
    expect(submitFundEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowAddress:   VALID_ESCROW,
        investorAddress: VALID_ADDRESS,
        amountStroops:   '7777',
        invoiceId:       VALID_INVOICE,
      })
    );
  });

  it('calls persistCommitment with the correct fields', async () => {
    await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '333' });
    expect(persistCommitment).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId:       VALID_INVOICE,
        investorAddress: VALID_ADDRESS,
        escrowAddress:   VALID_ESCROW,
        amountStroops:   '333',
        status:          'stubbed',
      })
    );
  });

  it('returns 500 when persistCommitment throws an unexpected error', async () => {
    persistCommitment.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send({ invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '500' });
    expect(res.status).toBe(500);
    // The actual error message must not leak to the client
    expect(JSON.stringify(res.body)).not.toContain('DB connection lost');
  });

  it('handles duplicate request gracefully (idempotent at service layer)', async () => {
    const body = { invoiceId: VALID_INVOICE, investorAddress: VALID_ADDRESS, amountStroops: '5000' };
    const firstRes  = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send(body);
    expect(firstRes.status).toBe(200);

    persistCommitment.mockResolvedValueOnce({ id: 'cmt-dup', status: 'stubbed' });

    const secondRes = await agent()
      .post('/api/invest/fund-invoice')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-tenant-id', TENANT_ID)
      .send(body);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.commitmentId).toBe('cmt-dup');
  });
});
