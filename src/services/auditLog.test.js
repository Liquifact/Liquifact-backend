/**
 * Unit tests for Audit Log Service
 * @jest-environment node
 */

const {
  createAuditLog,
  getAuditLogs,
  getInvoiceAuditTrail,
  countAuditLogs,
  clearAuditLogs,
  exportAuditLogs,
  sanitizeSensitiveData,
  calculateChanges,
} = require('../../src/services/auditLog');

describe('auditLog Service', () => {
  beforeEach(() => {
    clearAuditLogs();
  });

  describe('sanitizeSensitiveData', () => {
    it('should redact password fields', () => {
      const obj = { username: 'user', password: 'secret123' };
      const result = sanitizeSensitiveData(obj);
      expect(result.username).toBe('user');
      expect(result.password).toBe('***REDACTED***');
    });

    it('should redact token fields', () => {
      const obj = { accessToken: 'abc123', refreshToken: 'xyz789' };
      const result = sanitizeSensitiveData(obj);
      expect(result.accessToken).toBe('***REDACTED***');
      expect(result.refreshToken).toBe('***REDACTED***');
    });

    it('should redact API keys', () => {
      const obj = { apiKey: 'secret', API_SECRET: 'shh' };
      const result = sanitizeSensitiveData(obj);
      expect(result.apiKey).toBe('***REDACTED***');
      expect(result.API_SECRET).toBe('***REDACTED***');
    });

    it('should handle nested objects', () => {
      const obj = { user: { password: 'secret', name: 'john' }, token: 'abc' };
      const result = sanitizeSensitiveData(obj);
      expect(result.user.password).toBe('***REDACTED***');
      expect(result.user.name).toBe('john');
      expect(result.token).toBe('***REDACTED***');
    });

    it('should handle arrays', () => {
      const arr = [{ password: 'secret' }, { apiKey: 'key123' }];
      const result = sanitizeSensitiveData(arr);
      expect(result[0].password).toBe('***REDACTED***');
      expect(result[1].apiKey).toBe('***REDACTED***');
    });

    it('should handle null and undefined', () => {
      expect(sanitizeSensitiveData(null)).toBe(null);
      expect(sanitizeSensitiveData(undefined)).toBe(undefined);
      expect(sanitizeSensitiveData('string')).toBe('string');
    });
  });

  describe('calculateChanges', () => {
    it('should calculate differences between objects', () => {
      const before = { name: 'invoice1', amount: 100, status: 'pending' };
      const after = { name: 'invoice1', amount: 150, status: 'approved' };

      const changes = calculateChanges(before, after);
      expect(changes.before.amount).toBe(100);
      expect(changes.after.amount).toBe(150);
      expect(changes.before.status).toBe('pending');
      expect(changes.after.status).toBe('approved');
    });

    it('should ignore unchanged fields', () => {
      const before = { id: '123', name: 'invoice1', amount: 100 };
      const after = { id: '123', name: 'invoice1', amount: 150 };

      const changes = calculateChanges(before, after);
      expect(changes.before.id).toBeUndefined();
      expect(changes.after.id).toBeUndefined();
      expect(changes.before.name).toBeUndefined();
      expect(changes.after.amount).toBe(150);
    });

    it('should handle new fields in after', () => {
      const before = { name: 'invoice1' };
      const after = { name: 'invoice1', amount: 100 };

      const changes = calculateChanges(before, after);
      expect(changes.before.amount).toBeUndefined();
      expect(changes.after.amount).toBe(100);
    });

    it('should handle deleted fields', () => {
      const before = { name: 'invoice1', amount: 100 };
      const after = { name: 'invoice1' };

      const changes = calculateChanges(before, after);
      expect(changes.before.amount).toBe(100);
      expect(changes.after.amount).toBeUndefined();
    });

    it('should redact sensitive data in changes', () => {
      const before = { password: 'old_secret' };
      const after = { password: 'new_secret' };

      const changes = calculateChanges(before, after);
      expect(changes.before.password).toBe('***REDACTED***');
      expect(changes.after.password).toBe('***REDACTED***');
    });

    it('should handle null values', () => {
      const before = null;
      const after = { name: 'invoice1' };

      const changes = calculateChanges(before, after);
      expect(changes.before).toBe(null);
      expect(changes.after.name).toBe('invoice1');
    });
  });

  describe('createAuditLog', () => {
    it('should create an audit log entry with all required fields', async () => {
      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
      });

      expect(entry).toBeDefined();
      expect(entry.id).toMatch(/^AUDIT-\d+-/);
      expect(entry.timestamp).toBeDefined();
      expect(entry.actor).toBe('user-123');
      expect(entry.action).toBe('CREATE');
      expect(entry.resourceType).toBe('invoice');
      expect(entry.resourceId).toBe('inv-456');
    });

    it('should be immutable (frozen)', async () => {
      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
      });

      const originalActor = entry.actor;
      entry.actor = 'hacker';
      expect(entry.actor).toBe(originalActor);
      expect(Object.isFrozen(entry)).toBe(true);
    });

    it('should capture state changes', async () => {
      const before = { amount: 100, status: 'draft' };
      const after = { amount: 150, status: 'submitted' };

      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        before,
        after,
      });

      expect(entry.changes.before.amount).toBe(100);
      expect(entry.changes.after.amount).toBe(150);
    });

    it('should capture HTTP status code', async () => {
      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'DELETE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        statusCode: 204,
      });

      expect(entry.statusCode).toBe(204);
    });

    it('should capture IP address and user agent', async () => {
      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0',
      });

      expect(entry.ipAddress).toBe('192.168.1.100');
      expect(entry.userAgent).toBe('Mozilla/5.0');
    });

    it('should include metadata', async () => {
      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        metadata: { source: 'web', version: '1.0' },
      });

      expect(entry.metadata.source).toBe('web');
      expect(entry.metadata.version).toBe('1.0');
    });

    it('should throw error if actor is missing', async () => {
      await expect(() => {
        return createAuditLog({
          action: 'CREATE',
          resourceType: 'invoice',
          resourceId: 'inv-456',
        });
      }).rejects.toThrow('Audit log actor is required');
    });

    it('should throw error if action is missing', async () => {
      await expect(() => {
        return createAuditLog({
          actor: 'user-123',
          resourceType: 'invoice',
          resourceId: 'inv-456',
        });
      }).rejects.toThrow('Audit log action is required');
    });

    it('should throw error if action is invalid', async () => {
      await expect(() => {
        return createAuditLog({
          actor: 'user-123',
          action: 'INVALID',
          resourceType: 'invoice',
          resourceId: 'inv-456',
        });
      }).rejects.toThrow('Invalid action');
    });

    it('should throw error if resourceType is missing', async () => {
      await expect(() => {
        return createAuditLog({
          actor: 'user-123',
          action: 'CREATE',
          resourceId: 'inv-456',
        });
      }).rejects.toThrow('Audit log resourceType is required');
    }); 
        // createAuditLog({
        //   actor: 'user-123',
        //   action: 'CREATE',
        //   resourceId: 'inv-456',
        // });
     // })//.rejects.toThrow('Audit log resourceType is required');
    //});
  })
})

    it('should throw error if resourceId is missing', async () => {
      await expect(() => {
        return createAuditLog({
          actor: 'user-123',
          action: 'CREATE',
          resourceType: 'invoice',
        });
      }).rejects.toThrow('Audit log resourceId is required');
    });

    it('should capture CREATE action for new resources', async () => {
      const after = { id: 'inv-456', amount: 100, status: 'draft' };

      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        after,
      });

      expect(entry.action).toBe('CREATE');
      expect(entry.changes.after.id).toBe('inv-456');
    });

    it('should capture UPDATE action with before/after', async () => {
      const before = { amount: 100 };
      const after = { amount: 150 };

      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        before,
        after,
      });

      expect(entry.action).toBe('UPDATE');
      expect(entry.changes.before.amount).toBe(100);
      expect(entry.changes.after.amount).toBe(150);
    });

    it('should capture DELETE action', async () => {
      const before = { id: 'inv-456', amount: 100 };

      const entry = await createAuditLog({
        actor: 'user-123',
        action: 'DELETE',
        resourceType: 'invoice',
        resourceId: 'inv-456',
        before,
        statusCode: 204,
      });

      expect(entry.action).toBe('DELETE');
      expect(entry.changes.before.id).toBe('inv-456');
    });

  describe('getAuditLogs', () => {
    beforeEach(async() => {
      await createAuditLog({
        actor: 'user-1',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-1',
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-2',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-2',
      });
    });

    it('should return all audit logs by default', async() => {
      const logs = await getAuditLogs();
      expect(logs.length).toBe(3);
    });

    it('should filter by resourceId', async() => {
      const logs = await getAuditLogs({ resourceId: 'inv-1' });
      expect(logs.length).toBe(2);
      expect(logs.every((log) => log.resourceId === 'inv-1')).toBe(true);
    });

    it('should filter by resourceType', async() => {
      const logs = await getAuditLogs({ resourceType: 'invoice' });
      expect(logs.length).toBe(3);
    });

    it('should filter by actor', async() => {
      const logs = await getAuditLogs({ actor: 'user-1' });
      expect(logs.length).toBe(2);
    });

    it('should filter by action', async() => {
      const logs = await getAuditLogs({ action: 'CREATE' });
      expect(logs.length).toBe(2);
    });

    it('should return latest logs first (reverse chronological)', async() => {
      const logs = await getAuditLogs();
      expect(logs[0].action).toBe('CREATE'); // Most recent
      expect(logs[logs.length - 1].action).toBe('CREATE'); // Oldest
    });

    it('should support pagination with limit and offset', async() => {
      const page1 = await getAuditLogs({ limit: 1, offset: 0 });
      const page2 = await getAuditLogs({ limit: 1, offset: 1 });

      expect(page1.length).toBe(1);
      expect(page2.length).toBe(1);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('should return frozen objects to prevent mutation', async () => {
      const logs = await getAuditLogs();
      const originalActor = logs[0].actor;
      logs[0].actor = 'hacker';
      expect(logs[0].actor).toBe(originalActor);
      expect(Object.isFrozen(logs[0])).toBe(true);
    });

    it('should handle multiple filters simultaneously', async () => {
      const logs = await getAuditLogs({
        resourceId: 'inv-1',
        actor: 'user-1',
        action: 'UPDATE',
      });

      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe('UPDATE');
    });
  });

  describe('getInvoiceAuditTrail', () => {
    beforeEach(async () => {
      await createAuditLog({
        actor: 'user-1',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-1',
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-2',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-2',
      });
    });

    it('should return audit trail for invoice', async () => {
      const trail = await getInvoiceAuditTrail('inv-1');
      expect(trail.length).toBe(2);
      expect(trail.every((log) => log.resourceId === 'inv-1')).toBe(true);
    });

    it('should return empty array for non-existent invoice', async () => {
      const trail = await getInvoiceAuditTrail('inv-999');
      expect(trail.length).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const trail = await getInvoiceAuditTrail('inv-1', 1);
      expect(trail.length).toBe(1);
    });
  });

  describe('countAuditLogs', () => {
    beforeEach(async () => {
      await createAuditLog({
        actor: 'user-1',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-1',
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-2',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-2',
      });
    });

    it('should count all logs', async () => {
      const count = await countAuditLogs();
      expect(count).toBe(3);
    });

    it('should count filtered logs', async () => {
      const count1 = await countAuditLogs({ actor: 'user-1' });
      const count2 = await countAuditLogs({ action: 'CREATE' });
      const count3 = await countAuditLogs({ resourceId: 'inv-1' });

      expect(count1).toBe(2);
      expect(count2).toBe(2);
      expect(count3).toBe(2);
    });
  });

  describe('exportAuditLogs', () => {
    beforeEach(async () => {
      await createAuditLog({
        actor: 'user-1',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
      await createAuditLog({
        actor: 'user-2',
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
    });

    it('should export logs as JSON by default', async () => {
      const exported = await exportAuditLogs();
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });

    it('should export logs as CSV', async () => {
      const exported = await exportAuditLogs({ format: 'csv' });
      const lines = exported.split('\n');
      expect(lines[0]).toContain('id,timestamp,actor');
      expect(lines.length).toBeGreaterThan(1);
    });

    it('should respect limit in export', async () => {
      const exported = await exportAuditLogs({ limit: 1 });
      const parsed = JSON.parse(exported);
      expect(parsed.length).toBe(1);
    });

    it('should properly escape CSV values', async() => {
      await createAuditLog({
        actor: 'user,"test"',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });

      const exported = exportAuditLogs({ format: 'csv' });
      expect(exported).toContain('"user,""test"""');
    });
  });

  describe('clearAuditLogs', () => {
    beforeEach( async () => {
      await createAuditLog({
        actor: 'user-1',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      });
    });

    it('should clear all logs in non-production', async () => {
      const before = await getAuditLogs();
      expect(before.length).toBe(1);

      await clearAuditLogs();

      const after = await getAuditLogs();
      expect(after.length).toBe(0);
    });

    it('should prevent clearing in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      await expect(async () => {
        await clearAuditLogs();
      }).rejects.toThrow('Cannot clear audit logs in production');

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Edge cases and security', () => {
    it('should handle large audit logs efficiently', async () => {
      // Create 1000 audit logs
      for (let i = 0; i < 1000; i++) {
        await createAuditLog({
          actor: `user-${i % 10}`,
          action: 'CREATE',
          resourceType: 'invoice',
          resourceId: `inv-${i}`,
        });
      }

      const logs = await getAuditLogs({ limit: 100 });
      expect(logs.length).toBe(100);

      const count = await countAuditLogs();
      expect(count).toBe(1000);
    });

    it('should handle concurrent writes safely', async () => {
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          Promise.resolve().then(() => {
            return createAuditLog({
              actor: 'user-1',
              action: 'CREATE',
              resourceType: 'invoice',
              resourceId: `inv-${i}`,
            });
          })
        );
      }

      return Promise.all(promises).then(() => {
        return countAuditLogs().then((count) => {
          expect(count).toBe(50);
        });
      });
    });

    it('should never expose sensitive data in logs', async () => {
      await createAuditLog({
        actor: 'user-1',
        action: 'CREATE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
        before: {
          apiKey: 'super-secret-key-123',
          password: 'my-password',
          amount: 1000,
        },
        after: {
          apiKey: 'new-secret-key-456',
          password: 'new-password',
          amount: 2000,
        },
      });

      const exported = exportAuditLogs({ format: 'json' });
      expect(exported).not.toContain('super-secret-key');
      expect(exported).not.toContain('my-password');
      expect(exported).not.toContain('new-secret-key');
      expect(exported).toContain('***REDACTED***');
    });
  });

describe('getAuditLogs pageSize security cap', () => {
    beforeEach(async () => {
      // Make 200 logs so we can test capping
      for (let i = 0; i < 200; i++) {
        await createAuditLog({
          actor: 'user-1',
          action: 'CREATE',
          resourceType: 'invoice',
          resourceId: `inv-${i}`,
        });
      }
    });

    it('should clamp limit over cap to 100', async () => {
      const logs = await getAuditLogs({ limit: 500 }); // huge
      expect(logs.length).toBe(100); // not 500
    });

    it('should clamp Infinity to 100 - regression assert', async () => {
      const logs = await getAuditLogs({ limit: Infinity });
      expect(logs.length).toBe(100); // not all 200
    });

    it('should clamp negative limit to 100', async () => {
      const logs = await getAuditLogs({ limit: -5 });
      expect(logs.length).toBe(100); // default
    });

    it('should clamp zero limit to 100', async () => {
      const logs = await getAuditLogs({ limit: 0 });
      expect(logs.length).toBe(100); // default
    });

    it('should allow valid limit under cap', async () => {
      const logs = await getAuditLogs({ limit: 25 });
      expect(logs.length).toBe(25); // not capped
    });

    it('getInvoiceAuditTrail should also clamp to 100', async () => {
      const trail = await getInvoiceAuditTrail('inv-1', 999);
      expect(trail.length).toBeLessThanOrEqual(100);
    });
  });

   describe('getAuditLogs pageSize security cap', () => { 
    it('should clamp limit over cap to 100', async () => {
      const logs = await getAuditLogs({ limit: 500 });
      expect(logs.length).toBe(100);
    });

    // ...all 6 tests
  });
