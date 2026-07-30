'use strict';

/**
 * Invest Service
 * Handles data retrieval for investment opportunities with pagination and 
 * DTO mapping aligned to Soroban on-chain state.
 * 
 * @module services/investService
 */

/**
 * @typedef {Object} InvestmentOpportunity
 * @property {string} invoiceId - Unique identifier of the underlying invoice.
 * @property {number} fundedBpsOfTarget - Progress towards funding target in basis points (10000 = 100%).
 * @property {string} maturityAt - ISO timestamp when the investment matures.
 * @property {number} yieldBpsDisplay - Expected return in basis points (e.g. 500 = 5%).
 * @property {Object} onChain - Pointers to blockchain state.
 * @property {string} onChain.escrowAddress - Stellar/Soroban escrow contract address.
 * @property {string} onChain.ledgerIndex - The last ledger index synchronized for this opportunity.
 */

const db = require('../db/knex');
const { batchReadEscrowStates } = require('./escrowBatchRead');
const { PUBLIC_INVESTABLE_INVOICE_STATUSES } = require('./marketplaceService');
const { resolveEscrowAddress } = require('../config/escrowMap');
const logger = require('../logger');

/**
 * Re-validates invoice ownership before any tenant-sensitive batch escrow read.
 *
 * The caller's tenant comes from authenticated request context. IDs that are
 * foreign, deleted, or unknown are filtered out and recorded as a security
 * warning so a malformed query result cannot leak their on-chain state.
 *
 * @param {string[]} invoiceIds - Candidate invoice IDs from the opportunity query.
 * @param {string} tenantId - Resolved requesting tenant identifier.
 * @returns {Promise<string[]>} IDs confirmed to belong to the requesting tenant.
 */
async function filterTenantOwnedInvoiceIds(invoiceIds, tenantId) {
  if (invoiceIds.length === 0) {
    return [];
  }

  const uniqueInvoiceIds = [...new Set(invoiceIds)];
  const ownedRows = await db('invoices')
    .select('id')
    .whereIn('id', uniqueInvoiceIds)
    .where('tenant_id', tenantId)
    .whereNull('deleted_at');
  const ownedInvoiceIds = new Set(ownedRows.map(row => row.id));
  const deniedInvoiceIds = uniqueInvoiceIds.filter(id => !ownedInvoiceIds.has(id));

  if (deniedInvoiceIds.length > 0) {
    logger.warn(
      { tenantId, invoiceIds: deniedInvoiceIds, count: deniedInvoiceIds.length },
      'Invest batch escrow read blocked cross-tenant or unknown invoice IDs',
    );
  }

  return invoiceIds.filter(id => ownedInvoiceIds.has(id));
}

/**
 * Map a raw invoice row to an InvestmentOpportunity DTO.
 * @param {Object} invoiceRow - Raw invoice row from the database.
 * @returns {InvestmentOpportunity} DTO with camelCase fields and default on-chain pointers.
 */
function toOpportunityDto(invoiceRow) {
  const fundedRatio = invoiceRow && invoiceRow.funded_ratio !== undefined ? Number(invoiceRow.funded_ratio) : 0;
  const fundedBpsOfTarget = Number.isFinite(fundedRatio) ? Math.round(fundedRatio * 100) : 0;
  const maturityDate = invoiceRow && invoiceRow.maturity_date ? new Date(invoiceRow.maturity_date) : null;

  return {
    invoiceId: invoiceRow.id,
    fundedBpsOfTarget,
    maturityAt: maturityDate ? maturityDate.toISOString() : null,
    yieldBpsDisplay: invoiceRow.yield_bps !== undefined ? Number(invoiceRow.yield_bps) : null,
    onChain: {
      // These are pointers to LiquifactEscrow / Stellar state; until invoice rows
      // persist them, keep explicit nulls.
      escrowAddress: null,
      ledgerIndex: null,
    },
  };
}

/**
 * Retrieves paginated list of investment opportunities.
 *
 * @param {Object} [options={}] - Tenant context + pagination options.
 * @param {string} options.tenantId - The resolved tenant identifier (server-side).
 * @param {number} [options.page=1] - Page number (1-based).
 * @param {number} [options.limit=10] - Items per page.
 * @returns {Promise<{data: InvestmentOpportunity[], meta: Object}>}
 */
async function getOpportunities({ tenantId, page = 1, limit = 10 } = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 10)); // Cap limit at 100
  
  const start = (pageNum - 1) * limitSize;

  const baseQuery = db('invoices')
    .whereNull('deleted_at')
    .where('tenant_id', tenantId)
    .whereIn('status', PUBLIC_INVESTABLE_INVOICE_STATUSES);

  const countRow = await baseQuery.clone().clearSelect().clearOrder().count('* as total').first();
  const total = countRow && countRow.total ? parseInt(countRow.total, 10) : 0;

  const rows = await baseQuery
    .clone()
    .select(
      'id',
      'yield_bps',
      'funded_ratio',
      'maturity_date'
    )
    .orderBy('created_at', 'desc')
    .limit(limitSize)
    .offset(start);

  const paginatedData = rows.map(toOpportunityDto);

  return {
    data: paginatedData,
    meta: {
      total,
      page: pageNum,
      limit: limitSize,
      totalPages: Math.ceil(total / limitSize),
    },
  };
}

/**
 * Retrieves paginated list of investment opportunities using cursor-based
 * pagination and enriches them with fresh on-chain data via batched reads.
 *
 * @param {Object} [options={}] - Tenant context + pagination options.
 * @param {string} options.tenantId - The resolved tenant identifier (server-side).
 * @param {string} [options.cursor] - The invoiceId cursor to start after.
 * @param {number} [options.limit=10] - Number of items to retrieve.
 * @returns {Promise<{data: Object[], meta: Object}>}
 */
async function listInvestments({ tenantId, cursor, limit = 10 } = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }

  const limitSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  
  let query = db('invoices')
    .whereNull('deleted_at')
    .where('tenant_id', tenantId)
    .whereIn('status', PUBLIC_INVESTABLE_INVOICE_STATUSES)
    .orderBy('id', 'asc')
    .limit(limitSize);

  if (cursor) {
    query = query.andWhere('id', '>', cursor);
  }

  const rows = await query.select(
    'id',
    'yield_bps',
    'funded_ratio',
    'maturity_date'
  );

  const candidateItems = rows.map(toOpportunityDto);
  const invoiceIds = candidateItems.map(o => o.invoiceId);
  const tenantOwnedInvoiceIds = await filterTenantOwnedInvoiceIds(invoiceIds, tenantId);
  const tenantOwnedInvoiceIdSet = new Set(tenantOwnedInvoiceIds);
  const paginatedItems = candidateItems.filter(item => tenantOwnedInvoiceIdSet.has(item.invoiceId));
  
  // Batch read on-chain state for the current page
  const { results, errors } = await batchReadEscrowStates(tenantOwnedInvoiceIds);
  
  // Merge on-chain state into the opportunity objects
  const data = paginatedItems.map(item => {
    const onChainState = results.find(r => r.invoiceId === item.invoiceId);
    const errorState = errors.find(e => e.invoiceId === item.invoiceId);
    
    return {
      ...item,
      onChain: {
        ...item.onChain,
        ...(onChainState || {}),
        syncError: errorState ? errorState.error : null,
      }
    };
  });
  
  const nextCursor = data.length > 0 ? data[data.length - 1].invoiceId : null;

  return {
    data,
    meta: {
      limit: limitSize,
      next_cursor: nextCursor,
      count: data.length,
      // Cursor-based endpoints cannot know total cheaply; "has_more" is best-effort.
      has_more: data.length === limitSize,
    },
  };
}

/**
 * Retrieves a paginated list of investment opportunities enriched with
 * on-chain escrow state.
 *
 * Queries invoices that are publicly investable (status in
 * {@link PUBLIC_INVESTABLE_INVOICE_STATUSES}), maps each to an
 * {@link InvestmentOpportunity} DTO, and enriches with live on-chain data
 * from the Soroban escrow contract. If a per-invoice on-chain read fails,
 * that invoice is silently skipped from enrichment but still included in
 * the result with default on-chain pointers.
 *
 * @param {Object} [options={}] - Query options.
 * @param {string} options.tenantId - The resolved tenant identifier.
 * @param {number} [options.page=1] - Page number (1-based).
 * @param {number} [options.limit=20] - Items per page (capped at 100).
 * @returns {Promise<{data: InvestmentOpportunity[], meta: {total: number, page: number, limit: number, totalPages: number}}>}
 */
async function listOpportunities({ tenantId, page = 1, limit = 20 } = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Missing tenant context');
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitSize;

  const baseQuery = db('invoices')
    .whereNull('deleted_at')
    .where('tenant_id', tenantId)
    .whereIn('status', PUBLIC_INVESTABLE_INVOICE_STATUSES);

  const countRow = await baseQuery.clone().clearSelect().clearOrder().count('* as total').first();
  const total = countRow && countRow.total ? parseInt(countRow.total, 10) : 0;

  const rows = await baseQuery
    .clone()
    .select(
      'id',
      'yield_bps',
      'funded_ratio',
      'maturity_date'
    )
    .orderBy('created_at', 'desc')
    .limit(limitSize)
    .offset(offset);

  const candidateData = rows.map(toOpportunityDto);
  const invoiceIds = candidateData.map(o => o.invoiceId);
  const tenantOwnedInvoiceIds = await filterTenantOwnedInvoiceIds(invoiceIds, tenantId);
  const tenantOwnedInvoiceIdSet = new Set(tenantOwnedInvoiceIds);
  const data = candidateData.filter(item => tenantOwnedInvoiceIdSet.has(item.invoiceId));

  // Batch-read on-chain state; failures are isolated per invoice.
  const { results, errors } = await batchReadEscrowStates(tenantOwnedInvoiceIds);

  if (errors.length > 0) {
    logger.warn(
      { invoiceIds: errors.map(e => e.invoiceId), count: errors.length },
      'listOpportunities: on-chain reads failed for some invoices — skipping enrichment',
    );
  }

  // Merge on-chain state into each opportunity.
  for (const item of data) {
    const onChainState = results.find(r => r.invoiceId === item.invoiceId);
    let escrowAddress = '';
    try {
      const addr = resolveEscrowAddress(item.invoiceId);
      if (addr) {
        escrowAddress = addr;
      }
    } catch {
      // Escrow mapping not configured for this invoice; leave as empty string.
    }

    item.onChain = {
      ...(onChainState || {}),
      escrowAddress,
      ledgerIndex: null,
    };
  }

  return {
    data,
    meta: {
      total,
      page: pageNum,
      limit: limitSize,
      totalPages: Math.ceil(total / limitSize),
    },
  };
}

module.exports = {
  getOpportunities,
  listInvestments,
  listOpportunities,
  PUBLIC_INVESTABLE_INVOICE_STATUSES,
};
