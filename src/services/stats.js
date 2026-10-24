'use strict';

const { STATUSES } = require('../data/store');
const { parseDecimal, rescale, decimalToString } = require('../utils/decimal');

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
    const active = rows.filter((invoice) => invoice.status !== 'cancelled').map((invoice) => ({
      invoice,
      amount: parseDecimal(invoice.amount),
      funded: parseDecimal(invoice.fundedAmount),
    }));
    const scale = active.reduce((max, row) => Math.max(max, row.amount.scale, row.funded.scale), 0);
    let faceValue = 0n;
    let funded = 0n;
    let outstanding = 0n;
    let weightedYield = 0n;
    for (const row of active) {
      const amount = rescale(row.amount, scale);
      const principal = rescale(row.funded, scale);
      faceValue += amount;
      funded += principal;
      if (row.invoice.status === 'funded') {
        outstanding += principal;
      }
      weightedYield += amount * BigInt(row.invoice.yieldBps);
    }
    return [asset, {
      invoices: rows.length,
      faceValue: decimalToString(faceValue, scale),
      funded: decimalToString(funded, scale),
      outstanding: decimalToString(outstanding, scale),
      weightedYieldBps: faceValue ? Number((2n * weightedYield + faceValue) / (2n * faceValue)) : 0,
    }];
  }));

  // Compatibility-only legacy calculations: they intentionally retain the old
  // mixed-asset semantics. Consumers must migrate to byCurrency this release.
  const sum = (key) => selected.reduce((total, row) => total + Number(row[key]), 0);
  const deprecated = {
    totalFaceValue: sum('amount'),
    totalFunded: sum('fundedAmount'),
    averageYieldBps: selected.length ? Math.round(sum('yieldBps') / selected.length) : 0,
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
