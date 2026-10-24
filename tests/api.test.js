'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
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
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 25000, investor });
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
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 25000, investor });
    const res = await request(app).post('/api/invoices/INV_0002/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  test('cancel rejects settled invoice', async () => {
    const investor = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
    await request(app).post('/api/invoices/INV_0002/fund').send({ amount: 25000, investor });
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
