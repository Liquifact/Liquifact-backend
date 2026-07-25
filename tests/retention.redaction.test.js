'use strict';

const { v4: uuidv4 } = require('uuid');

// Mock database similar to retention.dryRun.test.js but expose store via queries
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

      // basic query builder methods
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
      b.whereNotIn = jest.fn().mockReturnThis();
      b.whereNull = jest.fn(function(field) {
        this._filters[field] = null;
        return this;
      });
      b.whereIn = jest.fn().mockReturnThis();
      b.andWhere = jest.fn(function(cond, op, val) { return this.where(cond, op, val); });
      b.orWhere = jest.fn().mockReturnThis();
      b.limit = jest.fn(function(val) { this._limitValue = val; return this; });
      b.orderBy = jest.fn(function(field, dir) { this._orderByField = field; this._orderByDirection = dir; return this; });
      b.select = jest.fn().mockResolvedValue([]);
      b.first = jest.fn().mockResolvedValue(null);
      b.insert = jest.fn(function(data) {
        this._isInsert = true;
        const rows = Array.isArray(data) ? data : [data];
        this._insertedData = rows.map(r => ({ id: r.id || require('uuid').v4(), created_at: new Date(), ...r }));
        if (store[table]) store[table].push(...this._insertedData);
        return this;
      });
      b.update = jest.fn(function(data) { this._updateData = data; return this; });
      b.del = jest.fn().mockReturnThis();
      b.delete = jest.fn().mockReturnThis();
      b.returning = jest.fn().mockReturnThis();
      b.then = jest.fn(function(resolve, reject) {
        let result;
        if (this._isInsert) {
          result = this._insertedData;
        } else if (this._isDelete) {
          if (store[table]) store[table] = [];
          result = 1;
        } else if (this._updateData) {
          const rows = store[table] || [];
          let updated = 0;
          rows.forEach(row => {
            const matches = Object.keys(this._filters).every(key => {
              const filterVal = this._filters[key];
              if (filterVal === null) return row[key] === null || row[key] === undefined;
              if (typeof filterVal === 'object' && filterVal.operator) {
                const { operator, value } = filterVal;
                if (operator === '<') return new Date(row[key]) < new Date(value);
                if (operator === '>') return new Date(row[key]) > new Date(value);
              }
              return row[key] === filterVal;
            });
            if (matches) {
              Object.assign(row, this._updateData);
              updated++;
            }
          });
          result = updated;
        } else {
          // select
          let data = store[table] || [];
          const filtered = data.filter(row => {
            const standardMatch = Object.keys(this._filters).every(key => {
              const filterVal = this._filters[key];
              if (filterVal === null) return row[key] === null || row[key] === undefined;
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
              if (row.expires_at && new Date(row.expires_at) <= new Date()) return false;
            }
            if (table === 'invoices') {
              const holds = store.legal_holds || [];
              const hasActiveHold = holds.some(h => h.invoice_id === row.id && h.status === 'active' && (!h.expires_at || new Date(h.expires_at) > new Date()));
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
          const final = this._limitValue !== null ? filtered.slice(0, this._limitValue) : filtered;
          result = this._isFirst ? (final[0] || null) : final;
        }
        return Promise.resolve(result).then(resolve, reject);
      });

      builders[table] = b;
    }
    const b = builders[table];
    // reset per-call state
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

// Mock logger to silence output
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

describe('Retention Redaction and Validation Tests', () => {
  let testTenantId;
  let testUserId;
  let testPolicyId;
  let oldEnvNodeEnv;

  beforeAll(async () => {
    oldEnvNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    // Speed up polling for tests
    retentionJob.retentionWorker.pollIntervalMs = 50;
    retentionJob.startQueueProcessing();
  });

  afterAll(async () => {
    process.env.NODE_ENV = oldEnvNodeEnv;
    await retentionJob.stopQueueProcessing(5000);
  });

  beforeEach(async () => {
    // clean tables
    await db('retention_audit_log').del();
    await db('retention_job_executions').del();
    await db('legal_holds').del();
    await db('retention_policies').del();
    await db('invoices').del();
    await db('users').del();
    await db('tenants').del();

    const [tenant] = await db('tenants').insert({
      name: 'Test Tenant',
      slug: 'test-tenant-' + Date.now(),
      status: 'active'
    }).returning('*');
    testTenantId = tenant.id;

    const [user] = await db('users').insert({
      tenant_id: testTenantId,
      email: 'test@example.com',
      password_hash: 'hashed',
      first_name: 'Test',
      last_name: 'User',
      role: 'admin'
    }).returning('*');
    testUserId = user.id;

    const [policy] = await db('retention_policies').insert({
      tenant_id: testTenantId,
      name: 'Test Policy',
      description: 'Test policy',
      retention_days: 30,
      pii_fields: ['customer_name', 'customer_email'],
      is_active: true
    }).returning('*');
    testPolicyId = policy.id;
  });

  test('should redact only fields specified in piiFields', async () => {
    const [invoice] = await db('invoices').insert({
      tenant_id: testTenantId,
      invoice_number: 'INV-RED',
      amount: 1000,
      currency: 'USD',
      customer_name: 'Name',
      customer_email: 'email@example.com',
      customer_tax_id: 'TAX-999',
      due_date: new Date(),
      issue_date: new Date(),
      status: 'completed',
      sme_id: uuidv4(),
      created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    }).returning('*');

    retentionJob.scheduleRetentionPurge({
      tenantId: testTenantId,
      policyId: testPolicyId,
      dryRun: false,
      performedBy: testUserId,
      piiFields: ['customer_tax_id']
    });

    await new Promise(r => setTimeout(r, 1000));

    const updated = await db('invoices').where('id', invoice.id).first();
    expect(updated.customer_name).toBe('Name');
    expect(updated.customer_email).toBe('email@example.com');
    expect(updated.customer_tax_id).toBeNull();
  });

  test('should reject non-UUID tenant IDs', async () => {
    retentionJob.scheduleRetentionPurge({
      tenantId: 'not-a-uuid',
      policyId: testPolicyId,
      dryRun: true,
      performedBy: testUserId
    });
    await new Promise(r => setTimeout(r, 1000));
    const executions = await db('retention_job_executions').where({ tenant_id: 'not-a-uuid' });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('failed');
  });

  test('should reject non-positive retentionDays', async () => {
    retentionJob.scheduleRetentionPurge({
      tenantId: testTenantId,
      policyId: testPolicyId,
      dryRun: true,
      performedBy: testUserId,
      retentionDays: 0
    });
    await new Promise(r => setTimeout(r, 1000));
    const executions = await db('retention_job_executions').where({ tenant_id: testTenantId });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('failed');
  });
});
