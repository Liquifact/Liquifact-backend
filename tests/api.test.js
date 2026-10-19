'use strict';

const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const app = require('../src/app');
const store = require('../src/data/store');

beforeEach(() => store.reset());

// ---------------------------------------------------------------------------
// Existing tests — unchanged
// ---------------------------------------------------------------------------
describe('system', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET / lists endpoints and contract', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.length).toBeGreaterThan(5);
    expect(res.body.contract.id).toMatch(/^C[A-Z0-9]{55}$/);
  });

  test('GET /docs and /openapi.json', async () => {
    const docs = await request(app).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui');
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/api/invoices');
  });

  test('unknown route is a JSON 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});

describe('invoices', () => {
  test('list and filter', async () => {
    const all = await request(app).get('/api/invoices');
    expect(all.body.count).toBe(4);
    const open = await request(app).get('/api/invoices?status=open');
    expect(open.body.data.every((i) => i.status === 'open')).toBe(true);
    const bad = await request(app).get('/api/invoices?status=weird');
    expect(bad.status).toBe(400);
  });

  test('get by id', async () => {
    expect((await request(app).get('/api/invoices/INV_0001')).status).toBe(200);
    expect((await request(app).get('/api/invoices/missing')).status).toBe(404);
  });

  test('create validates and stores', async () => {
    const bad = await request(app).post('/api/invoices').send({ sme: '' });
    expect(bad.status).toBe(400);
    const ok = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('open');
  });

  test('fund moves invoice to funded when target reached', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
    expect(again.status).toBe(409);
  });
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });
});

// ---------------------------------------------------------------------------
// New tests — acceptance criteria for issue #1562
// ---------------------------------------------------------------------------

describe('OpenAPI schema constraints (fail on main, pass with zod)', () => {
  test('CreateInvoiceBody.properties.amount has exclusiveMinimum/maximum', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);

    const schemas = res.body.components.schemas;
    expect(schemas).toBeDefined();
    expect(schemas.CreateInvoiceBody).toBeDefined();

    const amountProp = schemas.CreateInvoiceBody.properties.amount;
    expect(amountProp).toBeDefined();

    // Must have an upper bound
    expect(amountProp.maximum).toBe(1e12);

    // OAS 3.0: exclusiveMinimum is a boolean true (paired with minimum: 0)
    expect(amountProp.exclusiveMinimum).toBe(true);
    expect(amountProp.minimum).toBe(0);
  });

  test('string fields in CreateInvoiceBody have maxLength 120', async () => {
    const res = await request(app).get('/openapi.json');
    const schemas = res.body.components.schemas;
    const props = schemas.CreateInvoiceBody.properties;

    expect(props.sme.maxLength).toBe(120);
    expect(props.debtor.maxLength).toBe(120);
  });

  test('FundInvoiceBody marks amount as required', async () => {
    const res = await request(app).get('/openapi.json');
    const fundSchema = res.body.components.schemas.FundInvoiceBody;
    expect(fundSchema).toBeDefined();
    expect(fundSchema.required).toContain('amount');
  });
});

describe('unknown body key rejected (strict mode)', () => {
  test('POST /api/invoices with unknown field returns 400', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send({
        sme: 'A',
        debtor: 'B',
        amount: 5,
        dueDate: '2027-01-01',
        isAdmin: true, // unknown key
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  test('POST /api/invoices/:id/fund with unknown field returns 400', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0001/fund')
      .set('Content-Type', 'application/json')
      .send({ amount: 10, extra: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('415 when Content-Type is not application/json', () => {
  test('POST /api/invoices with text/plain returns 415', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'text/plain')
      .send('sme=A&debtor=B&amount=5&dueDate=2027-01-01');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('POST /api/invoices/:id/fund with text/plain returns 415', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0001/fund')
      .set('Content-Type', 'text/plain')
      .send('amount=100');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('overlong :id returns 400', () => {
  test('GET /api/invoices/:id with 1 KB id returns 400', async () => {
    const longId = 'A'.repeat(1024);
    const res = await request(app).get(`/api/invoices/${longId}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  test('POST /api/invoices/:id/fund with 1 KB id returns 400', async () => {
    const longId = 'A'.repeat(1024);
    const res = await request(app)
      .post(`/api/invoices/${longId}/fund`)
      .set('Content-Type', 'application/json')
      .send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('structured errors[].path for each invalid field', () => {
  test('errors array has path, message, code for each bad field', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send({ sme: '', debtor: 123, amount: -1, dueDate: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');

    const errors = res.body.errors;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);

    // Every error item must have path, message, code
    for (const e of errors) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
      expect(typeof e.code).toBe('string');
    }

    // We must see path entries for the known bad fields
    const paths = errors.map((e) => e.path);
    expect(paths).toContain('sme');
    expect(paths).toContain('amount');
    expect(paths).toContain('dueDate');
  });

  test('backward-compat: details is a flat string array', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send({ sme: '', amount: -1, dueDate: 'bad' });

    expect(res.status).toBe(400);
    const details = res.body.details;
    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeGreaterThan(0);
    expect(typeof details[0]).toBe('string');
  });
});

describe('GET /openapi.json is a valid OpenAPI 3 document', () => {
  test('swagger-parser validates the document without errors', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);

    // swagger-parser expects a URL or file path, but also accepts a plain JS object
    await expect(SwaggerParser.validate(res.body)).resolves.toBeDefined();
  });
});

describe('GET /openapi.json contains all new paths and schemas', () => {
  test('paths include invoices and fund endpoints', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/api/invoices');
    expect(paths).toContain('/api/invoices/{id}');
    expect(paths).toContain('/api/invoices/{id}/fund');
    expect(paths).toContain('/api/escrow');
    expect(paths).toContain('/api/escrow/live');
  });

  test('components.schemas includes all expected schemas', async () => {
    const res = await request(app).get('/openapi.json');
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toContain('Invoice');
    expect(schemas).toContain('CreateInvoiceBody');
    expect(schemas).toContain('FundInvoiceBody');
    expect(schemas).toContain('ErrorResponse');
  });

  test('POST /api/invoices requestBody refs CreateInvoiceBody', async () => {
    const res = await request(app).get('/openapi.json');
    const postBody =
      res.body.paths['/api/invoices'].post.requestBody.content['application/json'].schema;
    expect(postBody.$ref).toContain('CreateInvoiceBody');
  });

  test('POST /api/invoices/{id}/fund requestBody refs FundInvoiceBody', async () => {
    const res = await request(app).get('/openapi.json');
    const postBody =
      res.body.paths['/api/invoices/{id}/fund'].post.requestBody.content['application/json'].schema;
    expect(postBody.$ref).toContain('FundInvoiceBody');
  });

  test('POST /api/invoices documents 415 status', async () => {
    const res = await request(app).get('/openapi.json');
    const responses = res.body.paths['/api/invoices'].post.responses;
    expect(responses['415']).toBeDefined();
  });
});
