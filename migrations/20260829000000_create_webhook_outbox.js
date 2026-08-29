/**
 * Migration: 20260829000000_create_webhook_outbox.js
 * Purpose: Transactional event outbox for webhook delivery (issue #1210).
 *
 * The outbox pattern ensures webhook events are written atomically with the
 * invoice mutation that produced them. A background worker polls pending rows,
 * delivers them, and marks them delivered or failed with retry tracking.
 *
 * Columns:
 *   id             — unique event identifier
 *   invoice_id     — the invoice that triggered the event
 *   tenant_id      — tenant for isolation
 *   event          — event type string (e.g. 'invoice.submitted_to_approved')
 *   payload        — JSON-serialised webhook payload
 *   status         — 'pending' | 'delivered' | 'failed' | 'dead'
 *   attempts       — delivery attempt counter
 *   max_attempts   — ceiling before moving to dead-letter
 *   last_error     — most recent failure message
 *   next_retry_at  — earliest time the worker should retry
 *   correlation_id — request correlation for tracing
 *   created_at     — row creation timestamp
 *   delivered_at   — timestamp of successful delivery
 */

'use strict';

exports.up = function up(knex) {
  return knex.schema.createTable('webhook_outbox', (t) => {
    t.string('id').notNullable().primary();
    t.string('invoice_id').notNullable();
    t.string('tenant_id').notNullable().defaultTo('');
    t.string('event').notNullable();
    t.text('payload').notNullable();
    t.string('status').notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(5);
    t.text('last_error');
    t.string('next_retry_at');
    t.string('correlation_id');
    t.string('created_at').notNullable().defaultTo(knex.fn.now());
    t.string('delivered_at');

    // Indexes for the worker poll query (pending rows ordered by created_at)
    t.index(['status', 'next_retry_at'], 'idx_outbox_pending');
    t.index(['invoice_id'], 'idx_outbox_invoice');
    t.index(['tenant_id'], 'idx_outbox_tenant');
  });
};

exports.down = function down(knex) {
  return knex.schema.dropTableIfExists('webhook_outbox');
};
