'use strict';

jest.mock('../src/db/knex');

const express = require('express');
const request = require('supertest');
const db = require('../src/db/knex');
const { auditLogMiddleware } = require('../src/middleware/auditLog');
const { REDACTED } = require('../src/services/auditLogStore');

describe('audit log middleware', () => {
  let insertMock;
  let app;

  beforeEach(() => {
    insertMock = jest.fn().mockResolvedValue([1]);
    db.mockImplementation((tableName) => {
      if (tableName !== 'audit_log_events') {
        throw new Error(`unexpected table: ${tableName}`);
      }
      return { insert: insertMock };
    });

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'admin-user-1' };
      next();
    });
    app.use(auditLogMiddleware);

    app.post('/api/admin/kyc/:id/approve', (_req, res) => {
      return res.status(200).json({ ok: true });
    });

    app.post('/api/webhooks/test', async (req, res, next) => {
      try {
        await req.audit.logWebhookDelivery({
          endpoint: 'https://example.com/hooks/kyc',
          endpointId: 'wh_123',
          deliveryId: 'del_001',
          outcome: 'failed',
          statusCode: 500,
          requestPayload: {
            customerId: 'cus_123',
            apiKey: 'super-secret-key',
          },
          responseBody: {
            message: 'invalid signature',
            token: 'response-token',
          },
          errorMessage: 'timeout',
        });
        return res.status(202).json({ accepted: true });
      } catch (error) {
        return next(error);
      }
    });
  });

  it('auto-logs successful admin actions as append-only inserts', async () => {
    const response = await request(app)
      .post('/api/admin/kyc/cus_42/approve')
      .set('x-admin-action', 'kyc.approve')
      .set('x-audit-target-type', 'kyc_profile')
      .set('x-audit-target-id', 'cus_42')
      .send({
        reason: 'manual review completed',
        privateKey: 'stellar-secret',
      });

    expect(response.status).toBe(200);

    // finish handlers are async; flush microtasks before assertions.
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertMock).toHaveBeenCalledTimes(1);
    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.event_type).toBe('admin_action');
    expect(inserted.action).toBe('kyc.approve');
    expect(inserted.target_type).toBe('kyc_profile');
    expect(inserted.target_id).toBe('cus_42');

    const metadata = JSON.parse(inserted.metadata);
    expect(metadata.before.privateKey).toBe(REDACTED);
    expect(metadata.autoLogged).toBe(true);
  });

  it('supports explicit webhook delivery logging with redaction', async () => {
    const response = await request(app)
      .post('/api/webhooks/test')
      .set('user-agent', 'jest-agent')
      .send({ ok: true });

    expect(response.status).toBe(202);
    expect(insertMock).toHaveBeenCalledTimes(1);

    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.event_type).toBe('webhook_delivery');
    expect(inserted.action).toBe('webhook.dispatch');
    expect(inserted.target_id).toBe('wh_123');
    expect(inserted.status_code).toBe(500);

    const metadata = JSON.parse(inserted.metadata);
    expect(metadata.requestPayload.apiKey).toBe(REDACTED);
    expect(metadata.responseBody.token).toBe(REDACTED);
    expect(metadata.endpoint).toBe('https://example.com/hooks/kyc');
    expect(metadata.deliveryId).toBe('del_001');
  });
});
