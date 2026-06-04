// knexfile.js
// This file provides a simple Knex configuration used by some local tooling
// and legacy JS migrations. The canonical production migrations are run with
// `node-pg-migrate` (see `migrator-config.js` and `DB_MIGRATIONS.md`).

require('dotenv').config();

module.exports = {
  development: {
    client: 'sqlite3',
    connection: {
      filename: './db.sqlite3',
    },
    migrations: {
      directory: './migrations',
    },
    seeds: {
      directory: './seeds',
    },
    useNullAsDefault: true,
  },
  test: {
    // Note: Prefer creating migrations for `node-pg-migrate` (Postgres) and
    // testing them against a Postgres instance. The SQLite configs here are
    // provided for convenience in local development only.
    directory: './migrations',
  },
  seeds: {
    directory: './seeds',
  },
  useNullAsDefault: true,
},
  production: {
  client: 'pg',
    connection: process.env.DATABASE_URL,
      migrations: {
    directory: './migrations',
    },
  seeds: {
    directory: './seeds',
    },
},
};