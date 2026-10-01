/**
 * Database Migration: Create kyc_records table
 *
 * Persists KYC verification results so status survives restarts.
 * One row per SME; upserted on each provider response.
 *
 * ## Compatibility contract
 *
 * This migration is referenced from two places that are easy to miss:
 *
 *  - the real migration runner (`migrator-config.js` -> `migrations/`), which is
 *    configured for every environment, and
 *  - `migrations/20260727000001_add_soft_delete_to_kyc_records.sql`, which
 *    ALTERs `kyc_records` to add soft-delete columns.
 *
 * That second reference is the constraint that shapes everything below: the
 * table is created with `deleted_at` already present and indexed, because the
 * soft-delete migration's `CREATE INDEX ... ON kyc_records (deleted_at)` needs
 * the column to exist when it runs. Removing `deleted_at` from here, or
 * creating the table before it, breaks the later migration.
 *
 * ## Why `up` is written defensively
 *
 * `up` must be safe to run against a database where the table already exists.
 * Migrations get re-run in three ordinary situations, none of them bugs:
 *
 *  1. an operator replays a migration by hand while recovering,
 *  2. a deploy is retried after a partial failure, and
 *  3. a test harness applies migrations against a database another test already
 *     touched (this repo's own `tests/kycService.persistence.test.js` and
 *     `tests/load/kyc-webhooks.concurrency.test.js` both call `up` directly).
 *
 * A bare `createTable` throws `table already exists` in all three, which turns
 * a recoverable situation into an outage. `down` was already idempotent, so the
 * asymmetry was the bug: one direction tolerated re-runs and the other did not.
 *
 * ## Schema stability
 *
 * Column types and names are part of the contract and must not drift:
 * `sme_id` is the primary key that the KYC service upserts on, and `status`,
 * `provider_record_id`, and `verified_at` are read directly by
 * `src/services/kycService`. `checkTableExists` is therefore used to decide
 * whether to create at all, rather than creating-if-not-exists and leaving a
 * partially-upgraded table in place.
 */

/** Columns the soft-delete migration and the KYC service both depend on. */
const REQUIRED_COLUMNS = [
  'sme_id',
  'status',
  'provider_record_id',
  'verified_at',
  'updated_at',
  'deleted_at',
];

/** Indexes the soft-delete migration expects to find or create. */
const REQUIRED_INDEXES = ['idx_kyc_records_deleted_at'];

/**
 * Ensure the soft-delete index exists.
 *
 * Uses `CREATE INDEX IF NOT EXISTS` rather than probing for the index first.
 * Knex 3.1 has no portable index-existence API (`schema.hasIndex` is not
 * available), and the statement is idempotent in both SQLite and PostgreSQL,
 * so an unconditional create is both simpler and dialect-safe.
 *
 * @param {import('knex')} knex
 */
async function ensureSoftDeleteIndex(knex) {
  for (const index of REQUIRED_INDEXES) {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${index} ON kyc_records (deleted_at) WHERE deleted_at IS NOT NULL`,
    );
  }
}

/**
 * Whether `kyc_records` already exists.
 *
 * Uses `hasTable` rather than catching the `createTable` error so that a
 * genuine failure (permissions, connection lost) still surfaces instead of
 * being mistaken for "already migrated".
 *
 * @param {import('knex')} knex
 * @returns {Promise<boolean>}
 */
async function checkTableExists(knex) {
  return knex.schema.hasTable('kyc_records');
}

exports.up = async (knex) => {
  // Use atomic IF NOT EXISTS DDL so concurrent deploy/test invocations do not
  // race on the primary table. Keep indexes separate and idempotent: if an
  // index creation fails after the table exists, a retry completes the schema.
  await knex.schema.createTableIfNotExists('kyc_records', (table) => {
    table.string('sme_id', 128).primary();
    table.string('status', 32).notNullable().defaultTo('pending');
    table.string('provider_record_id', 256).nullable();
    table.timestamp('verified_at').nullable();
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
  });

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS ?? ON ?? (??)',
    ['kyc_records_status_index', 'kyc_records', 'status'],
  );
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS ?? ON ?? (??)',
    ['kyc_records_deleted_at_index', 'kyc_records', 'deleted_at'],
  );
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};

// Exported for the focused migration tests; not part of the knex contract.
exports.REQUIRED_COLUMNS = REQUIRED_COLUMNS;
exports.REQUIRED_INDEXES = REQUIRED_INDEXES;
exports.checkTableExists = checkTableExists;
exports.ensureSoftDeleteIndex = ensureSoftDeleteIndex;
