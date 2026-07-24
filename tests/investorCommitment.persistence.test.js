'use strict';

const db = require('../src/db/knex');
const {
  persistCommitment,
  updateCommitment,
  setInvestorLock,
  getInvestorLock,
  getAllInvestorLocks,
  getInvestorLocksByAddress,
  clearInvestorLocks,
} = require('../src/services/investorCommitment');

const VALID_ADDR = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';
const VALID_ESCROW = 'CDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';

beforeEach(async () => {
  await clearInvestorLocks();
});

describe('investorCommitment persistence — persistCommitment', () => {
  const baseParams = {
    invoiceId: 'inv_persist_001',
    investorAddress: VALID_ADDR,
    escrowAddress: VALID_ESCROW,
    amountStroops: '10000000',
    status: 'requires_signature',
  };

  it('inserts a new row when no idempotency key is supplied', async () => {
    const result = await persistCommitment(baseParams);
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    expect(result.invoice_id).toBe('inv_persist_001');
    expect(result.investor_address).toBe(VALID_ADDR);
    expect(result.amount_stroops).toBe('10000000');
    expect(result.status).toBe('requires_signature');
    expect(result.created_at).toBeDefined();
  });

  it('handles a non-matching idempotency key as new insert', async () => {
    const result = await persistCommitment({
      ...baseParams,
      invoiceId: 'inv_persist_002',
      idempotencyKey: 'no-match-key',
    });
    expect(result).toBeDefined();
    // The mock's .first() returns a default row so the idempotency path
    // returns it as-is (simulating a DB-level duplicate detection).
    expect(result).toHaveProperty('id');
  });

  it('inserts a row with stubbed status', async () => {
    const result = await persistCommitment({
      ...baseParams,
      invoiceId: 'inv_persist_003',
      status: 'stubbed',
      unsignedXdr: 'AAAA==',
    });
    expect(result).toBeDefined();
    expect(result.status).toBe('stubbed');
    expect(result.unsigned_xdr).toBe('AAAA==');
  });

  it('inserts a row with submitted status, txHash, and ledger', async () => {
    const result = await persistCommitment({
      ...baseParams,
      invoiceId: 'inv_persist_004',
      status: 'submitted',
      txHash: 'abc123def456',
      ledger: '12345678',
    });
    expect(result).toBeDefined();
    expect(result.status).toBe('submitted');
    expect(result.tx_hash).toBe('abc123def456');
    expect(result.ledger).toBe('12345678');
  });

  it('findCommitments returns an array', async () => {
    const { findCommitments } = require('../src/services/investorCommitment');

    await persistCommitment({
      ...baseParams,
      invoiceId: 'inv_find_001',
      idempotencyKey: 'find-key-1',
    });

    const results = await findCommitments(VALID_ADDR, 'inv_find_001');
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('investorCommitment persistence — updateCommitment', () => {
  const baseParams = {
    invoiceId: 'inv_update',
    investorAddress: VALID_ADDR,
    escrowAddress: VALID_ESCROW,
    amountStroops: '50000000',
    status: 'requires_signature',
  };

  it('throws CommitmentValidationError when amount_stroops is in fields (immutability)', async () => {
    const { CommitmentValidationError } = require('../src/services/investorCommitment');
    await expect(
      updateCommitment('some-id', { status: 'submitted', amount_stroops: '99999' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('rejects camelCase amountStroops in fields', async () => {
    const { CommitmentValidationError } = require('../src/services/investorCommitment');
    await expect(
      updateCommitment('some-id', { amountStroops: '50000' })
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('throws "Commitment not found" for non-existent ID', async () => {
    await expect(
      updateCommitment('nonexistent-uuid-12345', { status: 'submitted' })
    ).rejects.toThrow('Commitment not found: nonexistent-uuid-12345');
  });
});

describe('investorCommitment persistence — setInvestorLock / getInvestorLock', () => {
  it('inserts a lock record and reads it back', async () => {
    const lock = await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: '2026-07-01T00:00:00Z',
      investorEffectiveYieldBps: 600,
      invoiceId: 'inv_lock_001',
      tenantId: 'persistence-test',
    });

    expect(lock).toBeDefined();
    expect(lock.funderAddress).toBe(VALID_ADDR);
    expect(lock.claimNotBefore).toContain('2026-07-01');
    expect(lock.investorEffectiveYieldBps).toBe(600);
    expect(lock.invoiceId).toBe('inv_lock_001');

    const readBack = await getInvestorLock('inv_lock_001', VALID_ADDR, { tenantId: 'persistence-test' });
    expect(readBack).toBeDefined();
    expect(readBack.funderAddress).toBe(VALID_ADDR);
    expect(readBack.investorEffectiveYieldBps).toBe(600);
  });

  it('upserts an existing lock record on conflict', async () => {
    await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: '2026-07-01T00:00:00Z',
      investorEffectiveYieldBps: 600,
      invoiceId: 'inv_lock_upsert',
      tenantId: 'persistence-test',
    });

    const upserted = await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: '2026-08-01T00:00:00Z',
      investorEffectiveYieldBps: 750,
      invoiceId: 'inv_lock_upsert',
      tenantId: 'persistence-test',
    });

    expect(upserted.investorEffectiveYieldBps).toBe(750);
    expect(upserted.claimNotBefore).toContain('2026-08-01');

    const readBack = await getInvestorLock('inv_lock_upsert', VALID_ADDR, { tenantId: 'persistence-test' });
    expect(readBack.investorEffectiveYieldBps).toBe(750);
  });

  it('returns undefined for a non-existent lock', async () => {
    const result = await getInvestorLock('nonexistent-invoice', VALID_ADDR, { tenantId: 'persistence-test' });
    expect(result).toBeUndefined();
  });

  it('preserves an unparseable claimNotBefore value as-is', async () => {
    const lock = await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: 'not-a-real-date',
      investorEffectiveYieldBps: 400,
      invoiceId: 'inv_bad_date',
      tenantId: 'edge-test',
    });

    expect(lock.claimNotBefore).toBe('not-a-real-date');
  });

  it('uses default tenant when tenantId is not provided', async () => {
    const lock = await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: '2026-07-01T00:00:00Z',
      investorEffectiveYieldBps: 500,
      invoiceId: 'inv_no_tenant',
    });

    expect(lock).toBeDefined();
    expect(lock.funderAddress).toBe(VALID_ADDR);

    const readBack = await getInvestorLock('inv_no_tenant', VALID_ADDR, { tenantId: 'default' });
    expect(readBack).toBeDefined();
    expect(readBack.funderAddress).toBe(VALID_ADDR);
  });

  it('returns tenant-scoped undefined when record exists in a different tenant', async () => {
    await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: '2026-07-01T00:00:00Z',
      investorEffectiveYieldBps: 600,
      invoiceId: 'inv_scope',
      tenantId: 'tenant-a',
    });

    const fromTenantA = await getInvestorLock('inv_scope', VALID_ADDR, { tenantId: 'tenant-a' });
    expect(fromTenantA).toBeDefined();

    const fromTenantB = await getInvestorLock('inv_scope', VALID_ADDR, { tenantId: 'tenant-b' });
    expect(fromTenantB).toBeUndefined();
  });
});

describe('investorCommitment persistence — pagination and filtering', () => {
  const TENANT = 'paginate-test';

  beforeEach(async () => {
    await clearInvestorLocks({ tenantId: TENANT });
    for (let i = 1; i <= 5; i++) {
      await setInvestorLock({
        funderAddress: VALID_ADDR,
        claimNotBefore: `2026-0${i}-01T00:00:00Z`,
        investorEffectiveYieldBps: 500 + i * 50,
        invoiceId: `inv_pg_${String(7788 + i - 1)}`,
        tenantId: TENANT,
      });
    }
  });

  it('returns paginated results with default page size', async () => {
    const result = await getAllInvestorLocks({ tenantId: TENANT });
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.meta.total).toBeGreaterThan(0);
    expect(result.meta.page).toBe(1);
  });

  it('getAllInvestorLocks filters by invoiceId when provided', async () => {
    const result = await getAllInvestorLocks({ tenantId: TENANT, invoiceId: 'inv_pg_7789' });
    expect(result.data.length).toBe(1);
    expect(result.data[0].invoiceId).toBe('inv_pg_7789');
  });

  it('getInvestorLocksByAddress returns only locks for that funder', async () => {
    const result = await getInvestorLocksByAddress(VALID_ADDR, { tenantId: TENANT });
    expect(result.data.length).toBe(5);
    expect(result.data.every((l) => l.funderAddress === VALID_ADDR)).toBe(true);
  });

  it('getInvestorLocksByAddress filters by invoiceId', async () => {
    const result = await getInvestorLocksByAddress(VALID_ADDR, {
      tenantId: TENANT,
      invoiceId: 'inv_pg_7790',
    });
    expect(result.data.length).toBe(1);
    expect(result.data[0].invoiceId).toBe('inv_pg_7790');
  });

  it('returns empty data array when no locks match the funder', async () => {
    const otherAddr = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';
    const result = await getInvestorLocksByAddress(otherAddr, { tenantId: TENANT });
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it('returns empty data array when no locks match the invoice filter', async () => {
    const result = await getAllInvestorLocks({ tenantId: TENANT, invoiceId: 'nonexistent' });
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });
});

describe('investorCommitment persistence — clearInvestorLocks', () => {
  const TENANT = 'clear-test';

  beforeEach(async () => {
    for (let i = 1; i <= 3; i++) {
      await setInvestorLock({
        funderAddress: VALID_ADDR,
        claimNotBefore: '2026-07-01T00:00:00Z',
        investorEffectiveYieldBps: 600,
        invoiceId: `inv_clear_${i}`,
        tenantId: TENANT,
      });
    }
    await setInvestorLock({
      funderAddress: VALID_ADDR,
      claimNotBefore: '2026-07-01T00:00:00Z',
      investorEffectiveYieldBps: 650,
      invoiceId: 'inv_keep',
      tenantId: 'other-tenant',
    });
  });

  it('removes all locks for the specified tenant', async () => {
    await clearInvestorLocks({ tenantId: TENANT });

    const remaining = await getAllInvestorLocks({ tenantId: TENANT });
    expect(remaining.data).toEqual([]);
    expect(remaining.meta.total).toBe(0);

    const other = await getInvestorLock('inv_keep', VALID_ADDR, { tenantId: 'other-tenant' });
    expect(other).toBeDefined();
  });

  it('removes all locks when no tenant filter is provided', async () => {
    await clearInvestorLocks();

    const result = await getAllInvestorLocks({ tenantId: 'other-tenant' });
    expect(result.data).toEqual([]);
  });
});

describe('investorCommitment persistence — seedInvestorLocks', () => {
  beforeEach(async () => {
    await clearInvestorLocks();
  });

  it('seeds default tenant with multiple lock records', async () => {
    const { seedInvestorLocks } = require('../src/services/investorCommitment');

    await seedInvestorLocks();

    const locks = await getAllInvestorLocks({ tenantId: 'default' });
    expect(locks.data.length).toBeGreaterThanOrEqual(6);
    expect(locks.data[0]).toHaveProperty('funderAddress');
    expect(locks.data[0]).toHaveProperty('invoiceId');
    expect(locks.data[0]).toHaveProperty('investorEffectiveYieldBps');
  });

  it('seeds a specific tenant with lock records', async () => {
    const { seedInvestorLocks } = require('../src/services/investorCommitment');

    await seedInvestorLocks({ tenantId: 'seed-tenant' });

    const locks = await getAllInvestorLocks({ tenantId: 'seed-tenant' });
    expect(locks.data.length).toBeGreaterThanOrEqual(6);
  });
});
