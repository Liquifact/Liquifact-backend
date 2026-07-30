'use strict';

/**
 * @fileoverview Zod validation schemas for indexer query request payloads.
 *
 * Replaces ad-hoc validation in the admin indexer route with declarative
 * schemas that produce structured error messages at the API boundary.
 *
 * @module schemas/indexerQuery
 */

const { z } = require('zod');
const { INDEXER_SORT_FIELDS } = require('../services/indexerService');
const {
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
} = require('./validationHelper');

/**
 * Maximum allowed limit for pagination.
 */
const MAX_LIMIT = 100;

/**
 * Schema for the invoiceId query parameter.
 */
const invoiceIdSchema = z
  .string({ invalid_type_error: 'invoiceId must be a string' })
  .trim()
  .regex(INVOICE_ID_REGEX, {
    message: 'invoiceId must be 1-128 alphanumeric/underscore/hyphen characters',
  })
  .optional();

/**
 * Schema for the eventType query parameter.
 */
const eventTypeSchema = z
  .string({ invalid_type_error: 'eventType must be a string' })
  .min(1, { message: 'eventType must be a non-empty string (max 128 chars)' })
  .max(128, { message: 'eventType must be a non-empty string (max 128 chars)' })
  .trim()
  .optional();

/**
 * Schema for the contractId query parameter.
 */
const contractIdSchema = z
  .string({ invalid_type_error: 'contractId must be a string' })
  .regex(CONTRACT_ID_REGEX, {
    message: 'contractId must be a valid Stellar contract address (C... 56 chars)',
  })
  .trim()
  .optional();

/**
 * Schema for the sortBy query parameter.
 */
const sortBySchema = z
  .string({ invalid_type_error: 'sortBy must be a string' })
  .refine((val) => INDEXER_SORT_FIELDS.includes(val), {
    message: `sortBy must be one of: ${INDEXER_SORT_FIELDS.join(', ')}`,
  })
  .optional();

/**
 * Schema for the order query parameter.
 */
const orderSchema = z
  .string({ invalid_type_error: 'order must be a string' })
  .transform((val) => val.toLowerCase())
  .refine((val) => val === 'asc' || val === 'desc', {
    message: 'order must be "asc" or "desc"',
  })
  .optional();

/**
 * Schema for the cursor query parameter.
 */
const cursorSchema = z
  .string({ invalid_type_error: 'cursor must be a string' })
  .min(1, { message: 'cursor must be a non-empty string (max 2048 chars)' })
  .max(2048, { message: 'cursor must be a non-empty string (max 2048 chars)' })
  .optional();

/**
 * Schema for the page query parameter.
 */
const pageSchema = z
  .string({ invalid_type_error: 'page must be a string' })
  .transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'page must be an integer >= 1',
      });
      return z.NEVER;
    }
    return parsed;
  })
  .refine((val) => val >= 1, {
    message: 'page must be an integer >= 1',
  })
  .optional();

/**
 * Schema for the limit query parameter.
 */
const limitSchema = z
  .string({ invalid_type_error: 'limit must be a string' })
  .transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
      });
      return z.NEVER;
    }
    return parsed;
  })
  .refine((val) => val >= 1 && val <= MAX_LIMIT, {
    message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
  })
  .optional();

/**
 * Complete schema for the indexer query parameters.
 * All fields are optional since they are query params with defaults applied in the route.
 */
const indexerQuerySchema = z
  .object({
    invoiceId: invoiceIdSchema,
    eventType: eventTypeSchema,
    contractId: contractIdSchema,
    sortBy: sortBySchema,
    order: orderSchema,
    cursor: cursorSchema,
    page: pageSchema,
    limit: limitSchema,
  })
  .strict();

/**
 * Validates query parameters against the indexer schema.
 *
 * @param {object} query - Express req.query object.
 * @returns {{ isValid: boolean, fieldErrors: Record<string, string>, params: object }}
 *   Validation result with field errors and parsed parameters.
 */
function validateIndexerQuery(query) {
  // First check for unknown parameters
  const ALLOWED_PARAMS = new Set([
    'invoiceId', 'eventType', 'contractId', 'sortBy', 'order', 'cursor', 'page', 'limit'
  ]);
  const unknown = Object.keys(query).filter((k) => !ALLOWED_PARAMS.has(k));
  if (unknown.length > 0) {
    return {
      isValid: false,
      fieldErrors: { _unknown: `Unknown query parameters: ${unknown.join(', ')}` },
      params: {},
    };
  }

  // Ignore page when cursor is supplied (matches original behaviour)
  const queryToValidate = { ...query };
  if (queryToValidate.cursor && queryToValidate.page !== undefined) {
    delete queryToValidate.page;
  }

  const result = indexerQuerySchema.safeParse(queryToValidate);

  if (!result.success) {
    const fieldErrors = parseValidationErrors(result.error);
    return {
      isValid: false,
      fieldErrors,
      params: {},
    };
  }

  // Parse validated data into the expected params structure
  const validated = result.data;
  const params = {
    filters: {},
    sorting: {},
    pagination: {},
  };

  // Apply filters
  if (validated.invoiceId !== undefined) {
    params.filters.invoiceId = validated.invoiceId;
  }
  if (validated.eventType !== undefined) {
    params.filters.eventType = validated.eventType;
  }
  if (validated.contractId !== undefined) {
    params.filters.contractId = validated.contractId;
  }

  // Apply sorting
  if (validated.sortBy !== undefined) {
    params.sorting.sortBy = validated.sortBy;
  }
  if (validated.order !== undefined) {
    params.sorting.order = validated.order;
  }

  // Apply pagination
  if (validated.cursor !== undefined) {
    params.pagination.cursor = validated.cursor;
  }
  if (validated.page !== undefined) {
    params.pagination.page = validated.page;
  }
  if (validated.limit !== undefined) {
    params.pagination.limit = validated.limit;
  }

  return {
    isValid: true,
    fieldErrors: {},
    params,
  };
}

module.exports = {
  indexerQuerySchema,
  parseValidationErrors,
  validateIndexerQuery,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  MAX_LIMIT,
};
