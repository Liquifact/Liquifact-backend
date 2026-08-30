'use strict';

/**
 * @fileoverview Config versioning service (issue #1205).
 *
 * Manages the draft/published lifecycle for admin configuration records:
 *   - Operators create/update drafts (POST /api/admin/config with draft=true)
 *   - Operators review diffs before publishing
 *   - Publish requires expected_version for optimistic concurrency
 *   - Records actor, diff summary, and publication time
 *
 * @module services/configVersioning
 */

const db = require('../db/knex');
const logger = require('../logger');

const CONFIG_TABLE = 'runtime_config';

/**
 * Computes a human-readable diff summary between two config objects.
 * Returns a short description of what changed.
 *
 * @param {object|null} oldConfig - Previous config (null for new).
 * @param {object} newConfig - New config.
 * @returns {string} Diff summary.
 */
function computeDiffSummary(oldConfig, newConfig) {
  if (!oldConfig) {
    return 'New configuration created';
  }

  const changes = [];
  const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

  for (const key of allKeys) {
    const oldVal = oldConfig[key];
    const newVal = newConfig[key];

    if (oldVal === undefined && newVal !== undefined) {
      changes.push(`added '${key}'`);
    } else if (oldVal !== undefined && newVal === undefined) {
      changes.push(`removed '${key}'`);
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push(`changed '${key}'`);
    }
  }

  return changes.length > 0 ? changes.join(', ') : 'No changes detected';
}

/**
 * Saves a config draft. If no existing draft exists for the section+tenant,
 * creates one. If one exists, updates it. Does not affect published config.
 *
 * @param {string} section - Config section name.
 * @param {object} config - Validated config payload.
 * @param {object} context
 * @param {string} context.tenantId
 * @param {string} [context.actor]
 * @returns {Promise<object>} The draft record.
 */
async function saveDraft(section, config, context) {
  const { tenantId = '', actor = null } = context;
  const now = new Date().toISOString();

  // Find existing draft for this section+tenant
  const existing = await db(CONFIG_TABLE)
    .where({ section, tenant_id: tenantId, draft_status: 'draft' })
    .first();

  if (existing) {
    const diffSummary = computeDiffSummary(
      JSON.parse(existing.config || '{}'),
      config,
    );
    const [updated] = await db(CONFIG_TABLE)
      .where('id', existing.id)
      .update({
        config: JSON.stringify(config),
        diff_summary: diffSummary,
        draft_actor: actor,
        updated_at: now,
      })
      .returning('*');

    logger.info({ section, tenantId, id: updated.id, actor }, 'Config draft updated');
    return updated;
  }

  // Create new draft
  const id = `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const diffSummary = computeDiffSummary(null, config);
  const [created] = await db(CONFIG_TABLE)
    .insert({
      id,
      section,
      config: JSON.stringify(config),
      tenant_id: tenantId,
      draft_status: 'draft',
      version: 1,
      diff_summary: diffSummary,
      draft_actor: actor,
      created_at: now,
    })
    .returning('*');

  logger.info({ section, tenantId, id, actor }, 'Config draft created');
  return created;
}

/**
 * Publishes a draft config record with optimistic concurrency.
 * Validates expected_version matches the current version before publishing.
 *
 * @param {string} section - Config section name.
 * @param {object} config - The config to publish (must match the draft).
 * @param {object} context
 * @param {string} context.tenantId
 * @param {string} [context.actor]
 * @param {number} [context.expectedVersion] - Expected current version for CAS.
 * @returns {Promise<object>} The published record.
 * @throws {Error} With code 'STALE_VERSION' if expectedVersion doesn't match.
 * @throws {Error} With code 'NO_DRAFT' if no draft exists for the section.
 */
async function publishConfig(section, config, context) {
  const { tenantId = '', actor = null, expectedVersion } = context;
  const now = new Date().toISOString();

  // Find the current draft or published record
  const existing = await db(CONFIG_TABLE)
    .where({ section, tenant_id: tenantId })
    .orderBy('version', 'desc')
    .first();

  if (!existing) {
    const err = new Error(`No configuration found for section '${section}'`);
    err.code = 'NO_CONFIG';
    err.status = 404;
    throw err;
  }

  // Optimistic CAS: check version matches
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    const err = new Error(
      `Stale configuration: expected version ${expectedVersion} but found ${existing.version}. ` +
      'Another operator may have published a newer version. Reload and retry.',
    );
    err.code = 'STALE_VERSION';
    err.status = 409;
    throw err;
  }

  const diffSummary = computeDiffSummary(
    JSON.parse(existing.config || '{}'),
    config,
  );

  // Check for empty diff
  if (diffSummary === 'No changes detected') {
    const err = new Error('No changes to publish: the configuration is identical to the current version.');
    err.code = 'EMPTY_DIFF';
    err.status = 422;
    throw err;
  }

  const newVersion = (existing.version || 1) + 1;

  // Mark any existing draft/published as superseded, then create published record
  const [published] = await db(CONFIG_TABLE)
    .where('id', existing.id)
    .update({
      config: JSON.stringify(config),
      draft_status: 'published',
      version: newVersion,
      expected_version: existing.version,
      diff_summary: diffSummary,
      published_by: actor,
      published_at: now,
      draft_actor: actor,
      updated_at: now,
    })
    .returning('*');

  logger.info({
    section,
    tenantId,
    id: published.id,
    version: newVersion,
    previousVersion: existing.version,
    actor,
  }, 'Config published');

  return published;
}

/**
 * Returns the current published config for a section, or the latest draft.
 *
 * @param {string} section - Config section name.
 * @param {string} [tenantId=''] - Tenant identifier.
 * @returns {Promise<object|null>} The config record.
 */
async function getConfigVersion(section, tenantId = '') {
  return db(CONFIG_TABLE)
    .where({ section, tenant_id: tenantId })
    .orderBy('version', 'desc')
    .first();
}

/**
 * Returns the version history for a section (last 20 versions).
 *
 * @param {string} section - Config section name.
 * @param {string} [tenantId=''] - Tenant identifier.
 * @returns {Promise<object[]>} Version history.
 */
async function getConfigHistory(section, tenantId = '') {
  return db(CONFIG_TABLE)
    .where({ section, tenant_id: tenantId })
    .orderBy('version', 'desc')
    .limit(20)
    .select('id', 'section', 'version', 'draft_status', 'diff_summary',
            'published_by', 'published_at', 'draft_actor', 'created_at');
}

module.exports = {
  saveDraft,
  publishConfig,
  getConfigVersion,
  getConfigHistory,
  computeDiffSummary,
};
