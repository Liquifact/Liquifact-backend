'use strict';

/**
 * @file tests/unit/knex-validation.test.js
 * @description Unit tests for validation boundaries in src/db/knex.js.
 *
 * Tests the validation functions that ensure config structure, pool values,
 * and Knex instance validity before and after instantiation.
 */

describe('knex.js validation boundaries', () => {
  describe('validateEnvironment', () => {
    let validateEnvironment;

    beforeEach(() => {
      // Extract the function directly from the source file
      const fs = require('fs');
      const knexCode = fs.readFileSync(
        require('path').resolve(__dirname, '../../src/db/knex.js'),
        'utf8'
      );

      const fnMatch = knexCode.match(
        /function validateEnvironment\(environment\) \{[\s\S]*?\n\}/
      );
      if (fnMatch) {
        validateEnvironment = eval(`(${fnMatch[0]})`);
      }
    });

    test('accepts valid environment strings', () => {
      expect(() => validateEnvironment('development')).not.toThrow();
      expect(() => validateEnvironment('production')).not.toThrow();
      expect(() => validateEnvironment('test')).not.toThrow();
      expect(() => validateEnvironment('staging')).not.toThrow();
    });

    test('rejects empty string', () => {
      expect(() => validateEnvironment('')).toThrow(
        /NODE_ENV must be a non-empty string/
      );
    });

    test('rejects whitespace-only string', () => {
      expect(() => validateEnvironment('   ')).toThrow(
        /NODE_ENV must be a non-empty string/
      );
    });

    test('rejects null', () => {
      expect(() => validateEnvironment(null)).toThrow(
        /NODE_ENV must be a non-empty string/
      );
    });

    test('rejects undefined', () => {
      expect(() => validateEnvironment(undefined)).toThrow(
        /NODE_ENV must be a non-empty string/
      );
    });

    test('rejects number', () => {
      expect(() => validateEnvironment(123)).toThrow(
        /NODE_ENV must be a non-empty string/
      );
    });

    test('rejects object', () => {
      expect(() => validateEnvironment({})).toThrow(
        /NODE_ENV must be a non-empty string/
      );
    });
  });

  describe('validateConfigStructure', () => {
    let validateConfigStructure;

    beforeEach(() => {
      const fs = require('fs');
      const knexCode = fs.readFileSync(
        require('path').resolve(__dirname, '../../src/db/knex.js'),
        'utf8'
      );

      const fnMatch = knexCode.match(
        /function validateConfigStructure\(config\) \{[\s\S]*?\n\}/
      );
      if (fnMatch) {
        validateConfigStructure = eval(`(${fnMatch[0]})`);
      }
    });

    test('accepts valid config structure', () => {
      const validConfig = {
        client: 'sqlite3',
        connection: { filename: ':memory:' },
      };
      expect(() => validateConfigStructure(validConfig)).not.toThrow();
    });

    test('rejects null config', () => {
      expect(() => validateConfigStructure(null)).toThrow(
        /Config must be a non-null object/
      );
    });

    test('rejects undefined config', () => {
      expect(() => validateConfigStructure(undefined)).toThrow(
        /Config must be a non-null object/
      );
    });

    test('rejects non-object config', () => {
      expect(() => validateConfigStructure('string')).toThrow(
        /Config must be a non-null object/
      );
      expect(() => validateConfigStructure(123)).toThrow(
        /Config must be a non-null object/
      );
    });

    test('rejects missing client field', () => {
      expect(() =>
        validateConfigStructure({ connection: { filename: ':memory:' } })
      ).toThrow(/Config\.client must be a non-empty string/);
    });

    test('rejects empty client string', () => {
      expect(() =>
        validateConfigStructure({ client: '', connection: { filename: ':memory:' } })
      ).toThrow(/Config\.client must be a non-empty string/);
    });

    test('rejects whitespace-only client', () => {
      expect(() =>
        validateConfigStructure({ client: '   ', connection: { filename: ':memory:' } })
      ).toThrow(/Config\.client must be a non-empty string/);
    });

    test('rejects non-string client', () => {
      expect(() =>
        validateConfigStructure({ client: 123, connection: { filename: ':memory:' } })
      ).toThrow(/Config\.client must be a non-empty string/);
    });

    test('rejects missing connection field', () => {
      expect(() => validateConfigStructure({ client: 'sqlite3' })).toThrow(
        /Config\.connection must be a non-null object/
      );
    });

    test('rejects null connection', () => {
      expect(() =>
        validateConfigStructure({ client: 'sqlite3', connection: null })
      ).toThrow(/Config\.connection must be a non-null object/);
    });

    test('rejects non-object connection', () => {
      expect(() =>
        validateConfigStructure({ client: 'sqlite3', connection: 'string' })
      ).toThrow(/Config\.connection must be a non-null object/);
    });
  });

  describe('validatePoolConfig', () => {
    let validatePoolConfig;

    beforeEach(() => {
      const fs = require('fs');
      const knexCode = fs.readFileSync(
        require('path').resolve(__dirname, '../../src/db/knex.js'),
        'utf8'
      );

      const fnMatch = knexCode.match(
        /function validatePoolConfig\(pool\) \{[\s\S]*?\n\}/
      );
      if (fnMatch) {
        validatePoolConfig = eval(`(${fnMatch[0]})`);
      }
    });

    test('accepts null/undefined pool (uses defaults)', () => {
      expect(() => validatePoolConfig(null)).not.toThrow();
      expect(() => validatePoolConfig(undefined)).not.toThrow();
    });

    test('accepts valid pool config', () => {
      const validPool = {
        min: 2,
        max: 10,
        createTimeoutMillis: 30000,
        acquireTimeoutMillis: 30000,
      };
      expect(() => validatePoolConfig(validPool)).not.toThrow();
    });

    test('rejects negative min', () => {
      expect(() => validatePoolConfig({ min: -1 })).toThrow(
        /Pool\.min must be a non-negative integer/
      );
    });

    test('rejects non-integer min', () => {
      expect(() => validatePoolConfig({ min: 2.5 })).toThrow(
        /Pool\.min must be a non-negative integer/
      );
    });

    test('rejects non-number min', () => {
      expect(() => validatePoolConfig({ min: '2' })).toThrow(
        /Pool\.min must be a non-negative integer/
      );
    });

    test('rejects zero or negative max', () => {
      expect(() => validatePoolConfig({ max: 0 })).toThrow(
        /Pool\.max must be a positive integer/
      );
      expect(() => validatePoolConfig({ max: -1 })).toThrow(
        /Pool\.max must be a positive integer/
      );
    });

    test('rejects non-integer max', () => {
      expect(() => validatePoolConfig({ max: 10.5 })).toThrow(
        /Pool\.max must be a positive integer/
      );
    });

    test('rejects min greater than max', () => {
      expect(() => validatePoolConfig({ min: 10, max: 5 })).toThrow(
        /Pool\.min cannot be greater than Pool\.max/
      );
    });

    test('accepts min equal to max', () => {
      expect(() => validatePoolConfig({ min: 5, max: 5 })).not.toThrow();
    });

    test('rejects negative timeout values', () => {
      expect(() =>
        validatePoolConfig({ createTimeoutMillis: -1 })
      ).toThrow(/Pool\.createTimeoutMillis must be a non-negative integer/);
      expect(() =>
        validatePoolConfig({ acquireTimeoutMillis: -100 })
      ).toThrow(/Pool\.acquireTimeoutMillis must be a non-negative integer/);
    });

    test('rejects non-integer timeout values', () => {
      expect(() =>
        validatePoolConfig({ idleTimeoutMillis: 100.5 })
      ).toThrow(/Pool\.idleTimeoutMillis must be a non-negative integer/);
    });

    test('accepts zero timeout values', () => {
      expect(() =>
        validatePoolConfig({ createTimeoutMillis: 0 })
      ).not.toThrow();
    });

    test('rejects non-number timeout values', () => {
      expect(() =>
        validatePoolConfig({ reapIntervalMillis: '1000' })
      ).toThrow(/Pool\.reapIntervalMillis must be a non-negative integer/);
    });
  });

  describe('validateKnexInstance', () => {
    let validateKnexInstance;

    beforeEach(() => {
      const fs = require('fs');
      const knexCode = fs.readFileSync(
        require('path').resolve(__dirname, '../../src/db/knex.js'),
        'utf8'
      );

      const fnMatch = knexCode.match(
        /function validateKnexInstance\(instance\) \{[\s\S]*?\n\}/
      );
      if (fnMatch) {
        validateKnexInstance = eval(`(${fnMatch[0]})`);
      }
    });

    test('accepts valid Knex instance', () => {
      const validInstance = jest.fn(() => ({}));
      validInstance.client = {};
      validInstance.select = jest.fn();
      validInstance.where = jest.fn();
      validInstance.insert = jest.fn();
      validInstance.update = jest.fn();
      validInstance.delete = jest.fn();
      validInstance.transaction = jest.fn();
      expect(() => validateKnexInstance(validInstance)).not.toThrow();
    });

    test('rejects null instance', () => {
      expect(() => validateKnexInstance(null)).toThrow(
        /Knex instance must be a callable function/
      );
    });

    test('rejects undefined instance', () => {
      expect(() => validateKnexInstance(undefined)).toThrow(
        /Knex instance must be a callable function/
      );
    });

    test('rejects non-function instance', () => {
      expect(() => validateKnexInstance({})).toThrow(
        /Knex instance must be a callable function/
      );
    });

    test('rejects instance without client property', () => {
      const instance = jest.fn(() => ({}));
      instance.select = jest.fn();
      instance.where = jest.fn();
      instance.insert = jest.fn();
      instance.update = jest.fn();
      instance.delete = jest.fn();
      instance.transaction = jest.fn();
      expect(() => validateKnexInstance(instance)).toThrow(
        /Knex instance must have a client property/
      );
    });

    test('rejects instance missing required methods', () => {
      const instance = jest.fn(() => ({}));
      instance.client = {};
      instance.select = jest.fn();
      instance.where = jest.fn();
      instance.insert = jest.fn();
      instance.update = jest.fn();
      instance.delete = jest.fn();
      // Missing transaction
      expect(() => validateKnexInstance(instance)).toThrow(
        /Knex instance must have a transaction method/
      );
    });

    test('rejects instance with non-function methods', () => {
      const instance = jest.fn(() => ({}));
      instance.client = {};
      instance.select = 'not a function';
      instance.where = jest.fn();
      instance.insert = jest.fn();
      instance.update = jest.fn();
      instance.delete = jest.fn();
      instance.transaction = jest.fn();
      expect(() => validateKnexInstance(instance)).toThrow(
        /Knex instance must have a select method/
      );
    });
  });
});
