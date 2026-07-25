/**
 * Adds a unique partial index on legal_holds to enforce at most one active
 * hold per invoice at the database level.
 *
 * Knex-compatible migration (converted from Sequelize-style).
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('legal_holds');
  if (!hasTable) {
    // Table does not exist in test environments; skip silently.
    return;
  }

  // NOTE: `NOW()` is PostgreSQL-specific.  The `hasTable` guard above
  // ensures this branch is never reached on SQLite (where `legal_holds`
  // does not exist).

  // Raw SQL for partial unique index — works on PostgreSQL and SQLite 3.8+.
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS unique_active_legal_hold_per_invoice
       ON legal_holds (invoice_id)
       WHERE active = TRUE AND expires_at > NOW()`
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('legal_holds');
  if (!hasTable) {
    return;
  }
  await knex.raw('DROP INDEX IF EXISTS unique_active_legal_hold_per_invoice');
};
