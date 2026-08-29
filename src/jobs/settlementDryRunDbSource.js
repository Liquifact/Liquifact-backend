'use strict';

/**
 * @fileoverview Tenant-scoped, read-only DB adapter for the settlement dry-run.
 *
 * Implements the `{readBatch(cursor, limit)}` source contract expected by
 * `runInvoiceFundingReconciliation` (and, transitively, `runSettlementDryRun`)
 * against the real schema:
 *   - `invoices`            — id, amount, currency, status (tenant-scoped, excludes soft-deleted rows)
 *   - `escrow_summaries`    — cached `total_funded`, left-joined as `fundedAmount`
 *   - `escrow_operations`   — completed `fund` rows, treated as the individual
 *                             funding-record ledger for each invoice
 *
 * This module only ever issues `SELECT` queries. It never writes, and never
 * calls any external service (no Soroban RPC, no HTTP). Pagination uses
 * keyset pagination on `invoices.id`, mirroring the pattern already used by
 * `src/jobs/reconcileEscrow.js`'s `iterateInvoicesFromDb`.
 *
 * Known tradeoff: `escrow_operations` has no per-row currency column in the
 * current schema (see `migrations/20240425000003_create_escrow_operations.sql`),
 * so funding records built from this adapter never carry a `currency` field.
 * `evaluateInvoiceFundingInvariants`'s `CURRENCY_MISMATCH` check only fires
 * when a record supplies a currency that differs from the invoice's, so this
 * adapter cannot surface currency drift today — it is exercised in the job's
 * unit tests via the in-memory source, but not reachable through this
 * production adapter until `escrow_operations` gains a currency column. This
 * is a pre-existing schema gap, not something this PR should widen scope to
 * fix.
 *
 * @module jobs/settlementDryRunDbSource
 */

/** Hard ceiling applied to any caller-supplied page size, independent of the caller. */
const MAX_PAGE_SIZE = 1_000;

/**
 * Builds a read-only funding-reconciliation source scoped to one tenant.
 *
 * @param {object} params
 * @param {import('knex').Knex} params.dbClient - Knex instance (injectable for tests).
 * @param {string} params.tenantId - Tenant to scope every query to. Required — this
 *   function throws synchronously if omitted, rather than silently reading
 *   across tenants.
 * @returns {{readBatch: (cursor: string|null, limit: number) => Promise<{records: object[], nextCursor: string|null}>}}
 */
function createTenantInvoiceFundingDbSource({ dbClient, tenantId }) {
  if (!dbClient) {
    throw new Error('createTenantInvoiceFundingDbSource requires dbClient');
  }
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('createTenantInvoiceFundingDbSource requires a non-empty tenantId');
  }

  return {
    async readBatch(cursor, limit) {
      const boundedLimit = Math.min(Math.max(1, Math.trunc(Number(limit) || 1)), MAX_PAGE_SIZE);

      let invoiceQuery = dbClient('invoices')
        .leftJoin('escrow_summaries', 'escrow_summaries.invoice_id', 'invoices.id')
        .where('invoices.tenant_id', tenantId)
        .whereNull('invoices.deleted_at')
        .select(
          'invoices.id as id',
          'invoices.amount as amount',
          'invoices.currency as currency',
          'invoices.status as status',
          'escrow_summaries.total_funded as fundedAmount',
        )
        .orderBy('invoices.id', 'asc')
        .limit(boundedLimit);

      if (cursor !== null && cursor !== undefined) {
        invoiceQuery = invoiceQuery.where('invoices.id', '>', cursor);
      }

      const invoiceRows = await invoiceQuery;
      if (!invoiceRows || invoiceRows.length === 0) {
        return { records: [], nextCursor: null };
      }

      const invoiceIds = invoiceRows.map((row) => row.id);
      const fundingRows = await dbClient('escrow_operations')
        .where('escrow_operations.tenant_id', tenantId)
        .where('escrow_operations.operation_type', 'fund')
        .where('escrow_operations.status', 'completed')
        .whereIn('escrow_operations.invoice_id', invoiceIds)
        .select('id', 'invoice_id as invoiceId', 'amount');

      const recordsByInvoiceId = new Map();
      for (const row of fundingRows) {
        const bucket = recordsByInvoiceId.get(row.invoiceId) || [];
        bucket.push({ id: String(row.id), amount: row.amount });
        recordsByInvoiceId.set(row.invoiceId, bucket);
      }

      const records = invoiceRows.map((row) => ({
        id: String(row.id),
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        fundedAmount: row.fundedAmount ?? '0',
        fundingRecords: recordsByInvoiceId.get(row.id) || [],
      }));

      const nextCursor = invoiceRows.length < boundedLimit ? null : String(invoiceRows[invoiceRows.length - 1].id);
      return { records, nextCursor };
    },
  };
}

module.exports = {
  MAX_PAGE_SIZE,
  createTenantInvoiceFundingDbSource,
};
