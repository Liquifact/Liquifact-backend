'use strict';

const { STATUSES } = require('../data/store');
const { parseDecimal, rescale } = require('../utils/decimal');
const { formatAmount } = require('../lib/money');

function invoiceMinor(invoice, minorKey, decimalKey) {
  if (typeof invoice[minorKey] === 'bigint') {
    return invoice[minorKey];
  }
  return rescale(parseDecimal(invoice[decimalKey]), 7);
}

/** Pure aggregation of a snapshot; no mutation, FX conversion or persistence. */
function computeStats(invoices, currency, now = new Date()) {
  const selected = currency ? invoices.filter((invoice) => invoice.currency === currency) : invoices;
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const groups = new Map();
  for (const invoice of selected) {
    byStatus[invoice.status] += 1;
    if (!groups.has(invoice.currency)) {
      groups.set(invoice.currency, []);
    }
    groups.get(invoice.currency).push(invoice);
  }

  const byCurrency = Object.fromEntries([...groups].map(([asset, rows]) => {
    const active = rows.filter((invoice) => invoice.status !== 'cancelled');
    let faceValue = 0n;
    let funded = 0n;
    let outstanding = 0n;
    let weightedYield = 0n;
    for (const row of active) {
      const amount = invoiceMinor(row, 'amountMinor', 'amount');
      const principal = invoiceMinor(row, 'fundedAmountMinor', 'fundedAmount');
      faceValue += amount;
      funded += principal;
      if (row.status === 'funded') {
        outstanding += principal;
      }
      weightedYield += amount * BigInt(row.yieldBps);
    }
    return [asset, {
      invoices: rows.length,
      faceValue: formatAmount(faceValue),
      funded: formatAmount(funded),
      outstanding: formatAmount(outstanding),
      weightedYieldBps: faceValue ? Number((2n * weightedYield + faceValue) / (2n * faceValue)) : 0,
    }];
  }));

  // Compatibility-only legacy calculations: they intentionally retain the old
  // mixed-asset semantics. Consumers must migrate to byCurrency this release.
  const totalFaceValue = selected.reduce((total, row) => total + invoiceMinor(row, 'amountMinor', 'amount'), 0n);
  const totalFunded = selected.reduce((total, row) => total + invoiceMinor(row, 'fundedAmountMinor', 'fundedAmount'), 0n);
  const deprecated = {
    totalFaceValue: formatAmount(totalFaceValue),
    totalFunded: formatAmount(totalFunded),
    averageYieldBps: selected.length
      ? Math.round(selected.reduce((total, row) => total + row.yieldBps, 0) / selected.length)
      : 0,
  };
  return {
    invoices: selected.length,
    open: byStatus.open,
    byStatus,
    byCurrency,
    generatedAt: now.toISOString(),
    // Keep old top-level aliases during the one-release deprecation period so
    // clients have a migration window before these fields are removed.
    ...deprecated,
    deprecated,
  };
}

module.exports = { computeStats };
