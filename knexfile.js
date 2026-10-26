'use strict';

/**
 * Builds a knex connection config from a Postgres URL.
 * SSL is enabled when `PGSSLMODE=require`.
 *
 * @param {string} [connectionString]
 * @returns {import('knex').Knex.Config}
 */
function buildKnexConfig(connectionString) {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for knex');
  }
  const ssl = process.env.PGSSLMODE === 'require'
    ? { rejectUnauthorized: false }
    : undefined;
  return {
    client: 'pg',
    connection: {
      connectionString: url,
      ssl,
    },
    pool: { min: 0, max: 10 },
    migrations: {
      directory: `${__dirname}/migrations`,
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: `${__dirname}/seeds`,
    },
  };
}

/**
 * Knex CLI entry. Called with the current environment name.
 *
 * @param {string} [environment]
 * @returns {import('knex').Knex.Config}
 */
module.exports = function knexConfig(environment) {
  if (environment === 'test') {
    return buildKnexConfig(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  }
  return buildKnexConfig(process.env.DATABASE_URL);
};

module.exports.buildKnexConfig = buildKnexConfig;
