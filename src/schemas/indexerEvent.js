'use strict';

const { z } = require('zod');
const {
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
} = require('./validationHelper');

const contractIdSchema = z
  .string()
  .regex(CONTRACT_ID_REGEX, {
    message: 'contractId must be a valid Stellar contract address (C... 56 chars)',
  });

const indexerEventSchema = z.object({
  eventId: z
    .string({ invalid_type_error: 'eventId must be a string' })
    .min(1, { message: 'eventId is required' })
    .max(256, { message: 'eventId must not exceed 256 characters' })
    .transform((v) => v.trim()),

  invoiceId: z
    .string({ invalid_type_error: 'invoiceId must be a string' })
    .regex(INVOICE_ID_REGEX, {
      message: 'invoiceId must be 1-128 alphanumeric/underscore/hyphen characters',
    })
    .transform((v) => v.trim()),

  eventType: z
    .string({ invalid_type_error: 'eventType must be a string' })
    .min(1, { message: 'eventType is required' })
    .max(128, { message: 'eventType must not exceed 128 characters' })
    .transform((v) => v.trim()),

  ledgerSequence: z
    .number({ invalid_type_error: 'ledgerSequence must be a number' })
    .int({ message: 'ledgerSequence must be an integer' })
    .positive({ message: 'ledgerSequence must be a positive integer' })
    .max(Number.MAX_SAFE_INTEGER, { message: 'ledgerSequence is out of range' }),

  pagingToken: z
    .string({ invalid_type_error: 'pagingToken must be a string' })
    .max(2048, { message: 'pagingToken must not exceed 2048 characters' })
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
}).strict();

module.exports = {
  indexerEventSchema,
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
};
