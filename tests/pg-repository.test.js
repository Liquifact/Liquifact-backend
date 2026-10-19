'use strict';

const URL = process.env.TEST_DATABASE_URL;
const describePg = URL ? describe : describe.skip;

describePg('postgres repository', () => {
  let repo;

  beforeAll(async () => {
    const { createPgRepository } = require('../src/data/pg-repository');
    repo = createPgRepository({ connectionString: URL });
    await repo.knex.migrate.latest();
  });

  afterAll(() => repo.destroy());

  beforeEach(() => repo.reset());

  test('20 parallel funds of amount/10 reach exactly amount; surplus rejected', async () => {
    const inv = await repo.create({
      sme: 'Race SME',
      debtor: 'Buyer',
      amount: 100,
      currency: 'USDC',
      yieldBps: 800,
      dueDate: '2027-01-01',
    });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => repo.fund(inv.id, 10)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(10);
    const final = await repo.get(inv.id);
    expect(final.fundedAmount).toBe(final.amount);
    expect(final.status).toBe('funded');
  });

  test('numeric values come back as exact strings', async () => {
    const inv = await repo.create({
      sme: 'Dec SME',
      debtor: 'Buyer',
      amount: 0.3,
      currency: 'XLM',
      yieldBps: 1,
      dueDate: '2027-01-01',
    });
    expect(inv.amount).toBe('0.3');
    const funded = await repo.fund(inv.id, 0.1);
    expect(funded.fundedAmount).toBe('0.1');
  });

  test('migration up/down/up', async () => {
    const { knex } = repo;
    await knex.migrate.rollback(undefined, true);
    expect(await knex.schema.hasTable('invoices')).toBe(false);
    await knex.migrate.latest();
    expect(await knex.schema.hasTable('invoices')).toBe(true);
    await knex.migrate.rollback(undefined, true);
    expect(await knex.schema.hasTable('invoices')).toBe(false);
    await knex.migrate.latest();
    expect(await knex.schema.hasTable('invoices')).toBe(true);
  });

  test('connection failures surface as DB_UNAVAILABLE', async () => {
    const { createPgRepository } = require('../src/data/pg-repository');
    const dead = createPgRepository({ connectionString: 'postgres://u:p@127.0.0.1:1/none' });
    await expect(dead.list()).rejects.toMatchObject({ code: 'DB_UNAVAILABLE', status: 503 });
    await dead.destroy();
  });
});
