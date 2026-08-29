'use strict';

/* The public job contract is documented below; helper JSDoc is intentionally concise. */
/* eslint-disable jsdoc/require-description, jsdoc/require-param */

/**
 * Bounded, read-only settlement dry-run for invoice funding reconciliation.
 *
 * This sits directly on top of {@link module:jobs/invoiceFundingReconciliation}:
 * it runs the exact same bounded, read-only invariant scan and then classifies
 * each violation into either a deterministic proposed correction (bounded,
 * with a human-readable reason) or a manual-review item, WITHOUT applying
 * anything. There is no code path in this module that writes to `source` or
 * calls any external service — it only derives proposals from the violation
 * report that `runInvoiceFundingReconciliation` already computed in memory.
 *
 * Design tradeoff (documented deliberately, see PR description "Design
 * notes"): only `FUNDING_SUM_MISMATCH` gets an automatic proposed value. The
 * funding-record ledger (the individual funding rows) is treated as the
 * source of truth for that one case, so the proposal is "set fundedAmount to
 * match the record sum". Every other violation code (status mismatches,
 * overfunding, duplicate/invalid records, currency drift) is surfaced as a
 * manual-review item with a reason but no proposed value, because a safe
 * correction there requires business judgement (e.g. which of two duplicate
 * records is correct, or what lifecycle status an operator intends) that a
 * bounded automated tool must not guess. This mirrors the underlying job's
 * own "never auto-remediate; a financial mismatch requires an explicit
 * reviewed correction" principle in `docs/invoice-funding-reconciliation.md`.
 *
 * Only one mode is supported: `'dry-run'`. There is intentionally no `apply`
 * mode in this module or anywhere in this codebase — automatic application
 * of a settlement proposal is out of scope for this feature (see the linked
 * issue). Any `mode` value other than the literal string `'dry-run'` is
 * rejected before any scanning happens.
 *
 * @module jobs/settlementDryRun
 */

const {
  runInvoiceFundingReconciliation,
  VIOLATION_CODES,
  REPORT_STATUS,
} = require('./invoiceFundingReconciliation');

/** The only supported value for the `mode` option. */
const DRY_RUN_MODE = 'dry-run';

const DEFAULT_MAX_PROPOSALS = 500;
const MAX_MAX_PROPOSALS = 2_000;

class SettlementDryRunError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message);
    this.name = 'SettlementDryRunError';
    this.code = code;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Violation codes for which a deterministic, single-field correction can be
 * derived purely from the violation's own `details` without re-reading the
 * source invoice. See the module-level "Design tradeoff" note above for why
 * this set is deliberately small.
 */
const AUTO_CORRECTABLE_CODES = new Set([VIOLATION_CODES.FUNDING_SUM_MISMATCH]);

/**
 * Derives a proposed correction or a manual-review item for one violation.
 * Pure function: reads only the violation object, never touches `source`.
 *
 * @param {{invoiceId: string, code: string, message: string, details: object}} violationItem
 * @returns {object} A proposed-change or manual-review entry (see `runSettlementDryRun` JSDoc).
 */
function deriveSettlementItem(violationItem) {
  const { invoiceId, code, message, details } = violationItem;

  if (AUTO_CORRECTABLE_CODES.has(code)) {
    return {
      invoiceId,
      code,
      kind: 'proposed_change',
      field: 'fundedAmount',
      fromValue: details.fundedAmount,
      toValue: details.recordSum,
      reason: 'Funding records sum does not match the recorded fundedAmount; proposing a correction to align fundedAmount with the funding-record ledger.',
    };
  }

  return {
    invoiceId,
    code,
    kind: 'manual_review',
    reason: message,
    details,
  };
}

/** @returns {{mode: string, maxProposals: number}} Validated dry-run options. */
function normalizeSettlementOptions(options = {}) {
  if (options.mode !== DRY_RUN_MODE) {
    throw new SettlementDryRunError(
      'INVALID_MODE',
      `mode must be the literal string "${DRY_RUN_MODE}"; automatic application is not supported by this endpoint`,
    );
  }
  const maxProposals = Number(options.maxProposals ?? DEFAULT_MAX_PROPOSALS);
  if (!Number.isInteger(maxProposals) || maxProposals < 1 || maxProposals > MAX_MAX_PROPOSALS) {
    throw new SettlementDryRunError('INVALID_OPTIONS', `maxProposals must be an integer between 1 and ${MAX_MAX_PROPOSALS}`);
  }
  return { mode: options.mode, maxProposals };
}

/**
 * Runs a bounded, read-only settlement dry-run.
 *
 * Guarantees:
 *  - No writes: this function never calls any method on `source` other than
 *    the read-only `readBatch` invoked (indirectly) by
 *    `runInvoiceFundingReconciliation`, and never calls any external service.
 *  - No apply path exists: `mode` must be exactly `'dry-run'`.
 *  - Deterministic: repeated calls against an unchanged source snapshot
 *    return identical output, because the underlying violation scan is
 *    already deterministic (sorted by invoiceId/code/message) and this layer
 *    only maps that sorted list 1:1 into proposals.
 *  - Bounded: `proposals` (proposed changes + manual-review items combined)
 *    is capped at `maxProposals` (default 500, hard ceiling 2000); if the
 *    underlying violation count exceeds that, `truncated: true` is set and
 *    `omittedCount` reports how many were left out. This is independent from
 *    (and in addition to) the underlying job's own `maxRecords` scan bound.
 *
 * @param {object} params
 * @param {{readBatch: Function}} params.source - Same read-only source contract as `runInvoiceFundingReconciliation`.
 * @param {'dry-run'} params.mode - Must be the literal string `'dry-run'`.
 * @param {number} [params.maxProposals=500] - Cap on returned proposal/review items (1-2000).
 * @param {string} [params.runId] - Forwarded to the underlying scan for correlation.
 * @param {number} [params.pageSize] - Forwarded to the underlying scan.
 * @param {number} [params.maxRecords] - Forwarded to the underlying scan.
 * @returns {Promise<object>} Settlement dry-run report.
 */
async function runSettlementDryRun({ source, ...rawOptions } = {}) {
  const { mode, maxProposals } = normalizeSettlementOptions(rawOptions);
  const { mode: _mode, maxProposals: _maxProposals, ...scanOptions } = rawOptions;

  const report = await runInvoiceFundingReconciliation({ source, ...scanOptions });

  const proposedChanges = [];
  const manualReview = [];
  let omittedCount = 0;

  for (const violationItem of report.violations) {
    const item = deriveSettlementItem(violationItem);
    const bucket = item.kind === 'proposed_change' ? proposedChanges : manualReview;
    if (proposedChanges.length + manualReview.length >= maxProposals) {
      omittedCount += 1;
      continue;
    }
    bucket.push(item);
  }

  return {
    runId: report.runId,
    mode,
    status: report.status,
    scanned: report.scanned,
    batches: report.batches,
    complete: report.complete,
    nextCursor: report.nextCursor,
    proposedChangeCount: proposedChanges.length,
    manualReviewCount: manualReview.length,
    truncated: omittedCount > 0,
    omittedCount,
    proposedChanges,
    manualReview,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
  };
}

module.exports = {
  DRY_RUN_MODE,
  DEFAULT_MAX_PROPOSALS,
  MAX_MAX_PROPOSALS,
  REPORT_STATUS,
  SettlementDryRunError,
  AUTO_CORRECTABLE_CODES,
  deriveSettlementItem,
  normalizeSettlementOptions,
  runSettlementDryRun,
};
