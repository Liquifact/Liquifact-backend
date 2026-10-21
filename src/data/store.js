'use strict';

/**
 * Legacy export surface. Routes and new tests should use `req.app.locals.repo`
 * (or `createRepository()`). This module re-exports `STATUSES` and a shared
 * memory repository for scripts that still import `./store`.
 */

const { STATUSES } = require('./statuses');
const { createRepository } = require('./repository');

/** Shared default repository (memory unless DATABASE_URL / TEST_DATABASE_URL is set). */
const repo = createRepository();

module.exports = {
  STATUSES,
  repo,
  list: (...args) => repo.list(...args),
  get: (...args) => repo.get(...args),
  create: (...args) => repo.create(...args),
  fund: (id, amount, investor) => repo.fund(id, amount, investor),
  reset: () => repo.reset(),
  setStatus: (...args) => repo.setStatus(...args),
};
