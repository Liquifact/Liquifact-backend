'use strict';

const { v4: uuidv4 } = require('uuid');

// Distributed per-invoice lock (issue #1213) — mocked to a pass-through so
// this suite's assertions about purge/audit behavior aren't gated on a real
// or fake Redis connection. Lock-contention behavior itself is covered by
// tests/redisLock.test.js and tests/retentionPurge.lock.test.js.
jest.mock('../src/services/redisLock');

// Mock database before importing modules
jest.mock('../src/db/knex', () => {
  const store = {
    tenants: [],
    users: [],
    retention_policies: [],
    invoices: [],
    legal_holds: [],
    retention_audit_log: [],
    retention_job_executions: []
  };

  const builders = {};
  const db = jest.fn((table) => {
    if (!builders[table]) {
      const b = {
        _filters: {},
        _updateData: null,
        _isDelete: false,
        _isFirst: false,
        _isInsert: false,
        _insertedData: [],
        _limitValue: null,
        _orderByField: null,
        _orderByDirection: null,
      };
      
      b.where = jest.fn(function(cond, op, val) {
        if (typeof cond === 'function') {
          cond.call(this);
        } else if (typeof cond === 'object') {
          this._filters = { ...this._filters, ...cond };
        } else if (typeof cond === 'string') {
          if (val !== undefined) {
            this._filters[cond] = { operator: op, value: val };
          } else {
            this._filters[cond] = op;
          }
        }
        return this;
      });
      
      b.whereNotIn = jest.fn(function(field, values) {
        return this;
      });
      b.whereNull = jest.fn(function(field) {
        this._filters[field] = null;
        return this;
      });
      b.whereIn = jest.fn(function(field, values) {
        return this;
      });
      b.whereRaw = jest.fn().mockReturnThis();
      b.leftJoin = jest.fn().mockReturnThis();
      b.orderBy = jest.fn(function(field, dir) {
        this._orderByField = field;
        this._orderByDirection = dir;
        return this;
      });
      b.limit = jest.fn(function(val) {
        this._limitValue = val;
        return this;
      });
      b.select = jest.fn(function() {
        return this;
      });
      b.first = jest.fn(function() {
        this._isFirst = true;
        return this;
      });
      b.insert = jest.fn(function(data) {
        this._isInsert = true;
        const rows = Array.isArray(data) ? data : [data];
        this._insertedData = rows.map(r => ({
          id: r.id || require('uuid').v4(),
          created_at: new Date(),
          ...r
        }));
        if (table && store[table]) {
          store[table].push(...this._insertedData);
        }
        return this;
      });
      b.update = jest.fn(function(data) {
        this._updateData = data;
        return this;
      });
      b.del = jest.fn(function() {
        this._isDelete = true;
        return this;
      });
      b.delete = jest.fn(function() {
        this._isDelete = true;
        return this;
      });
      b.andWhere = jest.fn(function(cond, op, val) {
        return this.where(cond, op, val);
      });
      b.orWhere = jest.fn().mockReturnThis();
      b.returning = jest.fn(function() {
        return this;
      });
      b.then = jest.fn(function(resolve, reject) {
        let result;
        if (this._isInsert) {
          result = this._insertedData;
        } else if (this._isDelete) {
          if (table && store[table]) {
            store[table] = [];
          }
          result = 1;
        } else if (this._updateData) {
          const rows = store[table] || [];
          let updatedCount = 0;
          rows.forEach(row => {
            const matches = Object.keys(this._filters).every(key => {
              const filterVal = this._filters[key];
              if (filterVal === null) {
                return row[key] === null || row[key] === undefined;
              }
              if (typeof filterVal === 'object' && filterVal.operator) {
                const { operator, value } = filterVal;
                if (operator === '<') return new Date(row[key]) < new Date(value);
                if (operator === '>') return new Date(row[key]) > new Date(value);
              }
              return row[key] === filterVal;
            });
            if (matches) {
              Object.assign(row, this._updateData);
              updatedCount++;
            }
          });
          result = updatedCount;
        } else {
          let data = store[table] || [];
          let filtered = data.filter(row => {
            const standardMatch = Object.keys(this._filters).every(key => {
              const filterVal = this._filters[key];
              if (filterVal === null) {
                return row[key] === null || row[key] === undefined;
              }
              if (typeof filterVal === 'object' && filterVal.operator) {
                const { operator, value } = filterVal;
                if (operator === '<') return new Date(row[key]) < new Date(value);
                if (operator === '>') return new Date(row[key]) > new Date(value);
              }
              return row[key] === filterVal;
            });
            
            if (!standardMatch) return false;
            
            if (table === 'legal_holds') {
              if (row.status !== 'active') return false;
              if (row.expires_at) {
                const expiry = new Date(row.expires_at);
                if (expiry <= new Date()) return false;
              }
            }
            
            if (table === 'invoices') {
              const holds = store.legal_holds || [];
              const hasActiveHold = holds.some(h => {
                if (h.invoice_id !== row.id || h.status !== 'active') return false;
                if (h.expires_at) {
                  const expiry = new Date(h.expires_at);
                  if (expiry <= new Date()) return false;
                }
                return true;
              });
              if (hasActiveHold) return false;
            }
            
            return true;
          });

          if (this._orderByField) {
            filtered.sort((a, b) => {
              const valA = a[this._orderByField];
              const valB = b[this._orderByField];
              if (valA < valB) return this._orderByDirection === 'desc' ? 1 : -1;
              if (valA > valB) return this._orderByDirection === 'desc' ? -1 : 1;
              return 0;
            });
          }

          if (this._limitValue !== null) {
            filtered = filtered.slice(0, this._limitValue);
          }

          result = this._isFirst ? (filtered[0] || null) : filtered;
        }
        return Promise.resolve(result).then(resolve, reject);
      });
      
      builders[table] = b;
    }
    
    const b = builders[table];
    b._filters = {};
    b._updateData = null;
    b._isDelete = false;
    b._isFirst = false;
    b._isInsert = false;
    b._insertedData = [];
    b._limitValue = null;
    b._orderByField = null;
    b._orderByDirection = null;
    return b;
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

describe('Retention Purge Job - Dry Run Tests', () => {
  let testTenantId;
  let testUserId;
  let testPolicyId;
  let oldEnvNodeEnv;

  beforeAll(async () => {
    oldEnvNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    
    // Speed up worker polling in tests
    retentionJob.retentionWorker.pollIntervalMs = 50;
    
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
      expect(auditLogs[0].old_values).toEqual({});

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

  describe('Salted Hash Snapshots (Non-Dry Run Purges)', () => {
    test('should perform real purge, nullify PII, and store salted hashes in audit log', async () => {
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 40);

      const [invoice] = await db('invoices')
        .insert({
          tenant_id: testTenantId,
          invoice_number: 'INV-HASH-001',
          amount: 150.00,
          currency: 'USD',
          customer_name: 'Jane Doe',
          customer_email: 'jane@example.com',
          customer_tax_id: 'TAX-999',
          due_date: new Date(),
          issue_date: new Date(),
          status: 'completed',
          sme_id: uuidv4(),
          created_at: createdDate
        })
        .returning('*');

      // Schedule real (destructive) purge job
      const jobId = retentionJob.scheduleRetentionPurge({
        tenantId: testTenantId,
        policyId: testPolicyId,
        dryRun: false,
        performedBy: testUserId
      });

      // Wait for job completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify invoice PII data was nullified in database
      const purgedInvoice = await db('invoices')
        .where('id', invoice.id)
        .first();

      expect(purgedInvoice.customer_name).toBeNull();
      expect(purgedInvoice.customer_email).toBeNull();
      // customer_tax_id was not in the policy PII fields (only name/email), so it should remain
      expect(purgedInvoice.customer_tax_id).toBe('TAX-999');

      // Verify audit log has the correct entry with salted hashes
      const auditLogs = await db('retention_audit_log')
        .where({
          tenant_id: testTenantId,
          invoice_id: invoice.id,
          operation: 'pii_purged'
        });

      expect(auditLogs).toHaveLength(1);
      const auditEntry = auditLogs[0];
      expect(auditEntry.pii_fields).toEqual(['customer_name', 'customer_email']);

      // Calculate expected hashes
      const expectedNameHash = retentionJob.hashPiiValue('Jane Doe', invoice.id);
      const expectedEmailHash = retentionJob.hashPiiValue('jane@example.com', invoice.id);

      // Verify hashes (not clear text) were stored
      expect(auditEntry.old_values.customer_name).toBe(expectedNameHash);
      expect(auditEntry.old_values.customer_email).toBe(expectedEmailHash);
      expect(auditEntry.old_values.customer_name).not.toBe('Jane Doe');
      expect(auditEntry.old_values.customer_email).not.toBe('jane@example.com');

      // Verify counts in metadata
      expect(auditEntry.metadata.purgedFieldsCount).toBe(2);
      expect(auditEntry.metadata.policyId).toBe(testPolicyId);
      expect(auditEntry.performed_by).toBe(testUserId);
    });
  });
});
