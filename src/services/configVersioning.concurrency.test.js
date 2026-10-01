'use strict';

/**
 * @fileoverview Concurrent-execution regression tests for
 * src/services/configVersioning.publishConfig.
 *
 * These tests simulate concurrent publish attempts using an in-memory
 * record store (no real DB required) to verify the CAS invariants without
 * depending on database transactions.  The tests exercise the application-layer
 * optimistic concurrency logic (version check + secondary WHERE guard).
 *
 * For the database-level serialisation guarantee (SELECT FOR UPDATE /
 * conditional UPDATE with version guard), the test below uses a controlled
 * race simulation where two calls are submitted with the same expectedVersion
 * and only one is allowed to win.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

jest.mock('../logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal knex-compatible mock for a single `runtime_config` table
 * that holds one row per (section, tenant_id) pair.
 *
 * The mock supports:
 *   - db.transaction(fn) — passes the same mock as the trx argument
 *   - trx(table).where({...}).orderBy(...).first().forUpdate() — returns the row
 *   - trx(table).where('id', id).where('version', v).update({...}).returning('*')
 *   - trx(table).where('id', id).first() — refetch after update
 *
 * @param {object} initialRow - The initial row in the store.
 * @returns {{ db: object, store: object[] }}
 */
function buildMockDb(initialRow) {
  const store = [{ ...initialRow }];

  let _whereFilters = {};
  let _table = null;
  let _pendingUpdate = null;

  function makeBuilder() {
    const builder = {
      _filters: {},
      where(fieldOrObj, value) {
        if (typeof fieldOrObj === 'object') {
          Object.assign(this._filters, fieldOrObj);
        } else {
          this._filters[fieldOrObj] = value;
        }
        return this;
      },
      whereNotNull() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      select() { return this; },
      async first() {
        const filters = this._filters;
        return store.find((row) =>
          Object.entries(filters).every(([k, v]) => row[k] === v)
        ) || null;
      },
      forUpdate() {
        return this;
      },
      update(fields) {
        const filters = { ...this._filters };
        const updateBuilder = {
          async returning(colSpec) {
            const idx = store.findIndex((row) =>
              Object.entries(filters).every(([k, v]) => row[k] === v)
            );
            if (idx === -1) {
              // 0 rows affected — CAS guard fired
              return [];
            }
            Object.assign(store[idx], fields);
            if (colSpec === '*') {
              return [{ ...store[idx] }];
            }
            return [{ ...store[idx] }];
          },
        };
        return updateBuilder;
      },
    };
    return builder;
  }

  const db = jest.fn((table) => {
    _table = table;
    return makeBuilder();
  });

  // db.client.config.client is checked in publishConfig to decide SQLite vs PG path
  db.client = { config: { client: 'pg' } };

  db.transaction = async function (fn) {
    return fn(db);
  };

  return { db, store };
}

// ─────────────────────────────────────────────────────────────────────────────
// Controlled-race test: two publishConfig calls, only one row in the store
// ─────────────────────────────────────────────────────────────────────────────

describe('publishConfig — concurrent CAS (controlled race simulation)', () => {
  /**
   * In this test we want to simulate what happens when two concurrent
   * publishConfig invocations both read the same row (version=1) before either
   * has committed its UPDATE.
   *
   * Because Node.js is single-threaded and our mock db is synchronous, we
   * cannot reproduce a true concurrent read without instrumenting the mock to
   * serialise the critical section.  Instead we verify the application-layer
   * CAS logic by:
   *
   *   1. Letting both calls read the same version=1 row.
   *   2. Having the FIRST update succeed and advance to version=2.
   *   3. Having the SECOND update fail (0 rows) because the WHERE version=1
   *      clause no longer matches after the first commit.
   *
   * This faithfully models the outcome the transaction-wrapped UPDATE produces
   * in a real database under concurrent access.
   */
  it('two concurrent calls with same expectedVersion: exactly one wins', async () => {
    // Use a real in-memory store with a latch to simulate the race:
    // both callers will read version=1, but the second update will find
    // version≠1 after the first has committed.

    let updateCallCount = 0;
    const initialRow = {
      id: 'cfg_1',
      section: 'cors',
      config: JSON.stringify({ origins: ['https://old.com'] }),
      tenant_id: 't1',
      draft_status: 'published',
      version: 1,
      created_at: new Date().toISOString(),
    };

    const store = [{ ...initialRow }];

    // Build a db mock where both callers read the same initial row,
    // but the second UPDATE will fail because version has already been bumped.
    function makeBuilder(capturedFilters = {}) {
      const b = {
        _filters: { ...capturedFilters },
        where(fieldOrObj, value) {
          if (typeof fieldOrObj === 'object') {
            Object.assign(this._filters, fieldOrObj);
          } else {
            this._filters[fieldOrObj] = value;
          }
          return this;
        },
        whereNotNull() { return this; },
        orderBy() { return this; },
        limit() { return this; },
        select() { return this; },
        forUpdate() { return this; },
        async first() {
          const filters = this._filters;
          return store.find((row) =>
            Object.entries(filters).every(([k, v]) => row[k] === v),
          ) || null;
        },
        update(fields) {
          const filters = { ...this._filters };
          return {
            async returning() {
              const idx = store.findIndex((row) =>
                Object.entries(filters).every(([k, v]) => row[k] === v),
              );
              if (idx === -1) {
                return []; // 0 rows — CAS guard fired
              }
              updateCallCount++;
              Object.assign(store[idx], fields);
              return [{ ...store[idx] }];
            },
          };
        },
      };
      return b;
    }

    const mockDb = jest.fn(() => makeBuilder());
    mockDb.client = { config: { client: 'pg' } };
    mockDb.transaction = async (fn) => fn(mockDb);

    // Dynamically require with a mocked db
    jest.resetModules();
    jest.mock('../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
    jest.mock('../db/knex', () => mockDb);

    const { publishConfig } = require('./configVersioning');

    const [r1, r2] = await Promise.allSettled([
      publishConfig('cors', { origins: ['https://racer1.com'] }, {
        tenantId: 't1', actor: 'a1', expectedVersion: 1,
      }),
      publishConfig('cors', { origins: ['https://racer2.com'] }, {
        tenantId: 't1', actor: 'a2', expectedVersion: 1,
      }),
    ]);

    const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
    const failures = [r1, r2].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason.code).toBe('STALE_VERSION');
    expect(failures[0].reason.status).toBe(409);

    // Exactly one UPDATE committed
    expect(updateCallCount).toBe(1);
    expect(store[0].version).toBe(2);

    jest.resetModules();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Standard boundary / error cases (mocked db)
// ─────────────────────────────────────────────────────────────────────────────

describe('publishConfig — boundary cases (mocked db)', () => {
  let publishConfig;
  const baseRow = {
    id: 'cfg_base',
    section: 'cors',
    config: JSON.stringify({ origins: ['https://old.com'] }),
    tenant_id: 't1',
    draft_status: 'published',
    version: 5,
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('rejects stale expectedVersion without concurrent access', async () => {
    const { db } = buildMockDb({ ...baseRow, version: 5 });
    jest.mock('../db/knex', () => db);
    publishConfig = require('./configVersioning').publishConfig;

    await expect(
      publishConfig('cors', { origins: ['https://new.com'] }, {
        tenantId: 't1', actor: 'admin', expectedVersion: 4, // stale — current is 5
      }),
    ).rejects.toMatchObject({ code: 'STALE_VERSION', status: 409 });
  });

  it('rejects identical config with EMPTY_DIFF', async () => {
    const config = { origins: ['https://same.com'] };
    const { db } = buildMockDb({ ...baseRow, config: JSON.stringify(config), version: 1 });
    jest.mock('../db/knex', () => db);
    publishConfig = require('./configVersioning').publishConfig;

    await expect(
      publishConfig('cors', config, { tenantId: 't1', actor: 'admin', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'EMPTY_DIFF', status: 422 });
  });

  it('rejects when no config record exists for section', async () => {
    const emptyDb = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
      forUpdate: jest.fn().mockReturnThis(),
    }));
    emptyDb.client = { config: { client: 'pg' } };
    emptyDb.transaction = async (fn) => fn(emptyDb);
    jest.mock('../db/knex', () => emptyDb);
    publishConfig = require('./configVersioning').publishConfig;

    await expect(
      publishConfig('cors', { origins: ['https://x.com'] }, { tenantId: 't_missing', actor: 'admin' }),
    ).rejects.toMatchObject({ code: 'NO_CONFIG', status: 404 });
  });

  it('publishes without expectedVersion (no CAS gate)', async () => {
    const { db } = buildMockDb({ ...baseRow, version: 3 });
    jest.mock('../db/knex', () => db);
    publishConfig = require('./configVersioning').publishConfig;

    const published = await publishConfig('cors', { origins: ['https://new.com'] }, {
      tenantId: 't1', actor: 'admin',
      // no expectedVersion
    });
    expect(published.version).toBe(4);
  });

  it('increments version by 1 on each successful publish', async () => {
    const row = { ...baseRow, version: 1, config: JSON.stringify({ origins: ['https://v1.com'] }) };
    const { db, store } = buildMockDb(row);
    jest.mock('../db/knex', () => db);
    publishConfig = require('./configVersioning').publishConfig;

    const v2 = await publishConfig('cors', { origins: ['https://v2.com'] }, {
      tenantId: 't1', actor: 'admin', expectedVersion: 1,
    });
    expect(v2.version).toBe(2);
  });

  it('returns the published_by actor in the result', async () => {
    const { db } = buildMockDb({ ...baseRow, version: 1, config: JSON.stringify({ origins: ['https://old.com'] }) });
    jest.mock('../db/knex', () => db);
    publishConfig = require('./configVersioning').publishConfig;

    const result = await publishConfig('cors', { origins: ['https://new.com'] }, {
      tenantId: 't1', actor: 'specific_actor', expectedVersion: 1,
    });
    expect(result.published_by).toBe('specific_actor');
  });
});
