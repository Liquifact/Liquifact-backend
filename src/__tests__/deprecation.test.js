const request = require('supertest');
const express = require('express');
/* eslint-env jest */
const { deprecate } = require('../middleware/deprecation');

describe('Deprecation Middleware', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Mock deprecated route
    app.get('/old-api', deprecate({
      sunset: '2026-12-31T23:59:59Z',
      link: 'https://docs.example.com/v2'
    }), (req, res) => res.status(200).json({ ok: true }));

    // Mock healthy route
    app.get('/new-api', (req, res) => res.status(200).json({ ok: true }));
  });

  test('should include Deprecation header set to true', async () => {
    const res = await request(app).get('/old-api');
    expect(res.headers['deprecation']).toBe('true');
  });

  test('should include Sunset header in UTC format', async () => {
    const res = await request(app).get('/old-api');
    expect(res.headers['sunset']).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
  });

  test('should include Link header with rel="deprecation"', async () => {
    const res = await request(app).get('/old-api');
    expect(res.headers['link']).toBe('<https://docs.example.com/v2>; rel="deprecation"');
  });

  test('should NOT include deprecation headers on standard routes', async () => {
    const res = await request(app).get('/new-api');
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
  });
});
