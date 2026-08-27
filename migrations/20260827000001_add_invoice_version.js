'use strict';

/**
 * Add the compare-and-set token used by invoice updates.
 *
 * Existing rows start at version 1. The value is intentionally not exposed as
 * a timestamp: clients compare an opaque revision, not wall-clock time.
 */
exports.up = function up(knex) {
  return knex.schema.alterTable('invoices', (table) => {
    table.bigInteger('version').notNullable().defaultTo(1);
    table.index(['tenant_id', 'invoice_id', 'version'], 'invoices_occ_lookup');
  });
};

exports.down = function down(knex) {
  return knex.schema.alterTable('invoices', (table) => {
    table.dropIndex(['tenant_id', 'invoice_id', 'version'], 'invoices_occ_lookup');
    table.dropColumn('version');
  });
};
