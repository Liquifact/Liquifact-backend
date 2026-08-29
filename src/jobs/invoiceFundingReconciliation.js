'use strict';

/* The public job contract is documented below; helper JSDoc is intentionally concise. */
/* eslint-disable jsdoc/require-description, jsdoc/require-param, jsdoc/require-returns */

/**
 * Bounded, read-only reconciliation for invoice funding projections.
 *
 * The existing reconcileEscrow job compares an invoice projection with a
 * Soroban read. This job validates the internal invoice funding state itself:
 * the invoice total, aggregate funding records, amount bounds, record shape,
 * and lifecycle status must agree. It never repairs rows or changes status.
 *
 * A production source should implement readBatch with keyset pagination and
 * return records in a stable order. The included in-memory source makes the
 * contract usable in unit/integration tests without a database.
 */

const DECIMAL_SCALE = 1_000_000_000n;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_MAX_RECORDS = 10_000;

const VIOLATION_CODES = Object.freeze({
  INVALID_INVOICE: 'INVALID_INVOICE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  NEGATIVE_AMOUNT: 'NEGATIVE_AMOUNT',
  FUNDING_SUM_MISMATCH: 'FUNDING_SUM_MISMATCH',
  OVERFUNDED: 'OVERFUNDED',
  DUPLICATE_FUNDING_RECORD: 'DUPLICATE_FUNDING_RECORD',
  FUNDING_STATUS_MISMATCH: 'FUNDING_STATUS_MISMATCH',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INVALID_FUNDING_RECORD: 'INVALID_FUNDING_RECORD',
});

const REPORT_STATUS = Object.freeze({
  CLEAN: 'clean',
  DRIFT: 'drift',
  INCOMPLETE: 'incomplete',
});

const FULLY_FUNDED_STATUSES = new Set(['funded', 'completed']);
const PARTIALLY_FUNDED_STATUSES = new Set(['partially_funded']);
const UNFUNDED_STATUSES = new Set(['pending_verification', 'verified']);

class InvoiceFundingReconciliationError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message);
    this.name = 'InvoiceFundingReconciliationError';
    this.code = code;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** @returns {bigint} Fixed-point amount in nanounits. */
function parseAmount(value, fieldName) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,9})?$/.test(text)) {
    throw new InvoiceFundingReconciliationError(
      VIOLATION_CODES.INVALID_AMOUNT,
      `${fieldName} must be a non-negative decimal with at most 9 fractional places`,
    );
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(9, '0'));
}

/** @returns {string} Canonical decimal rendering. */
function amountText(value) {
  const units = BigInt(value);
  const whole = units / DECIMAL_SCALE;
  const fraction = (units % DECIMAL_SCALE).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

/** @returns {object} A stable, minimally detailed violation. */
function violation(invoiceId, code, message, details = {}) {
  return { invoiceId, code, message, details };
}

/** @returns {object[]} All invariant violations for one invoice. */
function evaluateInvoiceFundingInvariants(invoice) {
  const id = invoice && typeof invoice.id === 'string' ? invoice.id : '';
  if (!id) {
    return [violation(id || 'unknown', VIOLATION_CODES.INVALID_INVOICE, 'Invoice id is required')];
  }

  const violations = [];
  let invoiceAmount;
  let fundedAmount;
  try {
    invoiceAmount = parseAmount(invoice.amount, 'invoice.amount');
    fundedAmount = parseAmount(invoice.fundedAmount ?? '0', 'invoice.fundedAmount');
  } catch (error) {
    return [violation(id, VIOLATION_CODES.INVALID_AMOUNT, error.message)];
  }

  if (fundedAmount > invoiceAmount) {
    violations.push(violation(id, VIOLATION_CODES.OVERFUNDED, 'Funded amount exceeds invoice amount', {
      invoiceAmount: amountText(invoiceAmount), fundedAmount: amountText(fundedAmount),
    }));
  }

  const records = Array.isArray(invoice.fundingRecords) ? invoice.fundingRecords : [];
  const recordIds = new Set();
  let recordSum = 0n;
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) {
      violations.push(violation(id, VIOLATION_CODES.INVALID_FUNDING_RECORD, 'Funding record must have a non-empty id', { index }));
      continue;
    }
    if (recordIds.has(record.id)) {
      violations.push(violation(id, VIOLATION_CODES.DUPLICATE_FUNDING_RECORD, 'Funding record id is duplicated', { recordId: record.id }));
    }
    recordIds.add(record.id);
    let recordAmount;
    try {
      recordAmount = parseAmount(record.amount, `fundingRecords[${index}].amount`);
    } catch (error) {
      violations.push(violation(id, VIOLATION_CODES.INVALID_FUNDING_RECORD, error.message, { recordId: record.id }));
      continue;
    }
    recordSum += recordAmount;
    if (record.currency && invoice.currency && record.currency !== invoice.currency) {
      violations.push(violation(id, VIOLATION_CODES.CURRENCY_MISMATCH, 'Funding record currency differs from invoice currency', {
        recordId: record.id, invoiceCurrency: invoice.currency, recordCurrency: record.currency,
      }));
    }
  }

  if (recordSum !== fundedAmount) {
    violations.push(violation(id, VIOLATION_CODES.FUNDING_SUM_MISMATCH, 'Funding records do not sum to fundedAmount', {
      recordSum: amountText(recordSum), fundedAmount: amountText(fundedAmount),
    }));
  }

  const status = typeof invoice.status === 'string' ? invoice.status : '';
  const isFullyFunded = fundedAmount === invoiceAmount && invoiceAmount > 0n;
  const isPartiallyFunded = fundedAmount > 0n && fundedAmount < invoiceAmount;
  const isUnfunded = fundedAmount === 0n;
  if (FULLY_FUNDED_STATUSES.has(status) && !isFullyFunded) {
    violations.push(violation(id, VIOLATION_CODES.FUNDING_STATUS_MISMATCH, 'Fully funded status requires exact invoice funding', { status }));
  }
  if (PARTIALLY_FUNDED_STATUSES.has(status) && !isPartiallyFunded) {
    violations.push(violation(id, VIOLATION_CODES.FUNDING_STATUS_MISMATCH, 'Partially funded status requires funding between zero and the invoice total', { status }));
  }
  if (UNFUNDED_STATUSES.has(status) && !isUnfunded) {
    violations.push(violation(id, VIOLATION_CODES.FUNDING_STATUS_MISMATCH, 'Pre-funding status cannot have funded amount', { status }));
  }
  return violations;
}

/** @returns {{pageSize: number, maxRecords: number, runId: string}} Validated scan options. */
function normalizeOptions(options = {}) {
  const pageSize = Number(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const maxRecords = Number(options.maxRecords ?? DEFAULT_MAX_RECORDS);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new InvoiceFundingReconciliationError('INVALID_OPTIONS', `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1) {
    throw new InvoiceFundingReconciliationError('INVALID_OPTIONS', 'maxRecords must be a positive integer');
  }
  return { pageSize, maxRecords, runId: String(options.runId || `invoice-funding-${Date.now()}`) };
}

/**
 * Execute a deterministic, bounded scan. `source.readBatch` must be read-only;
 * neither this function nor the invariant evaluator mutates source records.
 */
async function runInvoiceFundingReconciliation({ source, ...rawOptions } = {}) {
  if (!source || typeof source.readBatch !== 'function') {
    throw new InvoiceFundingReconciliationError('INVALID_SOURCE', 'source.readBatch is required');
  }
  const options = normalizeOptions(rawOptions);
  const startedAt = new Date().toISOString();
  const allViolations = [];
  let cursor = null;
  let scanned = 0;
  let batches = 0;
  let complete = false;
  while (scanned < options.maxRecords) {
    let batch;
    try {
      batch = await source.readBatch(cursor, Math.min(options.pageSize, options.maxRecords - scanned));
    } catch (error) {
      throw new InvoiceFundingReconciliationError('SOURCE_UNAVAILABLE', 'Invoice funding source could not be read', error);
    }
    if (!batch || !Array.isArray(batch.records) || batch.records.length > options.pageSize) {
      throw new InvoiceFundingReconciliationError('INVALID_SOURCE_BATCH', 'Source returned an invalid or oversized batch');
    }
    for (const invoice of batch.records) {
      if (scanned >= options.maxRecords) {
        break;
      }
      scanned += 1;
      allViolations.push(...evaluateInvoiceFundingInvariants(invoice));
    }
    batches += 1;
    cursor = batch.nextCursor ?? null;
    if (cursor === null || batch.records.length === 0) {
      complete = true;
      break;
    }
  }

  const sortedViolations = allViolations.sort((a, b) =>
    a.invoiceId.localeCompare(b.invoiceId) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  const offendingIds = [...new Set(sortedViolations.map((item) => item.invoiceId))].sort();
  const counts = {};
  for (const item of sortedViolations) {
    counts[item.code] = (counts[item.code] || 0) + 1;
  }
  return {
    runId: options.runId,
    status: sortedViolations.length ? (complete ? REPORT_STATUS.DRIFT : REPORT_STATUS.INCOMPLETE) : (complete ? REPORT_STATUS.CLEAN : REPORT_STATUS.INCOMPLETE),
    scanned,
    batches,
    complete,
    nextCursor: complete ? null : cursor,
    violationCount: sortedViolations.length,
    counts,
    offendingIds,
    violations: sortedViolations,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

class InMemoryInvoiceFundingSource {
  /** @param {object[]} invoices Source snapshot, never mutated by the job. */
  constructor(invoices) {
    this.invoices = invoices.map((invoice) => ({ ...invoice, fundingRecords: invoice.fundingRecords?.map((record) => ({ ...record })) }));
    this.reads = [];
  }

  /** @returns {Promise<{records: object[], nextCursor: string|null}>} A bounded source page. */
  async readBatch(cursor, limit) {
    const start = cursor === null ? 0 : Number(cursor);
    this.reads.push({ cursor, limit });
    const records = this.invoices.slice(start, start + limit);
    const next = start + records.length;
    return { records, nextCursor: next < this.invoices.length ? String(next) : null };
  }
}

module.exports = {
  DECIMAL_SCALE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_MAX_RECORDS,
  VIOLATION_CODES,
  REPORT_STATUS,
  InvoiceFundingReconciliationError,
  parseAmount,
  amountText,
  evaluateInvoiceFundingInvariants,
  normalizeOptions,
  runInvoiceFundingReconciliation,
  InMemoryInvoiceFundingSource,
};
