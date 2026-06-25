'use strict';

/**
 * @file src/db/resolveConfig.js
 * @description Select the Knex config block that corresponds to NODE_ENV.
 *              Extracted into a separate module to enable isolated unit testing.
 * @module src/db/resolveConfig
 */

/**
 * Load the knexfile config block that corresponds to `environment`.
 *
 * Throws an explicit error when NODE_ENV=test but the `test` block is missing,
 * or when NODE_ENV=production and DATABASE_URL is not set.
 *
 * @param {string} environment - The resolved NODE_ENV value.
 * @returns {import('knex').Knex.Config} Knex configuration object.
 */
function resolveConfig(environment) {
  const allConfigs = require('../../knexfile');

  if (environment === 'test') {
    const testConfig = allConfigs.test;
    if (!testConfig) {
      throw new Error(
        '[db] No "test" config block found in knexfile.js. ' +
          'The test environment must use an isolated database configuration.'
      );
    }
    return testConfig;
  }

  if (environment === 'production') {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        '[db] DATABASE_URL must be set when NODE_ENV=production.'
      );
    }
    const prodConfig = allConfigs.production;
    if (!prodConfig) {
      throw new Error('[db] No "production" config block found in knexfile.js.');
    }
    return prodConfig;
  }

  const devConfig = allConfigs[environment] || allConfigs.development;
  if (!devConfig) {
    throw new Error(
      `[db] No config block found for NODE_ENV="${environment}" in knexfile.js.`
    );
  }
  return devConfig;
}

module.exports = resolveConfig;
