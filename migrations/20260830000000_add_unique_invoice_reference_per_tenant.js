exports.up = function(knex) {
  return knex.schema.alterTable('invoices', function(table) {
    table.unique(['tenant_id', 'invoice_number'], 'invoices_tenant_invoice_number_unique');
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('invoices', function(table) {
    table.dropUnique(['tenant_id', 'invoice_number'], 'invoices_tenant_invoice_number_unique');
  });
};
