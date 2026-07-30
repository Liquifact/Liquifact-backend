'use strict';

/**
 * Creates the durable tenant-scoped investor lock table.
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<void>}
 */
exports.up = async function (knex) {
  await knex.schema.createTable('investor_locks', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('tenant_id', 128).notNullable().index();
    t.string('invoice_id', 64).notNullable().index();
    t.string('funder_address', 60).notNullable().index();
    t.timestamp('claim_not_before').notNullable();
    t.integer('investor_effective_yield_bps').notNullable();
    t.timestamp('last_refreshed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['tenant_id', 'invoice_id', 'funder_address'], {
      indexName: 'investor_locks_tenant_invoice_funder_unique',
    });
    t.index(['tenant_id', 'funder_address', 'invoice_id'], 'investor_locks_tenant_funder_invoice_idx');
    t.index(['tenant_id', 'invoice_id'], 'investor_locks_tenant_invoice_idx');
  });
};

/**
 * Drops the durable investor lock table.
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<void>}
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('investor_locks');
};
