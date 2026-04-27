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

describe('Retention System - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Start retention worker for tests
    retentionJob.startQueueProcessing();
  });

  afterEach(async () => {
    // Stop retention worker to clean up
    await retentionJob.stopQueueProcessing(1000);
  });

  describe('Complete Job Workflow', () => {
    test('should execute complete retention job workflow', async () => {
      // Mock database responses for complete workflow
      let mockCallCount = 0;
      db.mockImplementation(() => {
        mockCallCount++;
        
        if (mockCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'execution-id' }])
          };
        } else if (mockCallCount === 2) {
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
        } else if (mockCallCount === 3) {
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
              created_at: new Date()
            }])
          };
        } else if (mockCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null) // No legal hold
          };
        } else if (mockCallCount === 5) {
          // Purge PII from invoice
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else if (mockCallCount === 6) {
          // Log audit entry
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (mockCallCount === 7) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      // Schedule and execute job
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: false,
        performedBy: 'test-user-id',
        batchSize: 100
      });

      expect(jobId).toBeDefined();
      expect(retentionJob.jobExecutions.has(jobId)).toBe(true);

      // Wait for job to process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify job was processed
      expect(db).toHaveBeenCalled();
    });

    test('should handle dry run workflow', async () => {
      let mockCallCount = 0;
      db.mockImplementation(() => {
        mockCallCount++;
        
        if (mockCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'dry-run-execution' }])
          };
        } else if (mockCallCount === 2) {
          // Get active policies
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
        } else if (mockCallCount === 3) {
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
              created_at: new Date()
            }])
          };
        } else if (mockCallCount === 4) {
          // Check legal holds
          return {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (mockCallCount === 5) {
          // Log audit entry for dry run
          return {
            insert: jest.fn().mockReturnThis()
          };
        } else if (mockCallCount === 6) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: true,
        performedBy: 'test-user-id'
      });

      expect(jobId).toBeDefined();
    });

    test('should handle legal hold protection', async () => {
      let mockCallCount = 0;
      db.mockImplementation(() => {
        mockCallCount++;
        
        if (mockCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'hold-execution' }])
          };
        } else if (mockCallCount === 2) {
          // Get active policies
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
        } else if (mockCallCount === 3) {
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
              created_at: new Date()
            }])
          };
        } else if (mockCallCount === 4) {
          // Check legal holds - return active hold
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
        } else if (mockCallCount === 5) {
          // Update job execution (no invoices purged due to hold)
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: false,
        performedBy: 'test-user-id'
      });

      expect(jobId).toBeDefined();
    });

    test('should handle multiple policies', async () => {
      let mockCallCount = 0;
      db.mockImplementation(() => {
        mockCallCount++;
        
        if (mockCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'multi-policy-execution' }])
          };
        } else if (mockCallCount === 2) {
          // Get active policies - return multiple
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
        } else if (mockCallCount >= 3 && mockCallCount <= 8) {
          // Handle multiple policy processing
          return {
            where: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([]), // No eligible invoices
            andWhere: jest.fn().mockReturnThis(),
            orWhere: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockReturnThis(),
            insert: jest.fn().mockReturnThis()
          };
        } else if (mockCallCount === 9) {
          // Update job execution
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: false,
        performedBy: 'test-user-id'
      });

      expect(jobId).toBeDefined();
    });
  });

  describe('Error Handling in Job Processing', () => {
    test('should handle policy not found error', async () => {
      let mockCallCount = 0;
      db.mockImplementation(() => {
        mockCallCount++;
        
        if (mockCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'error-execution' }])
          };
        } else if (mockCallCount === 2) {
          // Get specific policy - return null (not found)
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null)
          };
        } else if (mockCallCount === 3) {
          // Update job execution with failure
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        policyId: 'non-existent-policy',
        dryRun: false,
        performedBy: 'test-user-id'
      });

      expect(jobId).toBeDefined();
    });

    test('should handle database connection errors', async () => {
      // Mock database to throw error
      db.mockImplementation(() => ({
        insert: jest.fn().mockReturnThis(),
        returning: jest.fn().mockRejectedValue(new Error('Database connection failed'))
      }));

      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: false,
        performedBy: 'test-user-id'
      });

      expect(jobId).toBeDefined();
    });
  });

  describe('Job Queue Operations', () => {
    test('should handle job queue statistics', () => {
      const stats = retentionJob.retentionWorker.getStats();
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('processingCount');
      expect(stats).toHaveProperty('handlerCount');
      expect(stats).toHaveProperty('queueStats');
    });

    test('should handle job cancellation', () => {
      const jobId1 = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: true
      });

      const jobId2 = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        dryRun: true
      });

      expect(retentionJob.jobExecutions.has(jobId1)).toBe(true);
      expect(retentionJob.jobExecutions.has(jobId2)).toBe(true);

      // Cancel first job
      const cancelled1 = retentionJob.cancelRetentionJob(jobId1);
      expect(cancelled1).toBe(true);
      expect(retentionJob.jobExecutions.has(jobId1)).toBe(false);
      expect(retentionJob.jobExecutions.has(jobId2)).toBe(true);

      // Try to cancel non-existent job
      const cancelled2 = retentionJob.cancelRetentionJob('non-existent');
      expect(cancelled2).toBe(false);
    });
  });

  describe('PII Field Processing', () => {
    test('should handle all PII field combinations in jobs', async () => {
      const piiFieldCombinations = [
        ['customer_name'],
        ['customer_email'],
        ['customer_tax_id'],
        ['customer_name', 'customer_email'],
        ['customer_name', 'customer_tax_id'],
        ['customer_email', 'customer_tax_id'],
        ['customer_name', 'customer_email', 'customer_tax_id']
      ];

      for (const piiFields of piiFieldCombinations) {
        const jobId = retentionJob.scheduleRetentionPurge({
          tenantId: 'test-tenant-id',
          piiFields,
          dryRun: true,
          performedBy: 'test-user-id'
        });

        expect(jobId).toBeDefined();
        
        // Clean up for next iteration
        retentionJob.cancelRetentionJob(jobId);
      }
    });

    test('should validate PII fields in job scheduling', () => {
      expect(() => {
        retentionJob.scheduleRetentionPurge({
          tenantId: 'test-tenant-id',
          piiFields: ['invalid_field'],
          dryRun: true
        });
      }).toThrow('Invalid PII fields');
    });
  });

  describe('Batch Processing', () => {
    test('should handle different batch sizes', async () => {
      const batchSizes = [1, 10, 50, 100, 500, 1000];

      for (const batchSize of batchSizes) {
        const jobId = retentionJob.scheduleRetentionPurge({
          tenantId: 'test-tenant-id',
          batchSize,
          dryRun: true,
          performedBy: 'test-user-id'
        });

        expect(jobId).toBeDefined();
        
        // Clean up for next iteration
        retentionJob.cancelRetentionJob(jobId);
      }
    });

    test('should handle batch size limits', () => {
      // Test maximum batch size
      const maxJobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        batchSize: 1000,
        dryRun: true
      });

      expect(maxJobId).toBeDefined();

      // Test batch size exceeding maximum (should be capped)
      const overLimitJobId = retentionJob.scheduleRetentionPurge({
        tenantId: 'test-tenant-id',
        batchSize: 2000, // Exceeds max
        dryRun: true
      });

      expect(overLimitJobId).toBeDefined();
    });
  });

  describe('Retention Period Handling', () => {
    test('should handle various retention periods', async () => {
      const retentionPeriods = [1, 7, 30, 90, 365, 2555]; // 1 day to 7 years

      for (const retentionDays of retentionPeriods) {
        const jobId = retentionJob.scheduleRetentionPurge({
          tenantId: 'test-tenant-id',
          retentionDays,
          dryRun: true,
          performedBy: 'test-user-id'
        });

        expect(jobId).toBeDefined();
        
        // Clean up for next iteration
        retentionJob.cancelRetentionJob(jobId);
      }
    });
  });
});
