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
 * ## State invariants
 *
 * The following invariants are pinned by `src/db/resolveConfig.test.js` and
 * must hold for every call, including adverse inputs:
 *
 * - **Normalisation is the single source of truth.** The raw `environment`
 *   value is never compared directly. `normaliseEnvironment` trims and
 *   lowercases strings and maps every non-string value (including
 *   `undefined`, `null`, numbers, and objects) to the empty string. All
 *   branching and lookups therefore use the normalised key.
 * - **Deterministic for valid input.** For a valid environment key the same
 *   input always resolves to the same `knexfile` block reference, regardless
 *   of call order, repetition, or interleaved invalid calls.
 * - **Total for missing/empty/malformed input.** A missing, empty,
 *   whitespace-only, or non-string environment never throws on its own; it
 *   normalises to `""` and falls back to the `development` block. It only
 *   throws when no `development` fallback exists in `knexfile.js`.
 * - **Pure and non-mutating.** Resolution never mutates its argument, the
 *   `knexfile` blocks, or `process.env` (the production branch only *reads*
 *   `DATABASE_URL`). The returned object is the exact reference stored in
 *   `knexfile.js`, so the module stays side-effect-free.
 * - **Export shape is stable.** The module still exports the bare function
 *   (`module.exports = resolveConfig`) with `normaliseEnvironment` attached
 *   as a property.
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
  const allConfigs = require('../../knexfile');
  // Normalise once and use the key everywhere: this is what makes the
  // resolution deterministic for "PRODUCTION", " test ", and non-string
  // values, and what keeps unknown/malformed input from ever throwing here.
  const key = normaliseEnvironment(environment);

  // ------------------------------------------------------------------
  // test — fully isolated, no fallback permitted (CONTRACT 2, 3, 16)
  // ------------------------------------------------------------------
  if (key === 'test') {
    const testConfig = allConfigs.test;
    if (!testConfig) {
      throw new Error(
        '[db] No "test" config block found in knexfile.js. ' +
          'The test environment must use an isolated database configuration ' +
          '(better-sqlite3 :memory:). Falling back to development or ' +
          'production config in tests is not permitted.'
      );
    }
    return testConfig;
  }

  // ------------------------------------------------------------------
  // production — DATABASE_URL required, no fallback permitted (CONTRACT 4)
  // ------------------------------------------------------------------
  if (key === 'production') {
    // Guard: DATABASE_URL must be set before we even look at the config block.
    // An empty string is treated as absent (falsy check).
    if (!process.env.DATABASE_URL) {
      throw new Error(
        '[db] DATABASE_URL must be set when NODE_ENV=production. ' +
          'The application cannot start without a valid PostgreSQL connection string. ' +
          'Never fall back to a SQLite database in production.'
      );
    }

    const prodConfig = allConfigs.production;
    if (!prodConfig) {
      throw new Error(
        '[db] No "production" config block found in knexfile.js. ' +
          'Add a production block with client: "pg" and connection: process.env.DATABASE_URL.'
      );
    }

    return prodConfig;
  }

  // ------------------------------------------------------------------
  // Other environments (development, staging, etc.)
  // Falls back to the "development" block when the exact env key is absent.
  // Missing/empty/malformed input normalises to "" and lands here, which is
  // why a safe default is returned instead of a TypeError.
  // ------------------------------------------------------------------
  const envConfig = allConfigs[key] || allConfigs.development;
  if (!envConfig) {
    throw new Error(
      `[db] No config block found for NODE_ENV="${environment}" in knexfile.js ` +
        'and no "development" fallback block exists. ' +
        `Add a "${environment}" or "development" block to knexfile.js.`
    );
  }

  return envConfig;
}

resolveConfig.normaliseEnvironment = normaliseEnvironment;

module.exports = resolveConfig;
