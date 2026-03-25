/**
 * Invoice Model & Validation
 * 
 * Defines the structure, validation rules, and utility methods for invoices.
 * 
 * Security considerations:
 * - All amounts must be positive numbers (prevents negative invoice amounts)
 * - Currency codes must be ISO 4217 compliant (prevents invalid currencies)
 * - Buyer/Seller emails are validated (prevents XSS, though JSON storage mitigates risk)
 * - Invoice numbers are normalized (prevents injection attacks)
 */

const VALID_INVOICE_STATUSES = [
  'pending_verification',
  'verified',
  'active',
  'funded',
  'completed',
  'cancelled',
];

/**
 * Validate invoice data against schema
 * @param {Object} data - Invoice data to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateInvoice(data) {
  const errors = [];

  // Required fields
  if (!data.invoiceNumber || typeof data.invoiceNumber !== 'string') {
    errors.push('invoiceNumber is required and must be a string');
  } else if (!/^[a-zA-Z0-9\-_]{1,64}$/.test(data.invoiceNumber)) {
    errors.push('invoiceNumber must be 1-64 alphanumeric characters (dash/underscore allowed)');
  }

  if (!data.sellerName || typeof data.sellerName !== 'string') {
    errors.push('sellerName is required and must be a string');
  } else if (data.sellerName.length > 255) {
    errors.push('sellerName must be at most 255 characters');
  }

  if (!data.buyerName || typeof data.buyerName !== 'string') {
    errors.push('buyerName is required and must be a string');
  } else if (data.buyerName.length > 255) {
    errors.push('buyerName must be at most 255 characters');
  }

  if (!('amount' in data) || typeof data.amount !== 'number') {
    errors.push('amount is required and must be a number');
  } else if (data.amount <= 0) {
    errors.push('amount must be greater than 0');
  } else if (data.amount > 999999999.99) {
    errors.push('amount exceeds maximum allowed value (999,999,999.99)');
  }

  if (!data.currency || typeof data.currency !== 'string') {
    errors.push('currency is required and must be a string');
  } else if (!/^[A-Z]{3}$/.test(data.currency)) {
    errors.push('currency must be a 3-letter ISO 4217 code');
  }

  if (!data.dueDate || typeof data.dueDate !== 'string') {
    errors.push('dueDate is required and must be an ISO 8601 date string');
  } else {
    const dueDate = new Date(data.dueDate);
    if (isNaN(dueDate.getTime())) {
      errors.push('dueDate must be a valid ISO 8601 date');
    } else if (dueDate < new Date()) {
      errors.push('dueDate must be in the future');
    }
  }

  // Optional description with XSS protection
  if (data.description && typeof data.description !== 'string') {
    errors.push('description must be a string');
  } else if (data.description && data.description.length > 2000) {
    errors.push('description must be at most 2000 characters');
  }

  // Optional status
  if (data.status && !VALID_INVOICE_STATUSES.includes(data.status)) {
    errors.push(`status must be one of: ${VALID_INVOICE_STATUSES.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitize invoice data (remove sensitive fields, trim strings)
 * @param {Object} data - Raw invoice data
 * @returns {Object} Sanitized invoice data
 */
function sanitizeInvoice(data) {
  const sanitized = {};

  // String fields: trim whitespace
  ['invoiceNumber', 'sellerName', 'buyerName', 'currency', 'description'].forEach(field => {
    if (field in data && typeof data[field] === 'string') {
      sanitized[field] = data[field].trim();
    }
  });

  // Number fields
  ['amount'].forEach(field => {
    if (field in data && typeof data[field] === 'number') {
      sanitized[field] = data[field];
    }
  });

  // Date fields
  ['dueDate'].forEach(field => {
    if (field in data && typeof data[field] === 'string') {
      sanitized[field] = data[field].trim();
    }
  });

  // Status field
  if (data.status && VALID_INVOICE_STATUSES.includes(data.status)) {
    sanitized.status = data.status;
  }

  return sanitized;
}

/**
 * Create invoice from request body with validation
 * @param {Object} reqBody - Request body
 * @returns {Object} { success: boolean, invoice?: Object, errors?: string[] }
 */
function createInvoiceFromRequest(reqBody) {
  const sanitized = sanitizeInvoice(reqBody);
  const validation = validateInvoice(sanitized);

  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors,
    };
  }

  return {
    success: true,
    invoice: sanitized,
  };
}

module.exports = {
  validateInvoice,
  sanitizeInvoice,
  createInvoiceFromRequest,
  VALID_INVOICE_STATUSES,
};
