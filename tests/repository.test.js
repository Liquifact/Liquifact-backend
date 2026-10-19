'use strict';

const { createMemoryRepository } = require('../src/data/memory-repository');
const { createRepository } = require('../src/data');
const { toUnits, fromUnits } = require('../src/data/money');
const { newInvoiceId } = require('../src/data/ids');

describe('memory repository', () => {
  test('returns copies: mutating results does not change stored state', async () => {
    const repo = createMemoryRepository();
    const listed = await repo.list();
    listed[0].sme = 'HACKED';
    listed.pop();
    const fetched = await repo.get('INV_0001');
    fetched.status = 'settled';
    fetched.fundedAmount = '100';

    expect((await repo.list()).length).toBe(4);
    expect((await repo.list()).some((i) => i.sme === 'HACKED')).toBe(false);
    const again = await repo.get('INV_0001');
    expect(again.status).toBe('open');
    expect(again.fundedAmount).toBe('0');
  });

  test('fund returns a copy and rejects surplus', async () => {
    const repo = createMemoryRepository();
    const funded = await repo.fund('INV_0001', 40);
    funded.fundedAmount = '0';
    expect((await repo.get('INV_0001')).fundedAmount).toBe('40');
    await expect(repo.fund('INV_0001', 61)).rejects.toMatchObject({ code: 'OVERFUNDED' });
  });

  test('20 parallel contributions of amount/10 fund exactly once over', async () => {
    const repo = createMemoryRepository();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => repo.fund('INV_0001', 10)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const inv = await repo.get('INV_0001');
    expect(inv.fundedAmount).toBe('100');
    expect(inv.status).toBe('funded');
  });

  test('reset restores the seed', async () => {
    const repo = createMemoryRepository();
    await repo.fund('INV_0001', 100);
    await repo.reset();
    expect((await repo.get('INV_0001')).status).toBe('open');
  });
});

describe('helpers', () => {
  test('money round-trips without float error', () => {
    expect(fromUnits(toUnits(0.1) + toUnits(0.2))).toBe('0.3');
    expect(fromUnits(toUnits('100.0000000'))).toBe('100');
    expect(() => toUnits(-1)).toThrow();
  });

  test('ids are INV_ + 12 base32 chars', () => {
    expect(newInvoiceId()).toMatch(/^INV_[A-Z2-7]{12}$/);
  });

  test('createRepository defaults to memory without DATABASE_URL', async () => {
    const repo = createRepository({});
    expect((await repo.list()).length).toBe(4);
  });
});
