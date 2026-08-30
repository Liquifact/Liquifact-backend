'use strict';

/**
 * @fileoverview Zod schemas for invoice create/update validation.
 *
 * Exposes:
 *  - `invoiceCreateSchema`  — strict create schema (rejects unknown keys)
 *  - `invoiceUpdateSchema`  — partial update schema (all fields optional)
 *  - `validateInvoicePayload` — adapter returning `{ isValid, errors, validatedPayload }`
 *  - `paginationQuerySchema` — query-param schema for list endpoints
 *  - `parseValidationErrors` — Zod ZodError → field-keyed object
 *  - `validateBody` / `validateQuery` — Express middleware factories
 *
 * @module schemas/invoice
 */

const { z } = require('zod');
const { normalizeMonetaryInput, MonetaryValidationError } = require('../utils/monetary');

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Supported ISO 4217 currency codes.
 * @type {readonly string[]}
 */
const SUPPORTED_CURRENCIES = /** @type {const} */ ([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD',
  'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'KRW', 'ZAR', 'NGN',
  'GHS', 'KES', 'TZS', 'UGX', 'XOF', 'XAF', 'MAD', 'EGP', 'AED', 'SAR',
]);

/** @type {readonly string[]} */
const VALID_STATUSES = /** @type {const} */ (['paid', 'pending', 'overdue']);

/** @type {readonly string[]} */
const VALID_SORT_FIELDS = /** @type {const} */ (['amount', 'date', 'createdAt']);

// ── Shared primitives ────────────────────────────────────────────────────────

/** YYYY-MM-DD date string that is also a calendar-valid date. */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date must be in YYYY-MM-DD format' })
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Date must be a valid calendar date' });

/** 3-letter ISO 4217 currency, case-insensitive, normalised to upper-case. */
const currencySchema = z
  .string()
  .length(3, { message: 'Currency must be a 3-letter ISO 4217 code' })
  .transform((v) => v.toUpperCase())
  .refine((v) => SUPPORTED_CURRENCIES.includes(v), {
    message: `Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  });

// ── Create schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for invoice creation payloads.
 *
 * Security guarantees:
 *  - `.strict()` rejects unknown keys, preventing prototype-polluting payloads.
 *  - String length bounds prevent oversized inputs.
 *  - `amount` must be a positive, finite number.
 *  - `currency` is normalised to upper-case and allowlisted.
 *  - `amount` is validated for monetary precision (max 2 decimal places).
 *
 * @type {import('zod').ZodObject}
 */
const invoiceCreateSchema = z
  .object({
    /** Positive invoice amount with monetary precision validation. */
    amount: z
      .union([
        z.number({ invalid_type_error: 'amount must be a number', required_error: 'amount is required' })
          .positive({ message: 'amount must be a positive number' })
          .finite({ message: 'amount must be a finite number' }),
        z.string({ invalid_type_error: 'amount must be a number or string' })
          .min(1, { message: 'amount must not be empty' }),
      ])
      .transform((val) => {
        // Normalize to canonical decimal string
        try {
          return normalizeMonetaryInput(val, 'amount');
        } catch (err) {
          if (err instanceof MonetaryValidationError) {
            throw new z.ZodError([{
              code: z.ZodIssueCode.custom,
              message: err.message,
              path: ['amount'],
            }]);
          }
          throw err;
        }
      }),

    /** Due date in YYYY-MM-DD format. */
    dueDate: dateSchema.optional(),

    /** Buyer / customer name (1–255 chars). */
    buyer: z
      .string({ invalid_type_error: 'buyer must be a string' })
      .min(1, { message: 'buyer must be a non-empty string' })
      .max(255, { message: 'buyer must not exceed 255 characters' })
      .transform((v) => v.trim())
      .optional(),

    /** Alias for buyer accepted by invoiceService. */
    customer: z
      .string({ invalid_type_error: 'customer must be a string' })
      .min(1, { message: 'customer must be a non-empty string' })
      .max(255, { message: 'customer must not exceed 255 characters' })
      .transform((v) => v.trim())
      .optional(),

    /** Seller name (1–255 chars). */
    seller: z
      .string({ invalid_type_error: 'seller must be a string' })
      .min(1, { message: 'seller must be a non-empty string' })
      .max(255, { message: 'seller must not exceed 255 characters' })
      .transform((v) => v.trim())
      .optional(),

    /** ISO 4217 currency code. */
    currency: currencySchema.optional(),

    /** Optional human-readable description (max 1 000 chars). */
    description: z
      .string({ invalid_type_error: 'description must be a string' })
      .max(1000, { message: 'description must not exceed 1000 characters' })
      .optional(),

    /** Optional invoice reference number (max 100 chars). */
    invoiceNumber: z
      .string({ invalid_type_error: 'invoiceNumber must be a string' })
      .trim()
      .min(1, { message: 'invoiceNumber must be a non-empty string' })
      .max(100, { message: 'invoiceNumber must not exceed 100 characters' })
      .transform((v) => v.toLowerCase())
      .optional(),
  })
  .strict() // ← reject unknown keys
  .superRefine((data, ctx) => {
    // Require at least one of buyer / customer
    if (!data.buyer && !data.customer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'buyer is required',
        path: ['buyer'],
      });
    }
    // seller is required for create
    if (!data.seller) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'seller is required',
        path: ['seller'],
      });
    }
    // currency is required for create
    if (!data.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'currency is required',
        path: ['currency'],
      });
    }
    // dueDate is required for create
    if (!data.dueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dueDate is required',
        path: ['dueDate'],
      });
    }
  });

// ── Update schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for partial invoice update payloads.
 * All fields optional; unknown keys still rejected.
 *
 * @type {import('zod').ZodObject}
 */
const invoiceUpdateSchema = z
  .object({
    version: z
      .number({ invalid_type_error: 'version must be a number' })
      .int({ message: 'version must be an integer' })
      .positive({ message: 'version must be positive' })
      .safe({ message: 'version must be a safe integer' }),
    amount: z
      .union([
        z.number({ invalid_type_error: 'amount must be a number' })
          .positive({ message: 'amount must be a positive number' })
          .finite({ message: 'amount must be a finite number' }),
        z.string({ invalid_type_error: 'amount must be a number or string' })
          .min(1, { message: 'amount must not be empty' }),
      ])
      .transform((val) => {
        try {
          return normalizeMonetaryInput(val, 'amount');
        } catch (err) {
          if (err instanceof MonetaryValidationError) {
            throw new z.ZodError([{
              code: z.ZodIssueCode.custom,
              message: err.message,
              path: ['amount'],
            }]);
          }
          throw err;
        }
      })
      .optional(),

    dueDate: dateSchema.optional(),

    buyer: z
      .string({ invalid_type_error: 'buyer must be a string' })
      .min(1, { message: 'buyer must be a non-empty string' })
      .max(255, { message: 'buyer must not exceed 255 characters' })
      .transform((v) => v.trim())
      .optional(),

    customer: z
      .string()
      .min(1)
      .max(255)
      .transform((v) => v.trim())
      .optional(),

    seller: z
      .string({ invalid_type_error: 'seller must be a string' })
      .min(1, { message: 'seller must be a non-empty string' })
      .max(255, { message: 'seller must not exceed 255 characters' })
      .transform((v) => v.trim())
      .optional(),

    currency: currencySchema.optional(),

    notes: z
      .string({ invalid_type_error: 'notes must be a string' })
      .max(2000, { message: 'notes must not exceed 2000 characters' })
      .optional(),

    description: z
      .string()
      .max(1000, { message: 'description must not exceed 1000 characters' })
      .optional(),

    invoiceNumber: z
      .string()
      .trim()
      .min(1, { message: 'invoiceNumber must be a non-empty string' })
      .max(100, { message: 'invoiceNumber must not exceed 100 characters' })
      .transform((v) => v.toLowerCase())
      .optional(),

    status: z
      .enum(['pending', 'paid', 'overdue', 'cancelled'], {
        errorMap: () => ({ message: 'status must be one of: pending, paid, overdue, cancelled' }),
      })
      .optional(),
  })
  .strict();

// ── Pagination / query schema ────────────────────────────────────────────────

/**
 * Zod schema for `GET /api/invoices` query parameters.
 *
 * @type {import('zod').ZodObject}
 */
const paginationQuerySchema = z.object({
  page: z.coerce
    .number()
    .int({ message: 'page must be an integer' })
    .positive({ message: 'page must be a positive number' })
    .default(1),

  limit: z.coerce
    .number()
    .int({ message: 'limit must be an integer' })
    .min(1, { message: 'limit must be at least 1' })
    .max(100, { message: 'limit must not exceed 100' })
    .default(20),

  status: z
    .enum(/** @type {[string, ...string[]]} */ (VALID_STATUSES), {
      errorMap: () => ({ message: `status must be one of: ${VALID_STATUSES.join(', ')}` }),
    })
    .optional(),

  smeId: z.string().min(1).max(100).optional(),
  buyerId: z.string().min(1).max(100).optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),

  sortBy: z
    .enum(/** @type {[string, ...string[]]} */ (VALID_SORT_FIELDS), {
      errorMap: () => ({ message: `sortBy must be one of: ${VALID_SORT_FIELDS.join(', ')}` }),
    })
    .optional(),

  order: z
    .enum(['asc', 'desc'], {
      errorMap: () => ({ message: 'order must be "asc" or "desc"' }),
    })
    .optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const validationHelper = require('./validationHelper');

/**
 * Flattens a ZodError into a `{ [fieldPath]: firstMessage }` object.
 *
 * This is a re-export from the shared validation helper module,
 * preserving backward compatibility for existing callers.
 *
 * @param {import('zod').ZodError} zodError
 * @returns {Record<string, string>}
 */
function parseValidationErrors(zodError) {
  return validationHelper.parseValidationErrors(zodError);
}

// ── validateInvoicePayload adapter ───────────────────────────────────────────

/**
 * Validates an invoice creation payload using `invoiceCreateSchema`.
 *
 * Returns the same `{ isValid, errors, validatedPayload }` shape as the
 * previous hand-rolled implementation so all existing callers continue to
 * work without modification.
 *
 * Security:
 *  - Unknown keys are stripped (`.strict()` on the schema causes a parse
 *    error, but the adapter normalises that into a field error).
 *  - String fields are trimmed.
 *  - currency is normalised to upper-case.
 *
 * @param {unknown} body - Raw request body.
 * @returns {{ isValid: boolean, errors: string[], validatedPayload: object }}
 */
function validateInvoicePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      isValid: false,
      errors: ['Invoice payload must be a JSON object'],
      validatedPayload: {},
    };
  }

  const result = invoiceCreateSchema.safeParse(body);

  if (result.success) {
    return { isValid: true, errors: [], validatedPayload: result.data };
  }

  // Collect human-readable error messages (one per failing field)
  const errors = result.error.issues.map((issue) => {
    const field = issue.path.join('.') || 'payload';
    return `${field}: ${issue.message}`;
  });

  return { isValid: false, errors, validatedPayload: {} };
}

// ── Express middleware factories ─────────────────────────────────────────────

/**
 * Creates Express middleware that validates `req.body` against a Zod schema
 * and maps errors to an RFC 7807 `application/problem+json` response.
 *
 * On success, attaches the parsed (and transformed) value to `req.validated`.
 *
 * This is a thin wrapper around `createBodyValidator` from the shared
 * validation helper module, preserving the original API for backward
 * compatibility.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
function validateBody(schema) {
  return validationHelper.createBodyValidator(schema);
}

/**
 * Creates Express middleware that validates `req.query` against a Zod schema
 * and maps errors to an RFC 7807 `application/problem+json` response.
 *
 * On success, attaches the parsed value to `req.validatedQuery`.
 *
 * This is a thin wrapper around `createQueryValidator` from the shared
 * validation helper module, preserving the original API for backward
 * compatibility.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
function validateQuery(schema) {
  return validationHelper.createQueryValidator(schema);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  invoiceCreateSchema,
  invoiceUpdateSchema,
  paginationQuerySchema,
  validateInvoicePayload,
  validateBody,
  validateQuery,
  parseValidationErrors,
  SUPPORTED_CURRENCIES,
  VALID_STATUSES,
  VALID_SORT_FIELDS,
};
