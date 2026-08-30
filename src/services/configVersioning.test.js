'use strict';

/**
 * @fileoverview Unit tests for config versioning service (issue #1205).
 *
 * Tests:
 *   - saveDraft: creates and updates drafts
 *   - publishConfig: optimistic CAS, stale version rejection, empty diff
 *   - getConfigVersion: returns current version
 *   - getConfigHistory: returns version history
 *   - computeDiffSummary: computes human-readable diffs
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

jest.mock('../logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const {
  saveDraft,
  publishConfig,
  getConfigVersion,
  getConfigHistory,
  computeDiffSummary,
} = require('./configVersioning');

const db = require('../db/knex');

describe('configVersioning', () => {
  beforeAll(async () => {
    // Create runtime_config table for testing
    const exists = await db.schema.hasTable('runtime_config');
    if (!exists) {
      await db.schema.createTable('runtime_config', (t) => {
        t.string('id').notNullable().primary();
        t.string('section').notNullable();
        t.text('config').notNullable().defaultTo('{}');
        t.string('tenant_id').notNullable().defaultTo('');
        t.string('created_at').notNullable();
        t.string('draft_status').notNullable().defaultTo('published');
        t.integer('version').notNullable().defaultTo(1);
        t.integer('expected_version');
        t.text('diff_summary');
        t.string('published_by');
        t.string('published_at');
        t.string('draft_actor');
      });
    }
  });

  beforeEach(async () => {
    await db('runtime_config').del();
  });

  afterAll(async () => {
    await db('runtime_config').del();
    await db.destroy();
  });

  describe('computeDiffSummary', () => {
    it('reports new configuration when old config is null', () => {
      const summary = computeDiffSummary(null, { origins: ['https://a.com'] });
      expect(summary).toBe('New configuration created');
    });

    it('reports added keys', () => {
      const summary = computeDiffSummary({}, { origins: ['https://a.com'] });
      expect(summary).toContain("added 'origins'");
    });

    it('reports removed keys', () => {
      const summary = computeDiffSummary({ origins: ['https://a.com'] }, {});
      expect(summary).toContain("removed 'origins'");
    });

    it('reports changed keys', () => {
      const summary = computeDiffSummary(
        { origins: ['https://a.com'] },
        { origins: ['https://b.com'] },
      );
      expect(summary).toContain("changed 'origins'");
    });

    it('reports no changes when identical', () => {
      const config = { origins: ['https://a.com'], maxAge: 3600 };
      const summary = computeDiffSummary(config, { ...config });
      expect(summary).toBe('No changes detected');
    });

    it('reports multiple changes', () => {
      const summary = computeDiffSummary(
        { a: 1, b: 2 },
        { a: 1, b: 3, c: 4 },
      );
      expect(summary).toContain("changed 'b'");
      expect(summary).toContain("added 'c'");
    });
  });

  describe('saveDraft', () => {
    it('creates a new draft', async () => {
      const draft = await saveDraft('cors', { origins: ['https://a.com'] }, {
        tenantId: 'tenant_1',
        actor: 'admin@test.com',
      });

      expect(draft.id).toMatch(/^cfg_/);
      expect(draft.section).toBe('cors');
      expect(draft.draft_status).toBe('draft');
      expect(draft.version).toBe(1);
      expect(draft.draft_actor).toBe('admin@test.com');
      expect(draft.diff_summary).toBe('New configuration created');
    });

    it('updates existing draft', async () => {
      const draft1 = await saveDraft('cors', { origins: ['https://a.com'] }, {
        tenantId: 'tenant_1',
        actor: 'admin1@test.com',
      });

      const draft2 = await saveDraft('cors', { origins: ['https://b.com'] }, {
        tenantId: 'tenant_1',
        actor: 'admin2@test.com',
      });

      // Same ID (updated, not created)
      expect(draft2.id).toBe(draft1.id);
      expect(draft2.draft_actor).toBe('admin2@test.com');
      expect(draft2.diff_summary).toContain("changed 'origins'");
    });

    it('isolates drafts by tenant', async () => {
      await saveDraft('cors', { origins: ['https://a.com'] }, { tenantId: 'tenant_1', actor: 'a' });
      await saveDraft('cors', { origins: ['https://b.com'] }, { tenantId: 'tenant_2', actor: 'b' });

      const t1 = await getConfigVersion('cors', 'tenant_1');
      const t2 = await getConfigVersion('cors', 'tenant_2');

      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe('publishConfig', () => {
    it('publishes a config with version increment', async () => {
      // Seed a record
      await db('runtime_config').insert({
        id: 'cfg_test1',
        section: 'cors',
        config: JSON.stringify({ origins: ['https://old.com'] }),
        tenant_id: 't1',
        draft_status: 'published',
        version: 1,
        created_at: new Date().toISOString(),
      });

      const published = await publishConfig('cors', { origins: ['https://new.com'] }, {
        tenantId: 't1',
        actor: 'admin@test.com',
        expectedVersion: 1,
      });

      expect(published.version).toBe(2);
      expect(published.draft_status).toBe('published');
      expect(published.published_by).toBe('admin@test.com');
      expect(published.published_at).toBeTruthy();
    });

    it('rejects stale version with 409', async () => {
      await db('runtime_config').insert({
        id: 'cfg_test2',
        section: 'cors',
        config: JSON.stringify({ origins: ['https://old.com'] }),
        tenant_id: 't1',
        draft_status: 'published',
        version: 2,
        created_at: new Date().toISOString(),
      });

      try {
        await publishConfig('cors', { origins: ['https://new.com'] }, {
          tenantId: 't1',
          actor: 'admin@test.com',
          expectedVersion: 1, // stale!
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('STALE_VERSION');
        expect(err.status).toBe(409);
      }
    });

    it('rejects empty diff with 422', async () => {
      await db('runtime_config').insert({
        id: 'cfg_test3',
        section: 'cors',
        config: JSON.stringify({ origins: ['https://same.com'] }),
        tenant_id: 't1',
        draft_status: 'published',
        version: 1,
        created_at: new Date().toISOString(),
      });

      try {
        await publishConfig('cors', { origins: ['https://same.com'] }, {
          tenantId: 't1',
          actor: 'admin@test.com',
          expectedVersion: 1,
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('EMPTY_DIFF');
        expect(err.status).toBe(422);
      }
    });

    it('throws when no config exists', async () => {
      try {
        await publishConfig('nonexistent', {}, {
          tenantId: 't1',
          actor: 'admin@test.com',
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('NO_CONFIG');
        expect(err.status).toBe(404);
      }
    });

    it('publishes without expectedVersion (no CAS)', async () => {
      await db('runtime_config').insert({
        id: 'cfg_test4',
        section: 'cors',
        config: JSON.stringify({ origins: ['https://old.com'] }),
        tenant_id: 't1',
        draft_status: 'published',
        version: 1,
        created_at: new Date().toISOString(),
      });

      const published = await publishConfig('cors', { origins: ['https://new.com'] }, {
        tenantId: 't1',
        actor: 'admin@test.com',
        // no expectedVersion
      });

      expect(published.version).toBe(2);
    });
  });

  describe('getConfigVersion', () => {
    it('returns the latest version', async () => {
      await db('runtime_config').insert([
        { id: 'cfg_v1', section: 'cors', config: '{}', tenant_id: 't1', draft_status: 'published', version: 1, created_at: new Date().toISOString() },
        { id: 'cfg_v2', section: 'cors', config: '{}', tenant_id: 't1', draft_status: 'published', version: 2, created_at: new Date().toISOString() },
      ]);

      const record = await getConfigVersion('cors', 't1');
      expect(record.version).toBe(2);
      expect(record.id).toBe('cfg_v2');
    });

    it('returns null when no config exists', async () => {
      const record = await getConfigVersion('nonexistent', 't1');
      expect(record).toBeUndefined();
    });
  });

  describe('getConfigHistory', () => {
    it('returns versions in descending order', async () => {
      await db('runtime_config').insert([
        { id: 'cfg_h1', section: 'cors', config: '{}', tenant_id: 't1', draft_status: 'published', version: 1, diff_summary: 'v1', created_at: new Date().toISOString() },
        { id: 'cfg_h2', section: 'cors', config: '{}', tenant_id: 't1', draft_status: 'published', version: 2, diff_summary: 'v2', created_at: new Date().toISOString() },
        { id: 'cfg_h3', section: 'cors', config: '{}', tenant_id: 't1', draft_status: 'published', version: 3, diff_summary: 'v3', created_at: new Date().toISOString() },
      ]);

      const history = await getConfigHistory('cors', 't1');
      expect(history.length).toBe(3);
      expect(history[0].version).toBe(3);
      expect(history[1].version).toBe(2);
      expect(history[2].version).toBe(1);
    });
  });
});
