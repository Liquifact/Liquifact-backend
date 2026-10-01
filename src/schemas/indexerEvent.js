'use strict';

const { z } = require('zod');
const {
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
} = require('./validationHelper');

/**
 * Maximum length of a paging token. Horizon paging tokens are opaque but
 * bounded; a cap keeps a malicious/buggy producer from bloating the event
 * table with unbounded strings.
 * @type {number}
 */
const MAX_PAGING_TOKEN_LENGTH = 2048;

/**
 * Maximum length of an event ID--long enough for a Horizon token or a
 * composite key, but bounded to keep the event table deterministic.
 * @type {number}
 */
const MAX_EVENT_ID_LENGTH = 256;

/**
 * Maximum length of an event type label.
 * @type {number}
 */
const MAX_EVENT_TYPE_LENGTH = 128;

/**
 * Maximum length of an invoice ID.
 * @type {number}
 */
const MAX_INVOICE_ID_LENGTH = 128;

/**
 * Maximum acceptable ledger sequence. Stellar's ledger sequence is a
 * uninterpreted 32-bit counter in practice, but we bound to MaxSafeInteger
 * so the value is always representable in JS and in a Postgres bigint.
 * @type {number}
 */
const MAX_LEGDER_SEQUENCE = Number.MAX_SAFE_INTEGER;

/**
 * Minimum acceptable ledger sequence. Stellar ledgers are 1-based.
 * @type {number}
 */
const MIN_LEDGER_SEQUENCE = 1;

/**
 * Stellar contract address schema (C... 56 chars, StrKey encoded).
 * @type {z.ZodString}
 */
const contractIdSchema = z
  .string({ invalid_type_error: 'contractId must be a string' })
  .regex(CONTRACT_ID_REGEX, {
    message: 'contractId must be a valid Stellar contract address (C... 56 chars)',
  });

/**
 * Canonical schema for a single escrow indexer event. Strict mode rejects
 * unknown fields so a misspelled or unexpected property cannot silently
 * bypass validation.
 * @type {z.ZodObject}
 */
const indexerEventSchema = z
  .object({
    eventId: z
      .string({ invalid_type_error: 'eventId must be a string' })
      .min(1, { message: 'eventId is required' })
      .max(MAX_EVENT_ID_LENGTH, { message: `eventId must not exceed ${MAX_EVENT_ID_LENGTH} characters` })
      .transform((v) => v.trim()),

    invoiceId: z
      .string({ invalid_type_error: 'invoiceId must be a string' })
      .regex(INVOICE_ID_REGEX, {
        message: `invoiceId must be 1-${MAX_INVOICE_ID_LENGTH} alphanumeric/underscore/hyphen characters`,
      })
      .transform((v) => v.trim()),

    eventType: z
      .string({ invalid_type_error: 'eventType must be a string' })
      .min(1, { message: 'eventType is required' })
      .max(MAX_EVENT_TYPE_LENGTH, { message: `eventType must not exceed ${MAX_EVENT_TYPE_LENGTH} characters` })
      .transform((v) => v.trim()),

    ledgerSequence: z
      .number({ invalid_type_error: 'ledgerSequence must be a number' })
      .int({ message: 'ledgerSequence must be an integer' })
      .min(1, { message: 'ledgerSequence must be a positive integer' })
      .max(MAX_LEDGER_SEQUENCE, { message: 'ledgerSequence is out of range' }),

    pagingToken: z
      .string({ invalid_type_error: 'pagingToken must be a string' })
      .max(MAX_PAGING_TOKEN_LENGTH, { message: `pagingToken must not exceed ${MAX_PAGING_TOKEN_LENGTH} characters` })
      .default(''),

    contractId: z
      .union([contractIdSchema, z.null()])
      .optional(),

    txHash: z
      .union([
        z.string().regex(TX_HASH_REGEX, {
          message: 'txHash must be a 64-character hexadecimal string',
        }),
        z.null(),
      ])
      .optional(),

    eventBody: z.unknown().optional(),

    observedAt: z
      .string({ invalid_type_error: 'observedAt must be a string' })
      .datetime({ message: 'observedAt must be a valid ISO 8601 date string' })
      .optional(),
  })
  .strict();

module.exports = {
  indexerEventSchema,
  parseIndexerEvent,
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
  MAX_PAGING_TOKEN_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_INVOICE_ID_LENGTH,
  MAX_LEDGER_SEQUENCE,
  MIN_LEDGER_SEQUENCE,
};
