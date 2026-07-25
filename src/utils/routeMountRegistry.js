'use strict';

/**
 * @fileoverview Tracks feature-router mounts and rejects duplicate pairings.
 *
 * Express allows multiple routers at the same base path (e.g. two routers on
 * `/api/invoices`), but mounting the **same router instance** twice at the same
 * base path adds redundant middleware passes and makes route order ambiguous.
 *
 * @module utils/routeMountRegistry
 */

/** @type {Array<{ basePath: string, router: import('express').Router }>} */
const featureRouterMounts = [];

/**
 * Mounts a feature router at `basePath` and records the pairing.
 *
 * @param {import('express').Express} app - Express application.
 * @param {string} basePath - Mount prefix (e.g. `/api/investor`).
 * @param {import('express').Router} router - Router instance to mount.
 * @returns {void}
 * @throws {Error} When the same router instance is already mounted at `basePath`.
 */
function mountFeatureRouter(app, basePath, router) {
  const duplicate = featureRouterMounts.some(
    (entry) => entry.basePath === basePath && entry.router === router
  );

  if (duplicate) {
    throw new Error(
      `Duplicate route mount: router already mounted at ${basePath}`
    );
  }

  featureRouterMounts.push({ basePath, router });
  app.use(basePath, router);
}

/**
 * Startup guard: fails fast if duplicate (basePath, router) mounts were recorded.
 *
 * @returns {void}
 * @throws {Error} When duplicate mounts are detected.
 */
function assertNoDuplicateRouterMounts() {
  for (let i = 0; i < featureRouterMounts.length; i += 1) {
    for (let j = i + 1; j < featureRouterMounts.length; j += 1) {
      const left = featureRouterMounts[i];
      const right = featureRouterMounts[j];
      if (left.basePath === right.basePath && left.router === right.router) {
        throw new Error(`Duplicate route mount detected at ${left.basePath}`);
      }
    }
  }
}

/**
 * Returns a snapshot of recorded feature-router mounts (for tests and audits).
 *
 * @returns {ReadonlyArray<{ basePath: string, router: import('express').Router }>}
 */
function getFeatureRouterMounts() {
  return featureRouterMounts.map((entry) => ({ ...entry }));
}

/**
 * Clears recorded mounts. Call at the start of each `createApp()` invocation.
 *
 * @returns {void}
 */
function resetFeatureRouterMounts() {
  featureRouterMounts.length = 0;
}

module.exports = {
  mountFeatureRouter,
  assertNoDuplicateRouterMounts,
  getFeatureRouterMounts,
  resetFeatureRouterMounts,
};

if (process.env.NODE_ENV === 'test') {
  /**
   * Records a mount without mounting on the app (test-only helper).
   *
   * @param {string} basePath
   * @param {import('express').Router} router
   * @returns {void}
   */
  module.exports.recordFeatureRouterMountForTesting = (basePath, router) => {
    featureRouterMounts.push({ basePath, router });
  };
}
