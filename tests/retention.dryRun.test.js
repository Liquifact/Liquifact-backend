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
    delete: jest.fn().mockResolvedValue(1),
    first: jest.fn().mockResolvedValue(null),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
  };

  // Make returning resolve to data
  mockQuery.returning.mockReturnThis();
  mockQuery.insert.mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]);
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

describe('Retention Purge Job - Dry Run Tests', () => {
  let testTenantId;
  let testUserId;
  let testPolicyId;
  let oldEnvNodeEnv;

  beforeAll(async () => {
    oldEnvNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    
    // Start retention worker for tests
    retentionJob.startQueueProcessing();
  });

  afterAll(async () => {
    process.env.NODE_ENV = oldEnvNodeEnv;
    await retentionJob.stopQueueProcessing(5000);
  });

  beforeEach(async () => {
    // Clean up test data
    await db('retention_audit_log').del();
    await db('retention_job_executions').del();
    await db('legal_holds').del();
    await db('retention_policies').del();
    await db('invoices').del();
    await db('users').del();
    await db('tenants').del();

    // Create test tenant
    const [tenant] = await db('tenants')
      .insert({
        name: 'Test Tenant',
        slug: 'test-tenant-' + Date.now(),
        status: 'active'
      })
      .returning('*');
    testTenantId = tenant.id;

    // Create test user
    const [user] = await db('users')
      .insert({
        tenant_id: testTenantId,
        email: 'test@example.com',
        password_hash: 'hashed_password',
        first_name: 'Test',
        last_name: 'User',
        role: 'admin'
      })
      .returning('*');
    testUserId = user.id;

    // Create test retention policy
    const [policy] = await db('retention_policies')
      .insert({
        tenant_id: testTenantId,
        name: 'Test Policy',
        description: 'Test retention policy',
        retention_days: 30,
        pii_fields: ['customer_name', 'customer_email'],
        is_active: true
      })
      .returning('*');
    testPolicyId = policy.id;
  });

  describe('Dry Run Functionality', () => {
    test('should perform dry run without modifying data', async () => {
      // Create test invoice with PII data
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 40); // Older than retention period

      const [invoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-001',
          amount: 1000.00,
          currency: 'USD',
          customer_name: 'Test Customer',
          customer_email: 'customer@example.com',
          customer_tax_id: 'TAX-123',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: createdDate
        })
        .returning('*');

      // Schedule dry run job
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: true,
        performedBy: testUserId
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify invoice data is unchanged
      const unchangedInvoice = await db('invoices')
        .where('id', invoice.id)
        .first();

      expect(unchangedInvoice.customer_name).toBe('Test Customer');
      expect(unchangedInvoice.customer_email).toBe('customer@example.com');
      expect(unchangedInvoice.customer_tax_id).toBe('TAX-123');

      // Verify audit log shows dry run
      const auditLogs = await db('retention_audit_log')
        .where({ 
          tenant_id: testTenantId,
          invoice_id: invoice.id,
          operation: 'dry_run'
        });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].pii_fields).toEqual(['customer_name', 'customer_email']);

      // Verify job execution record
      const executions = await db('retention_job_executions')
        .where({ 
          tenant_id: testTenantId,
          dry_run: true
        });

      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('completed');
      expect(executions[0].invoices_processed).toBe(1);
      expect(executions[0].invoices_purged).toBe(1);
    });

    test('should respect legal holds during dry run', async () => {
      // Create test invoice
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 40);

      const [invoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-002',
          amount: 2000.00,
          currency: 'USD',
          customer_name: 'Held Customer',
          customer_email: 'held@example.com',
          customer_tax_id: 'HELD-456',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: createdDate
        })
        .returning('*');

      // Place legal hold on invoice
      await db('legal_holds')
        .insert({
          tenant_id: testTenantId,
          invoice_id: invoice.id,
          hold_reason: 'Legal investigation',
          hold_type: 'litigation',
          status: 'active',
          placed_by: testUserId
        });

      // Schedule dry run job
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: true,
        performedBy: testUserId
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify invoice was not processed
      const auditLogs = await db('retention_audit_log')
        .where({ 
          tenant_id: testTenantId,
          invoice_id: invoice.id
        });

      expect(auditLogs).toHaveLength(0);

      // Verify job execution shows no invoices processed
      const executions = await db('retention_job_executions')
        .where({ 
          tenant_id: testTenantId,
          dry_run: true
        });

      expect(executions).toHaveLength(1);
      expect(executions[0].invoices_processed).toBe(0);
      expect(executions[0].invoices_purged).toBe(0);
    });

    test('should only process invoices older than retention period', async () => {
      // Create old invoice (should be processed)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);

      const [oldInvoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-003',
          amount: 3000.00,
          currency: 'USD',
          customer_name: 'Old Customer',
          customer_email: 'old@example.com',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: oldDate
        })
        .returning('*');

      // Create recent invoice (should not be processed)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 10);

      const [recentInvoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-004',
          amount: 4000.00,
          currency: 'USD',
          customer_name: 'Recent Customer',
          customer_email: 'recent@example.com',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: recentDate
        })
        .returning('*');

      // Schedule dry run job
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: true,
        performedBy: testUserId
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify only old invoice was processed
      const auditLogs = await db('retention_audit_log')
        .where({ tenant_id: testTenantId, operation: 'dry_run' });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].invoice_id).toBe(oldInvoice.id);

      // Verify job execution shows correct counts
      const executions = await db('retention_job_executions')
        .where({ 
          tenant_id: testTenantId,
          dry_run: true
        });

      expect(executions).toHaveLength(1);
      expect(executions[0].invoices_processed).toBe(1);
      expect(executions[0].invoices_purged).toBe(1);
    });

    test('should validate PII fields and reject invalid ones', async () => {
      expect(() => {
        retentionJob.validatePiiFields(['invalid_field', 'customer_name']);
      }).toThrow('Invalid PII fields');

      expect(() => {
        retentionJob.validatePiiFields(['customer_name', 'customer_email', 'customer_tax_id']);
      }).not.toThrow();
    });

    test('should handle batch size limits in dry run', async () => {
      // Create multiple invoices
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 40);

      const invoiceIds = [];
      for (let i = 0; i < 5; i++) {
        const [invoice] = await db('invoices')
          .insert({
            tenant_id: testTenantId,
            invoice_number: `INV-BATCH-${i}`,
            amount: 1000.00 + i,
            currency: 'USD',
            customer_name: `Customer ${i}`,
            customer_email: `customer${i}@example.com`,
            due_date: new Date(),
            issue_date: new Date(),
            status: 'completed',
            sme_id: uuidv4(),
            created_at: createdDate
          })
          .returning('*');
        invoiceIds.push(invoice.id);
      }

      // Schedule dry run job with small batch size
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: true,
        performedBy: testUserId,
        batchSize: 2
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify only batch size number of invoices were processed
      const executions = await db('retention_job_executions')
        .where({ 
          tenant_id: testTenantId,
          dry_run: true
        });

      expect(executions).toHaveLength(1);
      expect(executions[0].invoices_processed).toBeLessThanOrEqual(2);
    });
  });

  describe('Legal Hold Integration', () => {
    test('should detect active legal holds', async () => {
      const [invoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-HOLD-001',
          amount: 1000.00,
          currency: 'USD',
          customer_name: 'Test Customer',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4()
        })
        .returning('*');

      // No hold initially
      const underHold1 = await retentionJob.isUnderLegalHold(testTenantId, invoice.id);
      expect(underHold1).toBe(false);

      // Add active hold
      await db('legal_holds')
        .insert({
          tenant_id: testTenantId,
          invoice_id: invoice.id,
          hold_reason: 'Test hold',
          hold_type: 'litigation',
          status: 'active',
          placed_by: testUserId
        });

      const underHold2 = await retentionJob.isUnderLegalHold(testTenantId, invoice.id);
      expect(underHold2).toBe(true);

      // Release hold
      await db('legal_holds')
        .where({ invoice_id: invoice.id })
        .update({ status: 'released', released_at: new Date() });

      const underHold3 = await retentionJob.isUnderLegalHold(testTenantId, invoice.id);
      expect(underHold3).toBe(false);
    });

    test('should respect expired holds', async () => {
      const [invoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-HOLD-002',
          amount: 1000.00,
          currency: 'USD',
          customer_name: 'Test Customer',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4()
        })
        .returning('*');

      // Add expired hold
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1);

      await db('legal_holds')
        .insert({
          tenant_id: testTenantId,
          invoice_id: invoice.id,
          hold_reason: 'Expired hold',
          hold_type: 'litigation',
          status: 'active',
          expires_at: expiredDate,
          placed_by: testUserId
        });

      const underHold = await retentionJob.isUnderLegalHold(testTenantId, invoice.id);
      expect(underHold).toBe(false);
    });
  });

  describe('Policy Management', () => {
    test('should get active policies for tenant', async () => {
      const policies = await retentionJob.getActivePolicies(testTenantId);
      expect(policies).toHaveLength(1);
      expect(policies[0].id).toBe(testPolicyId);
      expect(policies[0].is_active).toBe(true);

      // Create inactive policy
      await db('retention_policies')
        .insert({
          tenant_id: testTenantId,
          name: 'Inactive Policy',
          retention_days: 60,
          pii_fields: ['customer_name'],
          is_active: false
        });

      const policies2 = await retentionJob.getActivePolicies(testTenantId);
      expect(policies2).toHaveLength(1); // Still only active policy
    });

    test('should get eligible invoices based on policy', async () => {
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 40);

      // Create eligible invoice
      const [eligibleInvoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-ELIGIBLE',
          amount: 1000.00,
          currency: 'USD',
          customer_name: 'Eligible Customer',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: createdDate
        })
        .returning('*');

      // Create non-eligible invoice (too recent)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 10);

      const [nonEligibleInvoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-RECENT',
          amount: 2000.00,
          currency: 'USD',
          customer_name: 'Recent Customer',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: recentDate
        })
        .returning('*');

      const policy = {
        retention_days: 30,
        pii_fields: ['customer_name', 'customer_email']
      };

      const eligibleInvoices = await retentionJob.getEligibleInvoices(testTenantId, policy, 100);
      expect(eligibleInvoices).toHaveLength(1);
      expect(eligibleInvoices[0].id).toBe(eligibleInvoice.id);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid policy ID', async () => {
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: uuidv4(), // Non-existent policy
        dryRun: true,
        performedBy: testUserId
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      const executions = await db('retention_job_executions')
        .where({ tenant_id: testTenantId });

      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('failed');
    });

    test('should handle database errors gracefully', async () => {
      // Mock database error
      const originalQuery = db('invoices').where;
      db('invoices').where = jest.fn().mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: true,
        performedBy: testUserId
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Restore original method
      db('invoices').where = originalQuery;

      const executions = await db('retention_job_executions')
        .where({ tenant_id: testTenantId });

      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('failed');
      expect(executions[0].errors).not.toBeNull();
    });
  });

  describe('Job Management', () => {
    test('should cancel scheduled job', async () => {
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: true,
        performedBy: testUserId,
        delayMs: 5000 // Delay to allow cancellation
      });

      const cancelled = retentionJob.cancelRetentionJob(jobId);
      expect(cancelled).toBe(true);

      // Verify job was removed from tracking
      expect(retentionJob.jobExecutions.has(jobId)).toBe(false);
    });

    test('should get execution status', async () => {
      const [execution] = await db('retention_job_executions')
        .insert({
          tenant_id: testTenantId,
          job_type: 'manual_purge',
          status: 'completed',
          dry_run: false,
          invoices_processed: 5,
          invoices_purged: 3,
          performed_by: testUserId
        })
        .returning('*');

      const status = await retentionJob.getExecutionStatus(execution.id);
      expect(status).toBeDefined();
      expect(status.id).toBe(execution.id);
      expect(status.status).toBe('completed');
      expect(status.invoices_processed).toBe(5);
    });

    test('should get recent executions', async () => {
      // Create multiple executions
      for (let i = 0; i < 3; i++) {
        await db('retention_job_executions')
          .insert({
            tenant_id: testTenantId,
            job_type: 'scheduled_purge',
            status: 'completed',
            dry_run: i % 2 === 0,
            invoices_processed: i + 1,
            performed_by: testUserId
          });
      }

      const executions = await retentionJob.getRecentExecutions(testTenantId, 2);
      expect(executions).toHaveLength(2);
      expect(executions[0].dry_run).toBe(true); // Most recent
    });
  });
});
