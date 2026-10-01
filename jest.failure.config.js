'use strict';

/**
 * @fileoverview Isolated Jest configuration for the focused failure-recovery
 * suite (`src/app.failure.test.js`, issue #1259).
 *
 * The repository's default configuration (package.json → `jest.setupFilesAfterEnv`)
 * loads `tests/mocks/setup.js`, which is absent in this sparse checkout and
 * broken at the base revision. This isolated config runs the focused suite
 * without that global setup and without loading unrelated broken modules.
 *
 * Usage:
 *   npx jest -c jest.failure.config.js --runInBand --forceExit
 *
 * @module jest.failure.config
 */

module.exports = {
  testEnvironment: 'node',
  transform: {},
  setupFilesAfterEnv: [],
  testMatch: ['<rootDir>/src/app.failure.test.js'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
};
