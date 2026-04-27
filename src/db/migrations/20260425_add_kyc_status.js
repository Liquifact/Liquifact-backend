/**
 * Database Migration: Add KYC Status to Invoices
 * 
 * Adds kycStatus column to track SME KYC verification state.
 * KYC statuses: pending, verified, rejected, exempted
 * 
 * Usage: knex migrate:latest
 */

exports.up = async (knex) => {
  return knex.schema.table('invoices', (table) => {
    table
      .enum('kycStatus', ['pending', 'verified', 'rejected', 'exempted'], {
        useNative: true,
        enumName: 'kyc_status_enum',
      })
      .defaultTo('pending')
      .notNullable();

    // Track when KYC status was last updated
    table.timestamp('kycStatusUpdatedAt').defaultTo(knex.fn.now());

    // Reference to KYC record ID for audit trail
    table.string('kycRecordId', 128).nullable();

    // Add index for filtering by KYC status
    table.index('kycStatus');
    table.index(['kycStatus', 'createdAt']);
  });
};

exports.down = async (knex) => {
  return knex.schema.table('invoices', (table) => {
    table.dropIndex(['kycStatus', 'createdAt']);
    table.dropIndex('kycStatus');
    table.dropColumn('kycRecordId');
    table.dropColumn('kycStatusUpdatedAt');
    table.dropColumn('kycStatus');
  });
};
