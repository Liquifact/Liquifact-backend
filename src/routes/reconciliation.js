'use strict';

const express = require('express');
const config = require('../config');
const store = require('../data/store');
const { reconcileInvoice } = require('../services/reconciliation');
const escrowRoute = require('./escrow');

const router = express.Router();

/** Maximum concurrent RPC calls. */
const MAX_CONCURRENCY = 4;

/**
 * Fetches the escrow state for one contractId.
 * Returns { data, error } — never throws.
 *
 * @param {string} contractId
 * @returns {Promise<{data?: object, error?: string}>}
 */
async function fetchEscrow(contractId) {
  try {
    void contractId; // reserved for future multi-contract support
    const data = await escrowRoute.readEscrowOnChain();
    return { data };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

/**
 * Runs tasks with a concurrency cap.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function withConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(limit, tasks.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Reconciles all on-chain invoices and returns a full report.
 *
 * @returns {Promise<{checkedAt: string, summary: object, results: object[]}>}
 */
async function reconcileAll() {
  const onChainInvoices = store.list().filter((i) => i.onChain);

  // Deduplicate contract IDs so we only call RPC once per contract.
  const contractMap = new Map();
  for (const inv of onChainInvoices) {
    const cid = inv.escrowContractId || config.contractId;
    if (!contractMap.has(cid)) {
      contractMap.set(cid, []);
    }
    contractMap.get(cid).push(inv);
  }

  // Fetch escrow state for each unique contract (bounded concurrency).
  const contractIds = [...contractMap.keys()];
  const fetchTasks = contractIds.map((cid) => () => fetchEscrow(cid));
  const fetchResults = await withConcurrency(fetchTasks, MAX_CONCURRENCY);

  // Build a contractId → { data?, error? } lookup.
  const escrowByContract = new Map();
  contractIds.forEach((cid, i) => escrowByContract.set(cid, fetchResults[i]));

  // Reconcile each invoice against its contract's escrow state.
  const results = [];
  for (const inv of onChainInvoices) {
    const cid = inv.escrowContractId || config.contractId;
    const { data: escrow, error } = escrowByContract.get(cid);

    if (error) {
      results.push({
        invoiceId: inv.id,
        contractId: cid,
        status: 'error',
        code: 'RPC_ERROR',
        detail: error,
        mismatches: [],
      });
      continue;
    }

    // Attach the resolved contractId so reconcileInvoice can include it.
    const augmented = { ...inv, _resolvedContractId: cid };
    results.push(reconcileInvoice(augmented, escrow));
  }

  // Summarise.
  const summary = { inSync: 0, drift: 0, missing: 0, error: 0 };
  for (const r of results) {
    if (r.status === 'in_sync') { summary.inSync++; }
    else if (r.status === 'drift') { summary.drift++; }
    else if (r.status === 'missing_on_chain') { summary.missing++; }
    else { summary.error++; }
  }

  return { checkedAt: new Date().toISOString(), summary, results };
}

// ── GET /api/reconciliation ────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const report = await reconcileAll();
  res.json(report);
});

// ── GET /api/reconciliation/:invoiceId ────────────────────────────────────

router.get('/:invoiceId', async (req, res) => {
  const invoice = store.get(req.params.invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (!invoice.onChain) {
    return res.status(409).json({ error: 'NOT_ON_CHAIN', detail: 'Invoice is not tracked on-chain' });
  }

  const cid = invoice.escrowContractId || config.contractId;
  const { data: escrow, error } = await fetchEscrow(cid);

  if (error) {
    return res.json({
      invoiceId: invoice.id,
      contractId: cid,
      status: 'error',
      code: 'RPC_ERROR',
      detail: error,
      mismatches: [],
    });
  }

  const augmented = { ...invoice, _resolvedContractId: cid };
  return res.json(reconcileInvoice(augmented, escrow));
});

module.exports = router;
module.exports.reconcileAll = reconcileAll;
