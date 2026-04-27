'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/index');
const { getAuditLogs } = require('../src/services/auditLog');

describe('Security Middlewares Integration', () => {
  test('CORS: returns 403 for disallowed origin', async () => {
    const originalCorsOrigins = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = 'https://allowed.com';

    const app = createApp({ enableTestRoutes: true });
    const response = await request(app)
      .get('/health')
      .set('Origin', 'https://disallowed.com');

    expect(response.status).toBe(403);

    process.env.CORS_ORIGINS = originalCorsOrigins;
  });

  test('Body Limit: returns 413 when Content-Length exceeds 100kb', async () => {
    const app = createApp({ enableTestRoutes: true });
    const largeBody = JSON.stringify({ data: 'a'.repeat(101 * 1024) });

    const response = await request(app)
      .post('/api/invoices')
      .set('Content-Type', 'application/json')
      .send(largeBody);

    expect(response.status).toBe(413);
    expect(response.body.error).toBe('Payload Too Large');
  });

  test('Audit Log: does not contain Authorization header', async () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret';

    const app = createApp({ enableTestRoutes: true });
    const token = jwt.sign({ id: 'user-1', sub: 'user-1' }, 'test-secret');

    const response = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 100, customer: 'Test Corp' });

    expect(response.status).toBe(201);

    const logs = getAuditLogs();
    const lastLog = logs[logs.length - 1];
    const logString = JSON.stringify(lastLog).toLowerCase();

    expect(logString.includes('bearer')).toBe(false);
    expect(logString.includes(token.toLowerCase())).toBe(false);

    process.env.JWT_SECRET = originalSecret;
  });
});
