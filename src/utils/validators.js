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

module.exports = {
  validateInvoiceQueryParams,
};
