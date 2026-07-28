'use strict';

/**
 * @fileoverview Metrics Service.
 * Handles business logic for SME dashboard metrics (aggregated counts and optional paginated invoice lists).
 * @module services/metricsService
 */

const invoiceService = require('./invoiceService');
const { CursorError } = require('../utils/cursorPagination');

/**
 * Retrieves SME dashboard metrics, including aggregated invoice counts and
 * optional cursor-paginated invoice rows.
 *
 * @param {string} tenantId - Tenant identifier.
 * @param {string} userId - SME user identifier.
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Opaque pagination cursor.
 * @param {number|string} [options.limit] - Page size limit.
 * @returns {Promise<{data: object, meta: object}>} Aggregated counts and metadata.
 * @throws {CursorError} When cursor is malformed or tampered.
 * @throws {TypeError} When tenantId or userId is missing.
 */
async function getSmeMetrics(tenantId, userId, { cursor, limit } = {}) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TypeError('tenantId is required');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('userId is required');
  }

  const metrics = await invoiceService.getSmeInvoiceCounts(tenantId, userId);

  const usePagination = cursor !== undefined || limit !== undefined;

  if (!usePagination) {
    return {
      data: metrics,
      meta: {
        timestamp: new Date().toISOString(),
        version: '0.1.0'
      }
    };
  }

  const result = await invoiceService.getSmeInvoiceList(tenantId, userId, { cursor, limit });

  return {
    data: metrics,
    meta: {
      invoices: result.invoices,
      total: result.meta.total,
      limit: result.meta.limit,
      hasMore: result.meta.hasMore,
      nextCursor: result.meta.nextCursor,
      timestamp: new Date().toISOString(),
      version: '0.1.0'
    }
  };
}

module.exports = {
  getSmeMetrics,
};
