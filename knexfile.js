'use strict';

/**
 * Knex configuration. Reads DATABASE_URL; TLS is enabled when PGSSLMODE=require
 * (certificate is not verified, matching libpq's `require` semantics).
 */
module.exports = {
  client: 'pg',
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  },
  pool: { min: 0, max: 10 },
  migrations: { directory: './migrations' },
  seeds: { directory: './seeds' },
};
