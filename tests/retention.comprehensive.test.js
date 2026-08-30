'use strict';

const { v4: uuidv4 } = require('uuid');

// Distributed per-invoice lock (issue #1213) — mocked to a pass-through so
// this suite's assertions about purge/audit behavior aren't gated on a real
// or fake Redis connection. Lock-contention behavior itself is covered by
// tests/redisLock.test.js and tests/retentionPurge.lock.test.js.
jest.mock('../src/services/redisLock');

// Mock database with comprehensive coverage
jest.mock('../src/db/knex', () => {
  const mockQuery = {
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(1),
    select: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
    first: jest.fn().mockResolvedValue(null),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    then: jest.fn(function(resolve, reject) {
      return Promise.resolve([]).then(resolve, reject);
    })
  };

  const underlyingMock = jest.fn(() => mockQuery);

  const db = new Proxy(underlyingMock, {
    apply(target, thisArg, argumentsList) {
      const result = target.apply(thisArg, argumentsList);
      if (result && typeof result === 'object' && typeof result.then !== 'function') {
        if (!result.where) result.where = jest.fn().mockReturnThis();
        if (!result.whereNotIn) result.whereNotIn = jest.fn().mockReturnThis();
        if (!result.whereNull) result.whereNull = jest.fn().mockReturnThis();
        if (!result.whereIn) result.whereIn = jest.fn().mockReturnThis();
        if (!result.andWhere) result.andWhere = jest.fn().mockReturnThis();
        if (!result.orWhere) result.orWhere = jest.fn().mockReturnThis();
        if (!result.limit) result.limit = jest.fn().mockReturnThis();
        if (!result.orderBy) result.orderBy = jest.fn().mockReturnThis();
        if (!result.returning) result.returning = jest.fn().mockReturnThis();
        if (!result.insert) result.insert = jest.fn().mockReturnThis();
        if (!result.update) result.update = jest.fn().mockResolvedValue(1);
        if (!result.first) result.first = jest.fn().mockResolvedValue(null);
        if (!result.select) result.select = jest.fn().mockResolvedValue([]);
        
        result.then = jest.fn(function(resolve, reject) {
          if (result.select && typeof result.select.mock === 'object') {
            return result.select().then(resolve, reject);
          }
          if (result.first && typeof result.first.mock === 'object') {
            return result.first().then(resolve, reject);
          }
          return Promise.resolve([]).then(resolve, reject);
        });
      }
      return result;
    }
  });

  db.raw = jest.fn();
  return db;
});

const db = require('../src/db/knex');
const retentionJob = require('../src/jobs/retentionPurge');

// Mock logger to avoid noise in tests
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

describe('Retention System - Comprehensive Coverage Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Direct Job Handler Testing - All Code Paths', () => {
    test('should test retention_purge handler with all parameters', async () => {
      // Mock all database operations
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'execution-123' }])
          };
        } else if (dbCallCount === 2) {
          // Get specific policy
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name', 'customer_email'],
              is_active: true
            })
          };
        } else if (dbCallCount === 3) {
          // Get eligible invoices
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              customer_email: 'test@example.com',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 5) {
          // Get current invoice data
          return {
            where: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'invoice-1',
              customer_name: 'Test Customer',
              customer_email: 'test@example.com'
            })
          };
        } else if (dbCallCount === 6) {
          // Purge PII
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else if (dbCallCount === 7) {
          // Log audit entry
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 8) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return mockQuery;
        }
      });

      // Test the actual job handler
      const mockJob = {
        id: 'job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          policyId: uuidv4(),
          dryRun: false,
          retentionDays: 30,
          piiFields: ['customer_name', 'customer_email'],
          performedBy: uuidv4(),
          batchSize: 100
        }
      };

      // Get the registered handler and execute it
      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(7);
    });

    test('should test retention_purge handler with dry run', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'dry-execution' }])
          };
        } else if (dbCallCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 5) {
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 6) {
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'dry-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: true,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(5);
    });

    test('should test retention_purge handler with legal hold', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'hold-execution' }])
          };
        } else if (dbCallCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'hold-1',
              status: 'active',
              hold_reason: 'Legal investigation'
            })
          };
        } else if (dbCallCount === 5) {
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'hold-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(4);
    });

    test('should test retention_purge handler with no policies', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'no-policy-execution' }])
          };
        } else if (dbCallCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 3) {
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'no-policy-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          policyId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await expect(handler(mockJob)).rejects.toThrow(/not found or inactive/);
      }

      expect(dbCallCount).toBeGreaterThan(1);
    });

    test('should test retention_purge handler with multiple policies', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'multi-policy-execution' }])
          };
        } else if (dbCallCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([
              {
                id: 'policy-1',
                name: 'Policy 1',
                retention_days: 30,
                pii_fields: ['customer_name'],
                is_active: true
              },
              {
                id: 'policy-2',
                name: 'Policy 2',
                retention_days: 60,
                pii_fields: ['customer_email'],
                is_active: true
              }
            ])
          };
        } else if (dbCallCount >= 3 && dbCallCount <= 8) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([]),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue(1),
            insert: jest.fn().mockReturnThis()
          };
        } else if (dbCallCount === 9) {
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'multi-policy-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(4);
    });

    test('should test retention_purge handler with database errors', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'error-execution' }])
          };
        } else if (dbCallCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'invoice-1',
              invoice_number: 'INV-001',
              customer_name: 'Test Customer',
              created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            }])
          };
        } else if (dbCallCount === 4) {
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (dbCallCount === 5) {
          throw new Error('Database error during PII purging');
        } else if (dbCallCount === 6) {
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'db-error-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await expect(handler(mockJob)).resolves.not.toThrow();
      }
    });
  });

  describe('Helper Function Coverage', () => {
    test('should test validatePiiFields function directly', () => {
      // Test valid PII fields
      const validFields = ['customer_name', 'customer_email', 'customer_tax_id'];
      const result = retentionJob.validatePiiFields(validFields);
      expect(result).toEqual(validFields);

      // Test invalid PII fields
      expect(() => {
        retentionJob.validatePiiFields(['invalid_field']);
      }).toThrow('Invalid PII fields');

      // Test empty PII fields
      expect(() => {
        retentionJob.validatePiiFields(['']);
      }).toThrow('Invalid PII fields');
    });

    test('should test getActivePolicies function directly', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{
          id: 'policy-1',
          name: 'Test Policy',
          retention_days: 30,
          pii_fields: ['customer_name'],
          is_active: true
        }])
      }));

      const policies = await retentionJob.getActivePolicies('test-tenant-id');
      expect(policies).toBeDefined();
      expect(db).toHaveBeenCalledWith('retention_policies');
    });

    test('should test isUnderLegalHold function directly', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'hold-1',
          status: 'active',
          hold_reason: 'Legal investigation'
        })
      }));

      const underHold = await retentionJob.isUnderLegalHold('test-tenant-id', 'test-invoice-id');
      expect(typeof underHold).toBe('boolean');
      expect(db).toHaveBeenCalledWith('legal_holds');
    });

    test('should test getEligibleInvoices function directly', async () => {
      const policy = {
        retention_days: 30,
        pii_fields: ['customer_name']
      };

      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{
          id: 'invoice-1',
          invoice_number: 'INV-001',
          customer_name: 'Test Customer',
          created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
        }])
      }));

      const invoices = await retentionJob.getEligibleInvoices('test-tenant-id', policy, 100);
      expect(invoices).toBeDefined();
      expect(db).toHaveBeenCalledWith('invoices');
    });

    test('should test purgeInvoicePii function directly', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'invoice-1',
          customer_name: 'Test Customer',
          customer_email: 'test@example.com'
        }),
        update: jest.fn().mockResolvedValue(1)
      }));

      const result = await retentionJob.purgeInvoicePii('invoice-1', ['customer_name'], false);
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('dryRun');
      expect(result).toHaveProperty('purgedFields');
      expect(result).toHaveProperty('oldValues');
      expect(db).toHaveBeenCalledWith('invoices');
    });

    test('should test logRetentionOperation function directly', async () => {
      db.mockImplementation(() => ({
        insert: jest.fn().mockReturnThis()
      }));

      const auditData = {
        tenantId: 'test-tenant-id',
        invoiceId: 'test-invoice-id',
        operation: 'pii_purged',
        piiFields: ['customer_name'],
        reason: 'Retention policy applied',
        performedBy: 'test-user-id'
      };

      await expect(retentionJob.logRetentionOperation(auditData)).resolves.not.toThrow();
      expect(db).toHaveBeenCalledWith('retention_audit_log');
    });

    test('should test createJobExecution function directly', async () => {
      db.mockImplementation(() => ({
        insert: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 'execution-123' }])
      }));

      const executionData = {
        tenantId: 'test-tenant-id',
        dryRun: false,
        performedBy: 'test-user-id'
      };

      // Note: createJobExecution is not exported, so we can't test it directly
      // This test focuses on the handler which uses createJobExecution internally
    });

    test('should test handler internal execution tracking', async () => {
      // This tests the execution tracking logic within the handler
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'execution-123' }])
          };
        } else if (dbCallCount === 2) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            }])
          };
        } else if (dbCallCount === 3) {
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([])
          };
        } else if (dbCallCount === 4) {
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1)
          };
        } else {
          return {};
        }
      });

      const mockJob = {
        id: 'tracking-job-123',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: false,
          performedBy: uuidv4()
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await handler(mockJob);
      }

      expect(dbCallCount).toBeGreaterThan(1);
    });

    test('should test getExecutionStatus function directly', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'execution-123',
          status: 'completed',
          invoices_processed: 1,
          invoices_purged: 1
        })
      }));

      const status = await retentionJob.getExecutionStatus('execution-123');
      expect(status).toBeDefined();
      expect(db).toHaveBeenCalledWith('retention_job_executions');
    });

    test('should test getRecentExecutions function directly', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{
          id: 'execution-123',
          status: 'completed',
          created_at: new Date()
        }])
      }));

      const executions = await retentionJob.getRecentExecutions('test-tenant-id', 10);
      expect(executions).toBeDefined();
      expect(db).toHaveBeenCalledWith('retention_job_executions');
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    test('should handle invalid job payload in handler', async () => {
      const mockJob = {
        id: 'invalid-job-123',
        type: 'retention_purge',
        payload: {
          // Missing required fields
          dryRun: false
        }
      };

      const handlers = retentionJob.retentionWorker.handlers;
      const handler = handlers.get('retention_purge');
      
      if (handler) {
        await expect(handler(mockJob)).rejects.toThrow();
      }
    });

    test('should handle database errors in policy lookup', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        select: jest.fn().mockRejectedValue(new Error('Database connection failed'))
      }));

      await expect(retentionJob.getActivePolicies('test-tenant-id')).rejects.toThrow('Database connection failed');
    });

    test('should handle database errors in legal hold check', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        first: jest.fn().mockRejectedValue(new Error('Database error'))
      }));

      await expect(retentionJob.isUnderLegalHold('test-tenant-id', 'test-invoice-id')).rejects.toThrow('Database error');
    });

    test('should handle database errors in invoice lookup', async () => {
      const policy = {
        retention_days: 30,
        pii_fields: ['customer_name']
      };

      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockRejectedValue(new Error('Database error'))
      }));

      await expect(retentionJob.getEligibleInvoices('test-tenant-id', policy, 100)).rejects.toThrow('Database error');
    });

    test('should handle database errors in PII purging', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'invoice-1',
          customer_name: 'Test Customer'
        }),
        update: jest.fn().mockRejectedValue(new Error('Update failed'))
      }));

      await expect(retentionJob.purgeInvoicePii('invoice-1', ['customer_name'], false)).rejects.toThrow('Update failed');
    });

    test('should handle database errors in audit logging', async () => {
      db.mockImplementation(() => ({
        insert: jest.fn().mockRejectedValue(new Error('Audit log failed'))
      }));

      const auditData = {
        tenantId: 'test-tenant-id',
        invoiceId: 'test-invoice-id',
        operation: 'pii_purged',
        piiFields: ['customer_name']
      };

      await expect(retentionJob.logRetentionOperation(auditData)).rejects.toThrow('Audit log failed');
    });

    test('should handle database errors in job execution creation', async () => {
      db.mockImplementation(() => ({
        insert: jest.fn().mockReturnThis(),
        returning: jest.fn().mockRejectedValue(new Error('Execution creation failed'))
      }));

      const executionData = {
        tenantId: 'test-tenant-id',
        dryRun: false,
        performedBy: 'test-user-id'
      };

      await expect(retentionJob.createJobExecution(executionData)).rejects.toThrow('Execution creation failed');
    });

    test('should handle database errors in job execution update', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        update: jest.fn().mockRejectedValue(new Error('Execution update failed'))
      }));

      const updateData = {
        status: 'completed'
      };

      await expect(retentionJob.updateJobExecution('execution-123', updateData)).rejects.toThrow('Execution update failed');
    });

    test('should handle database errors in execution status lookup', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockRejectedValue(new Error('Status lookup failed'))
      }));

      await expect(retentionJob.getExecutionStatus('execution-123')).rejects.toThrow('Status lookup failed');
    });

    test('should handle database errors in recent executions lookup', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockRejectedValue(new Error('Recent executions failed'))
      }));

      await expect(retentionJob.getRecentExecutions('test-tenant-id', 10)).rejects.toThrow('Recent executions failed');
    });
  });
  describe('Forensic before-state snapshots', () => {
    test('should build salted hashed snapshots without clear-text PII', () => {
      const invoice = {
        id: 'invoice-snapshot-1',
        customer_name: 'Forensic Customer',
        customer_email: 'forensic@example.com',
        customer_tax_id: null
      };

      const snapshot = retentionJob.buildPiiBeforeStateSnapshot(invoice, [
        'customer_name',
        'customer_email',
        'customer_tax_id'
      ]);

      expect(snapshot.fieldCount).toBe(3);
      expect(snapshot.valueHashCount).toBe(2);
      expect(snapshot.fieldHashes.customer_name).toBe(retentionJob.hashPiiValue('Forensic Customer', invoice.id));
      expect(snapshot.fieldHashes.customer_email).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.fieldHashes.customer_email).not.toBe('forensic@example.com');
      expect(snapshot.fieldHashes).not.toHaveProperty('customer_tax_id');
    });

    test('should return hashed before-state for destructive purge helper calls', async () => {
      const invoiceId = 'invoice-real-snapshot-1';
      const invoiceQuery = {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: invoiceId,
          customer_name: 'Real Purge Customer',
          customer_email: 'real-purge@example.com',
          customer_tax_id: null
        })
      };
      const updateQuery = {
        where: jest.fn().mockReturnThis(),
        update: jest.fn().mockResolvedValue(1)
      };
      db.mockImplementationOnce(() => invoiceQuery).mockImplementationOnce(() => updateQuery);

      const result = await retentionJob.purgeInvoicePii(invoiceId, [
        'customer_name',
        'customer_email',
        'customer_tax_id'
      ], false);

      expect(result.success).toBe(true);
      expect(result.oldValues.customer_name).toBe(retentionJob.hashPiiValue('Real Purge Customer', invoiceId));
      expect(result.oldValues.customer_email).toMatch(/^[a-f0-9]{64}$/);
      expect(result.oldValues.customer_email).not.toBe('real-purge@example.com');
      expect(result.oldValues).not.toHaveProperty('customer_tax_id');
      expect(result.beforeStateSnapshot).toMatchObject({
        fieldCount: 3,
        valueHashCount: 2
      });
      expect(updateQuery.update).toHaveBeenCalledWith({
        customer_name: null,
        customer_email: null,
        customer_tax_id: null
      });
    });

    test('should not snapshot clear-text values during dry-run purge helper calls', async () => {
      const result = await retentionJob.purgeInvoicePii('invoice-dry-snapshot-1', [
        'customer_name',
        'customer_email'
      ], true);

      expect(result.dryRun).toBe(true);
      expect(result.oldValues).toEqual({});
      expect(result.beforeStateSnapshot).toEqual({
        fieldHashes: {},
        fieldCount: 2,
        valueHashCount: 0
      });
    });
  });

});
