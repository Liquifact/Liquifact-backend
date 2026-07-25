'use strict';

const express = require('express');
const {
  mountFeatureRouter,
  assertNoDuplicateRouterMounts,
  getFeatureRouterMounts,
  resetFeatureRouterMounts,
  recordFeatureRouterMountForTesting,
} = require('../src/utils/routeMountRegistry');

describe('routeMountRegistry', () => {
  beforeEach(() => {
    resetFeatureRouterMounts();
  });

  it('records a single mount without error', () => {
    const app = express();
    const router = express.Router();

    mountFeatureRouter(app, '/api/investor', router);

    expect(getFeatureRouterMounts()).toEqual([{ basePath: '/api/investor', router }]);
    assertNoDuplicateRouterMounts();
  });

  it('allows two different routers at the same base path', () => {
    const app = express();
    const routerA = express.Router();
    const routerB = express.Router();

    mountFeatureRouter(app, '/api/invoices', routerA);
    mountFeatureRouter(app, '/api/invoices', routerB);

    expect(getFeatureRouterMounts()).toHaveLength(2);
    assertNoDuplicateRouterMounts();
  });

  it('throws when the same router instance is mounted twice at the same base path', () => {
    const app = express();
    const router = express.Router();

    mountFeatureRouter(app, '/api/investor', router);

    expect(() => mountFeatureRouter(app, '/api/investor', router)).toThrow(
      /Duplicate route mount: router already mounted at \/api\/investor/
    );
  });

  it('assertNoDuplicateRouterMounts passes for distinct router instances', () => {
    const app = express();
    mountFeatureRouter(app, '/api/investor', express.Router());
    mountFeatureRouter(app, '/api/invest', express.Router());

    expect(() => assertNoDuplicateRouterMounts()).not.toThrow();
  });

  it('assertNoDuplicateRouterMounts throws when duplicate entries exist in the registry', () => {
    const router = express.Router();
    recordFeatureRouterMountForTesting('/api/investor', router);
    recordFeatureRouterMountForTesting('/api/investor', router);

    expect(() => assertNoDuplicateRouterMounts()).toThrow(
      /Duplicate route mount detected at \/api\/investor/
    );
  });
});
