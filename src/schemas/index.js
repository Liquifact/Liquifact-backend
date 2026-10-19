'use strict';

const { z } = require('zod');
const { extendZodWithOpenApi, OpenAPIRegistry } = require('@asteasolutions/zod-to-openapi');

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// InvoiceIdParam  — matches the Soroban contract's invoice-id rule
// ---------------------------------------------------------------------------
const InvoiceIdParam = registry.register(
  'InvoiceIdParam',
  z
    .object({
      id: z
        .string()
        .regex(/^[A-Za-z0-9_]{1,32}$/, 'id must be 1–32 alphanumeric/underscore characters')
        .openapi({ description: 'Invoice identifier', example: 'INV_0001' }),
    })
    .openapi('InvoiceIdParam'),
);

// ---------------------------------------------------------------------------
// ListInvoicesQuery
// ---------------------------------------------------------------------------
const STATUSES = ['open', 'funded', 'settled', 'cancelled'];

const ListInvoicesQuery = registry.register(
  'ListInvoicesQuery',
  z
    .object({
      status: z
        .enum(['open', 'funded', 'settled', 'cancelled'])
        .optional()
        .openapi({ description: 'Filter invoices by status' }),
    })
    .openapi('ListInvoicesQuery'),
);

// ---------------------------------------------------------------------------
// CreateInvoiceBody
// ---------------------------------------------------------------------------
const CreateInvoiceBody = registry.register(
  'CreateInvoiceBody',
  z
    .object({
      sme: z
        .string()
        .min(1, 'sme must be a non-empty string (max 120 chars)')
        .max(120, 'sme must be a non-empty string (max 120 chars)')
        .openapi({ description: 'SME name', example: 'Acme Components Ltd' }),
      debtor: z
        .string()
        .min(1, 'debtor must be a non-empty string (max 120 chars)')
        .max(120, 'debtor must be a non-empty string (max 120 chars)')
        .openapi({ description: 'Debtor name', example: 'Globex Retail' }),
      amount: z
        .number()
        .gt(0, 'amount must be a positive number')
        .max(1e12, 'amount must be a positive number')
        .openapi({ description: 'Invoice face value', example: 25000 }),
      currency: z
        .string()
        .max(12)
        .optional()
        .openapi({ description: 'Currency code (default USDC)', example: 'USDC', default: 'USDC' }),
      yieldBps: z
        .number()
        .int('yieldBps must be an integer between 0 and 10000')
        .min(0, 'yieldBps must be an integer between 0 and 10000')
        .max(10000, 'yieldBps must be an integer between 0 and 10000')
        .optional()
        .openapi({ description: 'Annualised yield in basis points', default: 800 }),
      dueDate: z
        .string()
        .refine((v) => !Number.isNaN(Date.parse(v)), 'dueDate must be an ISO date (YYYY-MM-DD)')
        .openapi({ description: 'Payment due date (ISO 8601)', example: '2027-01-01', format: 'date' }),
      smeAddress: z
        .string()
        .optional()
        .openapi({ description: 'Stellar address of the SME' }),
    })
    .strict()
    .openapi('CreateInvoiceBody'),
);

// ---------------------------------------------------------------------------
// FundInvoiceBody  — used for OpenAPI schema generation only
// Route validates investor manually to produce specific error codes.
// ---------------------------------------------------------------------------
const FundInvoiceBody = registry.register(
  'FundInvoiceBody',
  z
    .object({
      amount: z
        .number()
        .gt(0, 'amount must be a positive number')
        .openapi({ description: 'Contribution amount', example: 5000 }),
      investor: z
        .string()
        .openapi({ description: 'Stellar public key of the investor', example: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5' }),
    })
    .strict()
    .openapi('FundInvoiceBody'),
);

// Middleware-only schema: validates amount + rejects unknown keys; investor checked in route.
const FundInvoiceBodyValidate = z
  .object({
    amount: z.number().gt(0, 'amount must be a positive number'),
    investor: z.unknown().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Invoice  (response schema)
// ---------------------------------------------------------------------------
const Invoice = registry.register(
  'Invoice',
  z
    .object({
      id: z.string().openapi({ example: 'INV_0001' }),
      sme: z.string().openapi({ example: 'Acme Components Ltd' }),
      smeAddress: z.string().nullable().openapi({ example: null }),
      debtor: z.string().openapi({ example: 'Globex Retail' }),
      amount: z.number().openapi({ example: 25000 }),
      currency: z.string().openapi({ example: 'USDC' }),
      fundedAmount: z.number().openapi({ example: 0 }),
      yieldBps: z.number().int().openapi({ example: 800 }),
      dueDate: z.string().openapi({ example: '2027-01-17', format: 'date' }),
      status: z.enum(['open', 'funded', 'settled', 'cancelled']),
      onChain: z.boolean(),
      createdAt: z.string().openapi({ format: 'date-time' }),
    })
    .openapi('Invoice'),
);

// ---------------------------------------------------------------------------
// Error response (for OpenAPI docs)
// ---------------------------------------------------------------------------
const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional(),
      details: z.array(z.string()).optional(),
      errors: z
        .array(
          z.object({
            path: z.string(),
            message: z.string(),
            code: z.string(),
          }),
        )
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
  FundInvoiceBodyValidate,
  Invoice,
  ErrorResponse,
  STATUSES,
};
