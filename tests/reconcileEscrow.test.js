'use strict';

/**
 * Tests for the nightly escrow reconciliation job after wiring it to the real
 * Knex `invoices` table and the Soroban read path.
 *
 * Strategy: the `db/knex` module, the worker infra, and the structured logger
 * are replaced with Jest mocks so the unit under test exercises the real query
 * shape and classification logic against a controllable fake query builder and
 * an injectable Soroban adapter.
 */

// ---- Module mocks (hoisted by Jest) -------------------------------------

// Chainable fake Knex query builder. Each table name returns a builder whose
// terminal behaviour is configured per-test via `__queue` (for selects) and
// whose inserts are recorded in `__inserts`.
const dbState = {
  selectResults: [], // FIFO queue of row arrays returned by awaited select queries
  inserts: [], // recorded insert payloads for reconciliation_runs
  firstResult: null, // row returned by .first()
  failInsert: false,
  failFirst: false,
  failSelect: false,
};

function makeBuilder(tableName) {
  const builder = {
    _table: tableName,
    leftJoin() { return builder; },
    whereIn() { return builder; },
    whereNull() { return builder; },
    where() { return builder; },
    select() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    async first() {
      if (dbState.failFirst) { throw new Error('db down'); }
      return dbState.firstResult;
    },
    async insert(payload) {
      if (dbState.failInsert) { throw new Error('insert failed'); }
      dbState.inserts.push(payload);
      return [1];
    },
    // Awaiting the builder resolves the next queued select result.
    then(resolve, reject) {
      try {
        if (dbState.failSelect) { throw new Error('select failed'); }
        const rows = dbState.selectResults.length ? dbState.selectResults.shift() : [];
        return Promise.resolve(rows).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return builder;
}

const mockDb = jest.fn((tableName) => makeBuilder(tableName));

jest.mock('../src/db/knex', () => mockDb, { virtual: true });

// Logger mock so we can assert on warn/error payloads.
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/logger', () => mockLogger, { virtual: true });

// Worker infra is irrelevant here; stub it so requiring the job is cheap.
jest.mock('../src/workers/jobQueue', () => {
  return jest.fn().mockImplementation(() => ({
    enqueue: jest.fn(() => 'job-abc123'),
  }));
}, { virtual: true });

jest.mock('../src/workers/worker', () => {
  return jest.fn().mockImplementation(() => ({
    registerHandler: jest.fn(),
  }));
}, { virtual: true });

// escrowRead transitively pulls webhooks (axios + db); stub the surface we use.
// readFundedAmount is provided by the real module, so only mock its heavy deps.
jest.mock('../src/services/webhooks', () => ({ emitWebhook: jest.fn() }), { virtual: true });
jest.mock('../src/services/tokenMeta', () => ({ getTokenMetadata: jest.fn() }), { virtual: true });

// ---- Subject under test --------------------------------------------------

const { registry, escrowReconciliationMismatches } = require('../src/metrics');
const {
  performReconciliation,
  reconcileInvoice,
  iterateInvoicesFromDb,
  persistReconciliationSummary,
  handleReconciliationJob,
  scheduleNightlyReconciliation,
  getReconciliationSummary,
  RECONCILE_STATUS,
  RECONCILABLE_STATUSES,
} = require('../src/jobs/reconcileEscrow');

// Helpers ------------------------------------------------------------------

/** Reads the current value of the mismatch counter from the registry. */
async function mismatchCount() {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'escrow_reconciliation_mismatches_total');
  return m && m.values.length ? m.values[0].value : 0;
}

/** Adapter that returns a fixed on-chain funded amount per invoice id. */
function adapterFor(map) {
  return (invoiceId) => Promise.resolve({ invoiceId, fundedAmount: map[invoiceId] });
}

beforeEach(() => {
  dbState.selectResults = [];
  dbState.inserts = [];
  dbState.firstResult = null;
  dbState.failInsert = false;
  dbState.failFirst = false;
  dbState.failSelect = false;
  jest.clearAllMocks();
  // Reset counter between tests for deterministic assertions.
  escrowReconciliationMismatches.reset();
});

// ---- reconcileInvoice ----------------------------------------------------

describe('reconcileInvoice', () => {
  it('classifies MATCH when DB and on-chain amounts are equal', async () => {
    const result = await reconcileInvoice('inv_1', 1000, {
      escrowAdapter: adapterFor({ inv_1: 1000 }),
    });
    expect(result).toEqual({
      invoiceId: 'inv_1',
      status: RECONCILE_STATUS.MATCH,
      dbFundedTotal: 1000,
      onChainAmount: 1000,
      reconciledAt: expect.any(String),
    });
    expect(await mismatchCount()).toBe(0);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('classifies MISMATCH, increments the metric, and warns with the required fields', async () => {
    const result = await reconcileInvoice('inv_2', 2000, {
      escrowAdapter: adapterFor({ inv_2: 1990 }),
    });
    expect(result).toMatchObject({
      invoiceId: 'inv_2',
      status: RECONCILE_STATUS.MISMATCH,
      dbFundedTotal: 2000,
      onChainAmount: 1990,
    });

    // Metric incremented exactly once.
    expect(await mismatchCount()).toBe(1);

    // Warning log carries invoiceId, dbFundedTotal, onChainAmount.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = mockLogger.warn.mock.calls[0];
    expect(meta).toEqual({ invoiceId: 'inv_2', dbFundedTotal: 2000, onChainAmount: 1990 });
    expect(msg).toContain('inv_2');
  });

  it('classifies ERROR when the Soroban read throws and does not touch the metric', async () => {
    const result = await reconcileInvoice('inv_3', 500, {
      escrowAdapter: () => Promise.reject(new Error('Network error')),
    });
    expect(result).toMatchObject({
      invoiceId: 'inv_3',
      status: RECONCILE_STATUS.ERROR,
      dbFundedTotal: 500,
      onChainAmount: null,
      error: 'Network error',
    });
    expect(await mismatchCount()).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it('classifies ERROR for an invalid invoice id (validation failure)', async () => {
    const result = await reconcileInvoice('bad id!!', 100, {
      escrowAdapter: adapterFor({}),
    });
    expect(result.status).toBe(RECONCILE_STATUS.ERROR);
    expect(result.onChainAmount).toBeNull();
  });
});

// ---- iterateInvoicesFromDb ----------------------------------------------

describe('iterateInvoicesFromDb', () => {
  it('queries the invoices table filtered to reconcilable, non-deleted rows', async () => {
    dbState.selectResults = [[{ id: 'a', fundedTotal: '1000' }]];
    const out = [];
    for await (const row of iterateInvoicesFromDb({ dbClient: mockDb, pageSize: 100 })) {
      out.push(row);
    }
    expect(mockDb).toHaveBeenCalledWith('invoices');
    expect(out).toEqual([{ id: 'a', fundedTotal: 1000 }]);
  });

  it('coerces string/null DECIMAL funded totals to finite numbers', async () => {
    dbState.selectResults = [[
      { id: 'a', fundedTotal: '2500.50' },
      { id: 'b', fundedTotal: null },
    ]];
    const out = [];
    for await (const row of iterateInvoicesFromDb({ dbClient: mockDb })) { out.push(row); }
    expect(out).toEqual([
      { id: 'a', fundedTotal: 2500.5 },
      { id: 'b', fundedTotal: 0 },
    ]);
  });

  it('paginates: keeps fetching full pages until a short page is returned', async () => {
    // page size 2 -> first full page of 2, then short page of 1, then stop.
    dbState.selectResults = [
      [{ id: 'a', fundedTotal: 1 }, { id: 'b', fundedTotal: 2 }],
      [{ id: 'c', fundedTotal: 3 }],
    ];
    const out = [];
    for await (const row of iterateInvoicesFromDb({ dbClient: mockDb, pageSize: 2 })) {
      out.push(row.id);
    }
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('stops cleanly on an empty first page', async () => {
    dbState.selectResults = [[]];
    const out = [];
    for await (const row of iterateInvoicesFromDb({ dbClient: mockDb })) { out.push(row); }
    expect(out).toEqual([]);
  });

  it('clamps absurd page sizes into the [1,1000] range without throwing', async () => {
    dbState.selectResults = [[]];
    const out = [];
    for await (const row of iterateInvoicesFromDb({ dbClient: mockDb, pageSize: 999999 })) {
      out.push(row);
    }
    expect(out).toEqual([]);
  });
});

// ---- performReconciliation ----------------------------------------------

describe('performReconciliation', () => {
  it('reconciles all rows, builds an accurate summary, and persists it', async () => {
    dbState.selectResults = [[
      { id: 'inv_1', fundedTotal: 1000 },
      { id: 'inv_2', fundedTotal: 2000 },
      { id: 'inv_3', fundedTotal: 500 },
    ]];

    const summary = await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_1: 1000, inv_2: 1990, inv_3: 500 }),
    });

    expect(summary).toMatchObject({ total: 3, matches: 2, mismatches: 1, errors: 0 });
    expect(summary.results).toHaveLength(3);
    expect(await mismatchCount()).toBe(1);

    // Persisted exactly one run row with serialized results.
    expect(dbState.inserts).toHaveLength(1);
    const inserted = dbState.inserts[0];
    expect(inserted).toMatchObject({ total: 3, matches: 2, mismatches: 1, errors: 0 });
    expect(typeof inserted.results).toBe('string');
    expect(JSON.parse(inserted.results)).toHaveLength(3);

    // Crucially, no global stash is used anymore.
    expect(global.reconciliationSummary).toBeUndefined();
  });

  it('counts per-invoice errors without aborting the whole run', async () => {
    dbState.selectResults = [[
      { id: 'inv_1', fundedTotal: 1000 },
      { id: 'inv_2', fundedTotal: 2000 },
    ]];

    const summary = await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: (id) =>
        id === 'inv_2'
          ? Promise.reject(new Error('RPC down'))
          : Promise.resolve({ fundedAmount: 1000 }),
    });

    expect(summary).toMatchObject({ total: 2, matches: 1, mismatches: 0, errors: 1 });
  });

  it('still returns a summary when persistence fails (insert error is swallowed)', async () => {
    dbState.selectResults = [[{ id: 'inv_1', fundedTotal: 1000 }]];
    dbState.failInsert = true;

    const summary = await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_1: 1000 }),
    });

    expect(summary.total).toBe(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('handles an empty invoice set', async () => {
    dbState.selectResults = [[]];
    const summary = await performReconciliation({ dbClient: mockDb, escrowAdapter: adapterFor({}) });
    expect(summary).toMatchObject({ total: 0, matches: 0, mismatches: 0, errors: 0 });
    expect(dbState.inserts).toHaveLength(1);
  });
});

// ---- persistReconciliationSummary ---------------------------------------

describe('persistReconciliationSummary', () => {
  it('inserts a row mapping summary fields to columns', async () => {
    const summary = {
      total: 2, matches: 1, mismatches: 1, errors: 0,
      reconciledAt: '2026-04-29T00:00:00.000Z',
      results: [{ invoiceId: 'x', status: 'match' }],
    };
    await persistReconciliationSummary(summary, mockDb);
    expect(dbState.inserts[0]).toEqual({
      total: 2, matches: 1, mismatches: 1, errors: 0,
      results: JSON.stringify(summary.results),
      reconciled_at: '2026-04-29T00:00:00.000Z',
    });
  });

  it('logs and swallows insert failures', async () => {
    dbState.failInsert = true;
    await expect(
      persistReconciliationSummary({ total: 0, matches: 0, mismatches: 0, errors: 0, results: [], reconciledAt: 'x' }, mockDb),
    ).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// ---- getReconciliationSummary -------------------------------------------

describe('getReconciliationSummary', () => {
  it('returns null when no run has been persisted', async () => {
    dbState.firstResult = null;
    expect(await getReconciliationSummary(mockDb)).toBeNull();
  });

  it('maps the latest row back into a summary, parsing JSON results', async () => {
    dbState.firstResult = {
      total: 3, matches: 2, mismatches: 1, errors: 0,
      reconciled_at: '2026-04-29T02:00:00.000Z',
      results: JSON.stringify([{ invoiceId: 'inv_2', status: 'mismatch' }]),
    };
    const summary = await getReconciliationSummary(mockDb);
    expect(summary).toMatchObject({ total: 3, matches: 2, mismatches: 1, errors: 0 });
    expect(summary.reconciledAt).toBe('2026-04-29T02:00:00.000Z');
    expect(summary.results).toEqual([{ invoiceId: 'inv_2', status: 'mismatch' }]);
  });

  it('converts a Date reconciled_at to ISO and passes through object results', async () => {
    dbState.firstResult = {
      total: 0, matches: 0, mismatches: 0, errors: 0,
      reconciled_at: new Date('2026-04-29T03:00:00.000Z'),
      results: [{ invoiceId: 'a', status: 'match' }],
    };
    const summary = await getReconciliationSummary(mockDb);
    expect(summary.reconciledAt).toBe('2026-04-29T03:00:00.000Z');
    expect(summary.results).toEqual([{ invoiceId: 'a', status: 'match' }]);
  });

  it('returns null and logs when the DB read fails', async () => {
    dbState.failFirst = true;
    expect(await getReconciliationSummary(mockDb)).toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// ---- scheduleNightlyReconciliation & constants --------------------------

describe('handleReconciliationJob', () => {
  it('returns success with a summary on a clean run (default db path)', async () => {
    dbState.selectResults = [[]]; // no invoices to reconcile
    const res = await handleReconciliationJob({});
    expect(res.success).toBe(true);
    expect(res.summary).toMatchObject({ total: 0 });
  });

  it('returns a failure result when the run throws', async () => {
    dbState.failSelect = true; // make the invoices scan reject
    const res = await handleReconciliationJob({});
    expect(res.success).toBe(false);
    expect(res.error).toBe('select failed');
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe('scheduleNightlyReconciliation', () => {
  it('enqueues a reconcile_escrow job and returns its id', () => {
    const jobId = scheduleNightlyReconciliation();
    expect(jobId).toBe('job-abc123');
  });
});

describe('RECONCILABLE_STATUSES', () => {
  it('covers both linked_escrow and the funded SQL states', () => {
    expect(RECONCILABLE_STATUSES).toEqual(
      expect.arrayContaining(['linked_escrow', 'funded', 'partially_funded']),
    );
  });
});

// ---- readFundedAmount (escrowRead) --------------------------------------

describe('readFundedAmount', () => {
  const { readFundedAmount } = require('../src/services/escrowRead');

  it('uses the production base-state stub when no adapter is injected', async () => {
    // 'funded_invoice' is the stub fixture that reports fundedAmount 1000.
    await expect(readFundedAmount('funded_invoice')).resolves.toBe(1000);
    // Unknown id -> stub returns 0.
    await expect(readFundedAmount('some_other_invoice')).resolves.toBe(0);
  });

  it('accepts a bare numeric adapter return', async () => {
    const amount = await readFundedAmount('inv_1', { escrowAdapter: () => Promise.resolve(750) });
    expect(amount).toBe(750);
  });

  it('falls back to 0 for a non-finite on-chain value', async () => {
    const amount = await readFundedAmount('inv_1', {
      escrowAdapter: () => Promise.resolve({ fundedAmount: 'not-a-number' }),
    });
    expect(amount).toBe(0);
  });

  it('throws INVALID_INVOICE_ID for a malformed id', async () => {
    await expect(readFundedAmount('   ')).rejects.toMatchObject({ code: 'INVALID_INVOICE_ID' });
  });
});
