'use strict';

/**
 * @fileoverview Unit tests for escrow-read soft-delete (issue #31).
 *
 * Covers:
 *  - delete hides: a soft-deleted record is excluded from every default read
 *  - restore within window: tombstone cleared, record served again
 *  - window expiry: restore refused with 410, purge removes the row
 *  - config parsing, timestamp coercion, conflict/concurrency paths
 *  - the maintenance purge job wrapper (metrics + error propagation)
 */

process.env.NODE_ENV = 'test';

// Soroban is stubbed so the read path resolves adapters synchronously.
jest.mock('../src/services/soroban', () => ({
  callSorobanContract: jest.fn(async (operation) => operation()),
}));

// Keep the real read implementation (the exclusion assertions depend on it)
// but observe cache invalidation, which soft-delete/restore must trigger.
jest.mock('../src/services/escrowRead', () => {
  const actual = jest.requireActual('../src/services/escrowRead');
  return {
    ...actual,
    invalidateEscrowReadCache: jest.fn(async () => true),
  };
});

// The default (non-injected) db client path is exercised too: the mock
// delegates to whatever double the test installs on `__impl`.
jest.mock('../src/db/knex', () => {
  const proxy = (table) => proxy.__impl(table);
  proxy.__impl = () => {
    throw new Error('db double not configured');
  };
  return proxy;
});

const defaultDb = require('../src/db/knex');
const escrowRead = require('../src/services/escrowRead');
const softDelete = require('../src/services/escrowReadSoftDelete');
const {
  softDeleteEscrowRead,
  restoreEscrowRead,
  getEscrowReadDeletionState,
  purgeExpiredSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  PROJECTION_TABLE,
} = softDelete;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-25T12:00:00.000Z');

// ── In-memory knex double ─────────────────────────────────────────────────────
// Supports exactly the query shapes the module builds: where / whereNull /
// whereNotNull / whereIn / comparison where / orderBy / limit / select / first /
// update / del.

/**
 * Builds a chainable, Knex-like fake backed by an array of rows.
 *
 * @param {Array<object>} seed - Initial `escrow_event_projection` rows.
 * @returns {Function & { rows: Array<object> }} Callable knex double.
 */
function makeDb(seed = []) {
  const rows = seed.map((row) => ({
    invoice_id: row.invoice_id,
    latest_event_id: row.latest_event_id ?? 'evt-1',
    latest_event_type: row.latest_event_type ?? 'funded_invoice',
    latest_ledger_sequence: row.latest_ledger_sequence ?? 42,
    latest_paging_token: row.latest_paging_token ?? 'tok-1',
    latest_event_body:
      row.latest_event_body ?? JSON.stringify({ status: 'funded', fundedAmount: 1000 }),
    latest_observed_at: row.latest_observed_at ?? '2026-07-01T00:00:00.000Z',
    deleted_at: row.deleted_at ?? null,
    deleted_by: row.deleted_by ?? null,
    delete_reason: row.delete_reason ?? null,
    restored_at: row.restored_at ?? null,
    restored_by: row.restored_by ?? null,
  }));

  const toMs = (value) => (value == null ? null : Date.parse(value));

  function query(table) {
    if (table !== PROJECTION_TABLE) {
      throw new Error(`unexpected table: ${table}`);
    }
    const preds = [];
    let order = null;
    let limit = null;

    const matching = () => {
      let out = rows.filter((row) => preds.every((p) => p(row)));
      if (order) {
        out = [...out].sort((a, b) => (toMs(a[order]) ?? 0) - (toMs(b[order]) ?? 0));
      }
      if (limit !== null) {
        out = out.slice(0, limit);
      }
      return out;
    };

    const q = {
      where(field, opOrValue, maybe) {
        if (maybe === undefined) {
          preds.push((row) => row[field] === opOrValue);
        } else {
          preds.push((row) => {
            const left = toMs(row[field]);
            const right = toMs(maybe);
            if (left === null) return false;
            return opOrValue === '<=' ? left <= right : left < right;
          });
        }
        return q;
      },
      whereNull(field) {
        preds.push((row) => row[field] == null);
        return q;
      },
      whereNotNull(field) {
        preds.push((row) => row[field] != null);
        return q;
      },
      whereIn(field, values) {
        preds.push((row) => values.includes(row[field]));
        return q;
      },
      orderBy(field) {
        order = field;
        return q;
      },
      limit(n) {
        limit = n;
        return q;
      },
      async select(...fields) {
        return matching().map((row) => {
          const picked = {};
          fields.forEach((f) => {
            picked[f] = row[f];
          });
          return picked;
        });
      },
      async first() {
        return matching()[0] || null;
      },
      async update(patch) {
        const targets = matching();
        targets.forEach((row) => Object.assign(row, patch));
        return targets.length;
      },
      async del() {
        const targets = matching();
        targets.forEach((row) => rows.splice(rows.indexOf(row), 1));
        return targets.length;
      },
    };
    return q;
  }

  const db = (table) => query(table);
  db.rows = rows;
  return db;
}

/** @returns {object} A live (non-deleted) seed row for `inv_001`. */
function liveRow(overrides = {}) {
  return { invoice_id: 'inv_001', ...overrides };
}

/**
 * Wraps a db double so every `.update()` reports 0 affected rows — the shape a
 * lost write race produces (another request stamped the row between our read
 * and our guarded update).
 *
 * @param {Function} db - Knex double from {@link makeDb}.
 * @returns {Function} Knex double whose updates always affect 0 rows.
 */
function withLostUpdateRace(db) {
  return withOverrides(db, { update: async () => 0 });
}

/**
 * Wraps a db double, replacing terminal methods while keeping the builder
 * chain intact (a plain object spread would not: the inner methods return the
 * inner builder, bypassing the override).
 *
 * @param {Function} db - Knex double from {@link makeDb}.
 * @param {Record<string, Function>} overrides - Replacement methods.
 * @returns {Function} Knex double honouring the overrides.
 */
function withOverrides(db, overrides) {
  return (table) => {
    const inner = db(table);
    const wrapper = new Proxy(inner, {
      get(target, prop) {
        if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
          return overrides[prop];
        }
        const value = target[prop];
        if (typeof value !== 'function') {
          return value;
        }
        return (...args) => {
          const result = value.apply(target, args);
          return result === target ? wrapper : result;
        };
      },
    });
    return wrapper;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS;
  delete process.env.ESCROW_READ_PURGE_BATCH_SIZE;
  delete process.env.ESCROW_READ_PURGE_MAX_BATCHES;
});

// ── Configuration ─────────────────────────────────────────────────────────────

describe('retention configuration', () => {
  test('defaults to a 30-day window', () => {
    expect(getRetentionDays()).toBe(30);
    expect(getRetentionMs()).toBe(30 * DAY_MS);
  });

  test('honours a valid override', () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '7';
    expect(getRetentionDays()).toBe(7);
  });

  test('floors fractional values', () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '9.9';
    expect(getRetentionDays()).toBe(9);
  });

  test.each(['not-a-number', '0', '-5', ''])(
    'falls back to the default for invalid value %p',
    (value) => {
      process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = value;
      expect(getRetentionDays()).toBe(30);
    }
  );

  test('clamps absurdly long windows', () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '999999';
    expect(getRetentionDays()).toBe(3650);
  });

  test('purge batch size: default, override, invalid, and cap', () => {
    expect(getPurgeBatchSize()).toBe(500);
    process.env.ESCROW_READ_PURGE_BATCH_SIZE = '25';
    expect(getPurgeBatchSize()).toBe(25);
    process.env.ESCROW_READ_PURGE_BATCH_SIZE = '0';
    expect(getPurgeBatchSize()).toBe(500);
    process.env.ESCROW_READ_PURGE_BATCH_SIZE = '999999';
    expect(getPurgeBatchSize()).toBe(10000);
  });

  test('purge max batches: default, override, invalid, and cap', () => {
    expect(getPurgeMaxBatches()).toBe(100);
    process.env.ESCROW_READ_PURGE_MAX_BATCHES = '3';
    expect(getPurgeMaxBatches()).toBe(3);
    process.env.ESCROW_READ_PURGE_MAX_BATCHES = 'abc';
    expect(getPurgeMaxBatches()).toBe(100);
    process.env.ESCROW_READ_PURGE_MAX_BATCHES = '5000';
    expect(getPurgeMaxBatches()).toBe(1000);
  });
});

describe('isRetentionExpired', () => {
  test('is false inside the window and true at/after the boundary', () => {
    const retentionMs = 10 * DAY_MS;
    const deletedAt = new Date(NOW - 9 * DAY_MS).toISOString();
    expect(isRetentionExpired(deletedAt, { now: NOW, retentionMs })).toBe(false);

    const exactly = new Date(NOW - retentionMs).toISOString();
    expect(isRetentionExpired(exactly, { now: NOW, retentionMs })).toBe(true);
  });

  test('accepts Date and epoch-millisecond values', () => {
    const retentionMs = DAY_MS;
    expect(isRetentionExpired(new Date(NOW - 2 * DAY_MS), { now: NOW, retentionMs })).toBe(true);
    expect(isRetentionExpired(NOW - 1000, { now: NOW, retentionMs })).toBe(false);
  });

  test.each([null, undefined, '', 'garbage', {}, NaN, new Date('nope')])(
    'treats unparseable value %p as expired (never an unbounded window)',
    (value) => {
      expect(isRetentionExpired(value, { now: NOW })).toBe(true);
    }
  );

  test('uses the configured window when none is passed', () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '1';
    const deletedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    expect(isRetentionExpired(deletedAt)).toBe(true);
  });
});

// ── Delete hides ──────────────────────────────────────────────────────────────

describe('softDeleteEscrowRead', () => {
  test('tombstones the record and returns the retention envelope', async () => {
    const db = makeDb([liveRow()]);

    const result = await softDeleteEscrowRead('inv_001', {
      dbClient: db,
      actor: 'admin-user',
      reason: 'duplicate projection',
      now: NOW,
    });

    expect(result).toMatchObject({
      invoiceId: 'inv_001',
      deleted: true,
      deletedAt: new Date(NOW).toISOString(),
      deletedBy: 'admin-user',
      deleteReason: 'duplicate projection',
      restorable: true,
      retentionDays: 30,
      purgeAfter: new Date(NOW + 30 * DAY_MS).toISOString(),
    });

    // The row survives — soft delete never purges.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].deleted_at).toBe(new Date(NOW).toISOString());
  });

  test('invalidates the escrow read caches', async () => {
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });
    expect(escrowRead.invalidateEscrowReadCache).toHaveBeenCalledWith('inv_001');
  });

  test('trims the invoice id and defaults actor/reason to null', async () => {
    const db = makeDb([liveRow()]);
    const result = await softDeleteEscrowRead('  inv_001  ', { dbClient: db, now: NOW });
    expect(result.invoiceId).toBe('inv_001');
    expect(result.deletedBy).toBeNull();
    expect(result.deleteReason).toBeNull();
  });

  test('rejects an invalid invoice id', async () => {
    const db = makeDb([liveRow()]);
    await expect(softDeleteEscrowRead('bad id!', { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
      status: 400,
    });
    await expect(softDeleteEscrowRead('', { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
    });
  });

  test('404s for an unknown invoice', async () => {
    const db = makeDb([]);
    await expect(softDeleteEscrowRead('inv_404', { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.NOT_FOUND,
      status: 404,
    });
  });

  test('409s on re-delete instead of refreshing the window', async () => {
    const deletedAt = new Date(NOW - DAY_MS).toISOString();
    const db = makeDb([liveRow({ deleted_at: deletedAt })]);

    await expect(
      softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW })
    ).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.ALREADY_DELETED,
      status: 409,
      deletedAt,
    });

    // Window is not extended by the failed retry.
    expect(db.rows[0].deleted_at).toBe(deletedAt);
  });

  test('409s when a concurrent delete wins the guarded update', async () => {
    const db = makeDb([liveRow()]);
    const raced = withLostUpdateRace(db);

    await expect(
      softDeleteEscrowRead('inv_001', { dbClient: raced, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.ALREADY_DELETED, status: 409 });
  });
});

describe('soft-deleted records are excluded from default reads', () => {
  const adapters = { legalHoldAdapter: async () => false };

  test('readEscrowState reports the neutral not_found state', async () => {
    const db = makeDb([liveRow()]);

    const before = await escrowRead.readEscrowState('inv_001', { ...adapters, dbClient: db });
    expect(before).toMatchObject({ status: 'funded', source: 'projection', fundedAmount: 1000 });

    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });

    const after = await escrowRead.readEscrowState('inv_001', { ...adapters, dbClient: db });
    expect(after).toMatchObject({ status: 'not_found', fundedAmount: 0, source: 'rpc_stub' });
  });

  test('readFundedAmount reports 0 for a tombstoned record', async () => {
    const db = makeDb([liveRow()]);
    expect(await escrowRead.readFundedAmount('inv_001', { dbClient: db })).toBe(1000);

    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });
    expect(await escrowRead.readFundedAmount('inv_001', { dbClient: db })).toBe(0);
  });

  test('readEscrowStateWithAttestations hides the record too', async () => {
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });

    const state = await escrowRead.readEscrowStateWithAttestations('inv_001', {
      ...adapters,
      attestationAdapter: async () => [],
      dbClient: db,
    });
    expect(state.status).toBe('not_found');
  });

  test('the tombstone itself remains visible to the admin state read', async () => {
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', {
      dbClient: db,
      actor: 'admin-user',
      reason: 'bad index',
      now: NOW,
    });

    const state = await getEscrowReadDeletionState('inv_001', { dbClient: db, now: NOW });
    expect(state).toMatchObject({
      deleted: true,
      deletedBy: 'admin-user',
      deleteReason: 'bad index',
      restorable: true,
    });
  });
});

// ── Restore within the window ─────────────────────────────────────────────────

describe('restoreEscrowRead', () => {
  test('clears the tombstone and makes the record readable again', async () => {
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', { dbClient: db, actor: 'admin-a', now: NOW });

    const restoredAt = NOW + 5 * DAY_MS;
    const result = await restoreEscrowRead('inv_001', {
      dbClient: db,
      actor: 'admin-b',
      now: restoredAt,
    });

    expect(result).toMatchObject({
      invoiceId: 'inv_001',
      deleted: false,
      deletedAt: null,
      deletedBy: null,
      deleteReason: null,
      restoredAt: new Date(restoredAt).toISOString(),
      restoredBy: 'admin-b',
      purgeAfter: null,
      restorable: false,
    });

    const state = await escrowRead.readEscrowState('inv_001', {
      legalHoldAdapter: async () => false,
      dbClient: db,
    });
    expect(state).toMatchObject({ status: 'funded', source: 'projection', fundedAmount: 1000 });
  });

  test('restores on the last millisecond of the window', async () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '10';
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });

    const lastMoment = NOW + 10 * DAY_MS - 1;
    await expect(
      restoreEscrowRead('inv_001', { dbClient: db, now: lastMoment })
    ).resolves.toMatchObject({ deleted: false });
  });

  test('invalidates the escrow read caches', async () => {
    const db = makeDb([liveRow({ deleted_at: new Date(NOW - DAY_MS).toISOString() })]);
    await restoreEscrowRead('inv_001', { dbClient: db, now: NOW });
    expect(escrowRead.invalidateEscrowReadCache).toHaveBeenCalledWith('inv_001');
  });

  test('rejects an invalid invoice id', async () => {
    await expect(restoreEscrowRead('##', { dbClient: makeDb([]) })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
      status: 400,
    });
  });

  test('404s when the record is absent (e.g. already purged)', async () => {
    await expect(
      restoreEscrowRead('inv_001', { dbClient: makeDb([]), now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });
  });

  test('409s when the record is not deleted', async () => {
    const db = makeDb([liveRow()]);
    await expect(
      restoreEscrowRead('inv_001', { dbClient: db, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_DELETED, status: 409 });
  });

  test('409s when a concurrent restore already cleared the tombstone', async () => {
    const db = makeDb([liveRow({ deleted_at: new Date(NOW - DAY_MS).toISOString() })]);
    const raced = withLostUpdateRace(db);

    await expect(
      restoreEscrowRead('inv_001', { dbClient: raced, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_DELETED, status: 409 });
  });
});

// ── Window expiry ─────────────────────────────────────────────────────────────

describe('retention window expiry', () => {
  test('restore is refused with 410 once the window elapses', async () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '7';
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });

    const tooLate = NOW + 7 * DAY_MS;
    await expect(
      restoreEscrowRead('inv_001', { dbClient: db, now: tooLate })
    ).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      status: 410,
      deletedAt: new Date(NOW).toISOString(),
      purgeAfter: new Date(tooLate).toISOString(),
    });

    // The row is still present but is no longer restorable.
    expect(db.rows).toHaveLength(1);
    const state = await getEscrowReadDeletionState('inv_001', { dbClient: db, now: tooLate });
    expect(state.restorable).toBe(false);
  });

  test('purge removes expired tombstones and leaves everything else alone', async () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '30';
    const db = makeDb([
      liveRow({ invoice_id: 'inv_live' }),
      liveRow({
        invoice_id: 'inv_expired',
        deleted_at: new Date(NOW - 31 * DAY_MS).toISOString(),
      }),
      liveRow({
        invoice_id: 'inv_recent',
        deleted_at: new Date(NOW - 2 * DAY_MS).toISOString(),
      }),
    ]);

    const summary = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW });

    expect(summary).toMatchObject({
      purged: 1,
      batches: 1,
      retentionDays: 30,
      maxBatchesReached: false,
      invoiceIds: ['inv_expired'],
      cutoff: new Date(NOW - 30 * DAY_MS).toISOString(),
    });
    expect(db.rows.map((r) => r.invoice_id).sort()).toEqual(['inv_live', 'inv_recent']);
    expect(escrowRead.invalidateEscrowReadCache).toHaveBeenCalledWith('inv_expired');
  });

  test('a purged record can no longer be restored', async () => {
    process.env.ESCROW_READ_SOFT_DELETE_RETENTION_DAYS = '1';
    const db = makeDb([liveRow()]);
    await softDeleteEscrowRead('inv_001', { dbClient: db, now: NOW });

    await purgeExpiredSoftDeletes({ dbClient: db, now: NOW + 2 * DAY_MS });
    expect(db.rows).toHaveLength(0);

    await expect(
      restoreEscrowRead('inv_001', { dbClient: db, now: NOW + 2 * DAY_MS })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });
  });

  test('purges in bounded batches until the backlog is drained', async () => {
    const seed = Array.from({ length: 5 }, (_, i) =>
      liveRow({
        invoice_id: `inv_${i}`,
        deleted_at: new Date(NOW - (40 + i) * DAY_MS).toISOString(),
      })
    );
    const db = makeDb(seed);

    const summary = await purgeExpiredSoftDeletes({
      dbClient: db,
      now: NOW,
      batchSize: 2,
      maxBatches: 10,
    });

    expect(summary.purged).toBe(5);
    expect(summary.batches).toBe(3); // 2 + 2 + 1 (short final batch)
    expect(summary.maxBatchesReached).toBe(false);
    expect(db.rows).toHaveLength(0);
  });

  test('stops at maxBatches and reports the remaining backlog', async () => {
    const seed = Array.from({ length: 6 }, (_, i) =>
      liveRow({
        invoice_id: `inv_${i}`,
        deleted_at: new Date(NOW - (40 + i) * DAY_MS).toISOString(),
      })
    );
    const db = makeDb(seed);

    const summary = await purgeExpiredSoftDeletes({
      dbClient: db,
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    });

    expect(summary.purged).toBe(4);
    expect(summary.batches).toBe(2);
    expect(summary.maxBatchesReached).toBe(true);
    expect(db.rows).toHaveLength(2);
  });

  test('is a no-op when nothing has expired', async () => {
    const db = makeDb([liveRow()]);
    const summary = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW });

    expect(summary).toMatchObject({ purged: 0, batches: 0, invoiceIds: [] });
    expect(db.rows).toHaveLength(1);
    expect(escrowRead.invalidateEscrowReadCache).not.toHaveBeenCalled();
  });

  test.each([
    ['rows without a usable invoice id', async () => [null, { invoice_id: 42 }]],
    ['a driver that returns no rows at all', async () => undefined],
  ])('tolerates %s', async (_label, select) => {
    const stub = withOverrides(makeDb([]), { select });

    const summary = await purgeExpiredSoftDeletes({ dbClient: stub, now: NOW });
    expect(summary.purged).toBe(0);
  });

  test('uses configured batch/max-batch settings when not overridden', async () => {
    process.env.ESCROW_READ_PURGE_BATCH_SIZE = '1';
    process.env.ESCROW_READ_PURGE_MAX_BATCHES = '1';
    const db = makeDb([
      liveRow({ invoice_id: 'a', deleted_at: new Date(NOW - 40 * DAY_MS).toISOString() }),
      liveRow({ invoice_id: 'b', deleted_at: new Date(NOW - 41 * DAY_MS).toISOString() }),
    ]);

    const summary = await purgeExpiredSoftDeletes({ dbClient: db, now: NOW });
    expect(summary.purged).toBe(1);
    expect(summary.maxBatchesReached).toBe(true);
  });
});

describe('getEscrowReadDeletionState', () => {
  test('reports a live record', async () => {
    const db = makeDb([liveRow({ restored_at: '2026-07-02T00:00:00.000Z', restored_by: 'ops' })]);
    const state = await getEscrowReadDeletionState('inv_001', { dbClient: db, now: NOW });

    expect(state).toMatchObject({
      deleted: false,
      deletedAt: null,
      purgeAfter: null,
      restorable: false,
      restoredAt: '2026-07-02T00:00:00.000Z',
      restoredBy: 'ops',
    });
  });

  test('404s for an unknown invoice and 400s for an invalid id', async () => {
    await expect(
      getEscrowReadDeletionState('inv_404', { dbClient: makeDb([]) })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });

    await expect(
      getEscrowReadDeletionState(null, { dbClient: makeDb([]) })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID, status: 400 });
  });

  test('handles Date-typed timestamps (Postgres driver shape)', async () => {
    const db = makeDb([]);
    db.rows.push({
      invoice_id: 'inv_pg',
      deleted_at: new Date(NOW - DAY_MS),
      deleted_by: 'admin',
      delete_reason: null,
      restored_at: null,
      restored_by: null,
    });

    const state = await getEscrowReadDeletionState('inv_pg', { dbClient: db, now: NOW });
    expect(state.deleted).toBe(true);
    expect(state.deletedAt).toBe(new Date(NOW - DAY_MS).toISOString());
    expect(state.restorable).toBe(true);
  });
});

// ── Default (non-injected) db client and clock ────────────────────────────────

describe('default db client and clock', () => {
  test('every entry point falls back to the shared knex instance', async () => {
    defaultDb.__impl = makeDb([
      liveRow({ invoice_id: 'inv_default' }),
      liveRow({
        invoice_id: 'inv_old',
        deleted_at: new Date(Date.now() - 400 * DAY_MS).toISOString(),
      }),
    ]);

    const state = await getEscrowReadDeletionState('inv_default');
    expect(state).toMatchObject({ invoiceId: 'inv_default', deleted: false });

    const deleted = await softDeleteEscrowRead('inv_default');
    expect(deleted.deleted).toBe(true);

    const restored = await restoreEscrowRead('inv_default');
    expect(restored.deleted).toBe(false);

    const summary = await purgeExpiredSoftDeletes();
    expect(summary.purged).toBe(1);
    expect(summary.invoiceIds).toEqual(['inv_old']);
  });
});

// ── Maintenance job wrapper ───────────────────────────────────────────────────

describe('escrowReadPurge job', () => {
  const job = require('../src/jobs/escrowReadPurge');

  test('runs the purge and reports success', async () => {
    const db = makeDb([
      liveRow({ invoice_id: 'inv_old', deleted_at: new Date(NOW - 40 * DAY_MS).toISOString() }),
    ]);

    const result = await job.runEscrowReadPurge({ id: 'job-1' }, { dbClient: db, now: NOW });
    expect(result).toMatchObject({ success: true, purged: 1 });
    expect(db.rows).toHaveLength(0);
  });

  test('propagates purge failures so the worker can retry', async () => {
    const exploding = () => {
      throw new Error('db down');
    };
    await expect(
      job.runEscrowReadPurge({ id: 'job-2' }, { dbClient: exploding, now: NOW })
    ).rejects.toThrow('db down');
  });

  test('exposes cadence configuration with a sane floor', () => {
    delete process.env.ESCROW_READ_PURGE_INTERVAL_MS;
    expect(job.getIntervalMs()).toBe(6 * 60 * 60 * 1000);

    process.env.ESCROW_READ_PURGE_INTERVAL_MS = '1000'; // below the 1-minute floor
    expect(job.getIntervalMs()).toBe(6 * 60 * 60 * 1000);

    process.env.ESCROW_READ_PURGE_INTERVAL_MS = '90000';
    expect(job.getIntervalMs()).toBe(90000);
    delete process.env.ESCROW_READ_PURGE_INTERVAL_MS;
  });

  test('reloading the module re-uses already-registered counters', () => {
    // prom-client's registry is process-global while jest resets the module
    // registry between suites; a naive `new Counter(...)` would throw here.
    jest.isolateModules(() => {
      const reloaded = require('../src/jobs/escrowReadPurge');
      expect(typeof reloaded.runEscrowReadPurge).toBe('function');
    });
  });

  test('getStats surfaces the effective configuration', () => {
    const stats = job.getStats();
    expect(stats.config).toMatchObject({ retentionDays: 30, batchSize: 500, maxBatches: 100 });
  });

  test('schedulePurge enqueues a delayed run and triggerPurge enqueues an immediate one', () => {
    const enqueue = jest.spyOn(job.purgeQueue, 'enqueue').mockReturnValue('job-id');

    expect(job.schedulePurge()).toBe('job-id');
    expect(enqueue).toHaveBeenLastCalledWith(job.JOB_TYPE, {}, { delayMs: job.getIntervalMs() });

    expect(job.triggerPurge()).toBe('job-id');
    expect(enqueue).toHaveBeenLastCalledWith(job.JOB_TYPE, {}, { delayMs: 0 });

    enqueue.mockRestore();
  });

  test('start is idempotent and stop shuts the worker down', async () => {
    const start = jest.spyOn(job.purgeWorker, 'start').mockImplementation(function start() {
      this.isRunning = true;
    });
    const stop = jest.spyOn(job.purgeWorker, 'stop').mockResolvedValue(undefined);
    jest.spyOn(job.purgeQueue, 'enqueue').mockReturnValue('job-id');

    job.purgeWorker.isRunning = false;
    job.startPurgeWorker();
    job.startPurgeWorker(); // second call is a no-op
    expect(start).toHaveBeenCalledTimes(1);

    await job.stopPurgeWorker(1);
    expect(stop).toHaveBeenCalledWith(1);

    job.purgeWorker.isRunning = false;
    jest.restoreAllMocks();
  });

  test('the registered handler runs the purge for queued jobs', async () => {
    defaultDb.__impl = makeDb([
      liveRow({
        invoice_id: 'inv_handler',
        deleted_at: new Date(Date.now() - 400 * DAY_MS).toISOString(),
      }),
    ]);

    const handler = job.purgeWorker.handlers.get(job.JOB_TYPE);
    const result = await handler({ id: 'job-3' });
    expect(result.success).toBe(true);
  });
});
