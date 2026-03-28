const request = require('supertest');
const express = require('express');
const { sanitizeInput } = require('./sanitizeInput');

describe('sanitizeInput middleware', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(sanitizeInput);

    app.post('/echo/:invoiceId', (req, res) => {
      res.json({
        body: req.body,
        query: req.query,
        params: req.params,
      });
    });
  });

  it('sanitizes params, query, and body before handlers run', async () => {
    const response = await request(app)
      .post('/echo/%20inv-123%0A?customer=%20%20ACME%09')
      .send({
        customer: '  ACME \n LTD  ',
        invoice: {
          note: '\u0000 very  important ',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      body: {
        customer: 'ACME LTD',
        invoice: {
          note: 'very important',
        },
      },
      query: {
        customer: 'ACME',
      },
      params: {
        invoiceId: 'inv-123',
      },
    });
  });

  it('strips prototype-pollution keys from body payload', async () => {
    const response = await request(app)
      .post('/echo/inv-001')
      .send({
        customer: 'Test',
        constructor: 'drop-me',
        prototype: 'drop-me-too',
      });

    expect(response.status).toBe(200);
    expect(response.body.body).toEqual({
      customer: 'Test',
    });
  });
});
