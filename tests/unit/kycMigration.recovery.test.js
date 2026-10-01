'use strict';

const knexFactory = jest.requireActual('knex');
const knexConfig = require('../../knexfile').test;
const migration = require('../../src/db/migrations/20260425_add_kyc_status');

describe('KYC status migration recovery', () => {
  let db;

  beforeEach(() => {
    db = knexFactory(knexConfig);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function indexes() {
    const rows = await db.raw("PRAGMA index_list('kyc_records')");
    return rows.map((row) => row.name);
  }

  it('creates the table and indexes and is safe to retry without losing records', async () => {
    await migration.up(db);
    await db('kyc_records').insert({ sme_id: 'sme-retry', status: 'verified' });

    await migration.up(db);

    const row = await db('kyc_records').where({ sme_id: 'sme-retry' }).first();
    expect(row.status).toBe('verified');
    expect(await indexes()).toEqual(expect.arrayContaining([
      'kyc_records_status_index',
      'kyc_records_deleted_at_index',
    ]));
  });

  it('propagates table creation failures and allows a clean retry', async () => {
    let shouldFail = true;
    const flakyDb = new Proxy(db, {
      get(target, property) {
        if (property === 'schema') {
          return new Proxy(target.schema, {
            get(schema, method) {
              if (method === 'createTable' && shouldFail) {
                return () => {
                  shouldFail = false;
                  throw new Error('temporary table dependency failure');
                };
              }
              const value = Reflect.get(schema, method, schema);
              return typeof value === 'function' ? value.bind(schema) : value;
            },
          });
        }
        return Reflect.get(target, property, target);
      },
    });

    await expect(migration.up(flakyDb)).rejects.toThrow('temporary table dependency failure');
    expect(await db.schema.hasTable('kyc_records')).toBe(false);

    await migration.up(db);

    expect(await db.schema.hasTable('kyc_records')).toBe(true);
  });

  it('recovers when an index operation fails after table creation', async () => {
    let shouldFail = true;
    const flakyDb = new Proxy(db, {
      get(target, property) {
        if (property === 'raw') {
          return (sql, bindings) => {
            if (shouldFail && bindings.includes('deleted_at')) {
              shouldFail = false;
              throw new Error('temporary index dependency failure');
            }
            return target.raw(sql, bindings);
          };
        }
        return Reflect.get(target, property, target);
      },
    });

    await expect(migration.up(flakyDb)).rejects.toThrow('temporary index dependency failure');
    expect(await db.schema.hasTable('kyc_records')).toBe(true);
    expect(await indexes()).toContain('kyc_records_status_index');
    expect(await indexes()).not.toContain('kyc_records_deleted_at_index');

    await migration.up(db);

    expect(await indexes()).toEqual(expect.arrayContaining([
      'kyc_records_status_index',
      'kyc_records_deleted_at_index',
    ]));
  });

  it('rejects an incompatible existing table without deleting its data', async () => {
    await db.schema.createTable('kyc_records', (table) => {
      table.string('sme_id', 128).primary();
    });
    await db('kyc_records').insert({ sme_id: 'sme-preserve' });

    await expect(migration.up(db)).rejects.toThrow(
      'missing required columns (status, provider_record_id, verified_at, updated_at, deleted_at)'
    );

    expect(await db('kyc_records').where({ sme_id: 'sme-preserve' })).toHaveLength(1);
  });

  it('converges when invoked concurrently', async () => {
    await Promise.all([migration.up(db), migration.up(db)]);

    expect(await db.schema.hasTable('kyc_records')).toBe(true);
    expect(await indexes()).toEqual(expect.arrayContaining([
      'kyc_records_status_index',
      'kyc_records_deleted_at_index',
    ]));
  });
});
