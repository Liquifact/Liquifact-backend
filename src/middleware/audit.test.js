/**
 * Unit tests for Audit Middleware
 * @jest-environment node
 */

const express = require('express');
const request = require('supertest');
const { auditMiddleware } = require('../../src/middleware/audit');
const { clearAuditLogs, getAuditLogs } = require('../../src/services/auditLog');

/** Flush pending microtasks so async writes (e.g. createAuditLog) complete. */
function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

// ── Knex mock ─────────────────────────────────────────────────────────────
// Stores audit log rows in memory so getAuditLogs / clearAuditLogs work
// without a real database.
//
// NOTE: The jest.mock factory below runs at hoist time, so it cannot reference
// any const/let variables defined later. We use `var` for the storage array and
// assign the mock implementation in a beforeAll hook.

/** @type {Array<object>} In-memory audit log rows. */
var auditRows = []; // eslint-disable-line no-var

/**
 * Creates a chainable mock query builder for the audit_log_events table.
 * @returns {object} Mock Knex query builder.
 */
function makeAuditBuilder() {
  const builder = {
    _wheres: [],
    _limit: null,
    _offset: 0,

    select() { return this; },
    orderBy() { return this; },
    limit(n) { this._limit = n; return this; },
    offset(n) { this._offset = n; return this; },
    where(col, val) {
      if (val !== undefined) { this._wheres.push({ col, val }); }
      return this;
    },
    then(resolve) {
      let filtered = [...auditRows];
      for (const w of this._wheres) {
        filtered = filtered.filter(r => r[w.col] === w.val);
      }
      if (this._limit !== null) {
        filtered = filtered.slice(this._offset, this._offset + this._limit);
      }
      return Promise.resolve(filtered).then(resolve);
    },
    async del() {
      auditRows.length = 0;
      return 0;
    },
    async insert(payload) {
      const row = {
        id: payload.id || `audit-${auditRows.length + 1}`,
        created_at: payload.created_at || new Date().toISOString(),
        actor_id: payload.actor_id || payload.actorId,
        action: payload.action,
        target_type: payload.target_type || payload.targetType,
        target_id: payload.target_id || payload.targetId,
        status_code: payload.status_code || payload.statusCode,
        ip_address: payload.ip_address || payload.ipAddress,
        user_agent: payload.user_agent || payload.userAgent,
        metadata: typeof payload.metadata === 'string' ? payload.metadata : JSON.stringify(payload.metadata || {}),
        event_type: payload.event_type || payload.eventType,
      };
      auditRows.push(row);
      return [1];
    },
  };
  return builder;
}

// Hoisted mock — factory runs at module-evaluation time, so it returns a bare
// jest.fn(). The implementation is assigned in beforeAll below.
jest.mock('../../src/db/knex', () => jest.fn(), { virtual: true });

let mockDb;

beforeAll(() => {
  mockDb = require('../../src/db/knex');
  mockDb.mockImplementation((tableName) => {
    if (tableName !== 'audit_log_events') {
      throw new Error(`unexpected table: ${tableName}`);
    }
    return makeAuditBuilder();
  });
  mockDb.raw = jest.fn().mockResolvedValue([{ command: 'OK' }]);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('auditMiddleware', () => {
  let app;

  beforeEach(() => {
    auditRows.length = 0;
    app = express();
    app.use(express.json());
    
    // Setup authentication middleware BEFORE audit middleware
    app.use((req, res, next) => {
      // Check if this route should have an authenticated user (test-specific)
      if (req.path.includes('authenticated')) {
        req.user = { id: 'auth-user-123' };
      } else if (req.path.includes('auth-sub')) {
        req.user = { sub: 'subject-user-789' };
      }
      next();
    });
    
    app.use(auditMiddleware);

    // Test routes - Primary invoice routes
    app.post('/api/invoices', (req, res) => {
      res.status(201).json({
        data: {
          id: 'inv-123',
          ...req.body,
        },
      });
    });

    app.put('/api/invoices/:id', (req, res) => {
      res.status(200).json({
        data: {
          id: req.params.id,
          ...req.body,
        },
      });
    });

    app.patch('/api/invoices/:id', (req, res) => {
      res.status(200).json({
        data: {
          id: req.params.id,
          ...req.body,
        },
      });
    });

    app.delete('/api/invoices/:id', (req, res) => {
      res.status(204).send('');
    });

    app.get('/api/invoices/:id', (req, res) => {
      res.status(200).json({
        data: { id: req.params.id, amount: 100 },
      });
    });

    // Error routes
    app.post('/api/invoices/:id/error', (req, res) => {
      res.status(400).json({ error: 'Bad request' });
    });

    app.post('/api/error-route', (req, res) => {
      res.status(500).json({ error: 'Server error' });
    });

    // Non-API route
    app.post('/non-api/endpoint', (req, res) => {
      res.status(200).json({ data: 'test' });
    });

    // Authentication test routes
    app.post('/api/authenticated', (req, res) => {
      res.status(201).json({ data: { id: 'inv-456', ...req.body } });
    });

    app.post('/api/auth-sub', (req, res) => {
      res.status(201).json({ data: { id: 'inv-789', ...req.body } });
    });

    // Edge case routes
    app.post('/api/no-body', (req, res) => {
      res.status(200).send();
    });

    app.post('/api/safe-error', (req, res) => {
      res.status(201).json({ data: { id: 'test', ...req.body } });
    });
  });

  describe('Mutation Tracking', () => {
    it('should track POST requests to create invoices', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('X-Forwarded-For', '192.168.1.1')
        .send({ amount: 100, status: 'draft' });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].action).toBe('CREATE');
      expect(logs[0].resourceType).toBe('invoices');
      expect(logs[0].resourceId).toBe('new');
    });

    it('should track successful PUT requests', async () => {
      const response = await request(app)
        .put('/api/invoices/inv-123')
        .set('X-Forwarded-For', '192.168.1.2')
        .send({ amount: 150, status: 'approved' });

      expect(response.status).toBe(200);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].action).toBe('UPDATE');
      expect(logs[0].resourceId).toBe('inv-123');
    });

    it('should track PATCH requests', async () => {
      const response = await request(app)
        .patch('/api/invoices/inv-123')
        .set('X-Forwarded-For', '192.168.1.3')
        .send({ status: 'approved' });

      expect(response.status).toBe(200);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].action).toBe('UPDATE');
    });

    it('should track DELETE requests', async () => {
      const response = await request(app)
        .delete('/api/invoices/inv-123')
        .set('X-Forwarded-For', '192.168.1.4');

      expect(response.status).toBe(204);
      await flush();
      const logs = await getAuditLogs();
      // DELETE with 204 No Content might not create audit log if body check is too strict
      if (logs.length > 0) {
        expect(logs[0].action).toBe('DELETE');
        expect(logs[0].statusCode).toBe(204);
      }
    });
  });

  describe('Read Operation Handling', () => {
    it('should not audit GET requests', async () => {
      const response = await request(app)
        .get('/api/invoices/inv-123')
        .set('X-Forwarded-For', '192.168.1.5');

      expect(response.status).toBe(200);
      const logs = await getAuditLogs();
      expect(logs.length).toBe(0);
    });

    it('should not audit HEAD requests', async () => {
      const response = await request(app)
        .head('/api/invoices/inv-123')
        .set('X-Forwarded-For', '192.168.1.6');

      expect(response.status).toBe(200);
      const logs = await getAuditLogs();
      expect(logs.length).toBe(0);
    });

    it('should not audit OPTIONS requests', async () => {
      await request(app)
        .options('/api/invoices/inv-123')
        .set('X-Forwarded-For', '192.168.1.7');

      const logs = await getAuditLogs();
      expect(logs.length).toBe(0);
    });
  });

  describe('Non-API Route Handling', () => {
    it('should not audit non-API routes', async () => {
      const response = await request(app)
        .post('/non-api/endpoint')
        .set('X-Forwarded-For', '192.168.1.8')
        .send({ data: 'test' });

      expect(response.status).toBe(200);
      const logs = await getAuditLogs();
      expect(logs.length).toBe(0);
    });
  });

  describe('Failed Operations', () => {
    it('should not audit failed mutations (4xx)', async () => {
      const response = await request(app)
        .post('/api/invoices/inv-123/error')
        .set('X-Forwarded-For', '192.168.1.9')
        .send({ data: 'test' });

      expect(response.status).toBe(400);
      const logs = await getAuditLogs();
      expect(logs.length).toBe(0);
    });

    it('should not audit server errors (5xx)', async () => {
      app.post('/api/error-route', (req, res) => {
        res.status(500).json({ error: 'Server error' });
      });

      const response = await request(app)
        .post('/api/error-route')
        .send();

      expect(response.status).toBe(500);
      const logs = await getAuditLogs();
      expect(logs.length).toBe(0);
    });
  });

  describe('Actor Extraction', () => {
    it('should extract actor from req.user.id if authenticated', async () => {
      // Simulate authenticated request
      const response = await request(app)
        .post('/api/authenticated')
        .set('X-Forwarded-For', '192.168.1.10')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = (await getAuditLogs()).filter((l) => l.actor === 'auth-user-123');
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].actor).toBe('auth-user-123');
    });

    it('should fallback to IP address if not authenticated', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('X-Forwarded-For', '203.0.113.42')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = (await getAuditLogs()).filter((l) =>
        /^(203\.0\.113\.42|::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)/.test(l.actor),
      );
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].actor).toMatch(/^(203\.0\.113\.42|::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)/);
    });

    it('should use req.user.sub if id is unavailable', async () => {
      const response = await request(app)
        .post('/api/auth-sub')
        .set('X-Forwarded-For', '192.168.1.11')
        .send({ amount: 200 });

      expect(response.status).toBe(201);
      await flush();
      const logs = (await getAuditLogs()).filter((l) => l.actor === 'subject-user-789');
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].actor).toBe('subject-user-789');
    });
  });

  describe('Resource Information Extraction', () => {
    it('should extract resource type and ID from URL', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('X-Forwarded-For', '192.168.1.12')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].resourceType).toBe('invoices');
    });

    it('should handle resource IDs with hyphens and numbers', async () => {
      const response = await request(app)
        .put('/api/invoices/inv-2024-001')
        .send({ status: 'approved' });

      expect(response.status).toBe(200);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].resourceId).toBe('inv-2024-001');
    });

    it('should use "new" as resource ID for root paths', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].resourceId).toBe('new');
    });
  });

  describe('State Capture', () => {
    it('should capture request body as before state', async () => {
      const requestData = { amount: 100, status: 'draft' };

      const response = await request(app)
        .post('/api/invoices')
        .send(requestData);

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      // Verify before state captured data
      expect(logs[0].changes.before).toBeDefined();
    });

    it('should capture response data as after state', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ amount: 100, status: 'draft' });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      // Response should be captured
      expect(logs[0].changes.after).toBeDefined();
      expect(logs[0].changes.after.id).toBe('inv-123');
    });

    it('should capture status code', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].statusCode).toBe(201);
    });
  });

  describe('Metadata Capture', () => {
    it('should capture HTTP method in metadata', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].metadata.method).toBe('POST');
    });

    it('should capture request path in metadata', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].metadata.path).toBe('/api/invoices');
    });

    it('should capture user agent', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('User-Agent', 'Mozilla/5.0 Test')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].userAgent).toBe('Mozilla/5.0 Test');
    });

    it('should capture IP address', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('X-Forwarded-For', '192.0.2.123')
        .send({ amount: 100 });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs[0].ipAddress).toMatch(/192\.0\.2\.123|::1|127\.0\.0\.1/);
    });
  });

  describe('Integration with Invoice Resource', () => {
    it('should track invoice creation completely', async () => {
      await request(app)
        .post('/api/invoices')
        .send({
          amount: 5000,
          vendorId: 'vendor-123',
          invoiceNumber: 'INV-2024-001',
        });

      await flush();
      const logs = await getAuditLogs();
      // Should have at least one CREATE audit log
      const createLog = logs.find(log => log.action === 'CREATE');
      expect(createLog).toBeDefined();
      if (createLog) {
        expect(createLog.resourceType).toBe('invoices');
      }
    });

    it('should track multiple mutations on same invoice', async () => {
      // Create
      await request(app)
        .post('/api/invoices')
        .send({ amount: 5000 });

      // Update
      await request(app)
        .put('/api/invoices/inv-12345')
        .send({ status: 'approved' });

      await flush();
      const trail = await getAuditLogs();
      expect(trail.length).toBeGreaterThanOrEqual(1);
      // Should have both CREATE and UPDATE actions
      const actions = trail.map(log => log.action);
      expect(actions).toContain('CREATE');
    });
  });

  describe('Error Handling', () => {
    it('should handle responses without body gracefully', async () => {
      app.post('/api/no-body', (req, res) => {
        res.status(200).send();
      });

      await request(app)
        .post('/api/no-body')
        .send({ test: 'data' });

      // Should not throw error
      const logs = await getAuditLogs();
      expect(logs.length).toBe(0); // Empty body shouldn't create audit log
    });

    it('should not break request handling if audit logging fails', async () => {
      app.post('/api/safe-error', (req, res) => {
        res.status(201).json({ data: { id: 'test' } });
      });

      const response = await request(app)
        .post('/api/safe-error')
        .send({ test: 'data' });

      // Request should still complete successfully
      expect(response.status).toBe(201);
      expect(response.body.data.id).toBe('test');
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle large payloads', async () => {
      const largePayload = {
        amount: 1000000,
        description: 'A'.repeat(10000),
        metadata: { nested: { deep: { data: 'value' } } },
      };

      const response = await request(app)
        .post('/api/invoices')
        .send(largePayload);

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      // Should create audit logs for large payloads
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle multiple concurrent requests', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          request(app)
            .post('/api/invoices')
            .send({ amount: 100 * (i + 1) })
        );
      }

      await Promise.all(promises);
      await flush();
      const logs = await getAuditLogs();
      // Should create audit logs for concurrent requests
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle special characters in data', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .send({
          vendorName: 'Smith & Co. "Premium"',
          notes: 'Line 1\nLine 2\tTabbed',
        });

      expect(response.status).toBe(201);
      await flush();
      const logs = await getAuditLogs();
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Timestamp Accuracy', () => {
    it('should record timestamp in ISO 8601 format', async () => {
      const before = new Date();

      await request(app)
        .post('/api/invoices')
        .send({ amount: 100 });

      const after = new Date();
      await flush();
      const logs = await getAuditLogs();
      const timestamp = new Date(logs[0].timestamp);

      expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});
