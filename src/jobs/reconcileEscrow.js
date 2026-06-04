'use strict';

/**
 * @fileoverview Nightly escrow reconciliation job.
 *
 * Compares the on-chain `funded_amount` from the LiquifactEscrow Soroban
 * contract against the database `fundedTotal` for every invoice that currently
 * has escrow in flight (states: linked_escrow / funded / partially_funded) and
 * flags drift.
 *
 * Data sources (no mocks):
 *   - DB:       paginated `invoices` query joined to cached `escrow_summaries`
 *               via {@link module:db/knex}.
 *   - On-chain: `readFundedAmount` from {@link module:services/escrowRead},
 *               which routes through `callSorobanContract` (retry + error map).
 *
 * Results are persisted to the `reconciliation_runs` table (one row per run)
 * rather than `global.reconciliationSummary`, and every mismatch increments the
 * `escrow_reconciliation_mismatches_total` Prometheus counter.
 *
 * @module jobs/reconcileEscrow
 */

const logger = require('../logger');
const db = require('../db/knex');
const { readFundedAmount } = require('../services/escrowRead');
const { escrowReconciliationMismatches } = require('../metrics');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');

/**
 * Reconciliation result status.
 * @readonly
 * @enum {string}
 */
const RECONCILE_STATUS = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  ERROR: 'error',
};

/**
 * Invoice statuses that can have an active on-chain escrow worth reconciling.
 * Covers both the SQL invoices vocabulary (`funded`, `partially_funded`) and
 * the state-machine vocabulary (`linked_escrow`).
 *
 * @constant {string[]}
 */
const RECONCILABLE_STATUSES = ['linked_escrow', 'funded', 'partially_funded'];

/** Default page size for the paginated DB scan. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Coerces a DB-sourced funded total into a finite number.
 *
 * Postgres `DECIMAL` columns are returned as strings by the `pg` driver, so the
 * raw value may be a string, number, null, or undefined.
 *
 * @param {unknown} value - Raw `fundedTotal` from the query row.
 * @returns {number} Finite numeric funded total (0 when absent / unparseable).
 */
function toFundedTotal(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Streams reconcilable invoices from the database using keyset pagination on
 * `id`, joining the cached `escrow_summaries.total_funded` as `fundedTotal`.
 *
 * Pagination avoids loading the entire invoice table into memory on large
 * deployments; only `pageSize` rows are held at a time.
 *
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient=db] - Knex instance (injectable for tests).
 * @param {number} [options.pageSize=DEFAULT_PAGE_SIZE] - Rows per page (1-1000).
 * @yields {{ id: string, fundedTotal: number }} One invoice per iteration.
 */
async function* iterateInvoicesFromDb(options = {}) {
  const dbClient = options.dbClient || db;
  const rawSize = Number(options.pageSize) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, Math.trunc(rawSize)), 1000);

  let lastId = null;

  for (;;) {
    let query = dbClient('invoices')
      .leftJoin('escrow_summaries', 'escrow_summaries.invoice_id', 'invoices.id')
      .whereIn('invoices.status', RECONCILABLE_STATUSES)
      .whereNull('invoices.deleted_at')
      .select(
        'invoices.id as id',
        'escrow_summaries.total_funded as fundedTotal',
      )
      .orderBy('invoices.id', 'asc')
      .limit(pageSize);

    if (lastId !== null) {
      query = query.where('invoices.id', '>', lastId);
    }

    const rows = await query;
    if (!rows || rows.length === 0) {
      return;
    }

    for (const row of rows) {
      yield { id: String(row.id), fundedTotal: toFundedTotal(row.fundedTotal) };
    }

    if (rows.length < pageSize) {
      return;
    }
    lastId = rows[rows.length - 1].id;
  }
}

/**
 * Reconcile a single invoice's escrow state.
 *
 * @param {string} invoiceId - Invoice to reconcile.
 * @param {number} dbFundedTotal - Funded total from the database.
 * @param {object} [options={}]
 * @param {Function} [options.escrowAdapter] - Injected Soroban read adapter (tests).
 * @returns {Promise<Object>} Reconciliation result (status MATCH | MISMATCH | ERROR).
 */
async function reconcileInvoice(invoiceId, dbFundedTotal, options = {}) {
  try {
    const onChainAmount = await readFundedAmount(invoiceId, {
      escrowAdapter: options.escrowAdapter,
    });

    const matches = onChainAmount === dbFundedTotal;
    const status = matches ? RECONCILE_STATUS.MATCH : RECONCILE_STATUS.MISMATCH;

    if (!matches) {
      // Structured warning carrying the exact fields ops need to investigate.
      logger.warn(
        { invoiceId, dbFundedTotal, onChainAmount },
        `Escrow mismatch for invoice ${invoiceId}: DB=${dbFundedTotal}, OnChain=${onChainAmount}`,
      );
      escrowReconciliationMismatches.inc();
    }

    return {
      invoiceId,
      status,
      dbFundedTotal,
      onChainAmount,
      reconciledAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(
      { invoiceId, dbFundedTotal, err: error?.message },
      `Error reconciling invoice ${invoiceId}: ${error.message}`,
    );
    return {
      invoiceId,
      status: RECONCILE_STATUS.ERROR,
      dbFundedTotal,
      onChainAmount: null,
      error: error.message,
      reconciledAt: new Date().toISOString(),
    };
  }
}

/**
 * Persists a reconciliation summary to the `reconciliation_runs` table.
 *
 * Failure to persist is logged but does not fail the run - the reconciliation
 * itself (and any mismatch metrics/alerts) has already happened.
 *
 * @param {Object} summary - Summary produced by {@link performReconciliation}.
 * @param {import('knex').Knex} [dbClient=db] - Knex instance (injectable for tests).
 * @returns {Promise<void>}
 */
async function persistReconciliationSummary(summary, dbClient = db) {
  try {
    await dbClient('reconciliation_runs').insert({
      total: summary.total,
      matches: summary.matches,
      mismatches: summary.mismatches,
      errors: summary.errors,
      results: JSON.stringify(summary.results),
      reconciled_at: summary.reconciledAt,
    });
  } catch (error) {
    logger.error(
      { err: error?.message },
      `Failed to persist reconciliation summary: ${error.message}`,
    );
  }
}

/**
 * Perform nightly escrow reconciliation for all reconcilable invoices.
 *
 * @param {object} [options={}]
 * @param {import('knex').Knex} [options.dbClient] - Knex instance (tests).
 * @param {number} [options.pageSize] - DB page size (tests / tuning).
 * @param {Function} [options.escrowAdapter] - Injected Soroban read adapter (tests).
 * @returns {Promise<Object>} Reconciliation summary.
 */
async function performReconciliation(options = {}) {
  logger.info('Starting nightly escrow reconciliation');

  const dbClient = options.dbClient || db;
  const results = [];

  for await (const invoice of iterateInvoicesFromDb({
    dbClient,
    pageSize: options.pageSize,
  })) {
    const result = await reconcileInvoice(invoice.id, invoice.fundedTotal, {
      escrowAdapter: options.escrowAdapter,
    });
    results.push(result);
  }

  const summary = {
    total: results.length,
    matches: results.filter((r) => r.status === RECONCILE_STATUS.MATCH).length,
    mismatches: results.filter((r) => r.status === RECONCILE_STATUS.MISMATCH).length,
    errors: results.filter((r) => r.status === RECONCILE_STATUS.ERROR).length,
    reconciledAt: new Date().toISOString(),
    results,
  };

  logger.info(
    `Escrow reconciliation completed: ${summary.matches} matches, ${summary.mismatches} mismatches, ${summary.errors} errors`,
  );

  await persistReconciliationSummary(summary, dbClient);

  return summary;
}

/**
 * Job handler for escrow reconciliation. Executed by the background worker.
 *
 * @param {Object} [_payload] - Job payload (unused for now).
 * @returns {Promise<Object>} Job result.
 */
async function handleReconciliationJob(_payload) {
  try {
    const summary = await performReconciliation();
    return { success: true, summary };
  } catch (error) {
    logger.error(`Reconciliation job failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Initialize job queue and worker for reconciliation.
const reconciliationQueue = new JobQueue();
const reconciliationWorker = new BackgroundWorker({ jobQueue: reconciliationQueue });

// Register the reconciliation handler.
reconciliationWorker.registerHandler('reconcile_escrow', handleReconciliationJob);

/**
 * Schedule nightly reconciliation job.
 * In production, this would be called by a cron scheduler.
 *
 * @returns {string} Enqueued job ID.
 */
function scheduleNightlyReconciliation() {
  const jobId = reconciliationQueue.enqueue('reconcile_escrow', {});
  logger.info(`Scheduled reconciliation job: ${jobId}`);
  return jobId;
}

/**
 * Get the latest persisted reconciliation summary for health checks.
 *
 * Reads the most recent row from `reconciliation_runs`. Returns `null` when no
 * run has been recorded or the lookup fails (callers treat null as "not run").
 *
 * @param {import('knex').Knex} [dbClient=db] - Knex instance (injectable for tests).
 * @returns {Promise<Object|null>} Latest reconciliation summary or null.
 */
async function getReconciliationSummary(dbClient = db) {
  try {
    const row = await dbClient('reconciliation_runs')
      .orderBy('reconciled_at', 'desc')
      .first();

    if (!row) {
      return null;
    }

    return {
      total: row.total,
      matches: row.matches,
      mismatches: row.mismatches,
      errors: row.errors,
      reconciledAt:
        row.reconciled_at instanceof Date
          ? row.reconciled_at.toISOString()
          : row.reconciled_at,
      results: typeof row.results === 'string' ? JSON.parse(row.results) : row.results,
    };
  } catch (error) {
    logger.error(
      { err: error?.message },
      `Failed to read reconciliation summary: ${error.message}`,
    );
    return null;
  }
}

module.exports = {
  performReconciliation,
  reconcileInvoice,
  iterateInvoicesFromDb,
  persistReconciliationSummary,
  handleReconciliationJob,
  scheduleNightlyReconciliation,
  getReconciliationSummary,
  RECONCILE_STATUS,
  RECONCILABLE_STATUSES,
};
