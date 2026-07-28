/**
 * Database Migration: Create kyc_records table
 *
 * Persists KYC verification results so status survives restarts.
 * One row per SME; upserted on each provider response.
 */

exports.up = async (knex) => {
  await knex.schema.createTable('kyc_records', (table) => {
    table.string('sme_id', 128).primary();
    table.string('status', 32).notNullable().defaultTo('pending');
    table.string('provider_record_id', 256).nullable();
    table.timestamp('verified_at').nullable();
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.index('status');
    table.index('deleted_at');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('kyc_records');
};
