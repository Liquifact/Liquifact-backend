const db = require('../db/knex');
const { applyQueryOptions } = require('../utils/queryBuilder');

/**
 * Invoice Service
 * 
 * Handles database operations for invoices with efficient filtering and sorting.
 */

// Configuration for invoice query options
const INVOICE_QUERY_CONFIG = {
  allowedFilters: ['status', 'smeId', 'buyerId', 'dateFrom', 'dateTo'],
  allowedSortFields: ['amount', 'date'],
  columnMap: {
    smeId: 'sme_id',
    buyerId: 'buyer_id',
    dateFrom: 'date', // Filter on 'date' column
    dateTo: 'date'   // Filter on 'date' column
  }
};

/**
 * Retrieves invoices from the database with filtering and sorting applied.
 * 
 * @param {Object} queryParams - The validated query parameters.
 * @param {Object} queryParams.filters - Filter key-value pairs.
 * @param {Object} queryParams.sorting - Sorting configuration.
 * @returns {Promise<Array>} A promise that resolves to the list of invoices.
 * @throws {Error} If there is a database error.
 */
async function getInvoices(queryParams) {
  try {
    let query = db('invoices').select('*');

    // Apply filtering and sorting using the reusable utility
    query = applyQueryOptions(query, queryParams, INVOICE_QUERY_CONFIG);

    // Execute the query
    // In a real environment, this would run against PG.
    // Knex ensures this is translated to efficient SQL:
    // e.g. SELECT * FROM invoices WHERE status = 'paid' AND sme_id = '...' ORDER BY amount DESC
    return await query;
  } catch (error) {
    console.error('Error fetching invoices:', error);
    throw new Error('Database error while fetching invoices');
  }
}

module.exports = {
  getInvoices,
  INVOICE_QUERY_CONFIG
};
