/**
 * Migration: 20260829000001_add_config_versioning.js
 * Purpose: Draft/published config versioning with optimistic concurrency (issue #1205).
 *
 * Adds columns to runtime_config to support:
 *   - Draft vs published state (draft_status: 'draft' | 'published')
 *   - Optimistic version on publish (expected_version)
 *   - Actor, diff summary, and publication timestamp
 *
 * Existing rows are backfilled as 'published' with version 1 so the API
 * stays backward-compatible.
 */

'use strict';

exports.up = function up(knex) {
  return knex.schema.alterTable('runtime_config', (t) => {
    // Draft/published lifecycle
    t.string('draft_status').notNullable().defaultTo('published');
    t.integer('version').notNullable().defaultTo(1);
    t.integer('expected_version');       // for optimistic CAS on publish
    t.text('diff_summary');              // human-readable change summary
    t.string('published_by');            // actor who published
    t.string('published_at');            // when published
    t.string('draft_actor');             // actor who created/updated draft
  });
};

exports.down = function down(knex) {
  return knex.schema.alterTable('runtime_config', (t) => {
    t.dropColumns([
      'draft_status',
      'version',
      'expected_version',
      'diff_summary',
      'published_by',
      'published_at',
      'draft_actor',
    ]);
  });
};
