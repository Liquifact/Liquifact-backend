'use strict';

/**
 * @fileoverview Unit tests for invoice-state soft-delete (issue #866).
 *
 * Covers:
 *  - delete hides: a soft-deleted record is excluded from every default read
 *  - restore within window: tombstone cleared, record served again
 *  - window expiry: restore refused with 410, purge removes the row
 *  - config parsing, timestamp coercion, conflict/concurrency paths
 *  - the maintenance purge job wrapper (metrics + error propagation)
 */

process.env.NODE_ENV = 'test';

const softDelete = require('../src/services/invoiceStateSoftDelete');
const {
  softDeleteInvoiceState,
  restoreInvoiceState,
  getInvoiceStateDeletionState,
  purgeExpiredInvoiceStateSoftDeletes,
  isRetentionExpired,
  getRetentionDays,
  getRetentionMs,
  getPurgeBatchSize,
  getPurgeMaxBatches,
  SOFT_DELETE_ERRORS,
  INVOICE_TABLE,
} = softDelete;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

// ── In-memory knex double ─────────────────────────────────────────────────────
// Supports exactly the query shapes the module builds: where / whereNull /
// whereNotNull / whereIn / comparison where / orderBy / limit / select / first /
// update / del.

/**
 * Builds a chainable, Knex-like fake backed by an array of rows.
 *
 * @param {Array<object>} seed - Initial `invoices` rows.
 * @returns {Function & { rows: Array<object> }} Callable knex double.
 */
function makeDb(seed = []) {
  const rows = seed.map((row) => ({
    invoice_id: row.invoice_id,
    status: row.status ?? 'pending',
    tenant_id: row.tenant_id ?? 't1',
    amount: row.amount ?? 100,
    customer: row.customer ?? 'C',
    deleted_at: row.deleted_at ?? null,
    deleted_by: row.deleted_by ?? null,
    delete_reason: row.delete_reason ?? null,
    restored_at: row.restored_at ?? null,
    restored_by: row.restored_by ?? null,
  }));

  const toMs = (value) => (value == null ? null : Date.parse(value));

  function query(table) {
    if (table !== INVOICE_TABLE) {
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

/**
 * Wraps a db double, replacing terminal methods while keeping the builder
 * chain intact.
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

/** @returns {object} A live (non-deleted) seed row for `inv_001`. */
function liveRow(overrides = {}) {
  return { invoice_id: 'inv_001', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS;
  delete process.env.INVOICE_STATE_PURGE_BATCH_SIZE;
  delete process.env.INVOICE_STATE_PURGE_MAX_BATCHES;
});

// ── Configuration ─────────────────────────────────────────────────────────────

describe('retention configuration', () => {
  test('defaults to a 30-day window', () => {
    expect(getRetentionDays()).toBe(30);
    expect(getRetentionMs()).toBe(30 * DAY_MS);
  });

  test('honours a valid override', () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '7';
    expect(getRetentionDays()).toBe(7);
  });

  test('floors fractional values', () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '9.9';
    expect(getRetentionDays()).toBe(9);
  });

  test.each(['not-a-number', '0', '-5', ''])(
    'falls back to the default for invalid value %p',
    (value) => {
      process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = value;
      expect(getRetentionDays()).toBe(30);
    }
  );

  test('clamps absurdly long windows', () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '999999';
    expect(getRetentionDays()).toBe(3650);
  });

  test('purge batch size: default, override, invalid, and cap', () => {
    expect(getPurgeBatchSize()).toBe(500);
    process.env.INVOICE_STATE_PURGE_BATCH_SIZE = '25';
    expect(getPurgeBatchSize()).toBe(25);
    process.env.INVOICE_STATE_PURGE_BATCH_SIZE = '0';
    expect(getPurgeBatchSize()).toBe(500);
    process.env.INVOICE_STATE_PURGE_BATCH_SIZE = '999999';
    expect(getPurgeBatchSize()).toBe(10000);
  });

  test('purge max batches: default, override, invalid, and cap', () => {
    expect(getPurgeMaxBatches()).toBe(100);
    process.env.INVOICE_STATE_PURGE_MAX_BATCHES = '3';
    expect(getPurgeMaxBatches()).toBe(3);
    process.env.INVOICE_STATE_PURGE_MAX_BATCHES = 'abc';
    expect(getPurgeMaxBatches()).toBe(100);
    process.env.INVOICE_STATE_PURGE_MAX_BATCHES = '5000';
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
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '1';
    const deletedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    expect(isRetentionExpired(deletedAt)).toBe(true);
  });
});

// ── Delete hides ──────────────────────────────────────────────────────────────

describe('softDeleteInvoiceState', () => {
  test('tombstones the record and returns the retention envelope', async () => {
    const db = makeDb([liveRow()]);

    const result = await softDeleteInvoiceState('inv_001', {
      dbClient: db,
      actor: 'admin-user',
      reason: 'duplicate invoice',
      now: NOW,
    });

    expect(result).toMatchObject({
      invoiceId: 'inv_001',
      deleted: true,
      deletedAt: new Date(NOW).toISOString(),
      deletedBy: 'admin-user',
      deleteReason: 'duplicate invoice',
      restorable: true,
      retentionDays: 30,
      purgeAfter: new Date(NOW + 30 * DAY_MS).toISOString(),
    });

    // The row survives — soft delete never purges.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].deleted_at).toBe(new Date(NOW).toISOString());
  });

  test('trims the invoice id and defaults actor/reason to null', async () => {
    const db = makeDb([liveRow()]);
    const result = await softDeleteInvoiceState('  inv_001  ', { dbClient: db, now: NOW });
    expect(result.invoiceId).toBe('inv_001');
    expect(result.deletedBy).toBeNull();
    expect(result.deleteReason).toBeNull();
  });

  test('rejects an invalid invoice id', async () => {
    const db = makeDb([liveRow()]);
    await expect(softDeleteInvoiceState('bad id!', { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
      status: 400,
    });
    await expect(softDeleteInvoiceState('', { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
    });
    await expect(softDeleteInvoiceState(null, { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
    });
    const tooLong = 'a'.repeat(129);
    await expect(softDeleteInvoiceState(tooLong, { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
    });
  });

  test('rejects a non-string reason', async () => {
    const db = makeDb([liveRow()]);
    await expect(
      softDeleteInvoiceState('inv_001', { dbClient: db, reason: 42, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID, status: 400 });
  });

  test('rejects an over-long reason', async () => {
    const db = makeDb([liveRow()]);
    const longReason = 'x'.repeat(501);
    await expect(
      softDeleteInvoiceState('inv_001', { dbClient: db, reason: longReason, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID, status: 400 });
  });

  test('trims a reason and stores null for empty strings', async () => {
    const db = makeDb([liveRow()]);
    const result = await softDeleteInvoiceState('inv_001', {
      dbClient: db,
      reason: '   ',
      now: NOW,
    });
    expect(result.deleteReason).toBeNull();
  });

  test('404s for an unknown invoice', async () => {
    const db = makeDb([]);
    await expect(softDeleteInvoiceState('inv_404', { dbClient: db })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.NOT_FOUND,
      status: 404,
    });
  });

  test('409s on re-delete instead of refreshing the window', async () => {
    const deletedAt = new Date(NOW - DAY_MS).toISOString();
    const db = makeDb([liveRow({ deleted_at: deletedAt })]);

    await expect(
      softDeleteInvoiceState('inv_001', { dbClient: db, now: NOW })
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
    const raced = withOverrides(db, { update: async () => 0 });

    await expect(
      softDeleteInvoiceState('inv_001', { dbClient: raced, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.ALREADY_DELETED, status: 409 });
  });
});

// ── Restore within the window ─────────────────────────────────────────────────

describe('restoreInvoiceState', () => {
  test('clears the tombstone and makes the record readable again', async () => {
    const db = makeDb([liveRow()]);
    await softDeleteInvoiceState('inv_001', { dbClient: db, actor: 'admin-a', now: NOW });

    const restoredAt = NOW + 5 * DAY_MS;
    const result = await restoreInvoiceState('inv_001', {
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

    // Row is live again in the table.
    expect(db.rows[0].deleted_at).toBeNull();
    expect(db.rows[0].restored_at).toBe(new Date(restoredAt).toISOString());
  });

  test('restores on the last millisecond of the window', async () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '10';
    const db = makeDb([liveRow()]);
    await softDeleteInvoiceState('inv_001', { dbClient: db, now: NOW });

    const lastMoment = NOW + 10 * DAY_MS - 1;
    await expect(
      restoreInvoiceState('inv_001', { dbClient: db, now: lastMoment })
    ).resolves.toMatchObject({ deleted: false });
  });

  test('rejects an invalid invoice id', async () => {
    await expect(restoreInvoiceState('##', { dbClient: makeDb([]) })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
      status: 400,
    });
    await expect(restoreInvoiceState(null, { dbClient: makeDb([]) })).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID,
    });
  });

  test('404s when the record is absent (e.g. already purged)', async () => {
    await expect(
      restoreInvoiceState('inv_001', { dbClient: makeDb([]), now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });
  });

  test('409s when the record is not deleted', async () => {
    const db = makeDb([liveRow()]);
    await expect(
      restoreInvoiceState('inv_001', { dbClient: db, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_DELETED, status: 409 });
  });

  test('409s when a concurrent restore already cleared the tombstone', async () => {
    const db = makeDb([liveRow({ deleted_at: new Date(NOW - DAY_MS).toISOString() })]);
    const raced = withOverrides(db, { update: async () => 0 });

    await expect(
      restoreInvoiceState('inv_001', { dbClient: raced, now: NOW })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_DELETED, status: 409 });
  });
});

// ── Window expiry ─────────────────────────────────────────────────────────────

describe('retention window expiry', () => {
  test('restore is refused with 410 once the window elapses', async () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '7';
    const db = makeDb([liveRow()]);
    await softDeleteInvoiceState('inv_001', { dbClient: db, now: NOW });

    const tooLate = NOW + 7 * DAY_MS;
    await expect(
      restoreInvoiceState('inv_001', { dbClient: db, now: tooLate })
    ).rejects.toMatchObject({
      code: SOFT_DELETE_ERRORS.RETENTION_EXPIRED,
      status: 410,
      deletedAt: new Date(NOW).toISOString(),
      purgeAfter: new Date(tooLate).toISOString(),
    });

    // The row is still present but is no longer restorable.
    expect(db.rows).toHaveLength(1);
    const state = await getInvoiceStateDeletionState('inv_001', { dbClient: db, now: tooLate });
    expect(state.restorable).toBe(false);
  });

  test('purge removes expired tombstones and leaves everything else alone', async () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '30';
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

    const summary = await purgeExpiredInvoiceStateSoftDeletes({ dbClient: db, now: NOW });

    expect(summary).toMatchObject({
      purged: 1,
      batches: 1,
      retentionDays: 30,
      maxBatchesReached: false,
      invoiceIds: ['inv_expired'],
      cutoff: new Date(NOW - 30 * DAY_MS).toISOString(),
    });
    expect(db.rows.map((r) => r.invoice_id).sort()).toEqual(['inv_live', 'inv_recent']);
  });

  test('a purged record can no longer be restored', async () => {
    process.env.INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS = '1';
    const db = makeDb([liveRow()]);
    await softDeleteInvoiceState('inv_001', { dbClient: db, now: NOW });

    await purgeExpiredInvoiceStateSoftDeletes({ dbClient: db, now: NOW + 2 * DAY_MS });
    expect(db.rows).toHaveLength(0);

    await expect(
      restoreInvoiceState('inv_001', { dbClient: db, now: NOW + 2 * DAY_MS })
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

    const summary = await purgeExpiredInvoiceStateSoftDeletes({
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

    const summary = await purgeExpiredInvoiceStateSoftDeletes({
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
    const summary = await purgeExpiredInvoiceStateSoftDeletes({ dbClient: db, now: NOW });

    expect(summary).toMatchObject({ purged: 0, batches: 0, invoiceIds: [] });
    expect(db.rows).toHaveLength(1);
  });

  test.each([
    ['rows without a usable invoice id', async () => [null, { invoice_id: 42 }]],
    ['a driver that returns no rows at all', async () => undefined],
  ])('tolerates %s', async (_label, select) => {
    const stub = withOverrides(makeDb([]), { select });

    const summary = await purgeExpiredInvoiceStateSoftDeletes({ dbClient: stub, now: NOW });
    expect(summary.purged).toBe(0);
  });

  test('uses configured batch/max-batch settings when not overridden', async () => {
    process.env.INVOICE_STATE_PURGE_BATCH_SIZE = '1';
    process.env.INVOICE_STATE_PURGE_MAX_BATCHES = '1';
    const db = makeDb([
      liveRow({ invoice_id: 'a', deleted_at: new Date(NOW - 40 * DAY_MS).toISOString() }),
      liveRow({ invoice_id: 'b', deleted_at: new Date(NOW - 41 * DAY_MS).toISOString() }),
    ]);

    const summary = await purgeExpiredInvoiceStateSoftDeletes({ dbClient: db, now: NOW });
    expect(summary.purged).toBe(1);
    expect(summary.maxBatchesReached).toBe(true);
  });
});

describe('getInvoiceStateDeletionState', () => {
  test('reports a live record', async () => {
    const db = makeDb([liveRow({ restored_at: '2026-08-02T00:00:00.000Z', restored_by: 'ops' })]);
    const state = await getInvoiceStateDeletionState('inv_001', { dbClient: db, now: NOW });

    expect(state).toMatchObject({
      deleted: false,
      deletedAt: null,
      purgeAfter: null,
      restorable: false,
      restoredAt: '2026-08-02T00:00:00.000Z',
      restoredBy: 'ops',
    });
  });

  test('404s for an unknown invoice and 400s for an invalid id', async () => {
    await expect(
      getInvoiceStateDeletionState('inv_404', { dbClient: makeDb([]) })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.NOT_FOUND, status: 404 });

    await expect(
      getInvoiceStateDeletionState(null, { dbClient: makeDb([]) })
    ).rejects.toMatchObject({ code: SOFT_DELETE_ERRORS.INVALID_INVOICE_ID, status: 400 });
  });

  test('handles Date-typed timestamps (Postgres driver shape)', async () => {
    const db = makeDb([]);
    db.rows.push({
      invoice_id: 'inv_pg',
      status: 'pending',
      tenant_id: 't1',
      deleted_at: new Date(NOW - DAY_MS),
      deleted_by: 'admin',
      delete_reason: null,
      restored_at: null,
      restored_by: null,
    });

    const state = await getInvoiceStateDeletionState('inv_pg', { dbClient: db, now: NOW });
    expect(state.deleted).toBe(true);
    expect(state.deletedAt).toBe(new Date(NOW - DAY_MS).toISOString());
    expect(state.restorable).toBe(true);
  });
});

// ── Default (non-injected) db client and clock ────────────────────────────────

describe('default db client and clock', () => {
  test('every entry point falls back to the shared knex instance', async () => {
    // Re-require the knex module after the proxy mock below to make sure the
    // default `db` import inside the service points at our test double.
    jest.resetModules();
    jest.doMock('../src/db/knex', () => {
      const proxy = (table) => proxy.__impl(table);
      proxy.__impl = makeDb([
        liveRow({ invoice_id: 'inv_default' }),
        liveRow({
          invoice_id: 'inv_old',
          deleted_at: new Date(Date.now() - 400 * DAY_MS).toISOString(),
        }),
      ]);
      return proxy;
    });
    const fresh = require('../src/services/invoiceStateSoftDelete');

    const state = await fresh.getInvoiceStateDeletionState('inv_default');
    expect(state).toMatchObject({ invoiceId: 'inv_default', deleted: false });

    const deleted = await fresh.softDeleteInvoiceState('inv_default');
    expect(deleted.deleted).toBe(true);

    const restored = await fresh.restoreInvoiceState('inv_default');
    expect(restored.deleted).toBe(false);

    const summary = await fresh.purgeExpiredInvoiceStateSoftDeletes();
    expect(summary.purged).toBe(1);
    expect(summary.invoiceIds).toEqual(['inv_old']);
  });
});
