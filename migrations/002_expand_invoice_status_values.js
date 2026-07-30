'use strict';

/**
 * Relaxes the SQLite invoices.status CHECK constraint so state-machine values
 * (linked_escrow, rejected, cancelled) can be persisted during transitions.
 *
 * Application-layer validation in invoiceStateMachine remains authoritative;
 * this migration only affects the Knex/SQLite test and local-dev profile.
 */

exports.up = async function up(knex) {
  if (knex.client.config.client !== 'sqlite3') {
    return;
  }

  const hasTable = await knex.schema.hasTable('invoices');
  if (!hasTable) {
    return;
  }

  await knex.schema.createTable('invoices_new', (table) => {
    table.increments('id').primary();
    table.string('invoice_id').unique().notNullable();
    table.decimal('amount', 15, 2).notNullable();
    table.string('customer').notNullable();
    table.string('status').notNullable().defaultTo('pending');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.string('tenant_id').notNullable();
    table.string('sme_id').nullable();
    table.string('currency', 3).nullable();
    table.date('due_date').nullable();
    table.text('description').nullable();
    table.json('metadata').nullable();
  });

  await knex.raw(`
    INSERT INTO invoices_new (id, invoice_id, amount, customer, status, created_at, updated_at, deleted_at, tenant_id, sme_id, currency, due_date, description, metadata)
    SELECT id, invoice_id, amount, customer, status, created_at, updated_at, deleted_at, tenant_id, sme_id, currency, due_date, description, metadata FROM invoices
  `);

  await knex.schema.dropTable('invoices');
  await knex.schema.renameTable('invoices_new', 'invoices');
};

exports.down = async function down(knex) {
  if (knex.client.config.client !== 'sqlite3') {
    return;
  }

  const hasTable = await knex.schema.hasTable('invoices');
  if (!hasTable) {
    return;
  }

  await knex.schema.createTable('invoices_old', (table) => {
    table.increments('id').primary();
    table.string('invoice_id').unique().notNullable();
    table.decimal('amount', 15, 2).notNullable();
    table.string('customer').notNullable();
    table.string('status').notNullable().defaultTo('pending').checkIn(['pending', 'approved', 'on_chain']);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.string('tenant_id').notNullable();
    table.string('sme_id').nullable();
    table.string('currency', 3).nullable();
    table.date('due_date').nullable();
    table.text('description').nullable();
    table.json('metadata').nullable();
  });

  await knex.raw(`
    INSERT INTO invoices_old (id, invoice_id, amount, customer, status, created_at, updated_at, deleted_at, tenant_id, sme_id, currency, due_date, description, metadata)
    SELECT id, invoice_id, amount, customer, status, created_at, updated_at, deleted_at, tenant_id, sme_id, currency, due_date, description, metadata FROM invoices
  `);

  await knex.schema.dropTable('invoices');
  await knex.schema.renameTable('invoices_old', 'invoices');
};
