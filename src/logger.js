'use strict';

/**
 * Minimal structured logger for the LiquiFact backend.
 * Writes JSON lines to stdout (info/debug) and stderr (warn/error)
 * so log aggregators can parse them without a separate library.
 *
 * Level filtering is controlled by LOG_LEVEL (debug|info|warn|error, default info).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Resolves the active minimum log level from the environment. Invalid values
 * fall back to 'info' here; config.js is responsible for rejecting them at startup.
 * @returns {string}
 */
function activeLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? raw : 'info';
}

/**
 * Converts an Error (or any value) into a JSON-safe representation.
 * `stack` is included only when LOG_LEVEL=debug.
 * @param {Error} err
 * @returns {object}
 */
function serializeError(err) {
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) {
    out.code = err.code;
  }
  if (activeLevel() === 'debug' && err.stack) {
    out.stack = err.stack;
  }
  return out;
}

/**
 * JSON.stringify replacer that serializes Error instances (at any depth) and
 * replaces circular references with a placeholder instead of throwing.
 * @returns {Function}
 */
function createReplacer() {
  const ancestors = [];
  return function replacer(key, value) {
    if (value instanceof Error) {
      return serializeError(value);
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    // `this` is the object that contains `key`; trim the stack back to it.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return '[Circular]';
    }
    ancestors.push(value);
    return value;
  };
}

function log(level, message, meta = {}) {
  if (LEVELS[level] === undefined || LEVELS[level] < LEVELS[activeLevel()]) {
    return;
  }
  const entry = JSON.stringify(
    {
      level,
      message,
      ...meta,
      timestamp: new Date().toISOString(),
      service: 'liquifact-api',
    },
    createReplacer(),
  );
  if (level === 'error' || level === 'warn') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

const logger = {
  info:  (message, meta) => log('info',  message, meta),
  debug: (message, meta) => log('debug', message, meta),
  warn:  (message, meta) => log('warn',  message, meta),
  error: (message, meta) => log('error', message, meta),
};

module.exports = logger;
