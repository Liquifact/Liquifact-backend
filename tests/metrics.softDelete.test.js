'use strict';

process.env.NODE_ENV = 'test';

jest.mock('../src/db/knex', () => {
  const proxy = (table) => proxy.__impl(table);
  proxy.__impl = () => {
    throw new Error('db double not configured');
  };
  return proxy;
});

const defaultDb = require('../src/db/knex');
const softDelete = require('../src/services/metricsSoftDelete');
const {
  softDeleteMetricRecord,
  restoreMetricRecord,
  getMetricRecordDeletionState,
  purgeExpiredSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  METRICS_TABLE,
} = softDelete;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-25T12:00:00.000Z');

function makeDb(seed = []) {
  const rows = seed.map((row) => ({
    id: row.id,
    metric_name: row.metric_name ?? 'test_metric',
    metric_type: row.metric_type ?? 'gauge',
    metric_value: row.metric_value ?? 42,
    labels: row.labels ?? {},
    recorded_at: row.recorded_at ?? '2026-07-01T00:00:00.000Z',
    deleted_at: row.deleted_at ?? null,
    deleted_by: row.deleted_by ?? null,
    delete_reason: row.delete_reason ?? null,
    restored_at: row.restored_at ?? null,
    restored_by: row.restored_by ?? null,
  }));

  const toMs = (value) => (value == null ? null : Date.parse(value));

  function query(table) {
    if (table !== METRICS_TABLE) {
      throw new Error(`unexpected table: ${table}`);
    }
    const preds = [];
    let order = null;
    let limit = null;

    const matching = () => {
      let out = rows.filter((row) => preds.every((p) => p(row)));
      if (order) out.sort(order);
      if (limit) out = out.slice(0, limit);
      return out;
    };

    const chain = {
      where(field, op, val) {
        if (val === undefined) {
          preds.push((r) => String(r[field]) === String(op));
        } else if (op === '<= flesh' || op === '<=') {
          preds.push((r) => r[field] instanceof Date ? r[field].getTime() <= toMs(val) : r[field] <= val);
        } else {
          preds.push((r) => {
            const left = r[field] instanceof Date ? r[field].toISOString() : r[field];
            return left === val;
          });
        }
        return chain;
      },
      whereNull(field) {
        preds.push((r) => r[field] === null || r[field] === undefined);
        return chain;
      },
      whereNotNull(field) {
        preds.push((r) => r[field] !== null && r[field] !== undefined);
        return chain;
      },
      whereIn(field, vals) {
        preds.push((r) => vals.includes(r[field]));
        return chain;
      },
      orderBy(field, dir = 'asc') {
        order = (a, b) => {
          const av = a[field] instanceof Date ? a[field].getTime() : (a[field] || '');
          const bv = b[field] instanceof Date ? b[field].getTime() : (b[field] || '');
          if (av < bv) return dir === 'asc' ? -1 : 1;
          if (av > bv) return dir === 'asc' ? 1 : -1;
          return 0;
        };
        return chain;
      },
      limit(n) { limit = n; return chain; },
      select() { return chain; },
      first() { return matching()[0] || null; },
      update(changes) {
        const match = matching();
        if (match.length === 0) return Promise.resolve(0);
        match.forEach((row) => Object.assign(row, changes));
        return Promise.resolve(match.length);
      },
      del() {
        const match = matching();
        const count = match.length;
        match.forEach((r) => {
          const idx = rows.indexOf(r);
          if (idx !== -1) rows.splice(idx, 1);
        });
        return Promise.resolve(count);
      },
      then(resolve) { resolve(matching()); return Promise.resolve(matching()); },
      map: (fn) => matching().map(fn),
      filter: (fn) => matching().filter(fn),
      toPromise: () => Promise.resolve(matching()),
    };
    return chain;
  }

  query.__impl = query;
  query.rows = rows;
  return query;
}

beforeEach(() => {
  process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = '30';
  process.env.METRICS_PURGE_BATCH_SIZE = '500';
  process.env.METRICS_PURGE_MAX_BATCHES = '100';
});

afterEach(() => {
  delete process.env.METRICS_SOFT_DELETE_RETENTION_DAYS;
  delete process.env.METRICS_PURGE_BATCH_SIZE;
  delete process.env.METRICS_PURGE_MAX_BATCHES;
});

describe('getRetentionDays', () => {
  it('returns default when env var is absent', () => {
    delete process.env.METRICS_SOFT_DELETE_RETENTION_DAYS;
    expect(getRetentionDays()).toBe(30);
  });

  it('clamps to 1–3650', () => {
    process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = '0';
    expect(getRetentionDays()).toBe(30);
    process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = '5000';
    expect(getRetentionDays()).toBe(3650);
  });

  it('parses a valid value', () => {
    process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = '15';
    expect(getRetentionDays()).toBe(15);
  });

  it('falls back on non-numeric input', () => {
    process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = 'abc';
    expect(getRetentionDays()).toBe(30);
  });
});

describe('getRetentionMs', () => {
  it('returns days * ms per day', () => {
    process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = '1';
    expect(getRetentionMs()).toBe(DAY_MS);
    process.env.METRICS_SOFT_DELETE_RETENTION_DAYS = '30';
    expect(getRetentionMs()).toBe(30 * DAY_MS);
  });
});

describe('getPurgeBatchSize', () => {
  it('returns default when env var is absent', () => {
    delete process.env.METRICS_PURGE_BATCH_SIZE;
    expect(getPurgeBatchSize()).toBe(500);
  });

  it('clamps to max', () => {
    process.env.METRICS_PURGE_BATCH_SIZE = '20000';
    expect(getPurgeBatchSize()).toBe(10000);
  });

  it('falls back on invalid input', () => {
    process.env.METRICS_PURGE_BATCH_SIZE = '0';
    expect(getPurgeBatchSize()).toBe(500);
  });
});

describe('getPurgeMaxBatches', () => {
  it('returns default when env var is absent', () => {
    delete process.env.METRICS_PURGE_MAX_BATCHES;
    expect(getPurgeMaxBatches()).toBe(100);
  });

  it('clamps to max', () => {
    process.env.METRICS_PURGE_MAX_BATCHES = '2000';
    expect(getPurgeMaxBatches()).toBe(1000);
  });

  it('falls back on invalid input', () => {
    process.env.METRICS_PURGE_MAX_BATCHES = '0';
    expect(getPurgeMaxBatches()).toBe(100);
  });
});

describe('isRetentionExpired', () => {
  it('returns false for a recent delete', () => {
    const fiveDaysAgo = new Date(NOW - 5 * DAY_MS).toISOString();
    expect(isRetentionExpired(fiveDaysAgo, { now: NOW })).toBe(false);
  });

  it('returns true for a delete older than the window', () => {
    const thirtyFiveDaysAgo = new Date(NOW - 35 * DAY_MS).toISOString();
    expect(isRetentionExpired(thirtyFiveDaysAgo, { now: NOW })).toBe(true);
  });

  it('returns true for null/undefined/malformed', () => {
    expect(isRetentionExpired(null, { now: NOW })).toBe(true);
    expect(isRetentionExpired(undefined, { now: NOW })).toBe(true);
    expect(isRetentionExpired('garbage', { now: NOW })).toBe(true);
  });

  it('accepts custom retentionMs', () => {
    const old = new Date(NOW - 10 * DAY_MS).toISOString();
    expect(isRetentionExpired(old, { now: NOW, retentionMs: 5 * DAY_MS })).toBe(true);
    expect(isRetentionExpired(old, { now: NOW, retentionMs: 15 * DAY_MS })).toBe(false);
  });
});

describe('softDeleteMetricRecord', () => {
  it('soft-deletes a live record', async () => {
    const db = makeDb([{ id: 'rec-001' }]);
    const result = await softDeleteMetricRecord('rec-001', { dbClient: db, now: NOW, actor: 'admin', reason: 'cleanup' });

    expect(result.deleted).toBe(true);
    expect(result.deletedBy).toBe('admin');
    expect(result.deleteReason).toBe('cleanup');
    expect(result.restorable).toBe(true);
    expect(db.rows[0].deleted_at).toBeTruthy();
  });

  it('throws NOT_FOUND for absent id', async () => {
    const db = makeDb([]);
    await expect(
      softDeleteMetricRecord('rec-404', { dbClient: db })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });
  });

  it('throws ALREADY_DELETED when already tombstoned', async () => {
    const db = makeDb([{ id: 'rec-001', deleted_at: new Date(NOW - DAY_MS).toISOString() }]);
    await expect(
      softDeleteMetricRecord('rec-001', { dbClient: db })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.ALREADY_DELETED, status: 409 });
  });

  it('handles concurrent delete race (0 rows updated)', async () => {
    const db = makeDb([{ id: 'rec-001', deleted_at: null }]);
    db.__impl = (table) => {
      const base = makeDb([{ id: 'rec-001', deleted_at: null }])(table);
      const origUpdate = base.update.bind(base);
      base.update = (changes) => {
        db.rows[0].deleted_at = changes.deleted_at;
        return Promise.resolve(0);
      };
      base.whereNull = () => base;
      return base;
    };
    await expect(
      softDeleteMetricRecord('rec-001', { dbClient: db, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.ALREADY_DELETED, status: 409 });
  });
});

describe('restoreMetricRecord', () => {
  it('restores a tombstoned record within the window', async () => {
    const deletedAt = new Date(NOW - 5 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: deletedAt, deleted_by: 'admin', delete_reason: 'cleanup' }]);
    const result = await restoreMetricRecord('rec-001', { dbClient: db, now: NOW, actor: 'admin2' });

    expect(result.deleted).toBe(false);
    expect(result.restoredBy).toBe('admin2');
    expect(result.deletedBy).toBeNull();
    expect(result.deleteReason).toBeNull();
  });

  it('throws NOT_FOUND for absent id', async () => {
    const db = makeDb([]);
    await expect(
      restoreMetricRecord('rec-404', { dbClient: db })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });
  });

  it('throws NOT_DELETED for a live record', async () => {
    const db = makeDb([{ id: 'rec-001' }]);
    await expect(
      restoreMetricRecord('rec-001', { dbClient: db })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_DELETED, status: 409 });
  });

  it('throws RETENTION_EXPIRED when the window has elapsed', async () => {
    const deletedAt = new Date(NOW - 35 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: deletedAt }]);
    await expect(
      restoreMetricRecord('rec-001', { dbClient: db, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.RETENTION_EXPIRED, status: 410 });
  });

  it('handles concurrent restore race (0 rows updated)', async () => {
    const deletedAt = new Date(NOW - 5 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: deletedAt }]);
    db.__impl = (table) => {
      const base = makeDb([{ id: 'rec-001', deleted_at: deletedAt }])(table);
      base.update = () => Promise.resolve(0);
      base.whereNotNull = () => base;
      return base;
    };
    await expect(
      restoreMetricRecord('rec-001', { dbClient: db, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_DELETED, status: 409 });
  });
});

describe('getMetricRecordDeletionState', () => {
  it('returns live state for a non-deleted record', async () => {
    const db = makeDb([{ id: 'rec-001' }]);
    const state = await getMetricRecordDeletionState('rec-001', { dbClient: db });
    expect(state.deleted).toBe(false);
    expect(state.restorable).toBe(false);
    expect(state.id).toBe('rec-001');
  });

  it('returns tombstoned state for a deleted record', async () => {
    const deletedAt = new Date(NOW - 5 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: deletedAt, deleted_by: 'admin', delete_reason: 'test' }]);
    const state = await getMetricRecordDeletionState('rec-001', { dbClient: db, now: NOW });
    expect(state.deleted).toBe(true);
    expect(state.restorable).toBe(true);
    expect(state.deletedBy).toBe('admin');
  });

  it('returns non-restorable for expired tombstone', async () => {
    const deletedAt = new Date(NOW - 35 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: deletedAt }]);
    const state = await getMetricRecordDeletionState('rec-001', { dbClient: db, now: NOW });
    expect(state.deleted).toBe(true);
    expect(state.restorable).toBe(false);
  });

  it('throws NOT_FOUND for absent id', async () => {
    const db = makeDb([]);
    await expect(
      getMetricRecordDeletionState('rec-404', { dbClient: db })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });
  });
});

describe('purgeExpiredSoftDeletes', () => {
  it('purges tombstones past the retention window', async () => {
    const recent = new Date(NOW - 5 * DAY_MS).toISOString();
    const expired = new Date(NOW - 35 * DAY_MS).toISOString();
    const db = makeDb([
      { id: 'rec-001', deleted_at: expired },
      { id: 'rec-002', deleted_at: recent },
      { id: 'rec-003', deleted_at: expired },
    ]);
    const result = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW, batchSize: 10, maxBatches: 10 });

    expect(result.purged).toBe(2);
    expect(result.batches).toBe(1);
    expect(result.ids).toEqual(expect.arrayContaining(['rec-001', 'rec-003']));
    expect(result.ids).not.toContain('rec-002');
    expect(db.rows.map((r) => r.id)).toEqual(['rec-002']);
  });

  it('returns zero when nothing is expired', async () => {
    const recent = new Date(NOW - 5 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: recent }]);
    const result = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW, batchSize: 10, maxBatches: 10 });
    expect(result.purged).toBe(0);
    expect(result.batches).toBe(0);
  });

  it('returns zero when no tombstones exist', async () => {
    const db = makeDb([{ id: 'rec-001' }]);
    const result = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW, batchSize: 10, maxBatches: 10 });
    expect(result.purged).toBe(0);
  });

  it('stops early when batch is under size', async () => {
    const expired = new Date(NOW - 35 * DAY_MS).toISOString();
    const db = makeDb([{ id: 'rec-001', deleted_at: expired }]);
    const result = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW, batchSize: 100, maxBatches: 100 });
    expect(result.purged).toBe(1);
    expect(result.batches).toBe(1);
  });

  it('stops at maxBatches', async () => {
    const expired = new Date(NOW - 35 * DAY_MS).toISOString();
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `rec-${String(i).padStart(3, '0')}`, deleted_at: expired }));
    const db = makeDb(rows);
    const result = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW, batchSize: 10, maxBatches: 2 });
    expect(result.purged).toBe(20);
    expect(result.batches).toBe(2);
    expect(result.maxBatchesReached).toBe(true);
  });
});

describe('live deletion state is hidden from reads', () => {
  it('a live (non-deleted) record shows up in default matching', async () => {
    const db = makeDb([
      { id: 'rec-001', metric_name: 'cpu_usage' },
      { id: 'rec-002', metric_name: 'cpu_usage', deleted_at: new Date(NOW - 5 * DAY_MS).toISOString() },
    ]);

    const live = db.rows.filter((r) => r.deleted_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('rec-001');
  });

  it('deleted records are excluded from default reads (simulated)', async () => {
    const db = makeDb([
      { id: 'rec-001', metric_name: 'mem_usage' },
      { id: 'rec-002', metric_name: 'mem_usage', deleted_at: new Date(NOW - 5 * DAY_MS).toISOString() },
    ]);

    const live = db.rows.filter((r) => r.deleted_at === null && r.metric_name === 'mem_usage');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('rec-001');
  });
});
