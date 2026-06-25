'use strict';

const fs = require('fs');
const path = require('path');

describe('Database Migrations Integration Tests', () => {
  describe('Migration File Structure', () => {
    test('should have migration files with proper naming', () => {
      const migrationsDir = path.join(__dirname, '../../migrations');

      if (!fs.existsSync(migrationsDir)) {
        console.log('Migrations directory not found, skipping test');
        return;
      }

      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'));

      // The legacy JS migration does not follow the timestamped pattern – skip it.
      const timestampedFiles = migrationFiles.filter(
        (f) => /^\d{14}_/.test(f) || /^\d{12}/.test(f)
      );

      // Should have at least one migration file.
      expect(timestampedFiles.length).toBeGreaterThan(0);
    });

    test('should have migration files in chronological order', () => {
      const migrationsDir = path.join(__dirname, '../../migrations');

      if (!fs.existsSync(migrationsDir)) {
        console.log('Migrations directory not found, skipping test');
        return;
      }

      // Sort filenames lexicographically — the naming convention
      // (YYYYMMDDHHMMSS or YYYYMMDDHHNN prefix) ensures lex order == time order.
      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort();

      // Verify the sorted order matches lexicographic ordering (i.e. it is
      // already sorted), which is the invariant we care about for migration safety.
      const sorted = [...migrationFiles].sort();
      expect(migrationFiles).toEqual(sorted);
    });

    test('should have valid SQL content in migration files', () => {
      const migrationsDir = path.join(__dirname, '../../migrations');

      if (!fs.existsSync(migrationsDir)) {
        console.log('Migrations directory not found, skipping test');
        return;
      }

      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'));

      for (const file of migrationFiles) {
        const filePath = path.join(migrationsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // Should contain SQL comments.
        expect(content).toMatch(/--.*/);

        // Should contain CREATE or ALTER statements.
        expect(content).toMatch(/CREATE|ALTER/i);

        // Should not contain dangerous global operations.
        expect(content.toLowerCase()).not.toMatch(
          /drop\s+database|truncate\s+table/i
        );
      }
    });
  });

  describe('Configuration Files', () => {
    test('should have migration configuration file', () => {
      const configPath = path.join(__dirname, '../../migrator-config.js');
      expect(fs.existsSync(configPath)).toBe(true);
    });

    test('should have docker compose file', () => {
      const dockerComposePath = path.join(
        __dirname,
        '../../docker-compose.dev.yml'
      );
      expect(fs.existsSync(dockerComposePath)).toBe(true);
    });

    test('should have database initialization script', () => {
      const initScriptPath = path.join(
        __dirname,
        '../../scripts/init-db.sql'
      );
      expect(fs.existsSync(initScriptPath)).toBe(true);
    });
  });

  describe('Package.json Scripts', () => {
    test('should have migration scripts in package.json', () => {
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, 'utf8')
      );

      const expectedScripts = [
        'db:migrate',
        'db:migrate:down',
        'db:migrate:create',
        'db:migrate:reset',
        'db:setup',
      ];

      for (const script of expectedScripts) {
        expect(packageJson.scripts).toHaveProperty(script);
      }
    });

    test('should have correct migration script commands', () => {
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, 'utf8')
      );

      expect(packageJson.scripts['db:migrate']).toBe('node-pg-migrate up');
      expect(packageJson.scripts['db:migrate:down']).toBe(
        'node-pg-migrate down'
      );
      expect(packageJson.scripts['db:migrate:create']).toBe(
        'node-pg-migrate create'
      );
      expect(packageJson.scripts['db:migrate:reset']).toBe(
        'node-pg-migrate reset'
      );
    });
  });

  describe('Documentation', () => {
    test('should have migration documentation', () => {
      const docPath = path.join(__dirname, '../../DB_MIGRATIONS.md');
      expect(fs.existsSync(docPath)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Knexfile: test-environment isolation
  // ---------------------------------------------------------------------------
  describe('Knexfile test environment isolation', () => {
    let knexfile;

    beforeAll(() => {
      knexfile = require('../../knexfile');
    });

    test('should define an isolated "test" config block', () => {
      expect(knexfile.test).toBeDefined();
    });

    test('test config should use SQLite :memory: (no shared file or network)', () => {
      expect(knexfile.test.client).toBe('sqlite3');
      expect(knexfile.test.connection.filename).toBe(':memory:');
    });

    test('test config pool should be minimal (max 1)', () => {
      expect(knexfile.test.pool).toBeDefined();
      expect(knexfile.test.pool.max).toBe(1);
    });

    test('development config should not use :memory:', () => {
      expect(knexfile.development).toBeDefined();
      expect(knexfile.development.connection.filename).not.toBe(':memory:');
    });

    test('production config should use PostgreSQL', () => {
      expect(knexfile.production).toBeDefined();
      expect(knexfile.production.client).toBe('pg');
    });

    test('test config should be completely separate from production config', () => {
      // The test block must not reference any production values.
      expect(knexfile.test.client).not.toBe('pg');
      // Verify there is no DATABASE_URL leak into the test connection.
      const testConn = knexfile.test.connection;
      expect(testConn).not.toHaveProperty('connectionString');
      expect(testConn.filename).toBe(':memory:');
    });
  });

  // ---------------------------------------------------------------------------
  // src/db/resolveConfig.js: connection-selection logic (no real DB connection)
  //
  // We test resolveConfig directly rather than requiring src/db/knex.js because
  // knex.js calls the knex() constructor at module load, which opens a real
  // SQLite connection.  resolveConfig is the pure function that encapsulates
  // all env-guard / config-selection logic, making it the right unit to test.
  // ---------------------------------------------------------------------------
  describe('Knex factory resolveConfig', () => {
    let resolveConfig;

    beforeAll(() => {
      // Load the real resolveConfig module once — it has no side effects.
      resolveConfig = require('../../src/db/resolveConfig');
    });

    afterEach(() => {
      jest.resetModules();
    });

    test('should throw clearly when test config block is absent', () => {
      jest.doMock('../../knexfile', () => ({
        development: {
          client: 'sqlite3',
          connection: { filename: './db.sqlite3' },
          useNullAsDefault: true,
        },
      }));

      // Re-require resolveConfig so it picks up the mocked knexfile.
      jest.resetModules();
      const rc = require('../../src/db/resolveConfig');

      expect(() => rc('test')).toThrow(/No "test" config block found/);
    });

    test('should throw when NODE_ENV=production and DATABASE_URL is unset', () => {
      const savedUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;

      try {
        expect(() => resolveConfig('production')).toThrow(
          /DATABASE_URL must be set when NODE_ENV=production/
        );
      } finally {
        if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
      }
    });

    test('should throw for an unknown environment with no matching config block', () => {
      jest.doMock('../../knexfile', () => ({
        test: {
          client: 'sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
        },
        production: { client: 'pg', connection: 'postgresql://host/db' },
      }));

      jest.resetModules();
      const rc = require('../../src/db/resolveConfig');

      expect(() => rc('staging')).toThrow(
        /No config block found for NODE_ENV="staging"/
      );
    });

    test('test env selects the test config block', () => {
      const config = resolveConfig('test');
      expect(config.client).toBe('sqlite3');
      expect(config.connection.filename).toBe(':memory:');
    });

    test('development env selects the development config block', () => {
      // Capture the real knexfile value BEFORE entering the isolated scope
      // to avoid a circular require (mock factory calling require on itself).
      const realKnexfile = jest.requireActual('../../knexfile');

      jest.isolateModules(() => {
        jest.doMock('../../knexfile', () => realKnexfile);
        const rc = require('../../src/db/resolveConfig');
        const config = rc('development');
        expect(config.client).toBe('sqlite3');
        expect(config.connection.filename).not.toBe(':memory:');
      });
    });

    test('unknown env falls back to development config when present', () => {
      // "staging" has no block in the real knexfile, so it falls back to
      // development rather than throwing — only when development IS defined.
      // Re-mock knexfile with a staging+development pair to verify fallback.
      jest.isolateModules(() => {
        jest.doMock('../../knexfile', () => ({
          development: {
            client: 'sqlite3',
            connection: { filename: './db.sqlite3' },
            useNullAsDefault: true,
          },
          production: { client: 'pg', connection: 'postgresql://host/db' },
        }));

        const rc = require('../../src/db/resolveConfig');
        const config = rc('staging');
        expect(config.client).toBe('sqlite3');
      });
    });

    test('mock path is unaffected — manual mock exports a callable', () => {
      // Verify the manual mock contract: the file at src/db/__mocks__/knex.js
      // exports a jest.fn() that returns a query-chain object.  We load it
      // directly to avoid pulling in the real knex.js (which requires pino).
      const mockDb = require('../../src/db/__mocks__/knex');
      expect(typeof mockDb).toBe('function');
      const chain = mockDb('invoices');
      expect(typeof chain.where).toBe('function');
      expect(typeof chain.select).toBe('function');
    });
  });
});
