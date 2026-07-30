'use strict';

const request = require('supertest');
const express = require('express');
const { deprecate } = require('../src/middleware/deprecation');

describe('middleware/deprecation (tests/)', () => {
  it('omits Sunset when the date is invalid', async () => {
    const app = express();
    app.get('/old', deprecate({ sunset: 'not-a-date', link: 'https://docs.example.com/v2' }), (req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).get('/old');
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeUndefined();
    expect(res.headers.link).toBe('<https://docs.example.com/v2>; rel="deprecation"');
  });

  it('sets only Deprecation when no options are passed', async () => {
    const app = express();
    app.get('/old', deprecate(), (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/old');
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeUndefined();
    expect(res.headers.link).toBeUndefined();
  });
});
