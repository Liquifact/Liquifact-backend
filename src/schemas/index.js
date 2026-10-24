'use strict';

/**
 * Zod schemas: the single source of truth for request validation and the
 * OpenAPI component schemas generated from the registry below.
 */

const { z } = require('zod');
const { extendZodWithOpenApi, OpenAPIRegistry } = require('@asteasolutions/zod-to-openapi');
const { STATUSES, normalizeIdentity } = require('../data/store');

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const INVOICE_ID = /^[A-Za-z0-9_]{1,32}$/;
const INVOICE_NUMBER = /^[A-Za-z0-9._/-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// InvoiceIdParam — matches the Soroban contract's invoice-id rule
// ---------------------------------------------------------------------------
const InvoiceIdParam = registry.register(
  'InvoiceIdParam',
  z
    .object({
      id: z
        .string()
        .regex(INVOICE_ID, 'id must be 1-32 alphanumeric/underscore characters')
        .openapi({ description: 'Invoice identifier', example: 'INV_0001' }),
    })
    .openapi('InvoiceIdParam'),
);

// ---------------------------------------------------------------------------
// ListInvoicesQuery — documents the list filters; parsing (with its
// parameter-specific error details and cursor checks) is done by
// services/invoice-query.js.
// ---------------------------------------------------------------------------
const ListInvoicesQuery = registry.register(
  'ListInvoicesQuery',
  z
    .object({
      limit: z.string().optional().openapi({ description: 'Page size 1-100 (default 20)' }),
      cursor: z.string().max(2048).optional().openapi({ description: 'Opaque cursor from nextCursor' }),
      status: z.string().optional().openapi({ description: `Comma-separated statuses: ${STATUSES.join(', ')}` }),
      currency: z.string().max(12).optional(),
      sme: z.string().max(120).optional(),
      minAmount: z.string().optional(),
      maxAmount: z.string().optional(),
      minYieldBps: z.string().optional(),
      maxYieldBps: z.string().optional(),
      dueBefore: z.string().optional().openapi({ format: 'date' }),
      dueAfter: z.string().optional().openapi({ format: 'date' }),
      onChain: z.enum(['true', 'false']).optional(),
      sort: z.string().optional(),
    })
    .strict()
    .openapi('ListInvoicesQuery'),
);

// ---------------------------------------------------------------------------
// CreateInvoiceBody — preserves the existing field rules exactly
// ---------------------------------------------------------------------------
const nameField = (key) => {
  const message = `${key} must be a non-empty string (max 120 chars)`;
  return z
    .string({ required_error: message, invalid_type_error: message })
    .max(120, message)
    .refine((v) => v.trim().length > 0, message)
    .refine((v) => !v.trim() || Boolean(normalizeIdentity(v)), `${key} must contain letters or numbers`);
};

const AMOUNT_MESSAGE = 'amount must be a positive number';
const YIELD_MESSAGE = 'yieldBps must be an integer between 0 and 10000';
const DUE_DATE_MESSAGE = 'dueDate must be an ISO date (YYYY-MM-DD)';
const INVOICE_NUMBER_MESSAGE = 'invoiceNumber must be 1-64 characters using letters, digits, ., _, /, or -';

const CreateInvoiceBody = registry.register(
  'CreateInvoiceBody',
  z
    .object({
      sme: nameField('sme').openapi({ description: 'SME name', example: 'Acme Components Ltd' }),
      debtor: nameField('debtor').openapi({ description: 'Debtor name', example: 'Globex Retail' }),
      invoiceNumber: z
        .string({ invalid_type_error: INVOICE_NUMBER_MESSAGE })
        .trim()
        .min(1, INVOICE_NUMBER_MESSAGE)
        .max(64, INVOICE_NUMBER_MESSAGE)
        .regex(INVOICE_NUMBER, INVOICE_NUMBER_MESSAGE)
        .optional()
        .openapi({ description: 'SME invoice number (trimmed)', example: 'ACME-2027-001' }),
      confirmNotDuplicate: z
        .boolean()
        .optional()
        .openapi({ description: 'Explicitly permits a possible duplicate; never bypasses an exact invoice-number duplicate.' }),
      amount: z
        .number({ required_error: AMOUNT_MESSAGE, invalid_type_error: AMOUNT_MESSAGE })
        .gt(0, AMOUNT_MESSAGE)
        .max(1e12, AMOUNT_MESSAGE)
        .openapi({ description: 'Invoice face value', example: 25000 }),
      currency: z
        .string()
        .optional()
        .openapi({ description: 'Currency code, uppercased and truncated to 12 characters (default USDC)', example: 'USDC', default: 'USDC' }),
      yieldBps: z
        .number({ invalid_type_error: YIELD_MESSAGE })
        .int(YIELD_MESSAGE)
        .min(0, YIELD_MESSAGE)
        .max(10000, YIELD_MESSAGE)
        .nullable()
        .optional()
        .openapi({ description: 'Annualised yield in basis points (null or omitted means 800)', default: 800 }),
      dueDate: z
        .string({ required_error: DUE_DATE_MESSAGE, invalid_type_error: DUE_DATE_MESSAGE })
        .regex(ISO_DATE, DUE_DATE_MESSAGE)
        .refine((v) => !Number.isNaN(Date.parse(v)), DUE_DATE_MESSAGE)
        .openapi({ description: 'Payment due date', example: '2027-01-01', format: 'date' }),
      smeAddress: z
        .string()
        .nullable()
        .optional()
        .openapi({ description: 'Stellar address of the SME' }),
    })
    .strict()
    .openapi('CreateInvoiceBody'),
);

// ---------------------------------------------------------------------------
// FundInvoiceBody — documents the contract. The route validates the values
// itself so it can return its specific error codes and audit every attempt;
// the middleware schema below only enforces the shape (no unknown keys).
// ---------------------------------------------------------------------------
const FundInvoiceBody = registry.register(
  'FundInvoiceBody',
  z
    .object({
      amount: z
        .number()
        .gt(0)
        .openapi({ description: 'Positive finite amount not exceeding the invoice face value', example: 7000 }),
      investor: z
        .string()
        .openapi({ description: 'Stellar public key of the investor', example: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5' }),
      allowPartial: z
        .boolean()
        .optional()
        .openapi({
          description: 'When true, the contribution is capped at remainingCapacity and the response reports accepted/rejected',
          default: false,
        }),
    })
    .strict()
    .openapi('FundInvoiceBody'),
);

const FundInvoiceBodyShape = z
  .object({
    amount: z.unknown().optional(),
    investor: z.unknown().optional(),
    allowPartial: z.unknown().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Invoice (response)
// ---------------------------------------------------------------------------
const Invoice = registry.register(
  'Invoice',
  z
    .object({
      id: z.string().regex(INVOICE_ID).openapi({ example: 'INV_0001' }),
      invoiceNumber: z.string().optional().openapi({ example: 'ACME-2027-001' }),
      sme: z.string().openapi({ example: 'Acme Components Ltd' }),
      smeAddress: z.string().nullable(),
      debtor: z.string().openapi({ example: 'Globex Retail' }),
      amount: z.number().openapi({ example: 25000 }),
      currency: z.string().openapi({ example: 'USDC' }),
      fundedAmount: z.number().openapi({ example: 0 }),
      remainingCapacity: z.number().openapi({ example: 25000, description: 'amount - fundedAmount (computed)' }),
      yieldBps: z.number().int().openapi({ example: 800 }),
      dueDate: z.string().openapi({ format: 'date', example: '2027-01-17' }),
      status: z.enum(STATUSES),
      escrowContractId: z.string().nullable().openapi({ description: 'Verified linked escrow contract (null when off-chain)' }),
      onChain: z.boolean().openapi({ description: 'Derived from escrowContractId !== null', readOnly: true }),
      createdAt: z.string().openapi({ format: 'date-time' }),
      duplicateOverride: z.boolean().optional(),
    })
    .openapi('Invoice'),
);

// ---------------------------------------------------------------------------
// Error response
// ---------------------------------------------------------------------------
const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional(),
      details: z.array(z.string()).optional(),
      errors: z
        .array(z.object({ path: z.string(), message: z.string(), code: z.string() }))
        .optional(),
    })
    .openapi('ErrorResponse'),
);

module.exports = {
  registry,
  InvoiceIdParam,
  ListInvoicesQuery,
  CreateInvoiceBody,
  FundInvoiceBody,
  FundInvoiceBodyShape,
  Invoice,
  ErrorResponse,
};
