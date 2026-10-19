'use strict';

const { createMemoryRepository } = require('./memory-repository');

/**
 * Picks the repository: Postgres when DATABASE_URL is set, otherwise memory.
 *
 * @param {NodeJS.ProcessEnv} [env] environment
 * @returns {object} repository
 */
function createRepository(env = process.env) {
  if (env.DATABASE_URL) {
    // Required lazily so the zero-config demo never loads the pg driver.
    const { createPgRepository } = require('./pg-repository');
    return createPgRepository({ connectionString: env.DATABASE_URL });
  }
  return createMemoryRepository();
}

module.exports = { createRepository };
