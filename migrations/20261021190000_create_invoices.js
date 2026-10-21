'use strict';

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('invoices', (table) => {
    table.text('id').primary();
    table.text('sme').notNullable();
    table.text('sme_address').nullable();
    table.text('debtor').notNullable();
    table.specificType('amount', 'numeric(38,7)').notNullable();
    table.specificType('funded_amount', 'numeric(38,7)').notNullable().defaultTo(0);
    table.string('currency', 12);
    table.integer('yield_bps');
    table.date('due_date');
    table.text('status');
    table.boolean('on_chain');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true });
  });

  await knex.raw(`
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_amount_positive CHECK (amount > 0),
      ADD CONSTRAINT invoices_funded_bounds CHECK (
        funded_amount >= 0 AND funded_amount <= amount
      ),
      ADD CONSTRAINT invoices_yield_bps_range CHECK (
        yield_bps IS NULL OR (yield_bps >= 0 AND yield_bps <= 10000)
      ),
      ADD CONSTRAINT invoices_status_check CHECK (
        status IN ('open', 'funded', 'settled', 'cancelled')
      )
  `);

  await knex.schema.alterTable('invoices', (table) => {
    table.index(['status', 'created_at'], 'invoices_status_created_at_idx');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('invoices');
};
