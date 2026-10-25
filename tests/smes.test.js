'use strict';

const { authHeader } = require('./helpers/auth');
const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const { resetSmes } = require('../src/data/smes');

const VALID_ADDRESS = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';
const OTHER_ADDRESS = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
const TOKEN = 'test-admin-token';
const validSme = {
  legalName: 'Acme Components Ltd',
  registrationNumber: '12345',
  country: 'GB',
  stellarAddress: VALID_ADDRESS,
  contactEmail: 'ops@acme.test',
};
const validInvoice = {
  sme: 'Acme Components Ltd',
  debtor: 'Buyer Ltd',
  amount: 1500,
  dueDate: '2027-12-31',
};

describe('SME onboarding and invoice verification (#1557)', () => {
  const originalAdminToken = process.env.ADMIN_API_TOKEN;
  const originalVerificationFlag = process.env.REQUIRE_SME_VERIFICATION;

  beforeEach(() => {
    resetSmes();
    store.reset();
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.REQUIRE_SME_VERIFICATION;
  });

  afterAll(() => {
    if (originalAdminToken === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = originalAdminToken;
    }
    if (originalVerificationFlag === undefined) {
      delete process.env.REQUIRE_SME_VERIFICATION;
    } else {
      process.env.REQUIRE_SME_VERIFICATION = originalVerificationFlag;
    }
  });

  const createRecord = (overrides = {}) => request(app).post('/api/smes').set(authHeader()).send({ ...validSme, ...overrides });
  const review = (id, decision, note, token = TOKEN) =>
    request(app).post(`/api/smes/${id}/review`).set('Authorization', `Bearer ${token}`).send({ decision, note });

  describe('POST /api/smes', () => {
    test('creates a pending SME without echoing PII to anonymous callers', async () => {
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

    test.each([
      ['legalName', { legalName: 'A' }],
      ['legalName', { legalName: 'x'.repeat(201) }],
      ['registrationNumber', { registrationNumber: 'not@allowed' }],
      ['registrationNumber', { registrationNumber: '1'.repeat(65) }],
      ['country', { country: 'ZZ' }],
      ['country', { country: 'GBR' }],
      ['stellarAddress', { stellarAddress: 'GINVALID' }],
      ['stellarAddress', { stellarAddress: 'CDQCKR2YU6IVQ4GYPBMXBPZ4FGFQB5H25AI7ZSETHS2CZ5ZRCWQDSO6P' }],
      ['contactEmail', { contactEmail: 'not-an-email' }],
    ])('rejects an invalid %s', async (field, overrides) => {
      const response = await createRecord(overrides);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.errors.map((e) => e.path)).toContain(field);
    });

    test.each(['legalName', 'registrationNumber', 'country', 'stellarAddress', 'contactEmail'])('requires %s', async (field) => {
      const payload = { ...validSme };
      delete payload[field];
      const response = await request(app).post('/api/smes').set(authHeader()).send(payload);
      expect(response.status).toBe(400);
      expect(response.body.errors.map((e) => e.path)).toContain(field);
    });

    test('rejects unknown fields such as a self-assigned status', async () => {
      const response = await createRecord({ status: 'verified' });
      expect(response.status).toBe(400);
    });

    test('returns 409 for duplicate country and registration number (case-insensitive)', async () => {
      expect((await createRecord()).status).toBe(201);
      const duplicate = await createRecord({ country: 'gb', stellarAddress: OTHER_ADDRESS });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('SME_DUPLICATE');
    });

    test('returns 409 for a duplicate Stellar address', async () => {
      expect((await createRecord()).status).toBe(201);
      const duplicate = await createRecord({ registrationNumber: 'unique-2' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('SME_DUPLICATE');
    });
  });

  describe('GET /api/smes/:id', () => {
    test('omits contact email and registration number for anonymous and wrong-token reads', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const created = await createRecord();
      for (const auth of [undefined, 'Bearer wrong']) {
        const req = request(app).get(`/api/smes/${created.body.data.id}`);
        const response = await (auth ? req.set('Authorization', auth) : req);
        expect(response.status).toBe(200);
        expect(response.body.data.contactEmail).toBeUndefined();
        expect(response.body.data.registrationNumber).toBeUndefined();
      }
    });

    test('returns PII only when an admin token is presented', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const created = await createRecord();
      const response = await request(app)
        .get(`/api/smes/${created.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(response.body.data.contactEmail).toBe(validSme.contactEmail);
      expect(response.body.data.registrationNumber).toBe(validSme.registrationNumber);
    });

    test('unknown SME is 404', async () => {
      const response = await request(app).get('/api/smes/SME_missing');
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('SME_NOT_FOUND');
    });
  });

  describe('POST /api/smes/:id/review', () => {
    test('requires admin access and reports missing configuration', async () => {
      const created = await createRecord();
      const unconfigured = await request(app).post(`/api/smes/${created.body.data.id}/review`).send({ decision: 'verify' });
      expect(unconfigured.status).toBe(503);

      process.env.ADMIN_API_TOKEN = TOKEN;
      const unauthorized = await request(app).post(`/api/smes/${created.body.data.id}/review`).send({ decision: 'verify' });
      expect(unauthorized.status).toBe(401);
      expect((await review(created.body.data.id, 'verify', 'x', 'invalid-token')).status).toBe(401);
      expect((await review(created.body.data.id, 'verify', 'Reviewed')).status).toBe(200);
    });

    test('enforces pending → verified/rejected and verified → suspended transitions', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const pending = (await createRecord()).body.data;
      expect((await review(pending.id, 'suspend')).status).toBe(409);
      const verified = await review(pending.id, 'verify', 'KYB complete');
      expect(verified.body.data.status).toBe('verified');
      expect(verified.body.data.reviewHistory).toHaveLength(1);
      expect(verified.body.data.reviewHistory[0]).toMatchObject({ decision: 'verify', note: 'KYB complete' });
      expect((await review(pending.id, 'verify')).body.code).toBe('INVALID_TRANSITION');
      expect((await review(pending.id, 'reject')).body.code).toBe('INVALID_TRANSITION');
      const suspended = await review(pending.id, 'suspend');
      expect(suspended.body.data.status).toBe('suspended');
      expect(suspended.body.data.reviewHistory).toHaveLength(2);
      for (const decision of ['verify', 'reject', 'suspend']) {
        expect((await review(pending.id, decision)).status).toBe(409);
      }

      const rejected = (await createRecord({ registrationNumber: 'reject-me', stellarAddress: OTHER_ADDRESS })).body.data;
      expect((await review(rejected.id, 'reject')).body.data.status).toBe('rejected');
      for (const decision of ['verify', 'reject', 'suspend']) {
        expect((await review(rejected.id, decision)).status).toBe(409);
      }
    });

    test('rejects malformed decisions and notes over 500 characters', async () => {
      process.env.ADMIN_API_TOKEN = TOKEN;
      const created = (await createRecord()).body.data;
      expect((await review(created.id, 'approve')).status).toBe(400);
      expect((await review(created.id, 'verify', 'x'.repeat(501))).status).toBe(400);
      expect((await review('SME_missing', 'verify')).status).toBe(404);
    });
  });

  describe('POST /api/invoices with REQUIRE_SME_VERIFICATION=true', () => {
    const addresses = [
      VALID_ADDRESS,
      OTHER_ADDRESS,
      'GBVBHCYGDUIUKPEYDCBAS47E55NQHGUHGNRVUIZJPI34IH2436XZFZNV',
    ];

    beforeEach(() => {
      process.env.REQUIRE_SME_VERIFICATION = 'true';
      process.env.ADMIN_API_TOKEN = TOKEN;
    });

    test('requires smeId', async () => {
      const response = await request(app).post('/api/invoices').set(authHeader()).send(validInvoice);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('SME_ID_REQUIRED');
    });

    test('rejects pending, rejected and suspended SMEs', async () => {
      const pending = (await createRecord()).body.data;
      const rejected = (await createRecord({ registrationNumber: 'rejected', stellarAddress: addresses[1] })).body.data;
      const suspended = (await createRecord({ registrationNumber: 'suspended', stellarAddress: addresses[2] })).body.data;
      await review(rejected.id, 'reject');
      await review(suspended.id, 'verify');
      await review(suspended.id, 'suspend');

      for (const id of [pending.id, rejected.id, suspended.id]) {
        const response = await request(app).post('/api/invoices').set(authHeader()).send({ ...validInvoice, smeId: id });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('SME_NOT_VERIFIED');
      }
      expect(store.list()).toHaveLength(4);
    });

    test('accepts verified SMEs and overrides client-supplied identity values', async () => {
      const created = (await createRecord()).body.data;
      await review(created.id, 'verify');
      const response = await request(app).post('/api/invoices').set(authHeader()).send({
        ...validInvoice,
        smeId: created.id,
        sme: 'Impersonated Company',
        smeAddress: OTHER_ADDRESS,
      });
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        smeId: created.id,
        sme: validSme.legalName,
        smeAddress: VALID_ADDRESS,
      });
    });

    test('a verified smeId alone is enough (sme comes from the record)', async () => {
      const created = (await createRecord()).body.data;
      await review(created.id, 'verify');
      const withoutSme = { ...validInvoice };
      delete withoutSme.sme;
      const response = await request(app).post('/api/invoices').set(authHeader()).send({ ...withoutSme, smeId: created.id });
      expect(response.status).toBe(201);
      expect(response.body.data.sme).toBe(validSme.legalName);
    });

    test('returns not found for an unknown smeId', async () => {
      const response = await request(app).post('/api/invoices').set(authHeader()).send({ ...validInvoice, smeId: 'SME_missing' });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('SME_NOT_FOUND');
    });
  });

  test('keeps invoice creation unchanged when verification is disabled', async () => {
    const response = await request(app).post('/api/invoices').set(authHeader()).send(validInvoice);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ sme: validInvoice.sme, status: 'open' });
    expect(response.body.data.smeId).toBeUndefined();

    const missingSme = await request(app).post('/api/invoices').set(authHeader()).send({ debtor: 'B', amount: 5, dueDate: '2027-01-01' });
    expect(missingSme.status).toBe(400);
    expect(missingSme.body.errors.map((e) => e.path)).toContain('sme');
  });

  test('serves an OpenAPI document containing the SME routes and schemas', async () => {
    const { body: spec } = await request(app).get('/openapi.json');
    expect(spec.paths['/api/smes'].post.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CreateSmeRequest');
    expect(spec.paths['/api/smes'].post.responses['409']).toBeDefined();
    expect(spec.paths['/api/smes/{id}'].get).toBeDefined();
    expect(spec.paths['/api/smes/{id}/review'].post.responses['409']).toBeDefined();
    expect(spec.paths['/api/smes/{id}/review'].post.security).toEqual([{ adminBearer: [] }]);
    expect(spec.paths['/api/invoices'].post.responses['403']).toBeDefined();
    expect(spec.components.schemas.CreateInvoiceBody.properties.smeId).toBeDefined();
    expect(spec.components.schemas.CreateSmeRequest.required).toEqual([
      'legalName',
      'registrationNumber',
      'country',
      'stellarAddress',
      'contactEmail',
    ]);
    expect(spec.components.schemas.ReviewSmeRequest.properties.decision.enum).toEqual(['verify', 'reject', 'suspend']);
    expect(spec.components.schemas.SmeRecord.properties.contactEmail.description).toContain('PII');
  });
});
