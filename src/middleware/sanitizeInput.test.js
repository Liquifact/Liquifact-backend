const request = require('supertest');
const express = require('express');
const { sanitizeInput } = require('./sanitizeInput');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.post('/echo/:invoiceId', (req, res) => {
    res.json({ body: req.body, query: req.query, params: req.params });
  });
  return app;
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

describe('sanitizeInput middleware', () => {
  it('sanitizes params, query, and body before handlers run', async () => {
    const res = await request(buildApp())
      .post('/echo/%20inv-123%0A?customer=%20%20ACME%09')
      .send({ customer: '  ACME \n LTD  ', invoice: { note: '\u0000 very  important ' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      body: { customer: 'ACME LTD', invoice: { note: 'very important' } },
      query: { customer: 'ACME' },
      params: { invoiceId: 'inv-123' },
    });
  });

  it('strips prototype-pollution keys from body payload', async () => {
    const res = await request(buildApp())
      .post('/echo/inv-001')
      .send({ customer: 'Test', constructor: 'drop-me', prototype: 'drop-me-too' });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ customer: 'Test' });
  });

  it('strips __proto__ from nested body and does not pollute Object.prototype', async () => {
    const res = await request(buildApp())
      .post('/echo/inv-002')
      .send({ data: { __proto__: { evil: true }, safe: 'yes' } });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ data: { safe: 'yes' } });
    expect({}.evil).toBeUndefined();
  });

  it('re-sanitizes params when set is triggered', () => {
    const req = { body: {}, query: {}, params: {} };
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    // Trigger the params setter (simulates Express route matching)
    req.params = { invoiceId: '  inv\u0000-dirty  ', __proto__: { bad: true }, constructor: 'drop' };

    expect(req.params).toEqual({ invoiceId: 'inv-dirty' });
    expect({}.bad).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('re-sanitizes query when set is triggered', () => {
    const req = { body: {}, query: {}, params: {} };
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    // Trigger the query setter (simulates framework reassignment)
    req.query = { search: '  hello\u0000  ', __proto__: { bad: true } };

    expect(req.query).toEqual({ search: 'hello' });
    expect({}.bad).toBeUndefined();
  });

  it('sanitizes Express 5 getter-only query values without shadowing req.query', async () => {
    const app = express();

    app.use(sanitizeInput);
    app.get('/query', (req, res) => {
      res.json({
        hasOwnQuery: hasOwn(req, 'query'),
        query: req.query,
        sanitizedQuery: req.sanitizedQuery,
      });
    });

    const res = await request(app).get('/query?search=%20hello%00%20&tag=%20a&tag=%09b');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasOwnQuery: false,
      query: { search: 'hello', tag: ['a', 'b'] },
      sanitizedQuery: { search: 'hello', tag: ['a', 'b'] },
    });

    const secondRes = await request(app).get('/query?search=%20again%00%20');

    expect(secondRes.status).toBe(200);
    expect(secondRes.body).toEqual({
      hasOwnQuery: false,
      query: { search: 'again' },
      sanitizedQuery: { search: 'again' },
    });
  });

  it('falls back to sanitizedQuery for getter-only query test doubles without redefining query', () => {
    const proto = {};
    Object.defineProperty(proto, 'query', {
      configurable: true,
      enumerable: true,
      get() {
        return {
          search: '  hello\u0000  ',
          constructor: 'drop',
          nested: { note: '\u0000keep  me' },
        };
      },
    });

    const req = Object.create(proto);
    req.body = {};
    req.params = {};
    const next = jest.fn();

    expect(() => sanitizeInput(req, {}, next)).not.toThrow();

    expect(hasOwn(req, 'query')).toBe(false);
    expect(req.sanitizedQuery).toEqual({ search: 'hello', nested: { note: 'keep me' } });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses sanitizedQuery when the Express query parser is disabled', () => {
    const proto = {};
    Object.defineProperty(proto, 'query', {
      configurable: true,
      enumerable: true,
      get() {
        return { search: '  raw\u0000  ' };
      },
    });

    const req = Object.create(proto);
    req.app = {
      locals: {},
      get: jest.fn(() => false),
      set: jest.fn(),
    };
    req.body = {};
    req.params = {};
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(req.sanitizedQuery).toEqual({ search: 'raw' });
    expect(req.app.set).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('continues when a getter-only query throws', () => {
    const proto = {};
    Object.defineProperty(proto, 'query', {
      configurable: true,
      get() {
        throw new Error('query read failed');
      },
    });

    const req = Object.create(proto);
    req.body = {};
    req.params = {};
    const next = jest.fn();

    expect(() => sanitizeInput(req, {}, next)).not.toThrow();

    expect(req.sanitizedQuery).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to dedicated storage when body assignment throws', () => {
    const req = { query: {}, params: {} };
    Object.defineProperty(req, 'body', {
      configurable: true,
      get() {
        return { note: '  dirty\u0000 value  ' };
      },
      set() {
        throw new Error('body assignment failed');
      },
    });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(req.sanitizedBody).toEqual({ note: 'dirty value' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to dedicated storage when an accessor cannot be installed', () => {
    const target = { body: {}, query: {}, params: { invoiceId: '  inv\u0000-4  ' } };
    const req = new Proxy(target, {
      defineProperty(proxiedTarget, property, descriptor) {
        if (property === 'params') {
          throw new Error('params accessor failed');
        }

        return Reflect.defineProperty(proxiedTarget, property, descriptor);
      },
    });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(req.sanitizedParams).toEqual({ invoiceId: 'inv-4' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('installs sanitized accessors when query and params are initially absent', () => {
    const req = { body: {} };
    const next = jest.fn();

    sanitizeInput(req, {}, next);
    req.query = { search: '  clean\u0000 me  ' };
    req.params = { invoiceId: '  inv\u0000-5  ' };

    expect(req.query).toEqual({ search: 'clean me' });
    expect(req.params).toEqual({ invoiceId: 'inv-5' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not throw when request fields are non-writable', () => {
    const req = {};

    Object.defineProperty(req, 'body', {
      configurable: false,
      value: { note: '  dirty\u0000  ' },
      writable: false,
    });
    Object.defineProperty(req, 'query', {
      configurable: false,
      get() {
        return { search: '  dirty\u0000  ' };
      },
    });
    Object.defineProperty(req, 'params', {
      configurable: false,
      value: { invoiceId: '  inv\u0000-1  ' },
      writable: false,
    });
    Object.freeze(req);

    const next = jest.fn();

    expect(() => sanitizeInput(req, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles empty body and query gracefully', async () => {
    const res = await request(buildApp())
      .post('/echo/inv-003')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({});
    expect(res.body.query).toEqual({});
  });
});
