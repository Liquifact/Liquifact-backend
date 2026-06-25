// knexfile.js
// This file provides Knex configuration blocks for each runtime environment.
//
// Environment selection
// ---------------------
// `src/db/knex.js` selects the block that matches NODE_ENV at startup.
//
// test        – in-memory SQLite.  Fully isolated: no network, no shared file,
//               no fallback to development or production config.  Per-worker
//               isolation is achieved automatically because each Jest worker
//               gets its own in-process SQLite instance.
//
// development – file-based SQLite (`./db.sqlite3`) for fast local iteration.
//
// production  – PostgreSQL via DATABASE_URL (required).  Uses node-pg-migrate
//               as the authoritative migration runner (see DB_MIGRATIONS.md).
//
// Pool configuration
// ------------------
// Pool defaults (min/max/timeouts) are applied by `src/db/knex.js`.
// Override them here per-environment by adding a `pool` key.
//
// Canonical production migrations
// --------------------------------
// The canonical migration runner for production is `node-pg-migrate`
// (configured via `migrator-config.js`).  The `migrations.directory` values
// below are retained only for legacy tooling / the Knex CLI.

'use strict';

require('dotenv').config();

module.exports = {
  // -------------------------------------------------------------------------
  // test – isolated in-memory SQLite
  // -------------------------------------------------------------------------
  // IMPORTANT: This block must remain isolated from development/production.
  // - Uses SQLite `:memory:` so each test run starts with a clean, empty DB.
  // - `src/db/knex.js` throws if NODE_ENV=test and this block is missing,
  //   preventing silent fallback to a shared database.
  // - Jest's `--runInBand` flag means all tests share one process; each test
  //   file that requires its own DB state should use the manual mock at
  //   `src/db/__mocks__/knex.js` instead of this real connection.
  test: {
    client: 'sqlite3',
    connection: {
      filename: ':memory:',
    },
    migrations: {
      directory: './migrations',
    },
    seeds: {
      directory: './seeds',
    },
    useNullAsDefault: true,
    // Keep the pool tiny for tests – we never need more than one connection.
    pool: { min: 1, max: 1 },
  },

  // -------------------------------------------------------------------------
  // development – file-based SQLite
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // production – PostgreSQL (DATABASE_URL required)
  // -------------------------------------------------------------------------
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
