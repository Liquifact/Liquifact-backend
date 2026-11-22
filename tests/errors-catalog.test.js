'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const { ERROR_CATALOG, badRequest, notFound, conflict, unprocessable } = require('../src/errors');

describe('error catalog', () => {
  test('INVALID_LIMIT and INVALID_CURSOR descriptions match actual 1-100 / opaque cursor behavior', () => {
    expect(ERROR_CATALOG.INVALID_LIMIT.description).toContain('100');
    expect(ERROR_CATALOG.INVALID_LIMIT.description).not.toContain('20');
    expect(ERROR_CATALOG.INVALID_CURSOR.description).toContain('100');
    expect(ERROR_CATALOG.INVALID_CURSOR.description.toLowerCase()).toContain('opaque');
    expect(ERROR_CATALOG.INVALID_CURSOR.description).not.toContain('non-negative integer');
  });

  test('GET /errors/INVALID_LIMIT and GET /errors/INVALID_CURSOR return the corrected descriptions', async () => {
    const limitRes = await request(app).get('/errors/INVALID_LIMIT');
    expect(limitRes.status).toBe(200);
    expect(limitRes.body.code).toBe('INVALID_LIMIT');
    expect(limitRes.body.description).toBe(ERROR_CATALOG.INVALID_LIMIT.description);
    expect(limitRes.body.description).toContain('100');

    const cursorRes = await request(app).get('/errors/INVALID_CURSOR');
    expect(cursorRes.status).toBe(200);
    expect(cursorRes.body.code).toBe('INVALID_CURSOR');
    expect(cursorRes.body.description).toBe(ERROR_CATALOG.INVALID_CURSOR.description);
    expect(cursorRes.body.description).toContain('100');
    expect(cursorRes.body.description.toLowerCase()).toContain('opaque');
  });

  test('every error code passed to badRequest/notFound/conflict/unprocessable in src/routes/*.js has a catalog entry', () => {
    const routesDir = path.join(__dirname, '..', 'src', 'routes');
    const routeFiles = fs.readdirSync(routesDir).filter((file) => file.endsWith('.js'));
    const helperCallRegex = /\b(?:badRequest|notFound|conflict|unprocessable)\(\s*['"]([A-Z0-9_]+)['"]/g;

    const foundCodes = new Set();
    const missing = [];

    for (const file of routeFiles) {
      const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
      let match;
      while ((match = helperCallRegex.exec(source)) !== null) {
        const code = match[1];
        foundCodes.add(code);
        if (!ERROR_CATALOG[code]) {
          missing.push(`${file}: ${code}`);
        }
      }
    }

    expect(foundCodes.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test('error helper functions throw if an unknown code is missing from the catalog', () => {
    for (const helper of [badRequest, notFound, conflict, unprocessable]) {
      expect(() => helper('MISSING_FROM_CATALOG')).toThrow('Unknown error code: MISSING_FROM_CATALOG');
    }
  });
});
