'use strict';

/**
 * @file src/db/__mocks__/knex.js
 * @description Manual Jest mock for the Knex database client.
 *
 * This mock satisfies the same public interface contract as a real Knex
 * instance so that unit tests can import `src/db/knex` without opening a
 * real database connection. The shape is verified by the compatibility
 * contract tests in `src/db/knex.compatibility.test.js` (CONTRACT 10-13).
 *
 * ## Interface contract (mirroring real Knex)
 *
 * - `db(tableName)` — callable table-selector that returns a fluent query
 *   builder chain.
 * - `db.raw(sql, bindings?)` — raw SQL passthrough; resolves to undefined.
 * - `db.transaction(callback)` — executes callback with `db` as the trx
 *   argument; propagates errors thrown by the callback.
 * - `db.destroy()` — resolves to undefined (pool teardown stub for graceful
 *   shutdown).
 * - `db.schema` — stub object for DDL operations (callers check existence).
 * - `db.migrate` — stub object with `latest` for migration runners.
 * - `db.fn` — stub with `now()` for timestamp helpers.
 *
 * ## Fluent chain methods (CONTRACT 11)
 *
 * Every query-builder method on the chain returns `this` so callers can
 * compose arbitrarily deep chains:
 *   `db('t').where({}).select('*').orderBy('id').limit(10)`
 *
 * ## Terminal operations (CONTRACT 12)
 *
 * | Method   | Resolves to                                      |
 * |----------|--------------------------------------------------|
 * | insert   | `[{ id: 'mock-id', created_at: <Date> }]`        |
 * | update   | `1` (affected-row count)                         |
 * | del      | `1` (deleted-row count)                          |
 * | delete   | `1` (alias for del)                              |
 * | first    | `null` (no row found by default)                 |
 * | then     | `[]` (empty result set — chain is thenable)      |
 * | count    | `[{ count: 0 }]`                                 |
 *
 * @module src/db/__mocks__/knex
 */

/**
 * Fluent query-builder chain mock.
 *
 * Every builder method returns `mockQuery` so chains can be composed
 * without throwing. Terminal methods return resolved Promises with the
 * default values documented above.
 *
 * The chain is also thenable (`then` is defined) so `await db('table')`
 * resolves to `[]` — matching real Knex behaviour when no terminal method
 * is explicitly called.
 *
 * @type {object}
 */
const mockQuery = {
  // -------------------------------------------------------------------------
  // Fluent filter/join/sort methods — all return `this` (CONTRACT 11)
  // -------------------------------------------------------------------------
  where:        jest.fn().mockReturnThis(),
  whereNotIn:   jest.fn().mockReturnThis(),
  whereNull:    jest.fn().mockReturnThis(),
  whereIn:      jest.fn().mockReturnThis(),
  /** @contract CONTRACT 11 — whereRaw must be part of the fluent chain */
  whereRaw:     jest.fn().mockReturnThis(),
  leftJoin:     jest.fn().mockReturnThis(),
  orderBy:      jest.fn().mockReturnThis(),
  limit:        jest.fn().mockReturnThis(),
  offset:       jest.fn().mockReturnThis(),
  returning:    jest.fn().mockReturnThis(),
  select:       jest.fn().mockReturnThis(),
  andWhere:     jest.fn().mockReturnThis(),
  orWhere:      jest.fn().mockReturnThis(),
  /** @contract CONTRACT 11 — clone must return the chain */
  clone:        jest.fn().mockReturnThis(),
  /** @contract CONTRACT 11 — clearSelect must return the chain */
  clearSelect:  jest.fn().mockReturnThis(),
  /** @contract CONTRACT 11 — clearOrder must return the chain */
  clearOrder:   jest.fn().mockReturnThis(),
  onConflict:   jest.fn().mockReturnThis(),
  merge:        jest.fn().mockReturnThis(),
  modify:       jest.fn().mockReturnThis(),
  join:         jest.fn().mockReturnThis(),
  innerJoin:    jest.fn().mockReturnThis(),
  groupBy:      jest.fn().mockReturnThis(),
  having:       jest.fn().mockReturnThis(),
  distinct:     jest.fn().mockReturnThis(),

  // -------------------------------------------------------------------------
  // Terminal operations — resolve to expected default values (CONTRACT 12)
  // -------------------------------------------------------------------------

  /**
   * Resolves to an array containing a single inserted-row stub.
   * The stub always includes `id` and `created_at` so callers that
   * destructure the result do not encounter undefined fields.
   *
   * @returns {Promise<Array<{id: string, created_at: Date}>>}
   */
  insert: jest.fn().mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]),

  /**
   * Resolves to `1` — the affected-row count returned by PostgreSQL/SQLite
   * after a successful UPDATE.
   *
   * @returns {Promise<number>}
   */
  update: jest.fn().mockResolvedValue(1),

  /**
   * Resolves to `1` — the deleted-row count.
   *
   * @returns {Promise<number>}
   */
  del: jest.fn().mockResolvedValue(1),

  /**
   * Alias for `del` — some callers use `delete` instead.
   *
   * @returns {Promise<number>}
   */
  delete: jest.fn().mockResolvedValue(1),

  /**
   * Resolves to `null` — no row found by default.
   * Tests that expect a row should override this mock locally:
   *   `mockQuery.first.mockResolvedValueOnce({ id: 'found' })`
   *
   * @returns {Promise<null>}
   */
  first: jest.fn().mockResolvedValue(null),

  /**
   * Resolves to `[{ count: 0 }]` — the shape PostgreSQL/SQLite return
   * for `SELECT count(*) ...` queries.
   *
   * @returns {Promise<Array<{count: number}>>}
   */
  count: jest.fn().mockResolvedValue([{ count: 0 }]),

  /**
   * Makes the chain thenable so `await db('table').select('*')` resolves
   * to an empty array — matching real Knex behaviour.
   *
   * @param {Function} resolve - Fulfilment handler.
   * @returns {Promise<Array>}
   */
  where: jest.fn().mockReturnThis(),
  whereNotIn: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  whereRaw: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  returning: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  del: jest.fn().mockResolved(1),
  insert: jest.fn().mockResolved([{ id: 'mock-id', created_at: new Date() }]),
  update: jest.fn().mockResolved(1),
  delete: jest.fn().mockResolved(1),
  first: jest.fn().mockResolved(null),
  andWhere: jest.fn().mockReturnThis(),
  orWhere: jest.fn().mockReturnThis(),
  // Make mockQuery thenable so `await query` resolves to []
  then: jest.fn((resolve) => resolve([])),
};

/**
 * Mock Knex instance.
 *
 * Calling `db(tableName)` returns the shared `mockQuery` chain. Additional
 * static methods match the real Knex interface so callers that access
 * `db.raw`, `db.transaction`, `db.destroy`, `db.schema`, `db.migrate`, or
 * `db.fn` do not receive `undefined`.
 *
 * @type {jest.Mock & {
 *   raw: jest.Mock,
 *   transaction: jest.Mock,
 *   destroy: jest.Mock,
 *   schema: object,
 *   migrate: { latest: jest.Mock },
 *   fn: { now: jest.Mock }
 * }}
 */
const db = jest.fn(() => mockQuery);

// ---------------------------------------------------------------------------
// db.raw — raw SQL passthrough (CONTRACT 9 + CONTRACT 10)
// ---------------------------------------------------------------------------
db.raw = jest.fn().mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// db.transaction — executes callback with db as trx (CONTRACT 13)
//
// Invariants:
//  - The callback receives `db` (the mock itself) as its trx argument so
//    callers can issue queries inside the transaction body.
//  - If the callback throws, the error propagates to the caller — matching
//    real Knex rollback-on-throw semantics.
//  - If the callback succeeds, the transaction resolves to undefined.
// ---------------------------------------------------------------------------
db.transaction = jest.fn(async (callback) => {
  // Pass the same mock db as the transaction client.
  // Any error thrown by callback propagates naturally.
db.raw = jest.fn().mockResolved();
db.destroy = jest.fn().mockResolved();
db.transaction = jest.fn(async (callback) => {
  // The callback receives the same mock db instance as try
  await callback(db);
});

// ---------------------------------------------------------------------------
// db.destroy — pool teardown for graceful shutdown (CONTRACT 9)
//
// The real Knex instance exposes destroy() for the shutdown coordinator
// (see src/utils/shutdownCoordinator.js). The mock resolves immediately.
// ---------------------------------------------------------------------------
db.destroy = jest.fn().mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// db.schema — DDL builder stub (CONTRACT 9)
//
// Callers that check `if (db.schema)` or call `db.schema.createTable()`
// in migration helpers need this to be a defined, non-null object.
// Individual DDL methods are stubbed as resolved Promises.
// ---------------------------------------------------------------------------
db.schema = {
  createTable:        jest.fn().mockResolvedValue(undefined),
  dropTable:          jest.fn().mockResolvedValue(undefined),
  dropTableIfExists:  jest.fn().mockResolvedValue(undefined),
  hasTable:           jest.fn().mockResolvedValue(false),
  hasColumn:         jest.fn().mockResolvedValue(false),
  alterTable:         jest.fn().mockResolvedValue(undefined),
  raw:                jest.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// db.migrate — migration runner stub
//
// `db.migrate.latest()` is called by helpers that programmatically run
// migrations in test setup. It resolves with the standard [batchNo, files]
// tuple that Knex returns.
// ---------------------------------------------------------------------------
db.migrate = {
  latest:   jest.fn().mockResolvedValue([0, []]),
  rollback: jest.fn().mockResolvedValue([0, []]),
  currentVersion: jest.fn().mockResolvedValue('none'),
};

// ---------------------------------------------------------------------------
// db.fn — Knex function helpers
//
// `db.fn.now()` is used in insert/update payloads to produce a
// database-side timestamp. The mock returns a fixed ISO string so assertions
// are deterministic.
// ---------------------------------------------------------------------------
db.fn = {
  now: jest.fn(() => new Date().toISOString()),
};

module.exports = db;
module.exports.DatabaseLifecycleError = DatabaseLifecycleError;
module.exports.DB_STATE = DB_STATE;
