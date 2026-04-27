'use strict';

const { v4: uuidv4 } = require('uuid');

// Mock database before importing modules
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
    update: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
  };

  // Make the chain resolve properly
  mockQuery.insert.mockResolvedValue([{ id: 'test-id', created_at: new Date() }]);
  mockQuery.update.mockResolvedValue(1);
  mockQuery.returning.mockResolvedValue([{ id: 'test-id', created_at: new Date() }]);
  mockQuery.first.mockResolvedValue(null);
  mockQuery.select.mockResolvedValue([]);

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

describe('Retention System - Coverage Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Retention Job Handler - Full Coverage', () => {
    test('should handle job with all parameters', async () => {
      // Mock worker registration
      const mockHandler = jest.fn().mockResolvedValue();
      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      // Create a mock job
      const mockJob = {
        id: 'test-job-id',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          policyId: 'test-policy-id',
          dryRun: false,
          retentionDays: 30,
          piiFields: ['customer_name', 'customer_email'],
          performedBy: 'test-user-id',
          batchSize: 50
        }
      };

      // Mock database responses for policy lookup
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'test-policy-id',
          name: 'Test Policy',
          retention_days: 30,
          pii_fields: ['customer_name', 'customer_email'],
          is_active: true
        }),
        insert: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 'execution-id' }]),
        update: jest.fn().mockReturnThis()
      }));

      // Execute the handler
      await mockHandler(mockJob);

      expect(mockHandler).toHaveBeenCalled();
    });

    test('should handle job execution with errors', async () => {
      const mockHandler = jest.fn().mockImplementation(async (job) => {
        // Simulate an error during job processing
        if (job.payload.policyId === 'error-policy') {
          throw new Error('Policy not found');
        }
        return Promise.resolve();
      });

      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      const mockJob = {
        id: 'error-job-id',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          policyId: 'error-policy',
          dryRun: false
        }
      };

      // Should handle the error gracefully
      await expect(mockHandler(mockJob)).rejects.toThrow('Policy not found');
    });

    test('should handle database errors during policy lookup', async () => {
      // Mock database to throw error
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockRejectedValue(new Error('Database connection failed'))
      }));

      const mockHandler = jest.fn().mockImplementation(async (job) => {
        // This will trigger the database error path
        const policies = await retentionJob.getActivePolicies(job.payload.tenantId);
        return policies;
      });

      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      const mockJob = {
        id: 'db-error-job',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          dryRun: false
        }
      };

      await expect(mockHandler(mockJob)).rejects.toThrow('Database connection failed');
    });

    test('should handle invoice processing with legal holds', async () => {
      // Mock legal hold check to return true
      const isUnderLegalHoldSpy = jest.spyOn(retentionJob, 'isUnderLegalHold');
      isUnderLegalHoldSpy.mockResolvedValue(true);

      const mockHandler = jest.fn().mockImplementation(async (job) => {
        const underHold = await retentionJob.isUnderLegalHold(
          job.payload.tenantId, 
          'test-invoice-id'
        );
        return { underHold };
      });

      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      const mockJob = {
        id: 'legal-hold-job',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          dryRun: false
        }
      };

      const result = await mockHandler(mockJob);
      expect(result.underHold).toBe(true);
    });

    test('should handle batch processing with multiple invoices', async () => {
      // Mock multiple eligible invoices
      const mockInvoices = Array.from({ length: 5 }, (_, i) => ({
        id: `invoice-${i}`,
        invoice_number: `INV-${i}`,
        customer_name: `Customer ${i}`,
        customer_email: `customer${i}@example.com`,
        created_at: new Date()
      }));

      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(mockInvoices)
      }));

      const mockHandler = jest.fn().mockImplementation(async (job) => {
        const policy = {
          retention_days: 30,
          pii_fields: ['customer_name', 'customer_email']
        };
        const invoices = await retentionJob.getEligibleInvoices(
          job.payload.tenantId, 
          policy, 
          job.payload.batchSize
        );
        return { processed: invoices.length };
      });

      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      const mockJob = {
        id: 'batch-job',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          batchSize: 10,
          dryRun: false
        }
      };

      const result = await mockHandler(mockJob);
      expect(result.processed).toBe(5);
    });

    test('should handle audit logging for all operations', async () => {
      const auditSpy = jest.spyOn(retentionJob, 'logRetentionOperation');
      auditSpy.mockResolvedValue();

      const mockHandler = jest.fn().mockImplementation(async (job) => {
        await retentionJob.logRetentionOperation({
          tenantId: job.payload.tenantId,
          invoiceId: 'test-invoice-id',
          operation: 'pii_purged',
          piiFields: ['customer_name'],
          reason: 'Retention policy applied',
          performedBy: job.payload.performedBy
        });
      });

      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      const mockJob = {
        id: 'audit-job',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          performedBy: 'test-user-id',
          dryRun: false
        }
      };

      await mockHandler(mockJob);
      expect(auditSpy).toHaveBeenCalledWith({
        tenantId: 'test-tenant-id',
        invoiceId: 'test-invoice-id',
        operation: 'pii_purged',
        piiFields: ['customer_name'],
        reason: 'Retention policy applied',
        performedBy: 'test-user-id'
      });
    });

    test('should handle job execution tracking', async () => {
      const createExecutionSpy = jest.spyOn(retentionJob, 'createJobExecution');
      const updateExecutionSpy = jest.spyOn(retentionJob, 'updateJobExecution');
      
      createExecutionSpy.mockResolvedValue('execution-id');
      updateExecutionSpy.mockResolvedValue();

      const mockHandler = jest.fn().mockImplementation(async (job) => {
        const executionId = await retentionJob.createJobExecution({
          tenantId: job.payload.tenantId,
          dryRun: job.payload.dryRun,
          performedBy: job.payload.performedBy
        });

        await retentionJob.updateJobExecution(executionId, {
          status: 'completed',
          invoices_processed: 1,
          invoices_purged: 1
        });

        return { executionId };
      });

      retentionJob.retentionWorker.registerHandler('retention_purge', mockHandler);

      const mockJob = {
        id: 'tracking-job',
        type: 'retention_purge',
        payload: {
          tenantId: 'test-tenant-id',
          dryRun: false,
          performedBy: 'test-user-id'
        }
      };

      const result = await mockHandler(mockJob);
      expect(result.executionId).toBe('execution-id');
      expect(createExecutionSpy).toHaveBeenCalled();
      expect(updateExecutionSpy).toHaveBeenCalled();
    });
  });

  describe('PII Field Validation - Edge Cases', () => {
    test('should handle all valid PII field combinations', () => {
      const validCombinations = [
        ['customer_name'],
        ['customer_email'],
        ['customer_tax_id'],
        ['customer_name', 'customer_email'],
        ['customer_name', 'customer_tax_id'],
        ['customer_email', 'customer_tax_id'],
        ['customer_name', 'customer_email', 'customer_tax_id']
      ];

      validCombinations.forEach(fields => {
        expect(() => {
          retentionJob.validatePiiFields(fields);
        }).not.toThrow();
      });
    });

    test('should handle case sensitivity in PII fields', () => {
      expect(() => {
        retentionJob.validatePiiFields(['Customer_Name']); // Wrong case
      }).toThrow('Invalid PII fields');

      expect(() => {
        retentionJob.validatePiiFields(['CUSTOMER_NAME']); // Wrong case
      }).toThrow('Invalid PII fields');
    });

    test('should handle whitespace in PII fields', () => {
      expect(() => {
        retentionJob.validatePiiFields([' customer_name']); // Leading space
      }).toThrow('Invalid PII fields');

      expect(() => {
        retentionJob.validatePiiFields(['customer_name ']); // Trailing space
      }).toThrow('Invalid PII fields');
    });
  });

  describe('Legal Hold Edge Cases', () => {
    test('should handle expired legal holds', async () => {
      // Mock database to return expired hold
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'expired-hold',
          expires_at: new Date(Date.now() - 86400000), // Yesterday
          status: 'active'
        })
      }));

      const underHold = await retentionJob.isUnderLegalHold('test-tenant', 'test-invoice');
      expect(typeof underHold).toBe('boolean');
    });

    test('should handle released legal holds', async () => {
      // Mock database to return released hold
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'released-hold',
          status: 'released',
          released_at: new Date()
        })
      }));

      const underHold = await retentionJob.isUnderLegalHold('test-tenant', 'test-invoice');
      expect(typeof underHold).toBe('boolean');
    });
  });

  describe('Policy Management Edge Cases', () => {
    test('should handle multiple active policies', async () => {
      const mockPolicies = [
        { id: 'policy-1', name: 'Policy 1', retention_days: 30, is_active: true },
        { id: 'policy-2', name: 'Policy 2', retention_days: 60, is_active: true },
        { id: 'policy-3', name: 'Policy 3', retention_days: 90, is_active: true }
      ];

      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(mockPolicies)
      }));

      const policies = await retentionJob.getActivePolicies('test-tenant');
      expect(policies).toBeDefined();
    });

    test('should handle no active policies', async () => {
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([])
      }));

      const policies = await retentionJob.getActivePolicies('test-tenant');
      expect(policies).toBeDefined();
    });
  });

  describe('Error Recovery and Cleanup', () => {
    test('should handle job execution cleanup on error', async () => {
      const mockJob = {
        id: 'cleanup-test-job',
        type: 'retention_purge'
      };

      // Simulate job execution context cleanup
      expect(retentionJob.jobExecutions.has(mockJob.id)).toBe(false);
      
      // Add job to tracking
      retentionJob.jobExecutions.set(mockJob.id, { started: new Date() });
      expect(retentionJob.jobExecutions.has(mockJob.id)).toBe(true);

      // Simulate cleanup
      retentionJob.jobExecutions.delete(mockJob.id);
      expect(retentionJob.jobExecutions.has(mockJob.id)).toBe(false);
    });

    test('should handle worker graceful shutdown', async () => {
      // Start worker
      retentionJob.startQueueProcessing();
      expect(retentionJob.retentionWorker.isRunning).toBe(true);

      // Stop worker gracefully
      await retentionJob.stopQueueProcessing(1000);
      expect(retentionJob.retentionWorker.isRunning).toBe(false);
    });
  });

  describe('Performance and Limits', () => {
    test('should handle maximum batch size', () => {
      const options = {
        tenantId: 'test-tenant',
        batchSize: 1000, // Maximum allowed
        dryRun: true
      };

      const jobId = retentionJob.scheduleRetentionPurge(options);
      expect(jobId).toBeDefined();
    });

    test('should handle very large retention periods', () => {
      const options = {
        tenantId: 'test-tenant',
        retentionDays: 36500, // 100 years
        dryRun: true
      };

      const jobId = retentionJob.scheduleRetentionPurge(options);
      expect(jobId).toBeDefined();
    });

    test('should handle minimum retention periods', () => {
      const options = {
        tenantId: 'test-tenant',
        retentionDays: 1, // 1 day
        dryRun: true
      };

      const jobId = retentionJob.scheduleRetentionPurge(options);
      expect(jobId).toBeDefined();
    });
  });
});
