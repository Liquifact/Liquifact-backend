'use strict';

/**
 * Focused tests for the kyc_records migration.
 *
 * The migration is the only thing that creates the table, and
 * `migrations/20260727000001_add_soft_delete_to_kyc_records.sql` depends on it
 * having created `deleted_at`. These tests pin both the schema contract and
 * the re-run behaviour, using the same in-memory SQLite config the repo's
 * other migration tests use.
 */

const knexLib = jest.requireActual('knex');
const knexConfig = require('../../knexfile').test;

const migration = require('../../src/db/migrations/20260425_add_kyc_status');

describe('KYC records migration (20260425_add_kyc_status)', () => {
  let knex;

  beforeEach(async () => {
    knex = knexLib(knexConfig);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  describe('up', () => {
    it('creates the table', async () => {
      await migration.up(knex);
      expect(await knex.schema.hasTable('kyc_records')).toBe(true);
    });

    it('creates every column the service and soft-delete migration rely on', async () => {
      await migration.up(knex);
      const info = await knex('kyc_records').columnInfo();

      for (const column of migration.REQUIRED_COLUMNS) {
        expect(info).toHaveProperty(column);
      }
    });

    it('keeps sme_id as the primary key the service upserts on', async () => {
      await migration.up(knex);
      // Asserted behaviourally: the SQLite dialect does not populate
      // `columnInfo().primary`, but a duplicate sme_id must still be rejected.
      await knex('kyc_records').insert({ sme_id: 'sme_pk_01' });
      await expect(knex('kyc_records').insert({ sme_id: 'sme_pk_01' })).rejects.toThrow();
    });

    it('defaults status to pending so a row is never statusless', async () => {
      await migration.up(knex);
      await knex('kyc_records').insert({ sme_id: 'sme_default_status' });

      const row = await knex('kyc_records').where({ sme_id: 'sme_default_status' }).first();
      expect(row.status).toBe('pending');
    });

    it('indexes deleted_at, which the soft-delete migration filters on', async () => {
      await migration.up(knex);
      // Asserted name-agnostically on purpose. Knex's `table.index()` names its
      // index `kyc_records_deleted_at_index`, whereas the later
      // 20260727000001 SQL migration creates `idx_kyc_records_deleted_at` with
      // `CREATE INDEX IF NOT EXISTS`. Both are valid: what the later migration
      // requires is that the *column* exists and is indexed, not a specific
      // index name.
      const rows = await knex.raw(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kyc_records'",
      );
      const indexesOnDeletedAt = rows.filter((row) => /deleted_at/.test(row.sql || ''));
      expect(indexesOnDeletedAt.length).toBeGreaterThan(0);
    });

    // ── Re-run / retry safety ────────────────────────────────────────────────

    it('is safe to run twice', async () => {
      await migration.up(knex);
      await expect(migration.up(knex)).resolves.not.toThrow();
    });

    it('is safe to run many times', async () => {
      for (let i = 0; i < 5; i += 1) {
        await migration.up(knex);
      }
      expect(await knex.schema.hasTable('kyc_records')).toBe(true);
    });

    it('preserves existing rows when re-run', async () => {
      await migration.up(knex);
      await knex('kyc_records').insert({ sme_id: 'sme_survives', status: 'verified' });

      await migration.up(knex);

      const row = await knex('kyc_records').where({ sme_id: 'sme_survives' }).first();
      expect(row).toBeDefined();
      expect(row.status).toBe('verified');
    });

    it('repairs a table that predates the soft-delete column', async () => {
      // Simulates the shape an older deployment would have left behind.
      await knex.schema.createTable('kyc_records', (table) => {
        table.string('sme_id', 128).primary();
        table.string('status', 32).notNullable().defaultTo('pending');
      });

      await migration.up(knex);

      const info = await knex('kyc_records').columnInfo();
      expect(info).toHaveProperty('deleted_at');
      const indexes = await knex.raw(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kyc_records'",
      );
      expect(indexes.some((row) => /deleted_at/.test(row.sql || ''))).toBe(true);
    });

    it('keeps data intact while repairing the soft-delete column', async () => {
      await knex.schema.createTable('kyc_records', (table) => {
        table.string('sme_id', 128).primary();
        table.string('status', 32).notNullable().defaultTo('pending');
      });
      await knex('kyc_records').insert({ sme_id: 'sme_legacy', status: 'rejected' });

      await migration.up(knex);

      const row = await knex('kyc_records').where({ sme_id: 'sme_legacy' }).first();
      expect(row.status).toBe('rejected');
    });
  });

  describe('down', () => {
    it('drops the table', async () => {
      await migration.up(knex);
      await migration.down(knex);
      expect(await knex.schema.hasTable('kyc_records')).toBe(false);
    });

    it('is safe to run twice', async () => {
      await migration.up(knex);
      await migration.down(knex);
      await expect(migration.down(knex)).resolves.not.toThrow();
    });

    it('is safe when the table was never created', async () => {
      await expect(migration.down(knex)).resolves.not.toThrow();
    });
  });

  describe('up/down round trip', () => {
    it('recreates a usable table after a rollback', async () => {
      await migration.up(knex);
      await migration.down(knex);
      await migration.up(knex);

      await knex('kyc_records').insert({ sme_id: 'sme_after_roundtrip' });
      const row = await knex('kyc_records').where({ sme_id: 'sme_after_roundtrip' }).first();
      expect(row).toBeDefined();
    });

    it('survives repeated rollback and replay', async () => {
      for (let i = 0; i < 3; i += 1) {
        await migration.up(knex);
        await migration.down(knex);
      }
      await migration.up(knex);
      expect(await knex.schema.hasTable('kyc_records')).toBe(true);
    });
  });
});
