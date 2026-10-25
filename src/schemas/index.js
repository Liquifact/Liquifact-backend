'use strict';

/**
 * Zod schemas: the single source of truth for request validation and the
 * OpenAPI component schemas generated from the registry below.
 */

const { z } = require('zod');
const { extendZodWithOpenApi, OpenAPIRegistry } = require('@asteasolutions/zod-to-openapi');
const { StrKey } = require('@stellar/stellar-sdk');
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
      sme: nameField('sme')
        .optional()
        .openapi({ description: 'SME name (required unless smeId is given; ignored when SME verification is enforced)', example: 'Acme Components Ltd' }),
      smeId: z
        .string()
        .regex(/^SME_[A-Za-z0-9-]{1,64}$/, 'smeId must be an SME id (SME_...)')
        .optional()
        .openapi({ description: 'Onboarded SME. Required and must be verified when REQUIRE_SME_VERIFICATION=true.', example: 'SME_3f1c...' }),
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
        .openapi({ description: 'Stellar address of the SME (ignored when SME verification is enforced)' }),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (body.sme === undefined && body.smeId === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sme'], message: 'sme must be a non-empty string (max 120 chars)' });
      }
    })
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
      smeId: z.string().optional().openapi({ description: 'Linked onboarded SME, when given' }),
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
      createdBy: z.string().optional().openapi({ description: 'Opaque id of the API key that created the invoice' }),
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

// ---------------------------------------------------------------------------
// SME onboarding (KYB)
// ---------------------------------------------------------------------------
const ISO_COUNTRIES = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN ' +
  'MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS ' +
  'PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ ' +
  'TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(/\s+/));

const SME_STATUSES = ['pending', 'verified', 'rejected', 'suspended'];

const CreateSmeRequest = registry.register(
  'CreateSmeRequest',
  z
    .object({
      legalName: z.string().trim().min(2).max(200).openapi({ example: 'Acme Components Ltd' }),
      registrationNumber: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9/ -]+$/, 'registrationNumber may only contain letters, digits, spaces, / and -')
        .openapi({ description: 'Company registration number (PII: admin-only on reads)', example: '12345' }),
      country: z
        .string()
        .length(2)
        .refine((value) => ISO_COUNTRIES.has(value.toUpperCase()), 'country must be an ISO 3166-1 alpha-2 code')
        .openapi({ description: 'ISO 3166-1 alpha-2 country code', example: 'GB' }),
      stellarAddress: z
        .string()
        .refine((value) => StrKey.isValidEd25519PublicKey(value), 'stellarAddress must be a valid Stellar G... account')
        .openapi({ example: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5' }),
      contactEmail: z
        .string()
        .trim()
        .max(254)
        .email('contactEmail must be a valid email address')
        .openapi({ description: 'Contact email (PII: admin-only on reads)', example: 'ops@acme.test' }),
    })
    .strict()
    .openapi('CreateSmeRequest'),
);

const ReviewSmeRequest = registry.register(
  'ReviewSmeRequest',
  z
    .object({
      decision: z.enum(['verify', 'reject', 'suspend']),
      note: z.string().max(500).optional(),
    })
    .strict()
    .openapi('ReviewSmeRequest'),
);

const SmeRecord = registry.register(
  'SmeRecord',
  z
    .object({
      id: z.string().openapi({ example: 'SME_3f1c2b9a-...' }),
      legalName: z.string(),
      registrationNumber: z.string().optional().openapi({ description: 'PII — present only for admin callers' }),
      country: z.string(),
      stellarAddress: z.string(),
      contactEmail: z.string().optional().openapi({ description: 'PII — present only for admin callers' }),
      status: z.enum(SME_STATUSES),
      createdAt: z.string().openapi({ format: 'date-time' }),
      reviewHistory: z.array(z.object({
        decision: z.enum(['verify', 'reject', 'suspend']),
        note: z.string(),
        reviewedAt: z.string().openapi({ format: 'date-time' }),
      })),
    })
    .openapi('SmeRecord'),
);

module.exports = {
  registry,
  CreateSmeRequest,
  ReviewSmeRequest,
  SmeRecord,
  SME_STATUSES,
  InvoiceIdParam,
  ListInvoicesQuery,
  CreateInvoiceBody,
  FundInvoiceBody,
  FundInvoiceBodyShape,
  Invoice,
  ErrorResponse,
};
