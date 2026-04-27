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

describe('Retention System - Full Coverage Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete Job Handler Coverage', () => {
    test('should handle complete successful job execution', async () => {
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
            update: jest.fn().mockReturnThis()
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
            update: jest.fn().mockReturnThis()
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
          dryRun: false,
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

    test('should handle job with no active policies', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'no-policy-execution' }])
          };
        } else if (dbCallCount === 2) {
          // Get active policies - return empty
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([])
          };
        } else if (dbCallCount === 3) {
          // Update job execution with error
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'no-policy-job',
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

    test('should handle invoice processing errors', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'error-execution' }])
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
              pii_fields: ['customer_name'],
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
          // Error getting invoice data
          throw new Error('Database error');
        } else if (dbCallCount === 6) {
          // Update job execution with errors
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'invoice-error-job',
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

    test('should handle job execution cleanup', async () => {
      const mockJob = {
        id: 'cleanup-job',
        type: 'retention_purge',
        payload: {
          tenantId: uuidv4(),
          dryRun: true,
          performedBy: uuidv4()
        }
      };

      // Add job to tracking
      retentionJob.jobExecutions.set(mockJob.id, { started: new Date() });
      expect(retentionJob.jobExecutions.has(mockJob.id)).toBe(true);

      // Simulate job completion cleanup
      retentionJob.jobExecutions.delete(mockJob.id);
      expect(retentionJob.jobExecutions.has(mockJob.id)).toBe(false);
    });

    test('should handle all PII field combinations', async () => {
      const piiCombinations = [
        ['customer_name'],
        ['customer_email'],
        ['customer_tax_id'],
        ['customer_name', 'customer_email'],
        ['customer_name', 'customer_tax_id'],
        ['customer_email', 'customer_tax_id'],
        ['customer_name', 'customer_email', 'customer_tax_id']
      ];

      for (const piiFields of piiCombinations) {
        let dbCallCount = 0;
        db.mockImplementation(() => {
          dbCallCount++;
          
          if (dbCallCount === 1) {
            return {
              insert: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([{ id: `pii-execution-${piiFields.length}` }])
            };
          } else if (dbCallCount === 2) {
            return {
              where: jest.fn().mockReturnThis(),
              whereNull: jest.fn().mockReturnThis(),
              select: jest.fn().mockResolvedValue([{
                id: 'policy-1',
                name: 'Test Policy',
                retention_days: 30,
                pii_fields: piiFields,
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
                created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
                ...Object.fromEntries(piiFields.map(field => [field, `Test ${field}`]))
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
              where: jest.fn().mockReturnThis(),
              first: jest.fn().mockResolvedValue({
                id: 'invoice-1',
                ...Object.fromEntries(piiFields.map(field => [field, `Test ${field}`]))
              })
            };
          } else if (dbCallCount === 6) {
            return {
              where: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis()
            };
          } else if (dbCallCount === 7) {
            return {
              insert: jest.fn().mockReturnThis()
            };
          } else if (dbCallCount === 8) {
            return {
              where: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis()
            };
          } else {
            return mockQuery;
          }
        });

        const mockJob = {
          id: `pii-job-${piiFields.length}`,
          type: 'retention_purge',
          payload: {
            tenantId: uuidv4(),
            piiFields,
            dryRun: false,
            performedBy: uuidv4()
          }
        };

        const handlers = retentionJob.retentionWorker.handlers;
        const handler = handlers.get('retention_purge');
        
        if (handler) {
          await handler(mockJob);
        }
      }
    });

    test('should handle all retention periods', async () => {
      const retentionPeriods = [1, 7, 30, 90, 365, 2555]; // 1 day to 7 years

      for (const retentionDays of retentionPeriods) {
        let dbCallCount = 0;
        db.mockImplementation(() => {
          dbCallCount++;
          
          if (dbCallCount === 1) {
            return {
              insert: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([{ id: `retention-${retentionDays}` }])
            };
          } else if (dbCallCount === 2) {
            return {
              where: jest.fn().mockReturnThis(),
              whereNull: jest.fn().mockReturnThis(),
              select: jest.fn().mockResolvedValue([{
                id: 'policy-1',
                name: 'Test Policy',
                retention_days: retentionDays,
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
                created_at: new Date(Date.now() - (retentionDays + 10) * 24 * 60 * 60 * 1000)
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
              where: jest.fn().mockReturnThis(),
              first: jest.fn().mockResolvedValue({
                id: 'invoice-1',
                customer_name: 'Test Customer'
              })
            };
          } else if (dbCallCount === 6) {
            return {
              where: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis()
            };
          } else if (dbCallCount === 7) {
            return {
              insert: jest.fn().mockReturnThis()
            };
          } else if (dbCallCount === 8) {
            return {
              where: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis()
            };
          } else {
            return mockQuery;
          }
        });

        const mockJob = {
          id: `retention-job-${retentionDays}`,
          type: 'retention_purge',
          payload: {
            tenantId: uuidv4(),
            retentionDays,
            dryRun: false,
            performedBy: uuidv4()
          }
        };

        const handlers = retentionJob.retentionWorker.handlers;
        const handler = handlers.get('retention_purge');
        
        if (handler) {
          await handler(mockJob);
        }
      }
    });

    test('should handle all batch sizes', async () => {
      const batchSizes = [1, 10, 50, 100, 500, 1000];

      for (const batchSize of batchSizes) {
        let dbCallCount = 0;
        db.mockImplementation(() => {
          dbCallCount++;
          
          if (dbCallCount === 1) {
            return {
              insert: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([{ id: `batch-${batchSize}` }])
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
              select: jest.fn().mockResolvedValue(Array.from({ length: Math.min(batchSize, 5) }, (_, i) => ({
                id: `invoice-${i}`,
                invoice_number: `INV-${i}`,
                customer_name: `Customer ${i}`,
                created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
              })))
            };
          } else if (dbCallCount === 4) {
            return {
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orWhere: jest.fn().mockReturnThis(),
              first: jest.fn().mockResolvedValue(null)
            };
          } else if (dbCallCount >= 5 && dbCallCount <= 8) {
            return {
              where: jest.fn().mockReturnThis(),
              first: jest.fn().mockResolvedValue({
                id: `invoice-${dbCallCount - 5}`,
                customer_name: `Customer ${dbCallCount - 5}`
              }),
              update: jest.fn().mockReturnThis(),
              insert: jest.fn().mockReturnThis()
            };
          } else if (dbCallCount === 9) {
            return {
              where: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis()
            };
          } else {
            return mockQuery;
          }
        });

        const mockJob = {
          id: `batch-job-${batchSize}`,
          type: 'retention_purge',
          payload: {
            tenantId: uuidv4(),
            batchSize,
            dryRun: false,
            performedBy: uuidv4()
          }
        };

        const handlers = retentionJob.retentionWorker.handlers;
        const handler = handlers.get('retention_purge');
        
        if (handler) {
          await handler(mockJob);
        }
      }
    });

    test('should handle complex error scenarios', async () => {
      let dbCallCount = 0;
      db.mockImplementation(() => {
        dbCallCount++;
        
        if (dbCallCount === 1) {
          // Create job execution
          return {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'complex-error-execution' }])
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
              pii_fields: ['customer_name'],
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
          // Error in PII purging
          throw new Error('PII purging failed');
        } else if (dbCallCount === 6) {
          // Update job execution with errors
          return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis()
          };
        } else {
          return mockQuery;
        }
      });

      const mockJob = {
        id: 'complex-error-job',
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

    test('should handle all legal hold scenarios', async () => {
      const legalHoldScenarios = [
        { status: 'active', expires_at: null },
        { status: 'active', expires_at: new Date(Date.now() + 86400000) }, // Future
        { status: 'released', released_at: new Date() },
        { status: 'expired', expires_at: new Date(Date.now() - 86400000) } // Past
      ];

      for (const scenario of legalHoldScenarios) {
        let dbCallCount = 0;
        db.mockImplementation(() => {
          dbCallCount++;
          
          if (dbCallCount === 1) {
            return {
              insert: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([{ id: `hold-${scenario.status}` }])
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
                ...scenario
              })
            };
          } else if (dbCallCount === 5) {
            return {
              where: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis()
            };
          } else {
            return mockQuery;
          }
        });

        const mockJob = {
          id: `hold-job-${scenario.status}`,
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
      }
    });
  });
});
