'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const app = require('../src/app');
const store = require('../src/data/store');
const { defaultDocumentStore } = require('../src/data/documentStore');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample.pdf');
const FIXTURE_BYTES = fs.readFileSync(FIXTURE_PATH);
const FIXTURE_SHA256 = crypto.createHash('sha256').update(FIXTURE_BYTES).digest('hex');

beforeEach(() => {
  store.reset();
  defaultDocumentStore.clear();
});

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

  test('openapi documents funding contract', async () => {
    const spec = await request(app).get('/openapi.json');
    const fund = spec.body.paths['/api/invoices/{id}/fund'].post;
    expect(fund).toBeDefined();
    expect(fund.responses['422']).toBeDefined();
    expect(fund.responses['400']).toBeDefined();
    expect(fund.requestBody.content['application/json'].schema.properties.allowPartial).toBeDefined();
    const schemas = spec.body.components.schemas;
    expect(schemas.Invoice.properties.remainingCapacity).toBeDefined();
    expect(schemas.FundingError).toBeDefined();
    expect(schemas.FundRequest).toBeDefined();
    expect(schemas.FundResponse).toBeDefined();
  });

  test('unknown route is a JSON 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});

const invoice = (overrides = {}) => ({
  sme: 'Test SME',
  debtor: 'Buyer Co',
  invoiceNumber: 'TEST-001',
  amount: 500,
  dueDate: '2027-01-01',
  ...overrides,
});

describe('duplicate invoice guard', () => {
  test('openapi documents the invoice integrity contract', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    const post = spec.paths['/api/invoices'].post;
    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.required).not.toContain('invoiceNumber');
    expect(schema.properties.invoiceNumber).toMatchObject({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._/-]{1,64}$' });
    expect(schema.properties.confirmNotDuplicate.type).toBe('boolean');
    expect(post.responses).toHaveProperty('400');
    expect(post.responses).toHaveProperty('409');
    expect(post.responses['409'].content['application/json'].schema.properties.code.enum).toEqual(['DUPLICATE_INVOICE', 'POSSIBLE_DUPLICATE']);
  });

  test('permits multiple invoices without invoice numbers and gives them distinct ids', async () => {
    const payload = { sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };
    const first = await request(app).post('/api/invoices').send(payload);
    const second = await request(app).post('/api/invoices').send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.id).toMatch(/^INV_\d{4}$/);
    expect(second.body.data.id).toMatch(/^INV_\d{4}$/);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  test('exact and possible duplicates are rejected with 409', async () => {
    const first = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'DUP-1' }));
    const exact = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'DUP-1' }));
    expect(first.status).toBe(201);
    expect(exact.status).toBe(409);
    expect(exact.body).toEqual({ code: 'DUPLICATE_INVOICE', existingId: first.body.data.id });

    const possible = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'DUP-2' }));
    expect(possible.status).toBe(409);
    expect(possible.body).toEqual({ code: 'POSSIBLE_DUPLICATE', existingId: first.body.data.id });
  });

  test('normalized SME identity cannot bypass the exact duplicate check', async () => {
    await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'N-1' }));
    const variant = await request(app).post('/api/invoices').send(invoice({ sme: '  test   sme. ', invoiceNumber: 'N-1', amount: 900 }));
    expect(variant.status).toBe(409);
    expect(variant.body.code).toBe('DUPLICATE_INVOICE');
  });

  test('confirmNotDuplicate overrides only a possible duplicate and is recorded', async () => {
    await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'C-1' }));
    const confirmed = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'C-2', confirmNotDuplicate: true }));
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.duplicateOverride).toBe(true);
    expect(confirmed.body.data).not.toHaveProperty('confirmNotDuplicate');
    const exact = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'C-1', confirmNotDuplicate: true }));
    expect(exact.status).toBe(409);
    expect(exact.body.code).toBe('DUPLICATE_INVOICE');
  });

  test('a cancelled invoice can be submitted again', async () => {
    const first = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'X-1' }));
    expect((await request(app).post(`/api/invoices/${first.body.data.id}/cancel`)).status).toBe(200);
    const again = await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'X-1' }));
    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(first.body.data.id);
  });

  test('rejects malformed invoice numbers and punctuation-only names', async () => {
    expect((await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'bad number!' }))).status).toBe(400);
    expect((await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'x'.repeat(65) }))).status).toBe(400);
    expect((await request(app).post('/api/invoices').send(invoice({ sme: '...' }))).status).toBe(400);
  });

  test('store.reset rebuilds the duplicate indexes', async () => {
    await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'R-1' }));
    store.reset();
    expect((await request(app).post('/api/invoices').send(invoice({ invoiceNumber: 'R-1' }))).status).toBe(201);
    expect(store.get('INV_0001')).toBeDefined();
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

  test('remainingCapacity is present in list and detail', async () => {
    const list = await request(app).get('/api/invoices');
    const inv = list.body.data.find((i) => i.id === 'INV_0002');
    expect(inv.remainingCapacity).toBe(7000);
    const detail = await request(app).get('/api/invoices/INV_0002');
    expect(detail.body.data.remainingCapacity).toBe(7000);
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
    expect(ok.body.data.remainingCapacity).toBe(500);
  });

  test('fund moves invoice to funded when target reached', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('funded');
    expect(res.body.data.remainingCapacity).toBe(0);
    const again = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
    expect(again.status).toBe(409);
  });

  describe('over-funding', () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';

    test('rejects over-funding with 422 and does not mutate', async () => {
      const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 20000, investor });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FUNDING_EXCEEDS_CAPACITY');
      expect(res.body.remainingCapacity).toBe(7000);
      const after = await request(app).get('/api/invoices/INV_0002');
      expect(after.body.data.fundedAmount).toBe(18000);
      expect(after.body.data.status).toBe('open');
    });

    test('allowPartial caps contribution and reports split', async () => {
      const res = await request(app)
        .post('/api/invoices/INV_0002/fund')
        .send({ amount: 20000, investor, allowPartial: true });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(7000);
      expect(res.body.rejected).toBe(13000);
      expect(res.body.data.fundedAmount).toBe(25000);
      expect(res.body.data.status).toBe('funded');
      expect(res.body.data.remainingCapacity).toBe(0);
    });

    test('rejects invalid amounts (non-positive, non-finite, above face value, non-number) with 400', async () => {
      for (const amount of [0, -1, 1e308, 25001, '100']) {
        const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount, investor });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_AMOUNT');
      }
      expect(store.get('INV_0002').fundedAmount).toBe(18000);
    });

    test('an amount just above remaining capacity is rejected with 422', async () => {
      const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7001, investor });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FUNDING_EXCEEDS_CAPACITY');
    });

    test('rejects funding a non-open invoice with 409', async () => {
      await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
      const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 1, investor });
      expect(res.status).toBe(409);
    });
  });

  test('store.fund throws when called over capacity and does not mutate', () => {
    const invoice = store.get('INV_0002');
    expect(() => store.fund(invoice, 100000, 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC')).toThrow();
    expect(invoice.fundedAmount).toBe(18000);
    expect(invoice.status).toBe('open');
  });

  test('create rejects non-ISO dueDate', async () => {
    const bad = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: 'January 1, 2027' });
    expect(bad.status).toBe(400);

    const alsoBad = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '01/01/2027' });
    expect(alsoBad.status).toBe(400);
  });

  test('create treats null yieldBps as default', async () => {
    const ok = await request(app)
      .post('/api/invoices')
      .send({ sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01', yieldBps: null });
    expect(ok.status).toBe(201);
    expect(ok.body.data.yieldBps).toBe(800);
  });

  test('settle moves funded invoice to settled', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    const res = await request(app).post('/api/invoices/INV_0002/settle');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('settled');
  });

  test('settle rejects non-funded invoice', async () => {
    const res = await request(app).post('/api/invoices/INV_0001/settle');
    expect(res.status).toBe(409);
  });

  test('cancel moves open invoice to cancelled', async () => {
    const res = await request(app).post('/api/invoices/INV_0001/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  test('cancel moves funded invoice to cancelled', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    const res = await request(app).post('/api/invoices/INV_0002/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  test('cancel rejects settled invoice', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 7000, investor });
    await request(app).post('/api/invoices/INV_0002/settle');
    const res = await request(app).post('/api/invoices/INV_0002/cancel');
    expect(res.status).toBe(409);
  });

  test('settle and cancel return 404 for missing invoice', async () => {
    expect((await request(app).post('/api/invoices/missing/settle')).status).toBe(404);
    expect((await request(app).post('/api/invoices/missing/cancel')).status).toBe(404);
  });
});

describe('escrow', () => {
  test('GET /api/escrow returns contract metadata', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(200);
    expect(res.body.explorer).toContain('stellar.expert');
  });
});

describe('invoice document — upload (POST /api/invoices/:id/document)', () => {
  test('uploads a valid PDF and returns correct SHA-256 digest', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.sha256Hex).toBe(FIXTURE_SHA256);
    expect(res.body.data.sizeBytes).toBe(FIXTURE_BYTES.length);
    expect(res.body.data.originalName).toBe('sample.pdf');
    expect(typeof res.body.data.uploadedAt).toBe('string');
  });

  test('upload attaches document metadata to the invoice', async () => {
    await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', FIXTURE_BYTES, { filename: 'invoice.pdf', contentType: 'application/pdf' });

    const invoiceRes = await request(app).get('/api/invoices/INV_0001');
    expect(invoiceRes.body.data.document).toBeDefined();
    expect(invoiceRes.body.data.document.sha256Hex).toBe(FIXTURE_SHA256);
  });

  test('returns 404 for unknown invoice', async () => {
    const res = await request(app)
      .post('/api/invoices/UNKNOWN_INV/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(404);
  });

  test('returns 409 when invoice is not open (funded)', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0003/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  test('returns 409 when invoice is not open (settled)', async () => {
    const res = await request(app)
      .post('/api/invoices/INV_0004/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  test('returns 409 DOCUMENT_EXISTS on second upload', async () => {
    await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });

    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DOCUMENT_EXISTS');
  });

  test('returns 400 when no file is provided', async () => {
    // Send a multipart request with a non-file field — multer gets no 'file' field
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .field('other', 'value');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
  });

  test('returns 413 when file exceeds size limit', async () => {
    // Create a buffer that is slightly over 5 MiB
    const MAX = 5 * 1024 * 1024 + 1;
    // Build a fake "PDF" that is over the size limit — the multer limit fires before content validation
    const oversize = Buffer.alloc(MAX, 0x41); // fill with 'A'
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', oversize, { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PAYLOAD_TOO_LARGE');
  });

  test('returns 415 for file with wrong magic bytes (not a real PDF)', async () => {
    const fakePdf = Buffer.from('This is not a PDF file at all\n%%EOF\n');
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', fakePdf, { filename: 'fake.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('returns 415 for file with .pdf name but wrong content type when magic bytes are absent', async () => {
    const plainText = Buffer.from('not a pdf content here');
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', plainText, { filename: 'invoice.pdf', contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('returns 422 for PDF containing /JavaScript action', async () => {
    const unsafePdf = Buffer.from('%PDF-1.4\n/JavaScript (alert(1))\n%%EOF');
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', unsafePdf, { filename: 'unsafe.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('UNSAFE_PDF');
  });

  test('returns 422 for PDF containing /Launch action', async () => {
    const unsafePdf = Buffer.from('%PDF-1.4\n/Launch /Action\n%%EOF');
    const res = await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', unsafePdf, { filename: 'unsafe.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('UNSAFE_PDF');
  });
});

describe('invoice document — download (GET /api/invoices/:id/document)', () => {
  beforeEach(async () => {
    // Upload a document to INV_0001 before each download test
    await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });
  });

  test('returns identical bytes to what was uploaded', async () => {
    const res = await request(app)
      .get('/api/invoices/INV_0001/document')
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, FIXTURE_BYTES)).toBe(0);
  });

  test('sets correct Content-Type header (application/pdf)', async () => {
    const res = await request(app).get('/api/invoices/INV_0001/document');
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('sets Content-Disposition: attachment header', async () => {
    const res = await request(app).get('/api/invoices/INV_0001/document');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  test('sets X-Content-Type-Options: nosniff header', async () => {
    const res = await request(app).get('/api/invoices/INV_0001/document');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('sets ETag header with the SHA-256 digest', async () => {
    const res = await request(app).get('/api/invoices/INV_0001/document');
    expect(res.headers['etag']).toBe(`"${FIXTURE_SHA256}"`);
  });

  test('returns 404 for unknown invoice', async () => {
    const res = await request(app).get('/api/invoices/UNKNOWN_INV/document');
    expect(res.status).toBe(404);
  });

  test('returns 404 when invoice exists but has no document', async () => {
    const res = await request(app).get('/api/invoices/INV_0002/document');
    expect(res.status).toBe(404);
  });
});

describe('invoice document — metadata (GET /api/invoices/:id/document/meta)', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/invoices/INV_0001/document')
      .attach('file', FIXTURE_BYTES, { filename: 'sample.pdf', contentType: 'application/pdf' });
  });

  test('returns metadata with attestationHash equal to sha256Hex', async () => {
    const res = await request(app).get('/api/invoices/INV_0001/document/meta');
    expect(res.status).toBe(200);
    expect(res.body.data.sha256Hex).toBe(FIXTURE_SHA256);
    expect(res.body.data.attestationHash).toBe(FIXTURE_SHA256);
    expect(res.body.data.sha256Hex).toBe(res.body.data.attestationHash);
    expect(res.body.data.sizeBytes).toBe(FIXTURE_BYTES.length);
    expect(res.body.data.originalName).toBe('sample.pdf');
  });

  test('returns 404 for unknown invoice', async () => {
    const res = await request(app).get('/api/invoices/UNKNOWN_INV/document/meta');
    expect(res.status).toBe(404);
  });

  test('returns 404 when invoice exists but has no document', async () => {
    const res = await request(app).get('/api/invoices/INV_0002/document/meta');
    expect(res.status).toBe(404);
  });
});

describe('openapi.json — document routes are present', () => {
  let spec;

  beforeAll(async () => {
    const res = await request(app).get('/openapi.json');
    spec = res.body;
  });

  test('spec includes POST /api/invoices/{id}/document', () => {
    expect(spec.paths['/api/invoices/{id}/document']).toBeDefined();
    expect(spec.paths['/api/invoices/{id}/document'].post).toBeDefined();
  });

  test('spec includes GET /api/invoices/{id}/document', () => {
    expect(spec.paths['/api/invoices/{id}/document'].get).toBeDefined();
  });

  test('spec includes GET /api/invoices/{id}/document/meta', () => {
    expect(spec.paths['/api/invoices/{id}/document/meta']).toBeDefined();
    expect(spec.paths['/api/invoices/{id}/document/meta'].get).toBeDefined();
  });

  test('POST document has multipart/form-data request body', () => {
    const postOp = spec.paths['/api/invoices/{id}/document'].post;
    expect(postOp.requestBody.content['multipart/form-data']).toBeDefined();
    expect(postOp.requestBody.content['multipart/form-data'].schema.properties.file).toBeDefined();
  });

  test('spec documents 201, 400, 404, 409, 413, 415, 422 on POST document', () => {
    const responses = spec.paths['/api/invoices/{id}/document'].post.responses;
    expect(responses['201']).toBeDefined();
    expect(responses['400']).toBeDefined();
    expect(responses['404']).toBeDefined();
    expect(responses['409']).toBeDefined();
    expect(responses['413']).toBeDefined();
    expect(responses['415']).toBeDefined();
    expect(responses['422']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// zod validation and generated OpenAPI schemas (#1562)
// ---------------------------------------------------------------------------
describe('zod validation (#1562)', () => {
  const INVESTOR = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';

  test('CreateInvoiceBody.properties.amount has exclusiveMinimum/maximum and names have maxLength 120', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    const props = res.body.components.schemas.CreateInvoiceBody.properties;
    expect(props.amount.maximum).toBe(1e12);
    // OAS 3.0: exclusiveMinimum is a boolean paired with minimum
    expect(props.amount.exclusiveMinimum).toBe(true);
    expect(props.amount.minimum).toBe(0);
    expect(props.sme.maxLength).toBe(120);
    expect(props.debtor.maxLength).toBe(120);
  });

  test('FundInvoiceBody marks amount and investor as required', async () => {
    const res = await request(app).get('/openapi.json');
    const fundSchema = res.body.components.schemas.FundInvoiceBody;
    expect(fundSchema.required).toEqual(expect.arrayContaining(['amount', 'investor']));
  });

  test('request bodies in paths are the generated component schemas', async () => {
    const { body: spec } = await request(app).get('/openapi.json');
    const create = spec.paths['/api/invoices'].post.requestBody.content['application/json'].schema;
    const fund = spec.paths['/api/invoices/{id}/fund'].post.requestBody.content['application/json'].schema;
    expect(create).toEqual(spec.components.schemas.CreateInvoiceBody);
    expect(fund).toEqual(spec.components.schemas.FundInvoiceBody);
    expect(spec.paths['/api/invoices'].post.responses['415']).toBeDefined();
    expect(spec.paths['/api/invoices/{id}/fund'].post.responses['415']).toBeDefined();
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['Invoice', 'CreateInvoiceBody', 'FundInvoiceBody', 'InvoiceIdParam', 'ListInvoicesQuery', 'ErrorResponse']),
    );
  });

  test('POST /api/invoices with an unknown field returns 400', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .send({ sme: 'A', debtor: 'B', amount: 5, dueDate: '2027-01-01', isAdmin: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(store.list()).toHaveLength(4);
  });

  test('POST /api/invoices/:id/fund with an unknown field returns 400', async () => {
    const res = await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 10, investor: INVESTOR, extra: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(store.get('INV_0002').fundedAmount).toBe(18000);
  });

  test.each(['/api/invoices', '/api/invoices/INV_0001/fund'])('POST %s with text/plain returns 415', async (url) => {
    const res = await request(app).post(url).set('Content-Type', 'text/plain').send('amount=100');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('a 1 KB :id returns 400 on read and fund', async () => {
    const longId = 'A'.repeat(1024);
    const read = await request(app).get(`/api/invoices/${longId}`);
    expect(read.status).toBe(400);
    expect(read.body.code).toBe('VALIDATION_FAILED');
    const fund = await request(app).post(`/api/invoices/${longId}/fund`).send({ amount: 100, investor: INVESTOR });
    expect(fund.status).toBe(400);
    expect(fund.body.errors.map((e) => e.path)).toContain('id');
  });

  test('errors[] carries path, message and code for each invalid field; details stays a string array', async () => {
    const res = await request(app).post('/api/invoices').send({ sme: '', debtor: 123, amount: -1, dueDate: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    for (const e of res.body.errors) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
      expect(typeof e.code).toBe('string');
    }
    expect(res.body.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['sme', 'debtor', 'amount', 'dueDate']));
    expect(res.body.details.every((d) => typeof d === 'string')).toBe(true);
    expect(res.body.details).toContain('amount must be a positive number');
  });

  test('field rules and defaults are preserved (trim, uppercase currency, yieldBps 800)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .send({ sme: '  Trim SME  ', debtor: ' Buyer ', amount: 10, currency: 'usdc', dueDate: '2027-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ sme: 'Trim SME', debtor: 'Buyer', currency: 'USDC', yieldBps: 800, smeAddress: null });
    const tooLong = await request(app).post('/api/invoices').send({ sme: 'x'.repeat(121), debtor: 'B', amount: 10, dueDate: '2027-01-01' });
    expect(tooLong.status).toBe(400);
    const tooBig = await request(app).post('/api/invoices').send({ sme: 'A', debtor: 'B', amount: 1e12 + 1, dueDate: '2027-01-01' });
    expect(tooBig.status).toBe(400);
  });

  test('validateInvoice export still works', () => {
    const { validateInvoice } = require('../src/routes/invoices');
    expect(validateInvoice({ sme: 'A', debtor: 'B', amount: 5, dueDate: '2027-01-01' }).value).toMatchObject({ yieldBps: 800, currency: 'USDC' });
    expect(validateInvoice({}).errors.length).toBeGreaterThan(0);
  });

  test('GET /openapi.json is a valid OpenAPI 3 document', async () => {
    const res = await request(app).get('/openapi.json');
    await expect(SwaggerParser.validate(res.body)).resolves.toBeDefined();
  });
});
