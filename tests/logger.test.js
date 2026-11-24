'use strict';

/**
 * Tests for src/logger.js: Error serialization, circular-reference safety and
 * LOG_LEVEL filtering. stdout/stderr writes are captured via spies.
 */

const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;

function loadLogger(level) {
  if (level === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = level;
  }
  jest.resetModules();
  return require('../src/logger');
}

describe('logger', () => {
  let stdoutSpy;
  let stderrSpy;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (ORIGINAL_LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
    }
  });

  const parseWritten = (spy) =>
    spy.mock.calls.map(([chunk]) => JSON.parse(String(chunk).trim()));

  describe('Error serialization', () => {
    test('keeps message and name for an Error in meta', () => {
      const logger = loadLogger('info');
      const err = new TypeError('boom');
      logger.error('failed', { err });

      const [entry] = parseWritten(stderrSpy);
      expect(entry.err.name).toBe('TypeError');
      expect(entry.err.message).toBe('boom');
      expect(entry.err.stack).toBeUndefined();
    });

    test('includes code when present', () => {
      const logger = loadLogger('info');
      const err = Object.assign(new Error('nope'), { code: 'E_NOPE' });
      logger.warn('warned', { err });

      const [entry] = parseWritten(stderrSpy);
      expect(entry.err.code).toBe('E_NOPE');
    });

    test('includes stack only when LOG_LEVEL=debug', () => {
      const logger = loadLogger('debug');
      logger.error('failed', { err: new Error('deep') });

      const [entry] = parseWritten(stderrSpy);
      expect(typeof entry.err.stack).toBe('string');
      expect(entry.err.stack).toContain('deep');
    });

    test('serializes Errors nested at arbitrary depth', () => {
      const logger = loadLogger('info');
      logger.error('nested', { outer: { inner: new RangeError('far') } });

      const [entry] = parseWritten(stderrSpy);
      expect(entry.outer.inner.name).toBe('RangeError');
      expect(entry.outer.inner.message).toBe('far');
    });
  });

  describe('circular references', () => {
    test('does not throw on circular meta and emits a placeholder', () => {
      const logger = loadLogger('info');
      const meta = { name: 'loop' };
      meta.self = meta;

      expect(() => logger.info('circular', meta)).not.toThrow();

      const [entry] = parseWritten(stdoutSpy);
      expect(entry.name).toBe('loop');
      expect(entry.self).toBe('[Circular]');
    });

    test('handles deeper cycles without throwing', () => {
      const logger = loadLogger('info');
      const a = { label: 'a' };
      const b = { label: 'b', a };
      a.b = b;

      expect(() => logger.info('deep cycle', { a })).not.toThrow();

      const [entry] = parseWritten(stdoutSpy);
      expect(entry.a.b.a).toBe('[Circular]');
    });

    test('does not flag shared (non-circular) references as circular', () => {
      const logger = loadLogger('info');
      const shared = { x: 1 };
      logger.info('shared', { first: shared, second: shared });

      const [entry] = parseWritten(stdoutSpy);
      expect(entry.first).toEqual({ x: 1 });
      expect(entry.second).toEqual({ x: 1 });
    });
  });

  describe('LOG_LEVEL filtering', () => {
    test('LOG_LEVEL=warn suppresses info and debug', () => {
      const logger = loadLogger('warn');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(parseWritten(stdoutSpy)).toHaveLength(0);
      const levels = parseWritten(stderrSpy).map((e) => e.level);
      expect(levels).toEqual(['warn', 'error']);
    });

    test('defaults to info: debug is suppressed, info is emitted', () => {
      const logger = loadLogger(undefined);
      logger.debug('hidden');
      logger.info('shown');

      const entries = parseWritten(stdoutSpy);
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('shown');
    });

    test('LOG_LEVEL=debug emits everything', () => {
      const logger = loadLogger('debug');
      logger.debug('d');
      logger.info('i');

      expect(parseWritten(stdoutSpy).map((e) => e.level)).toEqual(['debug', 'info']);
    });

    test('LOG_LEVEL=error emits only error', () => {
      const logger = loadLogger('error');
      logger.warn('w');
      logger.error('e');

      expect(parseWritten(stderrSpy).map((e) => e.level)).toEqual(['error']);
    });
  });
});
