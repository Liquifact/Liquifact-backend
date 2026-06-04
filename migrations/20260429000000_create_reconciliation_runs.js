'use strict';

/**
 * Persistence for nightly escrow reconciliation runs.
 *
 * Replaces the previous `global.reconciliationSummary` in-memory stash so the
 * latest summary survives process restarts and a history of runs is queryable
 * for ops review. One row per `performReconciliation()` invocation; the full
 * per-invoice result set is stored as JSONB in `results`.
 */

exports.up = function up(knex) {
  return knex.schema.createTable('reconciliation_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.integer('total').notNullable().defaultTo(0);
    table.integer('matches').notNullable().defaultTo(0);
    table.integer('mismatches').notNullable().defaultTo(0);
    table.integer('errors').notNullable().defaultTo(0);
    // Per-invoice results: [{ invoiceId, status, dbFundedTotal, onChainAmount, ... }]
    table.jsonb('results').notNullable().defaultTo('[]');
    table.timestamp('reconciled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Health checks read the most recent run; index supports that lookup.
    table.index(['reconciled_at'], 'idx_reconciliation_runs_reconciled_at');
  });
};

exports.down = function down(knex) {
  return knex.schema.dropTableIfExists('reconciliation_runs');
};
