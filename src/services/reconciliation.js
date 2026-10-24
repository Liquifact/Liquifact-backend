'use strict';

/**
 * Maps an off-chain status string to the expected on-chain u32 value(s).
 * Status 3 (withdrawn) is treated as compatible with the off-chain "funded" state.
 *
 * @type {Record<string, number[]>}
 */
const STATUS_MAP = {
  open: [0],
  funded: [1, 3],
  settled: [2],
  cancelled: [4],
};

/**
 * Converts an XLM/token amount (floating-point, 7 decimal places) to stroops
 * as a BigInt for exact comparison.
 *
 * @param {number} amount off-chain amount (e.g. 100 XLM)
 * @returns {bigint} stroops
 */
function toStroops(amount) {
  // Multiply by 1e7 using integer arithmetic to avoid float rounding.
  // Math.round handles any residual floating-point error.
  return BigInt(Math.round(amount * 1e7));
}

/**
 * Parses a stroop string from the on-chain escrow struct to BigInt.
 *
 * @param {string|number|bigint} value on-chain stroop value
 * @returns {bigint}
 */
function parseOnChainStroops(value) {
  return BigInt(value);
}

/**
 * Converts a Unix timestamp (seconds) to a Date.
 *
 * @param {number} ts Unix seconds
 * @returns {Date}
 */
function unixToDate(ts) {
  return new Date(ts * 1000);
}

/**
 * Pure reconciliation function. Compares one off-chain invoice record against
 * a decoded on-chain escrow struct and returns a structured result describing
 * any field-level mismatches.
 *
 * @param {object} invoice  off-chain invoice record from the data store
 * @param {object} escrow   decoded on-chain escrow struct (from get_escrow)
 * @returns {{
 *   invoiceId: string,
 *   contractId: string,
 *   status: 'in_sync'|'drift'|'missing_on_chain'|'error',
 *   mismatches: Array<{field: string, offChain: *, onChain: *, severity: 'critical'|'warning'}>
 * }}
 */
function reconcileInvoice(invoice, escrow) {
  const invoiceId = invoice.id;
  // contractId stored on the invoice takes precedence over the global default;
  // the caller is responsible for supplying the correct contractId here.
  const contractId = invoice.escrowContractId || invoice._resolvedContractId || '';

  if (!escrow) {
    return { invoiceId, contractId, status: 'missing_on_chain', mismatches: [] };
  }

  const mismatches = [];

  // ── 1. invoice_id (critical) ──────────────────────────────────────────────
  if (escrow.invoice_id !== invoice.id) {
    mismatches.push({
      field: 'invoice_id',
      offChain: invoice.id,
      onChain: escrow.invoice_id,
      severity: 'critical',
    });
  }

  // ── 2. amount in stroops (critical) ──────────────────────────────────────
  if (escrow.amount !== undefined) {
    const offChainStroops = toStroops(invoice.amount);
    const onChainStroops = parseOnChainStroops(escrow.amount);
    if (offChainStroops !== onChainStroops) {
      mismatches.push({
        field: 'amount',
        offChain: offChainStroops.toString(),
        onChain: onChainStroops.toString(),
        severity: 'critical',
      });
    }
  }

  // ── 3. fundedAmount in stroops (critical) ─────────────────────────────────
  if (escrow.funded_amount !== undefined) {
    const offChainFundedStroops = toStroops(invoice.fundedAmount);
    const onChainFundedStroops = parseOnChainStroops(escrow.funded_amount);
    if (offChainFundedStroops !== onChainFundedStroops) {
      mismatches.push({
        field: 'fundedAmount',
        offChain: offChainFundedStroops.toString(),
        onChain: onChainFundedStroops.toString(),
        severity: 'critical',
      });
    }
  }

  // ── 4. status (critical) ──────────────────────────────────────────────────
  if (escrow.status !== undefined) {
    const expectedOnChainValues = STATUS_MAP[invoice.status];
    const onChainStatus = Number(escrow.status);
    if (!expectedOnChainValues || !expectedOnChainValues.includes(onChainStatus)) {
      mismatches.push({
        field: 'status',
        offChain: invoice.status,
        onChain: onChainStatus,
        severity: 'critical',
      });
    }
  }

  // ── 5. yieldBps (critical) ────────────────────────────────────────────────
  if (escrow.yield_bps !== undefined) {
    const onChainYield = Number(escrow.yield_bps);
    if (invoice.yieldBps !== onChainYield) {
      mismatches.push({
        field: 'yieldBps',
        offChain: invoice.yieldBps,
        onChain: onChainYield,
        severity: 'critical',
      });
    }
  }

  // ── 6. smeAddress (critical) ──────────────────────────────────────────────
  if (escrow.sme_address !== undefined) {
    if (invoice.smeAddress !== escrow.sme_address) {
      mismatches.push({
        field: 'smeAddress',
        offChain: invoice.smeAddress,
        onChain: escrow.sme_address,
        severity: 'critical',
      });
    }
  }

  // ── 7. dueDate vs maturity (warning, ±1 day tolerance = 86400 seconds) ────
  if (escrow.maturity !== undefined && invoice.dueDate) {
    const offChainDate = new Date(invoice.dueDate);
    const onChainDate = unixToDate(Number(escrow.maturity));
    const diffSeconds = Math.abs(offChainDate.getTime() - onChainDate.getTime()) / 1000;
    if (diffSeconds > 86400) {
      mismatches.push({
        field: 'dueDate',
        offChain: invoice.dueDate,
        onChain: onChainDate.toISOString().slice(0, 10),
        severity: 'warning',
      });
    }
  }

  return {
    invoiceId,
    contractId,
    status: mismatches.length === 0 ? 'in_sync' : 'drift',
    mismatches,
  };
}

module.exports = { reconcileInvoice, toStroops, parseOnChainStroops, STATUS_MAP };
