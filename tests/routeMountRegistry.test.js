'use strict';

const express = require('express');
const {
  mountFeatureRouter,
  assertNoDuplicateRouterMounts,
  listRouteMounts,
  resetRouteMounts,
  recordFeatureRouterMountForTesting,
} = require('../src/utils/routeMountRegistry');

describe('routeMountRegistry', () => {
  beforeEach(() => {
    resetRouteMounts();
  });

  it('records a single mount without error', () => {
    const app = express();
    const router = express.Router();

    mountFeatureRouter(app, '/api/investor', router);

    expect(listRouteMounts(app)).toEqual([{ basePath: '/api/investor', router }]);
    assertNoDuplicateRouterMounts(app);
  });

  it('allows two different routers at the same base path', () => {
    const app = express();
    const routerA = express.Router();
    const routerB = express.Router();

    mountFeatureRouter(app, '/api/invoices', routerA);
    mountFeatureRouter(app, '/api/invoices', routerB);

    expect(listRouteMounts(app)).toHaveLength(2);
    assertNoDuplicateRouterMounts(app);
  });

  it('throws when the same router instance is mounted twice at the same base path on one app', () => {
    const app = express();
    const router = express.Router();

    mountFeatureRouter(app, '/api/investor', router);

    expect(() => mountFeatureRouter(app, '/api/investor', router)).toThrow(
      /Duplicate route mount: router already mounted at \/api\/investor/
    );
  });

  it('allows the same router and path to be mounted on separate app instances', () => {
    const firstApp = express();
    const secondApp = express();
    const router = express.Router();

    mountFeatureRouter(firstApp, '/api/investor', router);
    mountFeatureRouter(secondApp, '/api/investor', router);

    expect(listRouteMounts(firstApp)).toHaveLength(1);
    expect(listRouteMounts(secondApp)).toHaveLength(1);
  });

  it('returns a read-only snapshot of recorded mounts', () => {
    const app = express();
    mountFeatureRouter(app, '/api/investor', express.Router());

    const mounts = listRouteMounts(app);

    expect(Object.isFrozen(mounts)).toBe(true);
    expect(Object.isFrozen(mounts[0])).toBe(true);
    expect(() => mounts.push({})).toThrow(TypeError);
  });

  it('resetRouteMounts clears one app without affecting another', () => {
    const firstApp = express();
    const secondApp = express();
    mountFeatureRouter(firstApp, '/api/investor', express.Router());
    mountFeatureRouter(secondApp, '/api/invest', express.Router());

    resetRouteMounts(firstApp);

    expect(listRouteMounts(firstApp)).toEqual([]);
    expect(listRouteMounts(secondApp)).toHaveLength(1);
  });

  it('assertNoDuplicateRouterMounts throws when duplicate entries exist for an app', () => {
    const app = express();
    const router = express.Router();
    recordFeatureRouterMountForTesting(app, '/api/investor', router);
    recordFeatureRouterMountForTesting(app, '/api/investor', router);

    expect(() => assertNoDuplicateRouterMounts(app)).toThrow(
      /Duplicate route mount detected at \/api\/investor/
    );
  });
});
