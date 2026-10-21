'use strict';

const { createPgRepository } = require('../src/data/pg-repository');

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;

describePg('Postgres fund concurrency', () => {
  /** @type {ReturnType<typeof createPgRepository>} */
  let repo;
  const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';

  beforeAll(() => {
    repo = createPgRepository(databaseUrl);
  });

  afterAll(async () => {
    if (repo) {
      await repo.destroy();
    }
  });

  beforeEach(async () => {
    await repo.reset();
  });

  test('20 parallel fund calls of amount/10 leave funded_amount == amount and reject surplus', async () => {
    const created = await repo.create({
      sme: 'Concurrency SME',
      debtor: 'Buyer',
      amount: 1000,
      currency: 'USDC',
      yieldBps: 500,
      dueDate: '2027-12-31',
      smeAddress: null,
    });

    const slice = 100; // amount / 10
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => repo.fund(created.id, slice, investor)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);

    const final = await repo.get(created.id);
    expect(final.fundedAmount).toBe(1000);
    expect(final.status).toBe('funded');

    for (const r of rejected) {
      expect(r.reason.code).toMatch(/EXCEEDS_CAPACITY|INVOICE_NOT_OPEN/);
    }
  });
});
