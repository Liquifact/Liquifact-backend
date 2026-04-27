exports.up = function(knex) {
  return knex.schema.createTable('invoices', function(table) {
    table.increments('id').primary();
    table.string('invoice_id').unique().notNullable(); // Unique identifier like inv_123
    table.decimal('amount', 15, 2).notNullable();
    table.string('customer').notNullable();
    table.string('status').notNullable().defaultTo('pending').checkIn(['pending', 'approved', 'on_chain']);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.string('tenant_id').notNullable(); // For multi-tenancy
    table.json('metadata').nullable(); // For additional data
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('invoices');
};