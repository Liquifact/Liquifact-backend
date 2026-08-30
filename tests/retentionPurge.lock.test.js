'use strict';

/**
 * @fileoverview Integration tests for the per-invoice distributed lock
 * wired into src/jobs/retentionPurge.js (issue #1213).
 *
 * Unlike the other retention.*.test.js files, this suite does NOT use the
 * pass-through redisLock mock — it provides its own controllable
 * `createRedisLockService` mock so specific invoices' locks can be made to
 * behave as "already held by another worker" or "lost mid-purge", and
 * asserts the job correctly skips/flags those invoices while still
 * processing the rest of the batch normally. This is the "authorization"
 * angle for this feature: only the worker holding a resource's lock token
 * may act on it, and this test proves a worker that does not hold the lock
 * for a given invoice never purges it.
 */

const { v4: uuidv4 } = require('uuid');

let lockBehavior; // per-test override map: resourceKey -> 'held' | 'lost' | undefined (normal)

jest.mock('../src/services/redisLock', () => {
  const actual = jest.requireActual('../src/services/redisLock');
  return {
    RedisLockError: actual.RedisLockError,
    buildResourceKey: actual.buildResourceKey,
    createRedisLockService: () => ({
      buildResourceKey: actual.buildResourceKey,
      acquire: jest.fn(),
      renew: jest.fn(),
      release: jest.fn(),
      withLock: jest.fn(async ({ resourceKey }, fn) => {
        const behavior = lockBehavior[resourceKey];
        if (behavior === 'held') {
          return { executed: false, reason: 'lock_held' };
        }
        if (behavior === 'lost') {
          throw new actual.RedisLockError('LOCK_LOST', 'Distributed lock lost during critical section (lost).');
        }
        if (behavior === 'unavailable') {
          throw new actual.RedisLockError('LOCK_UNAVAILABLE', 'Redis is not available for distributed locking.');
        }
        const result = await fn({ checkLock: () => {} });
        return { executed: true, result };
      }),
    }),
  };
});

// Mock database (same minimal in-memory store shape used by the other
// retention test files).
jest.mock('../src/db/knex', () => {
  const store = {
    tenants: [],
    users: [],
    retention_policies: [],
    invoices: [],
    legal_holds: [],
    retention_audit_log: [],
    retention_job_executions: [],
  };

  const builders = {};
  const db = jest.fn((table) => {
    if (!builders[table]) {
      const b = {
        _filters: {}, _updateData: null, _isDelete: false, _isFirst: false,
        _isInsert: false, _insertedData: [], _limitValue: null,
        _orderByField: null, _orderByDirection: null,
      };
      b.where = jest.fn(function where(cond, op, val) {
        if (typeof cond === 'function') { cond.call(this); }
        else if (typeof cond === 'object') { this._filters = { ...this._filters, ...cond }; }
        else if (typeof cond === 'string') { this._filters[cond] = val !== undefined ? { operator: op, value: val } : op; }
        return this;
      });
      b.whereNotIn = jest.fn(function whereNotIn() { return this; });
      b.whereNull = jest.fn(function whereNull(field) { this._filters[field] = null; return this; });
      b.whereIn = jest.fn(function whereIn() { return this; });
      b.whereRaw = jest.fn().mockReturnThis();
      b.leftJoin = jest.fn().mockReturnThis();
      b.orderBy = jest.fn(function orderBy(field, dir) { this._orderByField = field; this._orderByDirection = dir; return this; });
      b.limit = jest.fn(function limit(val) { this._limitValue = val; return this; });
      b.select = jest.fn(function select() { return this; });
      b.first = jest.fn(function first() { this._isFirst = true; return this; });
      b.insert = jest.fn(function insert(data) {
        this._isInsert = true;
        const rows = Array.isArray(data) ? data : [data];
        this._insertedData = rows.map((r) => ({ id: r.id || uuidv4(), created_at: new Date(), ...r }));
        if (table && store[table]) { store[table].push(...this._insertedData); }
        return this;
      });
      b.update = jest.fn(function update(data) { this._updateData = data; return this; });
      b.del = jest.fn(function del() { this._isDelete = true; return this; });
      b.delete = jest.fn(function del() { this._isDelete = true; return this; });
      b.andWhere = jest.fn(function andWhere(cond, op, val) { return this.where(cond, op, val); });
      b.orWhere = jest.fn().mockReturnThis();
      b.returning = jest.fn(function returning() { return this; });
      b.then = jest.fn(function then(resolve, reject) {
        let result;
        if (this._isInsert) {
          result = this._insertedData;
        } else if (this._isDelete) {
          if (table && store[table]) { store[table] = []; }
          result = 1;
        } else if (this._updateData) {
          const rows = store[table] || [];
          let updatedCount = 0;
          rows.forEach((row) => {
            const matches = Object.keys(this._filters).every((key) => {
              const fv = this._filters[key];
              if (fv === null) { return row[key] === null || row[key] === undefined; }
              return row[key] === fv;
            });
            if (matches) { Object.assign(row, this._updateData); updatedCount += 1; }
          });
          result = updatedCount;
        } else {
          const data = store[table] || [];
          let filtered = data.filter((row) => Object.keys(this._filters).every((key) => {
            const fv = this._filters[key];
            if (fv === null) { return row[key] === null || row[key] === undefined; }
            if (typeof fv === 'object' && fv.operator) {
              if (fv.operator === '<') { return new Date(row[key]) < new Date(fv.value); }
              if (fv.operator === '>') { return new Date(row[key]) > new Date(fv.value); }
            }
            return row[key] === fv;
          }));
          if (this._limitValue !== null) { filtered = filtered.slice(0, this._limitValue); }
          result = this._isFirst ? (filtered[0] || null) : filtered;
        }
        return Promise.resolve(result).then(resolve, reject);
      });
      builders[table] = b;
    }
    const b = builders[table];
    b._filters = {}; b._updateData = null; b._isDelete = false; b._isFirst = false;
    b._isInsert = false; b._insertedData = []; b._limitValue = null;
    b._orderByField = null; b._orderByDirection = null;
    return b;
  });
  db.raw = jest.fn();
  return db;
});

jest.mock('../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../src/db/knex');
const retentionJob = require('../src/jobs/retentionPurge');
const { buildResourceKey } = require('../src/services/redisLock');

describe('retentionPurge.js: per-invoice distributed lock (issue #1213)', () => {
  let testTenantId;
  let testUserId;
  let testPolicyId;

  beforeAll(() => {
    retentionJob.retentionWorker.pollIntervalMs = 20;
    retentionJob.startQueueProcessing();
  });

  afterAll(async () => {
    await retentionJob.stopQueueProcessing(5000);
  });

  beforeEach(async () => {
    lockBehavior = {};
    await db('retention_audit_log').del();
    await db('retention_job_executions').del();
    await db('legal_holds').del();
    await db('retention_policies').del();
    await db('invoices').del();
    await db('users').del();
    await db('tenants').del();

    const [tenant] = await db('tenants').insert({ name: 'Test Tenant', slug: `t-${Date.now()}`, status: 'active' }).returning('*');
    testTenantId = tenant.id;
    const [user] = await db('users').insert({ tenant_id: testTenantId, email: 'a@b.com', role: 'admin' }).returning('*');
    testUserId = user.id;
    const [policy] = await db('retention_policies').insert({
      tenant_id: testTenantId, name: 'P', retention_days: 30, pii_fields: ['customer_name', 'customer_email'], is_active: true,
    }).returning('*');
    testPolicyId = policy.id;
  });

  function oldInvoice(overrides = {}) {
    const createdDate = new Date();
    createdDate.setDate(createdDate.getDate() - 40);
    return {
      tenant_id: testTenantId,
      invoice_number: overrides.invoice_number || 'INV-LOCK',
      amount: 1000, currency: 'USD',
      customer_name: 'Jane Doe', customer_email: 'jane@example.com',
      due_date: new Date(), issue_date: new Date(), status: 'completed',
      sme_id: uuidv4(), created_at: createdDate,
      ...overrides,
    };
  }

  it('skips an invoice whose lock is already held by another worker, without erroring the job', async () => {
    const [invoice] = await db('invoices').insert(oldInvoice()).returning('*');
    const lockKey = buildResourceKey('invoice', testTenantId, invoice.id);
    lockBehavior[lockKey] = 'held';

    retentionJob.scheduleRetentionPurge({ tenantId: testTenantId, policyId: testPolicyId, dryRun: false, performedBy: testUserId });
    await new Promise((r) => setTimeout(r, 300));

    const unchanged = await db('invoices').where('id', invoice.id).first();
    expect(unchanged.customer_name).toBe('Jane Doe'); // never purged — lock was held elsewhere

    const executions = await db('retention_job_executions').where({ tenant_id: testTenantId });
    expect(executions[0].status).toBe('completed'); // the job itself did not fail
    expect(executions[0].invoices_purged).toBe(0);
  });

  it('processes the rest of the batch normally when only one invoice is lock-contended', async () => {
    const [heldInvoice] = await db('invoices').insert(oldInvoice({ invoice_number: 'INV-HELD' })).returning('*');
    const [freeInvoice] = await db('invoices').insert(oldInvoice({ invoice_number: 'INV-FREE' })).returning('*');
    lockBehavior[buildResourceKey('invoice', testTenantId, heldInvoice.id)] = 'held';

    retentionJob.scheduleRetentionPurge({ tenantId: testTenantId, policyId: testPolicyId, dryRun: false, performedBy: testUserId });
    await new Promise((r) => setTimeout(r, 300));

    const held = await db('invoices').where('id', heldInvoice.id).first();
    const free = await db('invoices').where('id', freeInvoice.id).first();
    expect(held.customer_name).toBe('Jane Doe'); // untouched
    expect(free.customer_name).toBeNull(); // purged normally
  });

  it('flags (does not silently succeed) an invoice whose lock is lost mid-purge', async () => {
    const [invoice] = await db('invoices').insert(oldInvoice()).returning('*');
    const lockKey = buildResourceKey('invoice', testTenantId, invoice.id);
    lockBehavior[lockKey] = 'lost';

    retentionJob.scheduleRetentionPurge({ tenantId: testTenantId, policyId: testPolicyId, dryRun: false, performedBy: testUserId });
    await new Promise((r) => setTimeout(r, 300));

    const executions = await db('retention_job_executions').where({ tenant_id: testTenantId });
    expect(executions[0].status).toBe('completed_with_errors');
  });

  it('fails closed (skips, does not purge unprotected) when the lock service itself is unavailable', async () => {
    const [invoice] = await db('invoices').insert(oldInvoice()).returning('*');
    const lockKey = buildResourceKey('invoice', testTenantId, invoice.id);
    lockBehavior[lockKey] = 'unavailable';

    retentionJob.scheduleRetentionPurge({ tenantId: testTenantId, policyId: testPolicyId, dryRun: false, performedBy: testUserId });
    await new Promise((r) => setTimeout(r, 300));

    const unchanged = await db('invoices').where('id', invoice.id).first();
    expect(unchanged.customer_name).toBe('Jane Doe'); // never purged without lock protection

    const executions = await db('retention_job_executions').where({ tenant_id: testTenantId });
    expect(executions[0].status).toBe('completed_with_errors');
  });

  it('tenant isolation: two tenants\' invoices never share a lock key even with the same invoice id shape', () => {
    const keyA = buildResourceKey('invoice', 'tenant-a', 'inv-1');
    const keyB = buildResourceKey('invoice', 'tenant-b', 'inv-1');
    expect(keyA).not.toBe(keyB);
  });
});
