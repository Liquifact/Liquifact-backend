'use strict';

/**
 * Zod schemas: the single source of truth for request validation and the
 * OpenAPI component schemas generated from the registry below.
 */

const { z } = require('zod');
const { extendZodWithOpenApi, OpenAPIRegistry } = require('@asteasolutions/zod-to-openapi');
const { StrKey } = require('@stellar/stellar-sdk');
const { STATUSES, normalizeIdentity } = require('../data/store');
const { parseAmount } = require('../lib/money');
const { parseIsoDate } = require('../lib/dates');
const config = require('../config');

// Money on the API boundary: a decimal string (preferred) or a JSON number,
// at most 7 fractional digits, > 0 and <= MAX_INVOICE_AMOUNT (2^63-1 minor units).
const DECIMAL_AMOUNT = /^\d+(\.\d{1,7})?$/;
// Approximate upper bound for docs; the exact limit is enforced by parseAmount.
const MAX_AMOUNT_NUMBER = Number('922337203685.4775807');
const isParseableAmount = (value) => {
  try {
    parseAmount(value);
    return true;
  } catch {
    return false;
  }
};
const moneyInput = (message) => z
  .union([
    z.number().gt(0).max(MAX_AMOUNT_NUMBER),
    z.string().regex(DECIMAL_AMOUNT),
  ], { errorMap: () => ({ message }) })
  .refine(isParseableAmount, message);
const decimalString = () => z.string().regex(DECIMAL_AMOUNT);

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const INVOICE_ID = /^[A-Za-z0-9_]{1,32}$/;
const INVOICE_NUMBER = /^[A-Za-z0-9._/-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Start of the current UTC day in epoch milliseconds.
 *
 * @param {number} nowMs current epoch milliseconds
 * @returns {number} epoch milliseconds of 00:00:00 UTC today
 */
function todayUtcMs(nowMs) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

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
const DUE_DATE_MESSAGE = 'dueDate must be a real calendar date in YYYY-MM-DD format';
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
      amount: moneyInput(AMOUNT_MESSAGE)
        .openapi({ description: 'Invoice face value: decimal string (preferred) or number, max 7 fractional digits', example: '25000.50' }),
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
        .refine((v) => parseIsoDate(v) !== null, DUE_DATE_MESSAGE)
        .superRefine((v, ctx) => {
          const parsed = parseIsoDate(v);
          if (!parsed) {
            return;
          }
          const todayMs = todayUtcMs(Date.now());
          const dueDateMs = parsed.date.getTime();
          if (dueDateMs < todayMs + config.minTenorDays * DAY_MS) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `dueDate must be at least ${config.minTenorDays} day(s) in the future (received ${v})`,
            });
          } else if (dueDateMs > todayMs + config.maxTenorDays * DAY_MS) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `dueDate must be within ${config.maxTenorDays} days from today (max ~${Math.round(config.maxTenorDays / 365)} years)`,
            });
          }
        })
        .openapi({
          description: 'Payment due date (real calendar date, at least MIN_TENOR_DAYS and at most MAX_TENOR_DAYS from today UTC)',
          example: '2027-01-01',
          format: 'date',
        }),
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
      amount: moneyInput('amount must be a positive amount with at most 7 fractional digits')
        .openapi({ description: 'Positive amount (decimal string or number, max 7 fractional digits) not exceeding the invoice face value', example: '7000' }),
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
      amount: decimalString().openapi({ example: '25000', description: 'Face value as a decimal string (see decimals)' }),
      currency: z.string().openapi({ example: 'USDC' }),
      fundedAmount: z.string().regex(/^\d+(\.\d{1,7})?$/).openapi({ example: '0', description: 'Funded amount as a decimal string' }),
      remainingCapacity: z.string().regex(/^\d+(\.\d{1,7})?$/).openapi({ example: '25000', description: 'amount - fundedAmount (computed, decimal string)' }),
      decimals: z.number().int().openapi({ example: 7, description: 'Fractional digits of the amount strings (minor units)' }),
      yieldBps: z.number().int().openapi({ example: 800 }),
      dueDate: z.string().openapi({ format: 'date', example: '2027-01-17' }),
      maturity: z
        .number()
        .int()
        .nonnegative()
        .openapi({ description: 'Maturity as Unix seconds (00:00:00 UTC on dueDate)', example: 1800144000 }),
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
