'use strict';

const express = require('express');
const {
  mountFeatureRouter,
  listRouteMounts,
  resetRouteMounts,
} = require('../src/utils/routeMountRegistry');

describe('routeMountRegistry reset hook', () => {
  beforeEach(() => {
    resetRouteMounts();
  });

  it('allows a clean app rebuild after the registry is reset', () => {
    const router = express.Router();
    const firstApp = express();
    const rebuiltApp = express();

    mountFeatureRouter(firstApp, '/api/feature', router);
    resetRouteMounts();
    mountFeatureRouter(rebuiltApp, '/api/feature', router);

    expect(listRouteMounts(rebuiltApp)).toEqual([
      { basePath: '/api/feature', router },
    ]);
  });

  it('does not expose mutable registry entries through listRouteMounts', () => {
    const app = express();
    const router = express.Router();
    mountFeatureRouter(app, '/api/feature', router);

    const snapshot = listRouteMounts(app);
    expect(() => {
      snapshot[0].basePath = '/changed';
    }).toThrow(TypeError);
    expect(listRouteMounts(app)[0].basePath).toBe('/api/feature');
  });
});
