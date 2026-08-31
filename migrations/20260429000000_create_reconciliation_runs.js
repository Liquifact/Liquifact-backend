'use strict';

exports.up = function up(knex) {
  return knex.schema.createTable('reconciliation_runs', (table) => {
    if (knex.client.config.client === 'sqlite3' || knex.client.config.client === 'better-sqlite3') {
      table.uuid('id').primary().defaultTo(knex.fn.uuid());
    } else {
      table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    }
    table.string('tenant_id', 64).notNullable();
    table.string('run_key', 255).notNullable();
    table.timestamp('window_start', { useTz: true }).notNullable();
    table.timestamp('window_end', { useTz: true }).notNullable();
    table.string('status', 16).notNullable().defaultTo('running');
    table.string('lease_token', 64).nullable();
    table.timestamp('lease_expires_at', { useTz: true }).nullable();
    table.integer('total').notNullable().defaultTo(0);
    table.integer('matches').notNullable().defaultTo(0);
    table.integer('mismatches').notNullable().defaultTo(0);
    table.integer('errors').notNullable().defaultTo(0);
    table.jsonb('results').notNullable().defaultTo('[]');
    table.timestamp('reconciled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['tenant_id', 'run_key'], 'uq_reconciliation_runs_tenant_run_key');
    table.index(['reconciled_at'], 'idx_reconciliation_runs_reconciled_at');
    table.index(['tenant_id', 'window_start', 'window_end'], 'idx_reconciliation_runs_tenant_window');
  });
};

exports.down = function down(knex) {
  return knex.schema.dropTableIfExists('reconciliation_runs');
};
