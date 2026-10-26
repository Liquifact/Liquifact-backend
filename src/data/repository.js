'use strict';

const { STATUSES } = require('./statuses');
const { createMemoryRepository } = require('./memory-repository');
const { createPgRepository } = require('./pg-repository');

/**
 * @typedef {object} InvoiceRepository
 * @property {string[]} STATUSES
 * @property {(filter?: { status?: string }) => Promise<object[]>} list
 * @property {(id: string) => Promise<object|undefined>} get
 * @property {(input: object) => Promise<object>} create
 * @property {(id: string, amount: number, investor: string) => Promise<object>} fund
 * @property {(id: string, status: string) => Promise<object>} setStatus
 * @property {() => Promise<void>} reset
 */

/** @type {InvoiceRepository|null} */
let singleton = null;

/**
 * @param {{ databaseUrl?: string|null }} [options]
 * @returns {InvoiceRepository}
 */
function buildRepository(options = {}) {
  const databaseUrl = options.databaseUrl !== undefined
    ? options.databaseUrl
    : (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || null);

  if (databaseUrl) {
    return createPgRepository(databaseUrl);
  }
  return createMemoryRepository();
}

/**
 * Selects the memory repository (default) or Postgres when a database URL is set.
 * Returns a process-wide singleton unless `{ fresh: true }` is passed.
 *
 * @param {{ databaseUrl?: string|null, fresh?: boolean }} [options]
 * @returns {InvoiceRepository}
 */
function createRepository(options = {}) {
  if (options.fresh) {
    return buildRepository(options);
  }
  if (!singleton) {
    singleton = buildRepository(options);
  }
  return singleton;
}

module.exports = {
  STATUSES,
  createRepository,
  createMemoryRepository,
  createPgRepository,
};
