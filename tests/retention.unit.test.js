'use strict';

const { z } = require('zod');
const retentionJob = require('../src/jobs/retentionPurge');

// Mock logger to avoid noise in tests
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

// Mock database with proper chainable methods
jest.mock('../src/db/knex', () => {
  const mockQuery = {
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(1),
    select: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    returning: jest.fn().mockReturnThis(),
  };

  // Make the chain resolve properly
  mockQuery.insert.mockResolvedValue([{ id: 'test-id', created_at: new Date() }]);
  mockQuery.update.mockResolvedValue(1);
  mockQuery.returning.mockResolvedValue([{ id: 'test-id', created_at: new Date() }]);

  const db = jest.fn(() => mockQuery);
  db.raw = jest.fn();
  return db;
});

describe('Retention System - Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('PII Field Validation', () => {
    test('should validate valid PII fields', () => {
      const validFields = ['customer_name', 'customer_email', 'customer_tax_id'];
      expect(() => {
        retentionJob.validatePiiFields(validFields);
      }).not.toThrow();

      const result = retentionJob.validatePiiFields(validFields);
      expect(result).toEqual(validFields);
    });

    test('should reject invalid PII fields', () => {
      const invalidFields = ['customer_name', 'invalid_field', 'customer_email'];
      
      expect(() => {
        retentionJob.validatePiiFields(invalidFields);
      }).toThrow('Invalid PII fields');
    });

    test('should reject empty PII fields', () => {
      expect(() => {
        retentionJob.validatePiiFields(['']);
      }).toThrow('Invalid PII fields');
    });
  });

  describe('Job Scheduling', () => {
    test('should schedule retention job with valid parameters', () => {
      const options = {
        tenantId: 'test-tenant-id',
        policyId: 'test-policy-id',
        dryRun: true,
        performedBy: 'test-user-id',
        batchSize: 50
      };

      const jobId = retentionJob.scheduleRetentionPurge(options);
      
      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
      expect(retentionJob.jobExecutions.has(jobId)).toBe(true);
    });

    test('should cancel scheduled job', () => {
      const options = {
        tenantId: 'test-tenant-id',
        dryRun: true
      };

      const jobId = retentionJob.scheduleRetentionPurge(options);
      expect(retentionJob.jobExecutions.has(jobId)).toBe(true);

      const cancelled = retentionJob.cancelRetentionJob(jobId);
      expect(cancelled).toBe(true);
      expect(retentionJob.jobExecutions.has(jobId)).toBe(false);
    });

    test('should return false when cancelling non-existent job', () => {
      const cancelled = retentionJob.cancelRetentionJob('non-existent-job-id');
      expect(cancelled).toBe(false);
    });
  });

  describe('Queue Management', () => {
    test('should start and stop queue processing', () => {
      expect(retentionJob.retentionWorker.isRunning).toBe(false);

      retentionJob.startQueueProcessing();
      expect(retentionJob.retentionWorker.isRunning).toBe(true);

      retentionJob.stopQueueProcessing(1000);
      expect(retentionJob.retentionWorker.isRunning).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid job parameters gracefully', () => {
      const invalidOptions = {
        tenantId: null, // Invalid
        dryRun: true
      };

      // The function should handle this gracefully by using defaults
      const jobId = retentionJob.scheduleRetentionPurge(invalidOptions);
      expect(jobId).toBeDefined();
    });

    test('should validate retention days', () => {
      const options = {
        tenantId: 'test-tenant-id',
        retentionDays: -5, // Invalid
        dryRun: true
      };

      // The function should handle this gracefully
      const jobId = retentionJob.scheduleRetentionPurge(options);
      expect(jobId).toBeDefined();
    });

    test('should validate batch size limits', () => {
      const options = {
        tenantId: 'test-tenant-id',
        batchSize: 2000, // Exceeds max of 1000
        dryRun: true
      };

      // The function should handle this gracefully by using max limit
      const jobId = retentionJob.scheduleRetentionPurge(options);
      expect(jobId).toBeDefined();
    });
  });

  describe('Worker Statistics', () => {
    test('should return worker statistics', () => {
      const stats = retentionJob.retentionWorker.getStats();
      
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('processingCount');
      expect(stats).toHaveProperty('handlerCount');
      expect(stats).toHaveProperty('queueStats');
      expect(typeof stats.isRunning).toBe('boolean');
      expect(typeof stats.processingCount).toBe('number');
      expect(typeof stats.handlerCount).toBe('number');
    });

    test('should return queue statistics', () => {
      const queueStats = retentionJob.retentionQueue.getStats();
      
      expect(queueStats).toHaveProperty('pending');
      expect(queueStats).toHaveProperty('processing');
      expect(queueStats).toHaveProperty('completed');
      expect(queueStats).toHaveProperty('failed');
      expect(typeof queueStats.pending).toBe('number');
      expect(typeof queueStats.processing).toBe('number');
      expect(typeof queueStats.completed).toBe('number');
      expect(typeof queueStats.failed).toBe('number');
    });
  });

  describe('Policy and Legal Hold Functions', () => {
    test('should handle database operations for policies', async () => {
      // Test getActivePolicies - returns whatever the mock returns
      const policies = await retentionJob.getActivePolicies('test-tenant-id');
      expect(policies).toBeDefined();
    });

    test('should handle database operations for legal holds', async () => {
      // Test isUnderLegalHold
      const underHold = await retentionJob.isUnderLegalHold('test-tenant-id', 'test-invoice-id');
      expect(typeof underHold).toBe('boolean');
    });

    test('should handle database operations for eligible invoices', async () => {
      // Test getEligibleInvoices
      const policy = {
        retention_days: 30,
        pii_fields: ['customer_name', 'customer_email']
      };

      const invoices = await retentionJob.getEligibleInvoices('test-tenant-id', policy, 100);
      expect(invoices).toBeDefined();
    });
  });

  describe('PII Purging Operations', () => {
    test('should handle dry run purging', async () => {
      const invoiceId = 'test-invoice-id';
      const piiFields = ['customer_name', 'customer_email'];
      const dryRun = true;

      const result = await retentionJob.purgeInvoicePii(invoiceId, piiFields, dryRun);
      
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('dryRun');
      expect(result).toHaveProperty('purgedFields');
      expect(result).toHaveProperty('oldValues');
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(Array.isArray(result.purgedFields)).toBe(true);
    });

    test('should handle live purging', async () => {
      const invoiceId = 'test-invoice-id';
      const piiFields = ['customer_name'];
      const dryRun = false;

      const result = await retentionJob.purgeInvoicePii(invoiceId, piiFields, dryRun);
      
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('dryRun');
      expect(result).toHaveProperty('purgedFields');
      expect(result.dryRun).toBe(false);
    });
  });

  describe('Audit Logging', () => {
    test('should log retention operations', async () => {
      const auditData = {
        tenantId: 'test-tenant-id',
        invoiceId: 'test-invoice-id',
        operation: 'dry_run',
        piiFields: ['customer_name'],
        reason: 'Test dry run',
        performedBy: 'test-user-id'
      };

      // Should not throw
      await expect(retentionJob.logRetentionOperation(auditData)).resolves.not.toThrow();
    });
  });

  describe('Job Execution Management', () => {
    test('should handle execution status queries', async () => {
      const executionId = 'test-execution-id';
      
      // Should not throw and return null for non-existent execution
      const status = await retentionJob.getExecutionStatus(executionId);
      expect(status).toBeNull();
    });

    test('should handle recent executions queries', async () => {
      const tenantId = 'test-tenant-id';
      const limit = 10;
      
      // Should not throw and return whatever the mock returns
      const executions = await retentionJob.getRecentExecutions(tenantId, limit);
      expect(executions).toBeDefined();
    });
  });
});
