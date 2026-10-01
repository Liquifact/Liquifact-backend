'use strict';

/**
 * @file src/db/resolveConfig.js
 * @description Select the Knex config block that corresponds to NODE_ENV.
 *
 * Extracted into a separate, side-effect-free module so it can be
 * unit-tested in isolation without loading knex, pino, or opening any
 * database connection.
 *
 * ## Selection rules (CONTRACT 3)
 *
 * | Input env    | Returns                  | Throws when                          |
 * |--------------|--------------------------|--------------------------------------|
 * | `"test"`     | `knexfile.test`          | block is absent                      |
 * | `"production"` | `knexfile.production`  | `DATABASE_URL` unset or block absent |
 * | anything else | `knexfile[env]`         | block absent **and** `development`   |
 * |              | falls back to `development` | block also absent               |
 *
 * ## Isolation invariants
 *
 * - The `test` block **never** falls back to `development` or `production`.
 *   A missing test block is always a fatal error (CONTRACT 2).
 * - The `production` block **never** falls back to `development`.
 *   A missing `DATABASE_URL` or a missing `production` block is always fatal
 *   (CONTRACT 4).
 * - Each error thrown is an `Error` instance with a human-readable message
 *   that names the problematic environment and/or missing variable so the
 *   operator can diagnose the problem without reading source code (CONTRACT 15).
 *
 * @module src/db/resolveConfig
 */

/**
 * Normalise an environment name into a stable lookup key.
 *
 * The key is trimmed and lowercased so that callers passing
 * `"production "`, `"PRODUCTION"`, or `undefined` get deterministic
 * behaviour. Non-string inputs are treated as an empty string so the
 * default development block is selected instead of throwing a TypeError.
 *
 * @param {*} environment - Raw NODE_ENV value.
 * @returns {string} Normalised lookup key.
 */
function normaliseEnvironment(environment) {
  if (typeof environment !== 'string') {
    return '';
  }
  return environment.trim().toLowerCase();
}

/**
 * Load the knexfile config block that corresponds to `environment`.
 *
 * @param {string} environment - The resolved NODE_ENV value.
 * @returns {import('knex').Knex.Config} The Knex configuration object for the
 *   given environment. The returned object is the same reference stored in
 *   `knexfile.js`, so repeated calls with the same argument return the same
 *   object (idempotent within a Node process lifetime).
 * @throws {Error} When the environment cannot be mapped to a valid, safe
 *   config block. Every thrown value is an `Error` instance (CONTRACT 15).
 */
function resolveConfig(environment) {
  // Require is deferred (not at the top of the file) so that:
  //  1. Jest's `jest.doMock('../../knexfile', ...)` calls made *before*
  //     `require('../../src/db/resolveConfig')` take effect when this
  //     function is invoked.
  //  2. Tests using `jest.isolateModules` get a fresh require cache for
  //     both this module and knexfile, so mock substitutions are scoped.
  validateEnvironment(environment);

  const allConfigs = require('../../knexfile');
  const key = normaliseEnvironment(environment);

  // ------------------------------------------------------------------
  // test — fully isolated, no fallback permitted (CONTRACT 2, 3, 16)
  // ------------------------------------------------------------------
  if (environment === 'test') {
    const testConfig = allConfigs.test;
    if (!testConfig) {
      const err = configError(
        ERROR_CODES.MISSING_TEST_CONFIG,
        '[db] No "test" config block found in knexfile.js. ' +
          'The test environment must use an isolated database configuration ' +
          '(better-sqlite3 :memory:). Falling back to development or ' +
          'production config in tests is not permitted.'
      );
      logFailure(err, normalized);
      throw err;
    }
    validateConfigStructure(testConfig, environment);
    return testConfig;
  }

  // ------------------------------------------------------------------
  // production — DATABASE_URL required, no fallback permitted (CONTRACT 4)
  // ------------------------------------------------------------------
  if (environment === 'production') {
    // Guard: DATABASE_URL must be set before we even look at the config block.
    // An empty string is treated as absent (falsy check).
    if (!process.env.DATABASE_URL) {
      throw new Error(
        '[db] DATABASE_URL must be set when NODE_ENV=production. ' +
          'The application cannot start without a valid PostgreSQL connection string. ' +
          'Never fall back to a SQLite database in production.'
      );
      logFailure(err, normalized);
      throw err;
    }

    const prodConfig = allConfigs.production;
    if (!prodConfig) {
      throw new Error(
        '[db] No "production" config block found in knexfile.js. ' +
          'Add a production block with client: "pg" and connection: process.env.DATABASE_URL.'
      );
    }

    validateConfigStructure(prodConfig, environment);
    return prodConfig;
  }

  // ------------------------------------------------------------------
  // Other environments (development, staging, etc.)
  // Falls back to the "development" block when the exact env key is absent.
  // ------------------------------------------------------------------
  const envConfig = allConfigs[environment] || allConfigs.development;
  if (!envConfig) {
    throw new Error(
      `[db] No config block found for NODE_ENV="${environment}" in knexfile.js ` +
        'and no "development" fallback block exists. ' +
        `Add a "${environment}" or "development" block to knexfile.js.`
    );
    logFailure(err, normalized);
    throw err;
  }

  return envConfig;
  validateConfigStructure(devConfig, environment);
  return devConfig;
}

resolveConfig.normaliseEnvironment = normaliseEnvironment;

module.exports = resolveConfig;
