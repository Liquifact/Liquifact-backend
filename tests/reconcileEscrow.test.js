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

const {
  registry,
  escrowReconciliationMismatches,
  escrowReconciliationMismatchedInvoicesGauge,
  escrowReconciliationDriftMagnitudeGauge,
  escrowReconciliationDriftAlertsTotal,
} = require('../src/metrics');
const {
  performReconciliation,
  reconcileInvoice,
  iterateInvoicesFromDb,
  persistReconciliationSummary,
  handleReconciliationJob,
  scheduleNightlyReconciliation,
  getReconciliationSummary,
  raiseReconciliationMismatchAlert,
  getMismatchAlertChannel,
  getMismatchAlertThreshold,
  getDriftThreshold,
  RECONCILE_STATUS,
  RECONCILABLE_STATUSES,
  DRIFT_THRESHOLD,
} = require('../src/jobs/reconcileEscrow');

// Helpers ------------------------------------------------------------------

/** Reads the current value of the mismatch counter from the registry. */
async function mismatchCount() {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'escrow_reconciliation_mismatches_total');
  return m && m.values.length ? m.values[0].value : 0;
}

/** Reads the current value of the mismatched-invoices gauge. */
async function mismatchedInvoicesGaugeValue() {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'escrow_reconciliation_mismatched_invoices');
  return m && m.values.length ? m.values[0].value : 0;
}

/** Reads the current value of the drift-magnitude gauge. */
async function driftMagnitudeGaugeValue() {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'escrow_reconciliation_drift_magnitude');
  return m && m.values.length ? m.values[0].value : 0;
}

/** Reads the current value of the drift-alerts counter. */
async function driftAlertsCount() {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'escrow_reconciliation_drift_alerts_total');
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
  // Reset all reconciliation counters/gauges between tests for deterministic assertions.
  escrowReconciliationMismatches.reset();
  escrowReconciliationMismatchedInvoicesGauge.reset();
  escrowReconciliationDriftMagnitudeGauge.reset();
  escrowReconciliationDriftAlertsTotal.reset();
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
      driftMagnitude: 0,
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
      driftMagnitude: 10,
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

  it('reads from the projection table when no adapter is injected', async () => {
    // Seed a projection row for 'funded_invoice' — the read path now resolves
    // funded_invoice through the projection table instead of any hardcoded
    // fixture, so the value comes straight from event data.
    dbState.firstResult = {
      invoice_id: 'funded_invoice',
      latest_event_id: 'evt_live_1',
      latest_event_type: 'funded',
      latest_ledger_sequence: 9001,
      latest_event_body: JSON.stringify({ status: 'funded', fundedAmount: 1000 }),
    };

    await expect(readFundedAmount('funded_invoice')).resolves.toBe(1000);
  });

  it('returns the neutral 0 when neither projection nor adapter has data', async () => {
    dbState.firstResult = null; // no projection row
    await expect(readFundedAmount('some_other_invoice')).resolves.toBe(0);
  });

  it('accepts a bare numeric adapter return', async () => {
    // Adapter short-circuits: the projection lookup must not run.
    dbState.firstResult = { latest_event_body: JSON.stringify({ fundedAmount: 9999 }) };
    const amount = await readFundedAmount('inv_1', { escrowAdapter: () => Promise.resolve(750) });
    expect(amount).toBe(750);
  });

  it('falls back to 0 for a non-finite adapter value', async () => {
    const amount = await readFundedAmount('inv_1', {
      escrowAdapter: () => Promise.resolve({ fundedAmount: 'not-a-number' }),
    });
    expect(amount).toBe(0);
  });

  it('throws INVALID_INVOICE_ID for a malformed id', async () => {
    await expect(readFundedAmount('   ')).rejects.toMatchObject({ code: 'INVALID_INVOICE_ID' });
  });
});

// ── drift alerting metrics (performReconciliation post-run gauges) ─────────

describe('drift alerting metrics', () => {
  it('sets mismatched-invoices gauge and drift-magnitude gauge to 0 when there is no drift', async () => {
    dbState.selectResults = [[
      { id: 'inv_1', fundedTotal: 1000 },
      { id: 'inv_2', fundedTotal: 2000 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_1: 1000, inv_2: 2000 }),
    });

    expect(await mismatchedInvoicesGaugeValue()).toBe(0);
    expect(await driftMagnitudeGaugeValue()).toBe(0);
    expect(await driftAlertsCount()).toBe(0);
    // No error-level alert log should be emitted.
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('sets mismatched-invoices gauge, drift-magnitude gauge, and increments drift-alerts when drift exceeds threshold', async () => {
    // Temporarily lower the threshold so we can trigger an alert with one mismatch.
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';

    dbState.selectResults = [[
      { id: 'inv_1', fundedTotal: 1000 },
      { id: 'inv_2', fundedTotal: 500 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_1: 800, inv_2: 500 }), // inv_1 has drift of 200
    });

    // One mismatch with |1000 - 800| = 200 drift.
    expect(await mismatchedInvoicesGaugeValue()).toBe(1);
    expect(await driftMagnitudeGaugeValue()).toBe(200);
    expect(await driftAlertsCount()).toBe(1);

    // An error-level log should be emitted for the threshold breach.
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const errorCall = mockLogger.error.mock.calls[0];
    const meta = errorCall[0];
    expect(meta).toMatchObject({ mismatches: 1, totalDrift: 200 });
    expect(errorCall[1]).toMatch(/drift alert/i);

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });

  it('accumulates total drift magnitude across multiple mismatched invoices', async () => {
    dbState.selectResults = [[
      { id: 'inv_1', fundedTotal: 1000 },
      { id: 'inv_2', fundedTotal: 2000 },
      { id: 'inv_3', fundedTotal: 300 },
    ]];

    // inv_1: drift 200, inv_2: drift 500, inv_3: match
    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_1: 800, inv_2: 1500, inv_3: 300 }),
    });

    expect(await mismatchedInvoicesGaugeValue()).toBe(2);
    expect(await driftMagnitudeGaugeValue()).toBe(700); // 200 + 500
  });

  it('does NOT increment drift-alerts counter when mismatches are below threshold', async () => {
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    // Set threshold to 3 so a single mismatch doesn't alert.
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '3';

    dbState.selectResults = [[
      { id: 'inv_1', fundedTotal: 1000 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_1: 999 }), // 1 mismatch < threshold of 3
    });

    expect(await driftAlertsCount()).toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });

  it('zero-drift run: gauges reflect empty invoice set', async () => {
    dbState.selectResults = [[]];

    await performReconciliation({ dbClient: mockDb, escrowAdapter: adapterFor({}) });

    expect(await mismatchedInvoicesGaugeValue()).toBe(0);
    expect(await driftMagnitudeGaugeValue()).toBe(0);
    expect(await driftAlertsCount()).toBe(0);
  });
});


// ── raiseReconciliationMismatchAlert ──────────────────────────────────────

describe('raiseReconciliationMismatchAlert', () => {
  describe('alert channel: log', () => {
    let origChannel;
    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'log';
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    });
    afterEach(() => {
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('emits a warn log with all required structured fields', () => {
      raiseReconciliationMismatchAlert({
        invoiceId: 'inv_log_1',
        expected: 5000,
        actual: 4800,
        driftMagnitude: 200,
        runMismatches: 1,
      });

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const [meta, msg] = mockLogger.warn.mock.calls[0];
      expect(meta).toMatchObject({
        alert: 'reconciliation_mismatch',
        invoiceId: 'inv_log_1',
        expected: 5000,
        actual: 4800,
        driftMagnitude: 200,
        runMismatches: 1,
      });
      expect(msg).toMatch(/mismatch/i);
    });

    it('does NOT emit a warn when runMismatches is below threshold', () => {
      process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = '3';
      raiseReconciliationMismatchAlert({
        invoiceId: 'inv_below',
        expected: 100,
        actual: 90,
        driftMagnitude: 10,
        runMismatches: 2, // below threshold of 3
      });
      expect(mockLogger.warn).not.toHaveBeenCalled();
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    });

    it('emits a warn exactly at the threshold boundary', () => {
      process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = '2';
      raiseReconciliationMismatchAlert({
        invoiceId: 'inv_boundary',
        expected: 100,
        actual: 90,
        driftMagnitude: 10,
        runMismatches: 2, // exactly at threshold
      });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    });
  });

  describe('alert channel: sentry (Sentry disabled)', () => {
    let origChannel;
    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry';
    });
    afterEach(() => {
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('does not throw when Sentry is disabled', () => {
      // Sentry is not enabled in test environment (no SENTRY_DSN)
      expect(() => {
        raiseReconciliationMismatchAlert({
          invoiceId: 'inv_sentry_off',
          expected: 500,
          actual: 450,
          driftMagnitude: 50,
          runMismatches: 1,
        });
      }).not.toThrow();
      // No warn log on sentry-only channel
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('alert channel: sentry+log (default)', () => {
    let origChannel;
    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry+log';
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    });
    afterEach(() => {
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('always emits a warn log on sentry+log channel', () => {
      raiseReconciliationMismatchAlert({
        invoiceId: 'inv_sl',
        expected: 300,
        actual: 200,
        driftMagnitude: 100,
        runMismatches: 1,
      });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('does not throw when Sentry is disabled (graceful fallback)', () => {
      expect(() => {
        raiseReconciliationMismatchAlert({
          invoiceId: 'inv_sl2',
          expected: 300,
          actual: 200,
          driftMagnitude: 100,
          runMismatches: 1,
        });
      }).not.toThrow();
    });
  });

  describe('invalid/unknown channel falls back to sentry+log', () => {
    let origChannel;
    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'unknown_channel';
    });
    afterEach(() => {
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('treats unknown channel as sentry+log and emits warn', () => {
      raiseReconciliationMismatchAlert({
        invoiceId: 'inv_unk',
        expected: 100,
        actual: 80,
        driftMagnitude: 20,
        runMismatches: 1,
      });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('default runMismatches=1 behavior', () => {
    let origChannel;
    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'log';
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    });
    afterEach(() => {
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('fires with default runMismatches=1 when threshold is 1 (default)', () => {
      // Called without runMismatches; defaults to 1, threshold defaults to 1 → fires
      raiseReconciliationMismatchAlert({
        invoiceId: 'inv_def',
        expected: 1000,
        actual: 900,
        driftMagnitude: 100,
      });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });
  });
});

// ── getMismatchAlertChannel / getMismatchAlertThreshold / getDriftThreshold ─

describe('getMismatchAlertChannel', () => {
  const origEnv = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
    } else {
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origEnv;
    }
  });

  it('defaults to sentry+log when unset', () => {
    delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
    expect(getMismatchAlertChannel()).toBe('sentry+log');
  });

  it('returns log when set to log', () => {
    process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'log';
    expect(getMismatchAlertChannel()).toBe('log');
  });

  it('returns sentry when set to sentry', () => {
    process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry';
    expect(getMismatchAlertChannel()).toBe('sentry');
  });

  it('falls back to sentry+log for unknown values', () => {
    process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'pagerduty';
    expect(getMismatchAlertChannel()).toBe('sentry+log');
  });
});

describe('getMismatchAlertThreshold', () => {
  const origEnv = process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = origEnv;
    }
  });

  it('defaults to 1 when unset', () => {
    delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
    expect(getMismatchAlertThreshold()).toBe(1);
  });

  it('parses a valid integer', () => {
    process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = '5';
    expect(getMismatchAlertThreshold()).toBe(5);
  });

  it('clamps below 1 to 1', () => {
    process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = '0';
    expect(getMismatchAlertThreshold()).toBe(1);
  });

  it('returns 1 for non-numeric value', () => {
    process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = 'abc';
    expect(getMismatchAlertThreshold()).toBe(1);
  });
});

describe('getDriftThreshold', () => {
  const origEnv = process.env.RECONCILIATION_DRIFT_THRESHOLD;
  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = origEnv;
    }
  });

  it('defaults to 1 when unset', () => {
    delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    expect(getDriftThreshold()).toBe(1);
  });

  it('parses a valid integer', () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '3';
    expect(getDriftThreshold()).toBe(3);
  });

  it('clamps below 1 to 1', () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '-5';
    expect(getDriftThreshold()).toBe(1);
  });
});

// ── performReconciliation: per-invoice alert integration ──────────────────

describe('performReconciliation: per-invoice alert via raiseReconciliationMismatchAlert', () => {
  let origThreshold;
  let origChannel;

  beforeEach(() => {
    origThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
    process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'log';
  });

  afterEach(() => {
    if (origThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = origThreshold;
    }
    if (origChannel === undefined) {
      delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
    } else {
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
    }
  });

  it('raises per-invoice alert when threshold is breached', async () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';
    dbState.selectResults = [[
      { id: 'inv_a', fundedTotal: 1000 },
      { id: 'inv_b', fundedTotal: 2000 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_a: 800, inv_b: 2000 }), // inv_a mismatches
    });

    // mockLogger.warn should have been called for both the mismatch warning AND the alert
    const warnCalls = mockLogger.warn.mock.calls;
    const alertCall = warnCalls.find(([meta]) => meta && meta.alert === 'reconciliation_mismatch');
    expect(alertCall).toBeDefined();
    expect(alertCall[0]).toMatchObject({
      alert: 'reconciliation_mismatch',
      invoiceId: 'inv_a',
      expected: 1000,
      actual: 800,
      driftMagnitude: 200,
    });
  });

  it('raises per-invoice alerts for ALL mismatched invoices when threshold is breached', async () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';
    dbState.selectResults = [[
      { id: 'inv_x', fundedTotal: 100 },
      { id: 'inv_y', fundedTotal: 200 },
      { id: 'inv_z', fundedTotal: 300 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_x: 90, inv_y: 180, inv_z: 300 }), // inv_x and inv_y mismatch
    });

    const warnCalls = mockLogger.warn.mock.calls;
    const alertCalls = warnCalls.filter(([meta]) => meta && meta.alert === 'reconciliation_mismatch');
    expect(alertCalls).toHaveLength(2);
    const alertedIds = alertCalls.map(([meta]) => meta.invoiceId).sort();
    expect(alertedIds).toEqual(['inv_x', 'inv_y']);
  });

  it('does NOT raise per-invoice alerts when mismatches are below threshold', async () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '5';
    process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = '5';
    dbState.selectResults = [[
      { id: 'inv_low', fundedTotal: 1000 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_low: 999 }), // 1 mismatch < threshold of 5
    });

    const warnCalls = mockLogger.warn.mock.calls;
    const alertCall = warnCalls.find(([meta]) => meta && meta.alert === 'reconciliation_mismatch');
    expect(alertCall).toBeUndefined();
    delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
  });

  it('does NOT raise per-invoice alerts when there are no mismatches', async () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';
    dbState.selectResults = [[
      { id: 'inv_ok', fundedTotal: 500 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      escrowAdapter: adapterFor({ inv_ok: 500 }),
    });

    const warnCalls = mockLogger.warn.mock.calls;
    const alertCall = warnCalls.find(([meta]) => meta && meta.alert === 'reconciliation_mismatch');
    expect(alertCall).toBeUndefined();
  });

  it('does NOT raise alerts for ERROR status invoices', async () => {
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';
    dbState.selectResults = [[
      { id: 'inv_err', fundedTotal: 1000 },
    ]];

    await performReconciliation({
      dbClient: mockDb,
      // escrowAdapter throws for inv_err — this is an ERROR not a MISMATCH
      escrowAdapter: () => Promise.reject(new Error('RPC fail')),
    });

    const warnCalls = mockLogger.warn.mock.calls;
    const alertCall = warnCalls.find(([meta]) => meta && meta.alert === 'reconciliation_mismatch');
    expect(alertCall).toBeUndefined();
  });
});

// ── checkReconciliationHealth ─────────────────────────────────────────────

describe('checkReconciliationHealth', () => {
  const { checkReconciliationHealth } = require('../src/services/health');

  beforeEach(() => {
    // Reset dbState for health lookups that go through getReconciliationSummary
    dbState.firstResult = null;
    dbState.failFirst = false;
  });

  it('returns not_run when no reconciliation has ever run', async () => {
    dbState.firstResult = null;
    const result = await checkReconciliationHealth();
    expect(result.status).toBe('not_run');
    expect(result.error).toMatch(/not been run/i);
  });

  it('returns healthy with mismatch summary fields when last run is clean', async () => {
    dbState.firstResult = {
      total: 10,
      matches: 10,
      mismatches: 0,
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: JSON.stringify([]),
    };
    const result = await checkReconciliationHealth();
    expect(result.status).toBe('healthy');
    expect(result.mismatches).toBe(0);
    expect(result.totalDrift).toBe(0);
    expect(result.thresholdBreached).toBe(false);
    expect(typeof result.threshold).toBe('number');
    expect(result.lastRun).toBeDefined();
  });

  it('returns degraded when mismatches are present but below threshold', async () => {
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '5';

    dbState.firstResult = {
      total: 10,
      matches: 8,
      mismatches: 2, // below threshold of 5
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: JSON.stringify([
        { invoiceId: 'inv_1', status: 'mismatch', driftMagnitude: 100 },
        { invoiceId: 'inv_2', status: 'mismatch', driftMagnitude: 50 },
      ]),
    };

    const result = await checkReconciliationHealth();
    expect(result.status).toBe('degraded');
    expect(result.mismatches).toBe(2);
    expect(result.totalDrift).toBe(150);
    expect(result.threshold).toBe(5);
    expect(result.thresholdBreached).toBe(false);
    expect(result.lastRun).toBeDefined();

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });

  it('returns mismatch_threshold_breached when mismatches meet threshold', async () => {
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '2';

    dbState.firstResult = {
      total: 10,
      matches: 8,
      mismatches: 2, // exactly at threshold of 2
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: JSON.stringify([
        { invoiceId: 'inv_1', status: 'mismatch', driftMagnitude: 500 },
        { invoiceId: 'inv_2', status: 'mismatch', driftMagnitude: 300 },
      ]),
    };

    const result = await checkReconciliationHealth();
    expect(result.status).toBe('mismatch_threshold_breached');
    expect(result.mismatches).toBe(2);
    expect(result.totalDrift).toBe(800);
    expect(result.threshold).toBe(2);
    expect(result.thresholdBreached).toBe(true);
    expect(result.lastRun).toBeDefined();

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });

  it('returns mismatch_threshold_breached when mismatches exceed threshold', async () => {
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '2';

    dbState.firstResult = {
      total: 10,
      matches: 5,
      mismatches: 5, // exceeds threshold of 2
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: JSON.stringify([
        { invoiceId: 'inv_a', status: 'mismatch', driftMagnitude: 100 },
        { invoiceId: 'inv_b', status: 'mismatch', driftMagnitude: 200 },
        { invoiceId: 'inv_c', status: 'mismatch', driftMagnitude: 150 },
        { invoiceId: 'inv_d', status: 'mismatch', driftMagnitude: 75 },
        { invoiceId: 'inv_e', status: 'mismatch', driftMagnitude: 25 },
      ]),
    };

    const result = await checkReconciliationHealth();
    expect(result.status).toBe('mismatch_threshold_breached');
    expect(result.thresholdBreached).toBe(true);
    expect(result.totalDrift).toBe(550);

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });

  it('returns stale when last run was more than 25 hours ago', async () => {
    const staleTimestamp = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    dbState.firstResult = {
      total: 5,
      matches: 5,
      mismatches: 0,
      errors: 0,
      reconciled_at: staleTimestamp,
      results: JSON.stringify([]),
    };

    const result = await checkReconciliationHealth();
    expect(result.status).toBe('stale');
    expect(result.lastRun).toBe(staleTimestamp);
    expect(result.error).toMatch(/not run recently/i);
  });

  it('returns not_run when DB lookup fails (getReconciliationSummary swallows errors → returns null)', async () => {
    // getReconciliationSummary catches its own errors and returns null.
    // checkReconciliationHealth therefore sees null and returns not_run.
    dbState.failFirst = true;
    const result = await checkReconciliationHealth();
    expect(['not_run', 'error']).toContain(result.status);
  });

  it('handles missing results field in summary (totalDrift defaults to 0)', async () => {
    dbState.firstResult = {
      total: 5,
      matches: 3,
      mismatches: 2,
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: null, // no results array
    };
    // With threshold=1 (default), 2 mismatches >= 1 → mismatch_threshold_breached
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';

    const result = await checkReconciliationHealth();
    expect(result.totalDrift).toBe(0); // defaults gracefully
    expect(['mismatch_threshold_breached', 'degraded']).toContain(result.status);

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });
});

// ── performReadinessChecks: reconciliation integration ───────────────────

describe('performReadinessChecks: reconciliation threshold degrades readiness', () => {
  const { performReadinessChecks } = require('../src/services/health');

  // Mock all the other health checks to return healthy so reconciliation is
  // the only variable.
  beforeEach(() => {
    // Use a fresh dbState for each test
    dbState.firstResult = null;
    dbState.failFirst = false;
  });

  it('is healthy when reconciliation returns healthy', async () => {
    // Return a clean recent run
    dbState.firstResult = {
      total: 5,
      matches: 5,
      mismatches: 0,
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: JSON.stringify([]),
    };

    const result = await performReadinessChecks();
    expect(result.checks.reconciliation).toBeDefined();
    expect(result.checks.reconciliation.status).toBe('healthy');
  });

  it('degrades readiness when reconciliation status is mismatch_threshold_breached', async () => {
    const originalThreshold = process.env.RECONCILIATION_DRIFT_THRESHOLD;
    process.env.RECONCILIATION_DRIFT_THRESHOLD = '1';

    dbState.firstResult = {
      total: 5,
      matches: 4,
      mismatches: 1,
      errors: 0,
      reconciled_at: new Date().toISOString(),
      results: JSON.stringify([{ invoiceId: 'inv_1', status: 'mismatch', driftMagnitude: 100 }]),
    };

    const result = await performReadinessChecks();
    expect(result.checks.reconciliation.status).toBe('mismatch_threshold_breached');
    // healthy should be false due to threshold breach
    expect(result.healthy).toBe(false);

    if (originalThreshold === undefined) {
      delete process.env.RECONCILIATION_DRIFT_THRESHOLD;
    } else {
      process.env.RECONCILIATION_DRIFT_THRESHOLD = originalThreshold;
    }
  });

  it('is not blocked when reconciliation has not_run status (fresh deployment)', async () => {
    dbState.firstResult = null; // no runs yet

    const result = await performReadinessChecks();
    expect(result.checks.reconciliation.status).toBe('not_run');
    // not_run should not block readiness (fresh deployment scenario)
    // Result depends on other checks, but reconciliation should not be the blocker
    expect(result.checks.reconciliation.status).not.toBe('mismatch_threshold_breached');
  });

  it('is not blocked when reconciliation DB lookup fails (not_run or error — non-blocking)', async () => {
    // getReconciliationSummary swallows errors → checkReconciliationHealth returns not_run.
    // Either way, it should not be mismatch_threshold_breached.
    dbState.failFirst = true;

    const result = await performReadinessChecks();
    // error or not_run — neither should block readiness
    expect(result.checks.reconciliation.status).not.toBe('mismatch_threshold_breached');
  });

  it('includes reconciliation in checks object', async () => {
    dbState.firstResult = null;
    const result = await performReadinessChecks();
    expect(result.checks).toHaveProperty('database');
    expect(result.checks).toHaveProperty('soroban');
    expect(result.checks).toHaveProperty('storage');
    expect(result.checks).toHaveProperty('reconciliation');
  });
});

// ── GET /api/admin/reconciliation/runs (route handler) ────────────────────


const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Sign a test JWT that satisfies authenticateToken (uses the secret from tests/mocks/setup.js)
const TEST_JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
const TEST_TENANT_ID = 'tenant-abc';
const adminToken = jwt.sign(
  { id: 'admin-user', tenantId: TEST_TENANT_ID, role: 'admin' },
  TEST_JWT_SECRET,
  { algorithm: 'HS256' },
);

/**
 * Builds a minimal Express app mounting the reconciliation router with a
 * real adminStack (JWT auth + tenant extraction). Pass an optional fakeDb to
 * inject via req._dbClient before the router runs.
 *
 * @param {Function|null} fakeDb - Injectable knex mock, attached as req._dbClient
 * @returns {import('express').Express}
 */
function makeRouteApp(fakeDb) {
  const app = express();
  app.use(express.json());
  // Inject the db client before the router fires.
  if (fakeDb) {
    app.use('/api/admin/reconciliation', (req, _res, next) => {
      req._dbClient = fakeDb;
      next();
    });
  }
  const reconciliationRouter = require('../src/routes/reconciliation');
  app.use('/api/admin/reconciliation', reconciliationRouter);
  return app;
}

/** Helper: build the Authorization header value. */
const authHeader = `Bearer ${adminToken}`;

describe('GET /api/admin/reconciliation/runs', () => {
  describe('successful listing', () => {
    let app;

    const sampleRuns = [
      { id: 'run-1', total: 10, matches: 9, mismatches: 1, errors: 0, reconciled_at: '2026-06-25T02:00:00.000Z', created_at: '2026-06-25T02:00:01.000Z' },
      { id: 'run-2', total: 8, matches: 8, mismatches: 0, errors: 0, reconciled_at: '2026-06-24T02:00:00.000Z', created_at: '2026-06-24T02:00:01.000Z' },
    ];

    beforeEach(() => {
      const fakeDb = jest.fn((table) => {
        if (table !== 'reconciliation_runs') return makeBuilder(table);
        return {
          count: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          offset: jest.fn().mockResolvedValue(sampleRuns),
          then: (res) => Promise.resolve([{ count: String(sampleRuns.length) }]).then(res),
        };
      });
      app = makeRouteApp(fakeDb);
    });

    it('returns 200 with data array and pagination meta', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toMatchObject({
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
        hasMore: false,
      });
      expect(res.body.message).toMatch(/retrieved/i);
    });

    it('respects limit and page query params', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=1&page=1')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ limit: 1, page: 1 });
    });

    it('does NOT expose results (per-invoice on-chain details) in list rows', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(200);
      res.body.data.forEach((row) => {
        expect(row.results).toBeUndefined();
      });
    });
  });

  describe('pagination validation', () => {
    let app;

    beforeEach(() => {
      // No fakeDb needed — validation fails before any DB query.
      app = makeRouteApp(null);
    });

    it('returns 400 when limit is out of range (> 100)', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=999')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });

    it('returns 400 when limit is 0', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=0')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(400);
    });

    it('returns 400 when page is 0', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?page=0')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-numeric limit', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs?limit=abc')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(400);
    });
  });

  describe('empty history', () => {
    let app;

    beforeEach(() => {
      const emptyDb = jest.fn((table) => {
        if (table !== 'reconciliation_runs') return makeBuilder(table);
        return {
          count: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          offset: jest.fn().mockResolvedValue([]),
          then: (res) => Promise.resolve([{ count: '0' }]).then(res),
        };
      });
      app = makeRouteApp(emptyDb);
    });

    it('returns 200 with empty data array when no runs have been recorded', async () => {
      const res = await request(app)
        .get('/api/admin/reconciliation/runs')
        .set('Authorization', authHeader)
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
      expect(res.body.meta.hasMore).toBe(false);
    });
  });

  describe('unauthorized caller', () => {
    it('returns 401 when no Authorization header is supplied', async () => {
      const app = makeRouteApp(null);
      const res = await request(app)
        .get('/api/admin/reconciliation/runs')
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(401);
    });

    it('returns 401 when a bogus token is supplied', async () => {
      const app = makeRouteApp(null);
      const res = await request(app)
        .get('/api/admin/reconciliation/runs')
        .set('Authorization', 'Bearer not-a-real-token')
        .set('x-tenant-id', TEST_TENANT_ID);
      expect(res.status).toBe(401);
    });
  });
});

describe('DRIFT_THRESHOLD constant', () => {
  it('is a positive integer (at least 1)', () => {
    expect(Number.isInteger(DRIFT_THRESHOLD)).toBe(true);
    expect(DRIFT_THRESHOLD).toBeGreaterThanOrEqual(1);
  });
});

// ── raiseReconciliationMismatchAlert: Sentry-enabled paths ────────────────
//
// Lines 169-191 in reconcileEscrow.js are the Sentry branches: they only run
// when sentry.isEnabled() returns true and @sentry/node is loadable. We use
// jest.isolateModules() + jest.doMock() to reload reconcileEscrow.js in a fresh
// registry where both the sentry wrapper and @sentry/node are replaced with
// controllable shims. The isolated function is captured from within the
// isolateModules callback and called from the it() body.

describe('raiseReconciliationMismatchAlert: Sentry-enabled paths', () => {

  describe('withScope path (Sentry fully initialized)', () => {
    let origChannel;
    let origThreshold;
    // These are assigned inside isolateModules so the it() bodies see them.
    let isolatedRaise;
    let mockWithScopeFn;
    let mockCaptureExceptionFn;
    let mockSetTagFn;
    let mockSetExtraFn;

    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      origThreshold = process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry';
      delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;

      mockCaptureExceptionFn = jest.fn();
      mockSetTagFn = jest.fn();
      mockSetExtraFn = jest.fn();
      mockWithScopeFn = jest.fn((cb) => cb({ setTag: mockSetTagFn, setExtra: mockSetExtraFn }));

      jest.isolateModules(() => {
        jest.doMock('@sentry/node', () => ({
          withScope: mockWithScopeFn,
          captureException: mockCaptureExceptionFn,
        }));

        jest.doMock('../src/observability/sentry', () => ({
          isEnabled: () => true,
          captureException: mockCaptureExceptionFn,
        }));

        // Re-mock transitive deps so the module loads cleanly.
        jest.doMock('../src/db/knex', () => mockDb);
        jest.doMock('../src/logger', () => mockLogger);
        jest.doMock('../src/workers/jobQueue', () =>
          jest.fn().mockImplementation(() => ({ enqueue: jest.fn() })));
        jest.doMock('../src/workers/worker', () =>
          jest.fn().mockImplementation(() => ({ registerHandler: jest.fn() })));

        isolatedRaise = require('../src/jobs/reconcileEscrow').raiseReconciliationMismatchAlert;
      });
    });

    afterEach(() => {
      jest.resetModules();
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
      if (origThreshold === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_THRESHOLD = origThreshold;
      }
    });

    it('calls withScope and sets all required tags + extras when Sentry is enabled', () => {
      isolatedRaise({
        invoiceId: 'inv_sentry_scope',
        expected: 10000,
        actual: 9000,
        driftMagnitude: 1000,
        runMismatches: 1,
      });

      expect(mockWithScopeFn).toHaveBeenCalledTimes(1);

      expect(mockSetTagFn).toHaveBeenCalledWith('alert_type', 'reconciliation_mismatch');
      expect(mockSetTagFn).toHaveBeenCalledWith('invoice_id', 'inv_sentry_scope');

      expect(mockSetExtraFn).toHaveBeenCalledWith('expected', 10000);
      expect(mockSetExtraFn).toHaveBeenCalledWith('actual', 9000);
      expect(mockSetExtraFn).toHaveBeenCalledWith('drift_magnitude', 1000);
      expect(mockSetExtraFn).toHaveBeenCalledWith('run_mismatches', 1);
      expect(mockSetExtraFn).toHaveBeenCalledWith('threshold', expect.any(Number));

      expect(mockCaptureExceptionFn).toHaveBeenCalledTimes(1);
      expect(mockCaptureExceptionFn.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(mockCaptureExceptionFn.mock.calls[0][0].message).toMatch(/reconciliation mismatch/i);
    });

    it('does not emit a warn log on sentry-only channel even when Sentry is enabled', () => {
      isolatedRaise({
        invoiceId: 'inv_sentry_only',
        expected: 500,
        actual: 400,
        driftMagnitude: 100,
        runMismatches: 1,
      });
      // sentry channel → no warn log
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('fires both warn log and withScope on sentry+log channel', () => {
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry+log';

      isolatedRaise({
        invoiceId: 'inv_both',
        expected: 300,
        actual: 250,
        driftMagnitude: 50,
        runMismatches: 1,
      });

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockWithScopeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('fallback path: Sentry enabled but withScope absent from @sentry/node', () => {
    let origChannel;
    let isolatedRaise;
    let mockFallbackCapture;

    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry';

      mockFallbackCapture = jest.fn();

      jest.isolateModules(() => {
        // @sentry/node present but withScope is absent → else branch
        jest.doMock('@sentry/node', () => ({
          captureException: jest.fn(),
          // withScope intentionally absent
        }));

        jest.doMock('../src/observability/sentry', () => ({
          isEnabled: () => true,
          captureException: mockFallbackCapture,
        }));

        jest.doMock('../src/db/knex', () => mockDb);
        jest.doMock('../src/logger', () => mockLogger);
        jest.doMock('../src/workers/jobQueue', () =>
          jest.fn().mockImplementation(() => ({ enqueue: jest.fn() })));
        jest.doMock('../src/workers/worker', () =>
          jest.fn().mockImplementation(() => ({ registerHandler: jest.fn() })));

        isolatedRaise = require('../src/jobs/reconcileEscrow').raiseReconciliationMismatchAlert;
      });
    });

    afterEach(() => {
      jest.resetModules();
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('falls back to sentry.captureException wrapper when withScope is absent', () => {
      isolatedRaise({
        invoiceId: 'inv_fallback',
        expected: 200,
        actual: 150,
        driftMagnitude: 50,
        runMismatches: 1,
      });

      expect(mockFallbackCapture).toHaveBeenCalledTimes(1);
      expect(mockFallbackCapture.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });

  describe('error resilience: @sentry/node require throws', () => {
    let origChannel;
    let isolatedRaise;

    beforeEach(() => {
      origChannel = process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = 'sentry+log';

      jest.isolateModules(() => {
        // Simulates @sentry/node not installed: require throws ModuleNotFoundError
        jest.doMock('@sentry/node', () => {
          throw new Error('@sentry/node not available');
        });

        jest.doMock('../src/observability/sentry', () => ({
          isEnabled: () => true,
          captureException: jest.fn(),
        }));

        jest.doMock('../src/db/knex', () => mockDb);
        jest.doMock('../src/logger', () => mockLogger);
        jest.doMock('../src/workers/jobQueue', () =>
          jest.fn().mockImplementation(() => ({ enqueue: jest.fn() })));
        jest.doMock('../src/workers/worker', () =>
          jest.fn().mockImplementation(() => ({ registerHandler: jest.fn() })));

        isolatedRaise = require('../src/jobs/reconcileEscrow').raiseReconciliationMismatchAlert;
      });
    });

    afterEach(() => {
      jest.resetModules();
      if (origChannel === undefined) {
        delete process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL;
      } else {
        process.env.RECONCILIATION_MISMATCH_ALERT_CHANNEL = origChannel;
      }
    });

    it('does not throw when @sentry/node require fails — Sentry error is swallowed', () => {
      expect(() => {
        isolatedRaise({
          invoiceId: 'inv_sentry_throw',
          expected: 100,
          actual: 80,
          driftMagnitude: 20,
          runMismatches: 1,
        });
      }).not.toThrow();
      // Log channel still fires even when Sentry throws
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });
  });
});
