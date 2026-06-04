/**
 * src/services/investorCommitment.js
 *
 * Persists investor commitment records produced by the fund-invoice flow.
 * Uses Knex (the project's existing query builder) so the implementation works
 * with both PostgreSQL (production) and SQLite (test/CI).
 *
 * Table: investor_commitments
 * Schema is created by migration: migrations/YYYYMMDDHHII_create_investor_commitments.js
 *
 * Idempotency: callers may supply an idempotencyKey (e.g. sha256 of
 * investor + invoiceId + amount). Duplicate submissions with the same key
 * return the existing row rather than inserting a second one.
 */

'use strict';

const db = require('../db'); // project's shared Knex instance

const TABLE = 'investor_commitments';

/**
 * @typedef {Object} CommitmentRecord
 * @property {string}  id
 * @property {string}  invoice_id
 * @property {string}  investor_address
 * @property {string}  escrow_address
 * @property {string}  amount_stroops      — integer string
 * @property {'requires_signature'|'submitted'|'stubbed'} status
 * @property {string|null} unsigned_xdr
 * @property {string|null} tx_hash
 * @property {string|null} ledger
 * @property {string|null} idempotency_key
 * @property {Date}    created_at
 * @property {Date}    updated_at
 */

/**
 * Persist a new commitment, or return the existing one when the idempotency
 * key matches a prior row.
 *
 * @param {Object} params
 * @param {string} params.invoiceId
 * @param {string} params.investorAddress
 * @param {string} params.escrowAddress
 * @param {string|number} params.amountStroops
 * @param {'requires_signature'|'submitted'|'stubbed'} params.status
 * @param {string|null} [params.unsignedXdr]
 * @param {string|null} [params.txHash]
 * @param {string|null} [params.ledger]
 * @param {string|null} [params.idempotencyKey]
 * @returns {Promise<CommitmentRecord>}
 */
async function persistCommitment({
  invoiceId,
  investorAddress,
  escrowAddress,
  amountStroops,
  status,
  unsignedXdr = null,
  txHash = null,
  ledger = null,
  idempotencyKey = null,
}) {
  // Idempotency check: return early if we've already processed this exact request
  if (idempotencyKey) {
    const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first();
    if (existing) {
      return existing;
    }
  }

  const [row] = await db(TABLE)
    .insert({
      invoice_id: invoiceId,
      investor_address: investorAddress,
      escrow_address: escrowAddress,
      amount_stroops: String(amountStroops),
      status,
      unsigned_xdr: unsignedXdr,
      tx_hash: txHash,
      ledger,
      idempotency_key: idempotencyKey,
    })
    .returning('*');

  return row;
}

/**
 * Update the status of an existing commitment (e.g. once the investor submits
 * the signed XDR and we observe the ledger result).
 *
 * @param {string} id        — commitment UUID
 * @param {Partial<CommitmentRecord>} fields
 * @returns {Promise<CommitmentRecord>}
 */
async function updateCommitment(id, fields) {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...fields, updated_at: db.fn.now() })
    .returning('*');
  if (!row) throw new Error(`Commitment not found: ${id}`);
  return row;
}

/**
 * Find commitments for a given investor and invoice.
 *
 * @param {string} investorAddress
 * @param {string} invoiceId
 * @returns {Promise<CommitmentRecord[]>}
 */
async function findCommitments(investorAddress, invoiceId) {
  return db(TABLE).where({ investor_address: investorAddress, invoice_id: invoiceId }).orderBy('created_at', 'desc');
}

module.exports = {
  persistCommitment,
  updateCommitment,
  findCommitments,
};