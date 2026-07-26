'use strict';

/**
 * @fileoverview Zod schema for the bulk escrow-read request body.
 *
 * Exposes:
 *  - `MAX_BATCH_SIZE`         — upper bound on invoice IDs per request
 *  - `escrowBatchReadSchema`  — strict body schema (rejects unknown keys)
 *
 * @module schemas/escrowBatchRead
 */

const { z } = require('zod');

/** Upper bound on invoice IDs accepted per bulk-read request. */
const MAX_BATCH_SIZE = 100;

/**
 * Bulk escrow-read request body schema.
 *
 * `invoiceIds` values are not format-validated here — malformed or unmapped
 * IDs are reported per-item in the response `errors` array by the route
 * handler rather than failing the whole batch.
 *
 * @type {import('zod').ZodObject}
 */
const escrowBatchReadSchema = z
  .object({
    invoiceIds: z
      .array(z.string())
      .min(1, 'invoiceIds must contain at least one invoice ID')
      .max(MAX_BATCH_SIZE, `invoiceIds must not exceed ${MAX_BATCH_SIZE} items`),
  })
  .strict();

module.exports = {
  MAX_BATCH_SIZE,
  escrowBatchReadSchema,
};
