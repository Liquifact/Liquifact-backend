'use strict';

/**
 * @fileoverview Route-level coverage for declarative kyc-webhooks schema
 * validation (issue #905).
 *
 * Covers:
 *  • POST /api/kyc/webhook — request payload validated against
 *    kycWebhookSchema at the boundary (valid payloads, legacy snake_case
 *    aliases, and structured 400s for invalid smeId/status/recordId/verifiedAt).
 *  • GET  /api/kyc/webhooks — response payload validated against
 *    kycWebhookListResponseSchema before being sent.
 */

jest.mock('../src/db/knex');

const request = require('supertest');
const express = require('express');
const db = require('../src/db/knex');
const { createSignatureHeader } = require('../src/services/webhooks');
const kycRoutes = require('../src/routes/kyc');

const WEBHOOK_SECRET = 'schema-test-secret';

describe('POST /api/kyc/webhook — request schema validation (issue #905)', () => {
  let app;

  beforeEach(() => {
    process.env.KYC_PROVIDER_SECRET = WEBHOOK_SECRET;
    app = express();
    app.use(express.raw({ type: 'application/json', limit: '100kb' }));
    app.use('/api/kyc', kycRoutes);

    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue([1]),
      update: jest.fn().mockResolvedValue(1),
    }));
  });

  function sendWebhook(payload) {
    const rawBody = JSON.stringify(payload);
    const signature = createSignatureHeader(WEBHOOK_SECRET, rawBody);
    return request(app)
      .post('/api/kyc/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(rawBody);
  }

  it('accepts a valid payload with all optional fields', async () => {
    const res = await sendWebhook({
      smeId: 'sme-schema-01',
      status: 'approved',
      recordId: 'rec_schema_01',
      verifiedAt: '2026-07-24T10:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.smeId).toBe('sme-schema-01');
  });

  it('accepts legacy snake_case provider aliases', async () => {
    const res = await sendWebhook({
      sme_id: 'sme-schema-02',
      kyc_status: 'approved',
      provider_record_id: 'rec_schema_02',
      verified_at: '2026-07-24T10:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects smeId with invalid characters and reports field-level details', async () => {
    const res = await sendWebhook({ smeId: 'sme 001!', status: 'approved' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing or invalid smeId/);
    expect(res.body.details.smeId).toBeDefined();
  });

  it('rejects an oversized recordId with a structured error', async () => {
    const res = await sendWebhook({
      smeId: 'sme-schema-03',
      status: 'approved',
      recordId: 'r'.repeat(256),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid KYC webhook payload');
    expect(res.body.details.recordId).toMatch(/255/);
  });

  it('rejects a malformed verifiedAt with a structured error', async () => {
    const res = await sendWebhook({
      smeId: 'sme-schema-04',
      status: 'approved',
      verifiedAt: 'not-a-date',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid KYC webhook payload');
    expect(res.body.details.verifiedAt).toMatch(/ISO 8601/);
  });

  it('still reports the historical message when smeId is missing', async () => {
    const res = await sendWebhook({ status: 'approved' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing or invalid smeId');
  });

  it('still reports the historical message when status is missing', async () => {
    const res = await sendWebhook({ smeId: 'sme-schema-05' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing or invalid status');
  });
});

describe('GET /api/kyc/webhooks — response schema validation (issue #905)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/kyc', kycRoutes);
  });

  function mockListQuery(rows) {
    const query = {};
    query.select = jest.fn().mockReturnValue(query);
    query.orderBy = jest.fn().mockReturnValue(query);
    query.limit = jest.fn().mockReturnValue(query);
    query.where = jest.fn().mockReturnValue(query);
    query.then = (resolve) => resolve(rows);
    return query;
  }

  it('returns an empty page matching the response schema when no records exist', async () => {
    db.mockImplementation(() => mockListQuery([]));

    const res = await request(app).get('/api/kyc/webhooks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: { limit: 20, hasMore: false, nextCursor: null } });
  });

  it('returns persisted records shaped per the response schema', async () => {
    const rows = [
      {
        smeId: 'sme-list-01',
        status: 'verified',
        recordId: 'rec_1',
        verifiedAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ];
    db.mockImplementation(() => mockListQuery(rows));

    const res = await request(app).get('/api/kyc/webhooks');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(rows);
    expect(res.body.meta.hasMore).toBe(false);
  });

  it('returns a structured 500 if the query result violates the response schema', async () => {
    const rows = [
      { smeId: 'sme-bad', status: 'verified', recordId: 123, verifiedAt: null, updatedAt: null },
    ];
    db.mockImplementation(() => mockListQuery(rows));

    const res = await request(app).get('/api/kyc/webhooks');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
