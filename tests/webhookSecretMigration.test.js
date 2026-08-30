'use strict';

/**
 * @fileoverview Tests for the legacy webhook-secret → one-way hash migration:
 * detection, verify-before-replace, atomicity, audit, tenant isolation, and
 * every required edge case:
 *
 *   - legacy key valid
 *   - legacy key invalid
 *   - already hashed record
 *   - migration interrupted
 *   - same key under two tenants
 *
 * Also asserts success / failure / retry / authorization-adjacent behaviour and
 * that plaintext is never written to logs or audit metadata.
 */

process.env.NODE_ENV = 'test';

// Mock the app's db + logger so requiring the service does not touch a DB.
jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const vault = require('../src/services/webhookSecretVault');
const {
  runMigration,
  defaultVerify,
} = require('../src/services/webhookSecretMigration');
const {
  createMigrateWebhookSecretsHandler,
  shouldRetry,
} = require('../src/jobs/migrateWebhookSecrets');

// ---------------------------------------------------------------------------
// In-memory Knex fake (transactional overlay) — enough surface for the runner.
// ---------------------------------------------------------------------------

/**
 * Builds a fake Knex-style instance backed by an in-memory tenant list.
 *
 * @param {Array<{id: string, settings: Object}>} tenantRows - Initial tenants.
 * @param {Object}   [behavior] - Failure injection.
 * @param {boolean}  [behavior.failWriteOnce=false] - Make the first committed
 *   write throw to simulate an interrupted migration.
 * @returns {Function & {transaction: Function, __store: Object, __audit: Array}}
 */
function makeDbClient(tenantRows, behavior = {}) {
  const store = {
    tenants: tenantRows.map((r) => ({ id: r.id, settings: r.settings })),
  };
  const __audit = [];

  let failWriteTriggered = false;

  function readTable(table) {
    if (table !== 'tenants') return [];
    return store.tenants.map((r) => {
      // Apply a hashed representation so isHashed() sees the promoted fields.
      if (vault.isHashed(r.settings)) {
        return { id: r.id, settings: r.settings };
      }
      return { id: r.id, settings: r.settings };
    });
  }

  function queryBuilder(forTable) {
    return {
      then(resolve) {
        resolve(readTable(forTable));
      },
    };
  }

  // Builder returned by `dbClient('tenants')...` — awaitable, orderBy/limit
  // are no-ops for this fake (the whole list is one page).
  function selectBuilder() {
    const builder = {
      select() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      where(col, op, val) {
        // where('id', '>', afterId)
        if (typeof op === 'string' && op === '>') {
          this._afterId = val;
        }
        return this;
      },
      then(resolve) {
        let rows = readTable('tenants');
        if (this._afterId) {
          rows = rows.filter((r) => r.id > this._afterId);
        }
        resolve(rows);
      },
    };
    return builder;
  }

  function makeTransaction() {
    let state = 'open';
    const staged = [];

    // Callable trx: `trx('tenants').where('id', id).update({...})`.
    function trxBuilder(table) {
      return {
        _table: table,
        where(col, val) { this._id = val; return this; },
        update(obj) {
          const id = this._id;
          const tableName = this._table;
          staged.push(() => {
            if (behavior.failWriteOnce && !failWriteTriggered) {
              failWriteTriggered = true;
              throw new Error('simulated DB write failure');
            }
            const t = store[tableName].find((x) => x.id === id);
            if (t) t.settings = obj.settings;
            return 1;
          });
          // update returns a promise; no-op until commit() applies staged writes.
          return Promise.resolve(1);
        },
      };
    }

    trxBuilder.commit = async () => {
      if (state !== 'open') return;
      // Apply staged writes; a throw here aborts the whole transaction.
      for (const apply of staged) {
        await apply();
      }
      state = 'committed';
    };
    trxBuilder.rollback = async () => {
      staged.length = 0;
      state = 'rolledback';
    };

    return trxBuilder;
  }

  function dbClient(table) {
    if (table === 'tenants') {
      return selectBuilder();
    }
    return queryBuilder(table);
  }
  dbClient.transaction = () => Promise.resolve(makeTransaction());

  return dbClient;
}

describe('webhook secret migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('runMigration happy path', () => {
    it('detects and promotes a valid legacy secret into a one-way hash (legacy key valid)', async () => {
      const dbClient = makeDbClient([
        { id: 'tenant-1', settings: { webhook_url: 'https://x/1', webhook_secret: 'plaintext-secret-a' } },
      ]);

      const audit = jest.fn().mockResolvedValue(undefined);
      const summary = await runMigration({ dbClient, audit, now: () => new Date('2026-01-01T00:00:00Z') });

      expect(summary.examined).toBe(1);
      expect(summary.legacy).toBe(1);
      expect(summary.hashed).toBe(1);
      expect(summary.invalid).toBe(0);
      expect(summary.alreadyHashed).toBe(0);
      expect(summary.errored).toBe(0);

      // Pull the updated row back out of the store via a fresh read.
      const updated = await dbClient('tenants');
      const row = updated[0];
      expect(vault.isHashed(row.settings)).toBe(true);
      expect(row.settings.webhook_secret_variant).toBe(vault.HASH_VARIANT);
      expect(row.settings.webhook_secret_hash).toBeTruthy();
      expect(row.settings.webhook_secret_salt).toBeTruthy();
      // The hash is one-way: it must never equal or contain the plaintext.
      expect(row.settings.webhook_secret_hash).not.toContain('plaintext-secret-a');
      expect(row.settings.webhook_secret_hash.length).toBeGreaterThan(0);

      // Verify the hash really represents the original secret.
      await expect(vault.matchesSecret('plaintext-secret-a', row.settings)).resolves.toBe(true);
      await expect(vault.matchesSecret('wrong-secret', row.settings)).resolves.toBe(false);

      // Audit written once, contains no plaintext, only a fingerprint.
      expect(audit).toHaveBeenCalledTimes(1);
      const [, opts] = audit.mock.calls[0];
      const event = audit.mock.calls[0][0];
      expect(opts && opts.db).toBeDefined();
      expect(event.action).toBe('webhook.secret.hashed');
      expect(event.metadata.tenantId).toBe('tenant-1');
      expect(event.metadata.variant).toBe(vault.HASH_VARIANT);
      expect(event.metadata.hashFingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(JSON.stringify(event)).not.toContain('plaintext-secret-a');
    });

    it('is deterministic across runs for the same secret+salt', async () => {
      const settings = { webhook_secret: 'shared-key' };
      const salt = 'a1b2c3d4e5f6a1b2'; // fixed 16-byte hex
      const hash1 = await vault.hashSecret('shared-key', salt);
      const hash2 = await vault.hashSecret('shared-key', salt);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toContain('shared-key');
    });
  });

  describe('edge cases', () => {
    it('does not promote an invalid legacy secret (legacy key invalid)', async () => {
      // A verifier that rejects every candidate simulates "invalid legacy key".
      const verify = () => false;
      const dbClient = makeDbClient([
        { id: 'tenant-1', settings: { webhook_secret: 'not-verifiable' } },
      ]);
      const audit = jest.fn();
      const summary = await runMigration({ dbClient, audit, verify });

      expect(summary.legacy).toBe(1);
      expect(summary.invalid).toBe(1);
      expect(summary.hashed).toBe(0);

      // Record untouched → still legacy.
      const rows = await dbClient('tenants');
      expect(vault.isLegacy(rows[0].settings)).toBe(true);
      expect(vault.isHashed(rows[0].settings)).toBe(false);
      expect(audit).not.toHaveBeenCalled();
    });

    it('skips an already-hashed record without re-hashing or re-auditing', async () => {
      const salted = 'aa'.repeat(8);
      const existingHash = await vault.hashSecret('previously-migrated', salted);
      const dbClient = makeDbClient([
        {
          id: 'tenant-1',
          settings: vault.buildHashedSettings({ webhook_secret: 'previously-migrated' }, {
            salt: salted,
            hash: existingHash,
            now: new Date('2026-01-01T00:00:00Z'),
          }),
        },
      ]);
      const audit = jest.fn();
      const summary = await runMigration({ dbClient, audit });

      expect(summary.alreadyHashed).toBe(1);
      expect(summary.legacy).toBe(0);
      expect(summary.hashed).toBe(0);
      expect(audit).not.toHaveBeenCalled();
      // Presentation of the original secret still verifies against the hash.
      const rows = await dbClient('tenants');
      await expect(vault.matchesSecret('previously-migrated', rows[0].settings)).resolves.toBe(true);
      await expect(vault.matchesSecret('other', rows[0].settings)).resolves.toBe(false);
    });

    it('leaves legacy value intact and records errored when migration is interrupted (atomic rollback)', async () => {
      // Simulate a DB write failure once → the tenant transaction rolls back,
      // the legacy plaintext stays, and a re-run succeeds.
      const dbClient = makeDbClient(
        [{ id: 'tenant-1', settings: { webhook_secret: 'legacy-secret' } }],
        { failWriteOnce: true },
      );
      const audit = jest.fn();

      const first = await runMigration({ dbClient, audit });
      expect(first.errored).toBe(1);
      expect(first.hashed).toBe(0);

      let rows = await dbClient('tenants');
      expect(rows[0].settings.webhook_secret).toBe('legacy-secret');
      expect(vault.isHashed(rows[0].settings)).toBe(false);

      // Re-run with the failure cleared → completes.
      const second = await runMigration({ dbClient, audit: jest.fn() });
      expect(second.errored).toBe(0);
      expect(second.hashed).toBe(1);
      rows = await dbClient('tenants');
      expect(vault.isHashed(rows[0].settings)).toBe(true);
    });

    it('hashes the same key independently per tenant (salt isolation, no cross-talk)', async () => {
      const dbClient = makeDbClient([
        { id: 'tenant-a', settings: { webhook_secret: 'SAME-SECRET' } },
        { id: 'tenant-b', settings: { webhook_secret: 'SAME-SECRET' } },
      ]);
      const audit = jest.fn().mockResolvedValue(undefined);
      const summary = await runMigration({ dbClient, audit });

      expect(summary.hashed).toBe(2);
      expect(audit).toHaveBeenCalledTimes(2);

      const rows = await dbClient('tenants');
      const a = rows.find((r) => r.id === 'tenant-a').settings;
      const b = rows.find((r) => r.id === 'tenant-b').settings;

      // Distinct per-tenant salts → distinct hashes for the same plaintext.
      expect(a.webhook_secret_salt).not.toBe(b.webhook_secret_salt);
      expect(a.webhook_secret_hash).not.toBe(b.webhook_secret_hash);

      await expect(vault.matchesSecret('SAME-SECRET', a)).resolves.toBe(true);
      await expect(vault.matchesSecret('SAME-SECRET', b)).resolves.toBe(true);
    });

    it('does not log or audit the plaintext secret', async () => {
      const dbClient = makeDbClient([
        { id: 't1', settings: { webhook_secret: 'TOPSECRET-PLAINTEXT' } },
      ]);
      const audit = jest.fn().mockResolvedValue(undefined);
      await runMigration({ dbClient, audit });

      const { info, warn, error } = require('../src/logger');
      const allLogs = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
      expect(allLogs).not.toContain('TOPSECRET-PLAINTEXT');

      const auditSerialized = JSON.stringify(audit.mock.calls.map((c) => c[0]));
      expect(auditSerialized).not.toContain('TOPSECRET-PLAINTEXT');
    });
  });

  describe('verification helpers', () => {
    it('verifyLegacySecret requires a legacy record', () => {
      const legacy = { webhook_secret: 'abc' };
      expect(vault.verifyLegacySecret(legacy, 'abc')).toBe(true);
      expect(vault.verifyLegacySecret(legacy, 'nope')).toBe(false);
      expect(() => vault.verifyLegacySecret({}, 'abc')).toThrow('not in legacy format');
    });

    it('defaultVerify delegates to verifyLegacySecret', () => {
      expect(defaultVerify({ webhook_secret: 'k' }, 'k')).toBe(true);
      expect(defaultVerify({ webhook_secret: 'k' }, 'x')).toBe(false);
    });
  });

  describe('retry / authorization-adjacent paths', () => {
    it('shouldRetry treats transient errors as retryable and permanent as not', () => {
      expect(shouldRetry(new Error('pool timeout'))).toBe(true);
      expect(shouldRetry(Object.assign(new Error('too long'), { code: 'SECRET_TOO_LONG' }))).toBe(false);
      expect(shouldRetry(null)).toBe(false);
    });

    it('job handler retries a transient failure then succeeds', async () => {
      const runner = jest
        .fn()
        .mockRejectedValueOnce(new Error('transient db unavailable'))
        .mockResolvedValueOnce({ examined: 1, legacy: 1, hashed: 1, alreadyHashed: 0, invalid: 0, errored: 0 });

      const handler = createMigrateWebhookSecretsHandler({ runner });
      process.env.WEBHOOK_SECRET_MIGRATION_BASE_DELAY = '0';
      process.env.WEBHOOK_SECRET_MIGRATION_MAX_DELAY = '0';
      try {
        const summary = await handler({ id: 'job-1', payload: {} });
        expect(runner).toHaveBeenCalledTimes(2);
        expect(summary.hashed).toBe(1);
      } finally {
        delete process.env.WEBHOOK_SECRET_MIGRATION_BASE_DELAY;
        delete process.env.WEBHOOK_SECRET_MIGRATION_MAX_DELAY;
      }
    });

    it('job handler rethrows after exhausting retries', async () => {
      const runner = jest.fn().mockRejectedValue(new Error('permanent failure'));
      const handler = createMigrateWebhookSecretsHandler({ runner });
      process.env.WEBHOOK_SECRET_MIGRATION_BASE_DELAY = '0';
      process.env.WEBHOOK_SECRET_MIGRATION_MAX_DELAY = '0';
      process.env.WEBHOOK_SECRET_MIGRATION_MAX_RETRIES = '1';
      try {
        await expect(handler({ id: 'job-2', payload: {} })).rejects.toThrow('permanent failure');
        expect(runner).toHaveBeenCalled();
      } finally {
        delete process.env.WEBHOOK_SECRET_MIGRATION_BASE_DELAY;
        delete process.env.WEBHOOK_SECRET_MIGRATION_MAX_DELAY;
        delete process.env.WEBHOOK_SECRET_MIGRATION_MAX_RETRIES;
      }
    });
  });
});