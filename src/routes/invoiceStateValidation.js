'use strict';

const invoiceService = require('../services/invoiceService');

/**
 * Builds a structured validation error object with status code and error details.
 * @param {string} code - Machine-readable error code.
 * @param {string} message - Human-readable error message.
 * @param {number} [statusCode=400] - HTTP status code.
 * @param {object} [details={}] - Additional error details.
 * @returns {{statusCode: number, error: {code: string, message: string, details?: object}}}
 *   Structured error object.
 */
function buildInvoiceStateError(code, message, statusCode = 400, details = {}) {
  return {
    statusCode,
    error: {
      code,
      message,
      ...(Object.keys(details || {}).length > 0 ? { details } : {}),
    },
  };
}

/**
 * Extracts and normalizes the tenant identifier from a request object.
 * Checks x-tenant-id and x-tenant headers first, then falls back to req.tenantId.
 * @param {import('express').Request|null|undefined} req - Express request object.
 * @returns {string} Normalized tenant ID string, or empty string when absent.
 */
function normalizeTenantId(req) {
  const rawTenantId = req && (req.headers && (req.headers['x-tenant-id'] || req.headers['x-tenant']))
    ? req.headers['x-tenant-id'] || req.headers['x-tenant']
    : req && req.tenantId;

  return typeof rawTenantId === 'string' ? rawTenantId.trim() : '';
}

/**
 * Normalizes an invoice ID by trimming whitespace.
 * Returns empty string for non-string or missing values.
 * @param {*} invoiceId - Raw invoice identifier.
 * @returns {string} Normalized invoice ID string.
 */
function normalizeInvoiceId(invoiceId) {
  if (typeof invoiceId === 'string') {
    return invoiceId.trim();
  }
  return '';
}

/**
 * Resolves the full invoice state context for a request.
 * Validates tenant ID, normalizes invoice ID, and looks up the invoice.
 * Returns either a success context or a structured error.
 * @param {import('express').Request} req - Express request object.
 * @param {string} invoiceId - Raw invoice identifier from route params.
 * @returns {Promise<{invoiceId: string, tenantId: string, invoice: object}|{error: {statusCode: number, error: {code: string, message: string, details?: object}}}>}
 *   Resolved context or error.
 */
async function resolveInvoiceStateContext(req, invoiceId) {
  const tenantId = normalizeTenantId(req);
  if (!tenantId) {
    return {
      error: buildInvoiceStateError('MISSING_TENANT', 'Tenant context is required.', 400),
    };
  }

  const normalizedInvoiceId = normalizeInvoiceId(invoiceId);
  if (!normalizedInvoiceId) {
    return {
      error: buildInvoiceStateError('MISSING_INVOICE_ID', 'Invoice ID is required.', 400),
    };
  }

  const invoice = await invoiceService.getInvoiceById(normalizedInvoiceId, tenantId);
  if (!invoice) {
    return {
      error: buildInvoiceStateError('INVOICE_NOT_FOUND', 'Invoice not found.', 404),
    };
  }

  return {
    invoiceId: normalizedInvoiceId,
    tenantId,
    invoice,
  };
}

module.exports = {
  buildInvoiceStateError,
  normalizeTenantId,
  normalizeInvoiceId,
  resolveInvoiceStateContext,
};
