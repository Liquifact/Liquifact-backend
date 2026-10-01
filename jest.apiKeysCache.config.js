'use strict';

/**
 * Isolated Jest config for the api-keys cache state-invariant suite.
 *
 * The repository default config loads `tests/mocks/setup.js`, which at base
 * fails while requiring `src/services/cacheStore.js` (`CacheValidationError is
 * not defined`). This suite mocks its own collaborators and needs none of that
 * global setup, so it runs against this minimal, self-contained config.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  transform: {},
  testMatch: ['<rootDir>/src/cache/apiKeysCache.test.js'],
};
