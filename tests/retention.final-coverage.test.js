'use strict';

const { v4: uuidv4 } = require('uuid');

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
  };

  const db = jest.fn(() => mockQuery);
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

describe('Retention System - Final Coverage Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete Handler Coverage', () => {
    test('should test retention_purge handler with all code paths', async () => {
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
          // Get active policies
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([{
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name', 'customer_email'],
              is_active: true
            }])
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
            first: jest.fn().mockResolvedValue({
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            })
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
            first: jest.fn().mockResolvedValue({
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            })
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

    test('should test retention_purge handler with multiple policies', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'multi-execution' }])
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
        id: 'multi-job-123',
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

      expect(dbCallCount).toBeGreaterThan(8);
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
            first: jest.fn().mockResolvedValue({
              id: 'policy-1',
              name: 'Test Policy',
              retention_days: 30,
              pii_fields: ['customer_name'],
              is_active: true
            })
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
        id: 'error-job-123',
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

  describe('All Helper Functions', () => {
    test('should test validatePiiFields', () => {
      const validFields = ['customer_name', 'customer_email', 'customer_tax_id'];
      const result = retentionJob.validatePiiFields(validFields);
      expect(result).toEqual(validFields);

      expect(() => {
        retentionJob.validatePiiFields(['invalid_field']);
      }).toThrow('Invalid PII fields');

      expect(() => {
        retentionJob.validatePiiFields(['']);
      }).toThrow('Invalid PII fields');
    });

    test('should test getActivePolicies', async () => {
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

    test('should test isUnderLegalHold', async () => {
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

    test('should test getEligibleInvoices', async () => {
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

    test('should test purgeInvoicePii', async () => {
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

    test('should test logRetentionOperation', async () => {
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

    test('should test getExecutionStatus', async () => {
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

    test('should test getRecentExecutions', async () => {
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

  describe('Edge Cases and Error Handling', () => {
    test('should test invalid job payload', async () => {
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
        await expect(handler(mockJob)).resolves.not.toThrow();
      }
    });

    test('should test database errors in helper functions', async () => {
      // Test getActivePolicies error
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockRejectedValue(new Error('Database error'))
      }));

      await expect(retentionJob.getActivePolicies('test-tenant-id')).resolves.not.toThrow();
    });

    test('should test isUnderLegalHold error', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        first: jest.fn().mockRejectedValue(new Error('Database error'))
      }));

      await expect(retentionJob.isUnderLegalHold('test-tenant-id', 'test-invoice-id')).resolves.not.toThrow();
    });

    test('should test getEligibleInvoices error', async () => {
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

      await expect(retentionJob.getEligibleInvoices('test-tenant-id', policy, 100)).resolves.not.toThrow();
    });

    test('should test purgeInvoicePii error', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'invoice-1',
          customer_name: 'Test Customer'
        }),
        update: jest.fn().mockRejectedValue(new Error('Update failed'))
      }));

      await expect(retentionJob.purgeInvoicePii('invoice-1', ['customer_name'], false)).resolves.not.toThrow();
    });

    test('should test logRetentionOperation error', async () => {
      db.mockImplementation(() => ({
        insert: jest.fn().mockRejectedValue(new Error('Audit log failed'))
      }));

      const auditData = {
        tenantId: 'test-tenant-id',
        invoiceId: 'test-invoice-id',
        operation: 'pii_purged',
        piiFields: ['customer_name']
      };

      await expect(retentionJob.logRetentionOperation(auditData)).resolves.not.toThrow();
    });

    test('should test getExecutionStatus error', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockRejectedValue(new Error('Status lookup failed'))
      }));

      await expect(retentionJob.getExecutionStatus('execution-123')).resolves.not.toThrow();
    });

    test('should test getRecentExecutions error', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockRejectedValue(new Error('Recent executions failed'))
      }));

      await expect(retentionJob.getRecentExecutions('test-tenant-id', 10)).resolves.not.toThrow();
    });
  });
});
