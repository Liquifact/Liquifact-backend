'use strict';

const request = require('supertest');
const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SME_OWNER = 'lf_owner_key';
const SME_OTHER = 'lf_other_sme_key';
const ADMIN_KEY = 'lf_admin_key';
const INVESTOR_KEY = 'lf_investor_key';

process.env.API_KEYS = [
  `owner:sme:${sha256(SME_OWNER)}`,
  `other-sme:sme:${sha256(SME_OTHER)}`,
  `admin:admin:${sha256(ADMIN_KEY)}`,
  `investor:investor:${sha256(INVESTOR_KEY)}`,
].join(',');

const app = require('../src/app');
const store = require('../src/data/store');
const { defaultDocumentStore } = require('../src/data/documentStore');
const { auditLog } = require('../src/audit/audit-log');

const bearer = (key) => ({ authorization: `Bearer ${key}` });
const invoiceBody = {
  sme: 'Owner Company',
  debtor: 'Buyer Company',
  amount: 100,
  dueDate: '2027-01-01',
};
const pdf = Buffer.from('%PDF-1.4\n%%EOF');

async function createOwnedInvoice() {
  return request(app).post('/api/invoices').set(bearer(SME_OWNER)).send(invoiceBody);
}

describe('SME invoice ownership', () => {
  beforeEach(() => {
    store.reset();
    defaultDocumentStore.clear();
    auditLog.resetForTests();
  });

  test('different SME and seeded SME invoices cannot cancel', async () => {
    const created = await createOwnedInvoice();
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const other = await request(app).post(`/api/invoices/${id}/cancel`).set(bearer(SME_OTHER)).send();
    expect(other.status).toBe(403);
    expect(other.headers['content-type']).toMatch(/^application\/problem\+json\b/);
    expect(other.body.code).toBe('NOT_INVOICE_OWNER');

    const seed = await request(app).post('/api/invoices/INV_0001/cancel').set(bearer(SME_OWNER)).send();
    expect(seed.status).toBe(403);
    expect(seed.body.code).toBe('NOT_INVOICE_OWNER');

    const audit = auditLog.query({ action: 'invoice.cancel' }).data;
    expect(audit.filter((entry) => entry.outcome === 'rejected' && entry.metadata.code === 'NOT_INVOICE_OWNER')).toHaveLength(2);
  });

  test('owner and admin can cancel; investor remains forbidden', async () => {
    const ownerInvoice = await createOwnedInvoice();
    expect(ownerInvoice.status).toBe(201);
    const ownerId = ownerInvoice.body.data.id;
    expect((await request(app).post(`/api/invoices/${ownerId}/cancel`).set(bearer(SME_OWNER))).status).toBe(200);

    const adminInvoice = await createOwnedInvoice();
    expect(adminInvoice.status).toBe(201);
    const adminId = adminInvoice.body.data.id;
    expect((await request(app).post(`/api/invoices/${adminId}/cancel`).set(bearer(ADMIN_KEY))).status).toBe(200);
    expect((await request(app).post(`/api/invoices/${adminId}/cancel`).set(bearer(INVESTOR_KEY))).status).toBe(403);
  });

  test('different SME and seeded SME invoices cannot upload documents', async () => {
    const created = await createOwnedInvoice();
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const other = await request(app)
      .post(`/api/invoices/${id}/document`)
      .set(bearer(SME_OTHER))
      .attach('file', pdf, 'invoice.pdf');
    expect(other.status).toBe(403);
    expect(other.headers['content-type']).toMatch(/^application\/problem\+json\b/);
    expect(other.body.code).toBe('NOT_INVOICE_OWNER');

    const seed = await request(app)
      .post('/api/invoices/INV_0001/document')
      .set(bearer(SME_OWNER))
      .attach('file', pdf, 'invoice.pdf');
    expect(seed.status).toBe(403);
    expect(seed.body.code).toBe('NOT_INVOICE_OWNER');

    const audit = auditLog.query({ action: 'invoice.document.upload' }).data;
    expect(audit.filter((entry) => entry.outcome === 'rejected' && entry.metadata.code === 'NOT_INVOICE_OWNER')).toHaveLength(2);
  });

  test('owner and admin can upload; investor remains forbidden', async () => {
    const ownerInvoice = await createOwnedInvoice();
    const ownerId = ownerInvoice.body.data.id;
    expect((await request(app)
      .post(`/api/invoices/${ownerId}/document`)
      .set(bearer(SME_OWNER))
      .attach('file', pdf, 'owner.pdf')).status).toBe(201);

    const adminInvoice = await createOwnedInvoice();
    const adminId = adminInvoice.body.data.id;
    expect((await request(app)
      .post(`/api/invoices/${adminId}/document`)
      .set(bearer(ADMIN_KEY))
      .attach('file', pdf, 'admin.pdf')).status).toBe(201);
    expect((await request(app)
      .post(`/api/invoices/${adminId}/document`)
      .set(bearer(INVESTOR_KEY))
      .attach('file', pdf, 'investor.pdf')).status).toBe(403);
  });

  test('OpenAPI documents NOT_INVOICE_OWNER on cancel and document upload', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    for (const path of ['/api/invoices/{id}/cancel', '/api/invoices/{id}/document']) {
      const response = spec.paths[path].post.responses['403'];
      expect(response.content['application/problem+json']).toBeDefined();
      expect(response.content['application/problem+json'].schema.properties.code.enum).toContain('NOT_INVOICE_OWNER');
    }
  });
});
