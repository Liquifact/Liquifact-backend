'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetSmes } = require('../src/data/smes');

const VALID_ADDRESS = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';
const TOKEN = 'test-admin-token';
const validSme = {
  legalName: 'Acme Components Ltd',
  registrationNumber: '12345',
  country: 'GB',
  stellarAddress: VALID_ADDRESS,
  contactEmail: 'ops@acme.test',
};
const validInvoice = {
  amount: 1500,
  dueDate: '2026-12-31',
  buyer: 'Buyer Ltd',
  seller: 'Seller Ltd',
  currency: 'USD',
};

describe('SME onboarding and invoice verification', () => {
  let app;
  const originalAdminToken = process.env.ADMIN_API_TOKEN;
  const originalVerificationFlag = process.env.REQUIRE_SME_VERIFICATION;

  beforeEach(() => {
    resetSmes();
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.REQUIRE_SME_VERIFICATION;
    app = createApp();
  });

  afterAll(() => {
    if (originalAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = originalAdminToken;
    if (originalVerificationFlag === undefined) delete process.env.REQUIRE_SME_VERIFICATION;
    else process.env.REQUIRE_SME_VERIFICATION = originalVerificationFlag;
  });

  async function createRecord(overrides = {}) {
    return request(app).post('/api/smes').send({ ...validSme, ...overrides });
  }

  async function review(id, decision, note, token = TOKEN) {
    return request(app)
      .post(`/api/smes/${id}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision, note });
  }

  describe('POST /api/smes', () => {
    it('creates a pending SME with the submitted fields', async () => {
      const response = await createRecord();
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        legalName: validSme.legalName,
        country: validSme.country,
        stellarAddress: validSme.stellarAddress,
        id: expect.stringMatching(/^SME_/),
        status: 'pending',
        reviewHistory: [],
      });
      expect(response.body.data.contactEmail).toBeUndefined();
      expect(response.body.data.registrationNumber).toBeUndefined();
    });

    it.each([
      ['legalName', { legalName: 'A' }],
      ['legalName length', { legalName: 'x'.repeat(201) }],
      ['registrationNumber', { registrationNumber: 'not@allowed' }],
      ['registrationNumber length', { registrationNumber: '1'.repeat(65) }],
      ['country', { country: 'ZZ' }],
      ['stellarAddress', { stellarAddress: 'GINVALID' }],
      ['contactEmail', { contactEmail: 'not-an-email' }],
    ])('rejects an invalid %s', async (_field, overrides) => {
      const response = await createRecord(overrides);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each(['legalName', 'registrationNumber', 'country', 'stellarAddress', 'contactEmail'])(
      'requires %s',
      async (field) => {
        const payload = { ...validSme };
        delete payload[field];
        const response = await request(app).post('/api/smes').send(payload);
        expect(response.status).toBe(400);
        expect(response.body.error.fieldErrors[field]).toBeDefined();
      }
    );

    it('returns 409 for duplicate country and registration number', async () => {
      expect((await createRecord()).status).toBe(201);
      const duplicate = await createRecord({ registrationNumber: '12345', country: 'gb' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('SME_DUPLICATE');
    });

    it('returns 409 for a duplicate Stellar address', async () => {
      expect((await createRecord()).status).toBe(201);
      const duplicate = await createRecord({ registrationNumber: 'unique-2' });
      expect(duplicate.status).toBe(409);
    });
  });

  describe('GET /api/smes/:id', () => {
    it('omits contact email and registration number for anonymous reads', async () => {
      const created = await createRecord();
      const response = await request(app).get(`/api/smes/${created.body.data.id}`);
      expect(response.status).toBe(200);
      expect(response.body.data.contactEmail).toBeUndefined();
      expect(response.body.data.registrationNumber).toBeUndefined();
    });

    it('returns PII only when an admin token is presented', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const created = await createRecord();
      const response = await request(app)
        .get(`/api/smes/${created.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(response.body.data.contactEmail).toBe(validSme.contactEmail);
      expect(response.body.data.registrationNumber).toBe(validSme.registrationNumber);
    });
  });

  describe('POST /api/smes/:id/review', () => {
    it('requires admin access and reports missing configuration', async () => {
      const created = await createRecord();
      const unconfigured = await request(app)
        .post(`/api/smes/${created.body.data.id}/review`)
        .send({ decision: 'verify' });
      expect(unconfigured.status).toBe(503);

      process.env.ADMIN_API_TOKEN = TOKEN;
      const unauthorized = await request(app)
        .post(`/api/smes/${created.body.data.id}/review`)
        .send({ decision: 'verify' });
      expect(unauthorized.status).toBe(401);
      const invalidToken = await request(app)
        .post(`/api/smes/${created.body.data.id}/review`)
        .set('Authorization', 'Bearer invalid-token')
        .send({ decision: 'verify' });
      expect(invalidToken.status).toBe(401);
      expect((await review(created.body.data.id, 'verify', 'Reviewed')).status).toBe(200);
    });

    it('enforces pending → verified/rejected and verified → suspended transitions', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const pending = (await createRecord()).body.data;
      expect((await review(pending.id, 'suspend')).status).toBe(409);
      const verified = await review(pending.id, 'verify', 'KYB complete');
      expect(verified.body.data.status).toBe('verified');
      expect(verified.body.data.reviewHistory).toHaveLength(1);
      expect((await review(pending.id, 'verify')).body.error.code).toBe('INVALID_TRANSITION');
      expect((await review(pending.id, 'reject')).body.error.code).toBe('INVALID_TRANSITION');
      const suspended = await review(pending.id, 'suspend');
      expect(suspended.body.data.status).toBe('suspended');
      expect(suspended.body.data.reviewHistory).toHaveLength(2);
      expect((await review(pending.id, 'verify')).status).toBe(409);
      expect((await review(pending.id, 'reject')).status).toBe(409);
      expect((await review(pending.id, 'suspend')).status).toBe(409);

      const rejected = (await createRecord({ registrationNumber: 'reject-me' })).body.data;
      expect((await review(rejected.id, 'reject')).body.data.status).toBe('rejected');
      expect((await review(rejected.id, 'verify')).status).toBe(409);
      expect((await review(rejected.id, 'reject')).status).toBe(409);
      expect((await review(rejected.id, 'suspend')).status).toBe(409);
    });

    it('rejects malformed decisions and notes over 500 characters', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const created = (await createRecord()).body.data;
      expect((await review(created.id, 'approve')).status).toBe(400);
      expect((await review(created.id, 'verify', 'x'.repeat(501))).status).toBe(400);
    });
  });

  describe('POST /api/invoices with SME verification enabled', () => {
    beforeEach(() => {
      process.env.REQUIRE_SME_VERIFICATION = 'true';
      process.env.ADMIN_API_TOKEN = TOKEN;
    });

    it('requires smeId', async () => {
      const response = await request(app).post('/api/invoices').send(validInvoice);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SME_ID_REQUIRED');
    });

    it('rejects pending, rejected, and suspended SMEs', async () => {
      const pending = (await createRecord()).body.data;
      const rejected = (await createRecord({ registrationNumber: 'rejected' })).body.data;
      const suspended = (await createRecord({ registrationNumber: 'suspended' })).body.data;
      await review(rejected.id, 'reject');
      await review(suspended.id, 'verify');
      await review(suspended.id, 'suspend');

      for (const id of [pending.id, rejected.id, suspended.id]) {
        const response = await request(app)
          .post('/api/invoices')
          .send({ ...validInvoice, smeId: id });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('SME_NOT_VERIFIED');
      }
    });

    it('accepts verified SMEs and overrides client-supplied identity values', async () => {
      const created = (await createRecord()).body.data;
      await review(created.id, 'verify');
      const response = await request(app).post('/api/invoices').send({
        ...validInvoice,
        smeId: created.id,
        sme: 'Impersonated Company',
        smeAddress: 'GCLIENTSUPPLIED',
      });
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        smeId: created.id,
        sme: validSme.legalName,
        smeAddress: VALID_ADDRESS,
      });
    });

    it('returns not found for an unknown smeId', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ ...validInvoice, smeId: 'SME_missing' });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('SME_NOT_FOUND');
    });
  });

  it('keeps legacy invoice creation unchanged when verification is disabled', async () => {
    const response = await request(app).post('/api/invoices').send(validInvoice);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ id: 'placeholder', status: 'pending_verification' });
    expect(response.body.data.smeId).toBeUndefined();
  });

  it('serves an OpenAPI document containing SME and invoice contracts', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths['/openapi.json'].get.responses['200']).toBeDefined();
    expect(response.body.paths['/api/smes'].post.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CreateSmeRequest');
    expect(response.body.paths['/api/smes'].post.responses['409']).toBeDefined();
    expect(response.body.paths['/api/smes/{id}'].get).toBeDefined();
    expect(response.body.paths['/api/smes/{id}/review'].post.responses['409']).toBeDefined();
    expect(response.body.paths['/api/invoices'].post.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CreateInvoiceRequest');
    expect(response.body.components.schemas.CreateSmeRequest.required).toEqual([
      'legalName',
      'registrationNumber',
      'country',
      'stellarAddress',
      'contactEmail',
    ]);
    expect(response.body.components.schemas.ReviewSmeRequest.properties.decision.enum)
      .toEqual(['verify', 'reject', 'suspend']);
    expect(response.body.components.schemas.SmeRecord.properties.contactEmail.description)
      .toContain('PII');
  });
});
