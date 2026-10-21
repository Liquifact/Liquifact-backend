'use strict';

const knexLib = require('knex');
const { buildKnexConfig } = require('../knexfile');

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;

describePg('knex migrations', () => {
  /** @type {import('knex').Knex} */
  let knex;

  beforeAll(() => {
    knex = knexLib(buildKnexConfig(databaseUrl));
  });

  afterAll(async () => {
    if (knex) {
      await knex.destroy();
    }
  });

  test('migrate up, down, and up again', async () => {
    await knex.migrate.latest();
    expect(await knex.schema.hasTable('invoices')).toBe(true);

    await knex.migrate.rollback(undefined, true);
    expect(await knex.schema.hasTable('invoices')).toBe(false);

    await knex.migrate.latest();
    expect(await knex.schema.hasTable('invoices')).toBe(true);

    const columns = await knex('invoices').columnInfo();
    expect(columns).toHaveProperty('id');
    expect(columns).toHaveProperty('funded_amount');
    expect(columns).toHaveProperty('status');
  });
});
