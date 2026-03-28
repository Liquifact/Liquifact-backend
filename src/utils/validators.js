/**
 * Input Validation Utilities
 * 
 * Provides functions to validate incoming query parameters.
 */

/**
 * Validates invoice query parameters.
 * 
 * @param {Object} query - The Express query object.
 * @returns {Object} { isValid, errors, validatedParams }
 */
function validateInvoiceQueryParams(query) {
  const errors = [];
  const validatedParams = {
    filters: {},
    sorting: {}
  };

  const {
    status,
    smeId,
    buyerId,
    dateFrom,
    dateTo,
    sortBy,
    order
  } = query;

  // Validate status
  if (status !== undefined) {
    const validStatuses = ['paid', 'pending', 'overdue'];
    if (validStatuses.includes(status)) {
      validatedParams.filters.status = status;
    } else {
      errors.push(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
  }

  // Validate SME ID (assuming non-empty string)
  if (smeId !== undefined) {
    if (typeof smeId === 'string' && smeId.trim().length > 0) {
      validatedParams.filters.smeId = smeId;
    } else {
      errors.push('Invalid smeId format');
    }
  }

  // Validate Buyer ID (assuming non-empty string)
  if (buyerId !== undefined) {
    if (typeof buyerId === 'string' && buyerId.trim().length > 0) {
      validatedParams.filters.buyerId = buyerId;
    } else {
      errors.push('Invalid buyerId format');
    }
  }

  // Validate Dates
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dateFrom !== undefined) {
    if (dateRegex.test(dateFrom) && !isNaN(Date.parse(dateFrom))) {
      validatedParams.filters.dateFrom = dateFrom;
    } else {
      errors.push('Invalid dateFrom format. Use YYYY-MM-DD');
    }
  }

  if (dateTo !== undefined) {
    if (dateRegex.test(dateTo) && !isNaN(Date.parse(dateTo))) {
      validatedParams.filters.dateTo = dateTo;
    } else {
      errors.push('Invalid dateTo format. Use YYYY-MM-DD');
    }
  }

  // Validate sortBy
  if (sortBy !== undefined) {
    const validSortFields = ['amount', 'date'];
    if (validSortFields.includes(sortBy)) {
      validatedParams.sorting.sortBy = sortBy;
    } else {
      errors.push(`Invalid sortBy. Must be one of: ${validSortFields.join(', ')}`);
    }
  }

  // Validate order
  if (order !== undefined) {
    const lowerOrder = order.toLowerCase();
    if (['asc', 'desc'].includes(lowerOrder)) {
      validatedParams.sorting.order = lowerOrder;
    } else {
      errors.push('Invalid order. Must be "asc" or "desc"');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    validatedParams
  };
}

/**
 * Supported ISO 4217 currency codes accepted by the invoice API.
 *
 * @constant {Set<string>}
 */
const VALID_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD',
  'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'KRW', 'ZAR', 'NGN',
  'GHS', 'KES', 'TZS', 'UGX', 'XOF', 'XAF', 'MAD', 'EGP', 'AED', 'SAR',
]);

/**
 * Validates invoice creation payload fields.
 *
 * Performs strict type and format checks on all required invoice fields:
 * amount, dueDate, buyer, seller, and currency. Collects all validation
 * errors in a single pass so the caller can surface them together.
 *
 * @param {Object} body - The raw request body object.
 * @param {number}  body.amount   - Invoice amount (must be a positive finite number).
 * @param {string}  body.dueDate  - Due date in YYYY-MM-DD format.
 * @param {string}  body.buyer    - Buyer name (non-empty string).
 * @param {string}  body.seller   - Seller name (non-empty string).
 * @param {string}  body.currency - ISO 4217 currency code (e.g. USD, EUR).
 * @returns {{ isValid: boolean, errors: string[], validatedPayload: Object }}
 *   - `isValid`          — true when all fields pass validation.
 *   - `errors`           — list of human-readable error messages.
 *   - `validatedPayload` — sanitised copy of accepted fields.
 */
function validateInvoicePayload(body) {
  const errors = [];
  const validatedPayload = {};
  const safeBody = body && typeof body === 'object' ? body : {};

  // ── amount ───────────────────────────────────────────────────────────────
  const { amount } = safeBody;
  if (amount === undefined || amount === null) {
    errors.push('amount is required');
  } else if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    errors.push('amount must be a positive number');
  } else {
    validatedPayload.amount = amount;
  }

  // ── dueDate ──────────────────────────────────────────────────────────────
  const { dueDate } = safeBody;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dueDate === undefined || dueDate === null) {
    errors.push('dueDate is required');
  } else if (
    typeof dueDate !== 'string' ||
    !dateRegex.test(dueDate) ||
    isNaN(Date.parse(dueDate))
  ) {
    errors.push('dueDate must be a valid date in YYYY-MM-DD format');
  } else {
    validatedPayload.dueDate = dueDate;
  }

  // ── buyer ────────────────────────────────────────────────────────────────
  const { buyer } = safeBody;
  if (buyer === undefined || buyer === null) {
    errors.push('buyer is required');
  } else if (typeof buyer !== 'string' || buyer.trim().length === 0) {
    errors.push('buyer must be a non-empty string');
  } else {
    validatedPayload.buyer = buyer.trim();
  }

  // ── seller ───────────────────────────────────────────────────────────────
  const { seller } = safeBody;
  if (seller === undefined || seller === null) {
    errors.push('seller is required');
  } else if (typeof seller !== 'string' || seller.trim().length === 0) {
    errors.push('seller must be a non-empty string');
  } else {
    validatedPayload.seller = seller.trim();
  }

  // ── currency ─────────────────────────────────────────────────────────────
  const { currency } = safeBody;
  if (currency === undefined || currency === null) {
    errors.push('currency is required');
  } else if (
    typeof currency !== 'string' ||
    !VALID_CURRENCIES.has(currency.toUpperCase())
  ) {
    errors.push('currency must be a supported ISO 4217 code (e.g. USD, EUR, GBP)');
  } else {
    validatedPayload.currency = currency.toUpperCase();
  }

  return {
    isValid: errors.length === 0,
    errors,
    validatedPayload,
  };
}

module.exports = {
  validateInvoiceQueryParams,
  validateInvoicePayload,
  VALID_CURRENCIES,
};
