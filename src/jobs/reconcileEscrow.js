'use strict';

/**
 * @fileoverview Nightly escrow reconciliation job.
 * Compares on-chain funded_amount with DB fundedTotal for all invoices.
 * Detects drift and triggers alerts on mismatches.
 *
 * @module jobs/reconcileEscrow
 */

const logger = require('../logger');
const { callSorobanContract } = require('../services/soroban');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');

/**
 * Reconciliation result status
 * @readonly
 * @enum {string}
 */
const RECONCILE_STATUS = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  ERROR: 'error',
};

/**
 * Mock database query for invoices with fundedTotal.
 * In production, this would query the actual database.
 *
 * @returns {Promise<Array>} Array of invoice objects with id and fundedTotal
 */
async function getInvoicesFromDb() {
  // Mock data - replace with actual DB query
  return [
    { id: 'inv_1', fundedTotal: 1000 },
    { id: 'inv_2', fundedTotal: 2000 },
    { id: 'inv_3', fundedTotal: 500 },
  ];
}

/**
 * Mock Soroban contract call to get funded_amount for an invoice.
 * In production, this would invoke the actual LiquifactEscrow contract.
 *
 * @param {string} invoiceId - The invoice ID
 * @returns {Promise<number>} The on-chain funded amount
 */
async function getOnChainFundedAmount(invoiceId) {
  // Mock implementation - replace with actual Soroban contract call
  const mockAmounts = {
    'inv_1': 1000,  // matches
    'inv_2': 1990,  // mismatch
    'inv_3': 500,   // matches
  };

  return mockAmounts[invoiceId] || 0;
}

/**
 * Reconcile a single invoice's escrow state.
 *
 * @param {string} invoiceId - Invoice to reconcile
 * @param {number} dbFundedTotal - Funded total from database
 * @returns {Promise<Object>} Reconciliation result
 */
async function reconcileInvoice(invoiceId, dbFundedTotal) {
  try {
    const onChainAmount = await callSorobanContract(() =>
      getOnChainFundedAmount(invoiceId)
    );

    const matches = onChainAmount === dbFundedTotal;
    const status = matches ? RECONCILE_STATUS.MATCH : RECONCILE_STATUS.MISMATCH;

    if (!matches) {
      logger.warn(`Escrow mismatch for invoice ${invoiceId}: DB=${dbFundedTotal}, OnChain=${onChainAmount}`);
      // TODO: Send alert email or notification
    }

    return {
      invoiceId,
      status,
      dbFundedTotal,
      onChainAmount,
      reconciledAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Error reconciling invoice ${invoiceId}: ${error.message}`);
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
 * Perform nightly escrow reconciliation for all invoices.
 *
 * @returns {Promise<Object>} Reconciliation summary
 */
async function performReconciliation() {
  logger.info('Starting nightly escrow reconciliation');

  const invoices = await getInvoicesFromDb();
  const results = [];

  for (const invoice of invoices) {
    const result = await reconcileInvoice(invoice.id, invoice.fundedTotal);
    results.push(result);
  }

  const summary = {
    total: results.length,
    matches: results.filter(r => r.status === RECONCILE_STATUS.MATCH).length,
    mismatches: results.filter(r => r.status === RECONCILE_STATUS.MISMATCH).length,
    errors: results.filter(r => r.status === RECONCILE_STATUS.ERROR).length,
    reconciledAt: new Date().toISOString(),
    results,
  };

  logger.info(`Escrow reconciliation completed: ${summary.matches} matches, ${summary.mismatches} mismatches, ${summary.errors} errors`);

  // Store summary for health check
  global.reconciliationSummary = summary;

  return summary;
}

/**
 * Job handler for escrow reconciliation.
 * Executed by the background worker.
 *
 * @param {Object} payload - Job payload (unused for now)
 * @returns {Promise<Object>} Job result
 */
async function handleReconciliationJob(payload) {
  try {
    const summary = await performReconciliation();
    return { success: true, summary };
  } catch (error) {
    logger.error(`Reconciliation job failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Initialize job queue and worker for reconciliation
const reconciliationQueue = new JobQueue();
const reconciliationWorker = new BackgroundWorker({ jobQueue: reconciliationQueue });

// Register the reconciliation handler
reconciliationWorker.registerHandler('reconcile_escrow', handleReconciliationJob);

/**
 * Schedule nightly reconciliation job.
 * In production, this would be called by a cron scheduler.
 */
function scheduleNightlyReconciliation() {
  // For demo purposes, run immediately. In production, schedule for nightly run.
  const jobId = reconciliationQueue.enqueue('reconcile_escrow', {});
  logger.info(`Scheduled reconciliation job: ${jobId}`);
  return jobId;
}

/**
 * Get the latest reconciliation summary for health checks.
 *
 * @returns {Object|null} Latest reconciliation summary or null if not run
 */
function getReconciliationSummary() {
  return global.reconciliationSummary || null;
}

module.exports = {
  performReconciliation,
  reconcileInvoice,
  scheduleNightlyReconciliation,
  getReconciliationSummary,
  RECONCILE_STATUS,
};