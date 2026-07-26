'use strict';

/**
 * @fileoverview Tracks feature-router mounts and rejects duplicate pairings.
 *
 * Express allows multiple routers at the same base path (e.g. two routers on
 * `/api/invoices`), but mounting the **same router instance** twice at the same
 * base path adds redundant middleware passes and makes route order ambiguous.
 *
 * Mount state is scoped to each Express app instance so independently-built
 * applications do not share registry state.
 *
 * @module utils/routeMountRegistry
 */

/** @type {WeakMap<import('express').Express, Array<{ basePath: string, router: import('express').Router }>>} */
let featureRouterMountsByApp = new WeakMap();

/**
 * Resolves the mutable mount registry for an Express app.
 *
 * @param {import('express').Express} app - Express application.
 * @returns {Array<{ basePath: string, router: import('express').Router }>} Mount registry.
 */
function getMountsForApp(app) {
  let mounts = featureRouterMountsByApp.get(app);
  if (!mounts) {
    mounts = [];
    featureRouterMountsByApp.set(app, mounts);
  }
  return mounts;
}

/**
 * Mounts a feature router at `basePath` and records the pairing for `app`.
 *
 * @param {import('express').Express} app - Express application.
 * @param {string} basePath - Mount prefix (e.g. `/api/investor`).
 * @param {import('express').Router} router - Router instance to mount.
 * @returns {void}
 * @throws {Error} When the same router instance is already mounted at `basePath` on `app`.
 */
function mountFeatureRouter(app, basePath, router) {
  const mounts = getMountsForApp(app);
  const duplicate = mounts.some(
    (entry) => entry.basePath === basePath && entry.router === router
  );

  if (duplicate) {
    throw new Error(
      `Duplicate route mount: router already mounted at ${basePath}`
    );
  }

  mounts.push({ basePath, router });
  app.use(basePath, router);
}

/**
 * Startup guard: fails fast if duplicate (basePath, router) mounts were recorded
 * for an app.
 *
 * @param {import('express').Express} app - Express application.
 * @returns {void}
 * @throws {Error} When duplicate mounts are detected.
 */
function assertNoDuplicateRouterMounts(app) {
  const mounts = getMountsForApp(app);
  for (let i = 0; i < mounts.length; i += 1) {
    for (let j = i + 1; j < mounts.length; j += 1) {
      const left = mounts[i];
      const right = mounts[j];
      if (left.basePath === right.basePath && left.router === right.router) {
        throw new Error(`Duplicate route mount detected at ${left.basePath}`);
      }
    }
  }
}

/**
 * Returns an immutable snapshot of feature-router mounts for an app.
 *
 * @param {import('express').Express} app - Express application.
 * @returns {ReadonlyArray<{ basePath: string, router: import('express').Router }>} Mount snapshot.
 */
function listRouteMounts(app) {
  return Object.freeze(
    getMountsForApp(app).map((entry) => Object.freeze({ ...entry }))
  );
}

/**
 * Backwards-compatible alias for `listRouteMounts`.
 *
 * @param {import('express').Express} app - Express application.
 * @returns {ReadonlyArray<{ basePath: string, router: import('express').Router }>} Mount snapshot.
 */
function getFeatureRouterMounts(app) {
  return listRouteMounts(app);
}

/**
 * Clears mounts for one app, or replaces the registry entirely when no app is
 * provided. The no-argument form is intended for test setup.
 *
 * @param {import('express').Express} [app] - Optional Express application.
 * @returns {void}
 */
function resetRouteMounts(app) {
  if (app) {
    featureRouterMountsByApp.delete(app);
    return;
  }
  featureRouterMountsByApp = new WeakMap();
}

/**
 * Backwards-compatible alias for `resetRouteMounts`.
 *
 * @param {import('express').Express} [app] - Optional Express application.
 * @returns {void}
 */
function resetFeatureRouterMounts(app) {
  resetRouteMounts(app);
}

module.exports = {
  mountFeatureRouter,
  assertNoDuplicateRouterMounts,
  listRouteMounts,
  resetRouteMounts,
  getFeatureRouterMounts,
  resetFeatureRouterMounts,
};

if (process.env.NODE_ENV === 'test') {
  /**
   * Records a mount without mounting on the app (test-only helper).
   *
   * @param {import('express').Express} app - Express application.
   * @param {string} basePath - Mount prefix.
   * @param {import('express').Router} router - Router instance.
   * @returns {void}
   */
  module.exports.recordFeatureRouterMountForTesting = (app, basePath, router) => {
    getMountsForApp(app).push({ basePath, router });
  };
}
