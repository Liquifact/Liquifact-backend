'use strict';

const { createMemoryRepository } = require('../src/data/memory-repository');

describe('memory repository copies', () => {
  test('mutating a listed invoice does not change stored state', async () => {
    const repo = createMemoryRepository();
    const [first] = await repo.list();
    first.status = 'cancelled';
    first.fundedAmount = 999999;
    const again = await repo.get(first.id);
    expect(again.status).not.toBe('cancelled');
    expect(again.fundedAmount).not.toBe(999999);
  });

  test('mutating a get() result does not change stored state', async () => {
    const repo = createMemoryRepository();
    const invoice = await repo.get('INV_0001');
    invoice.sme = 'Mutated';
    const again = await repo.get('INV_0001');
    expect(again.sme).toBe('Acme Components Ltd');
  });
});
