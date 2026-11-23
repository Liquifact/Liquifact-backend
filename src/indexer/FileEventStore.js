'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createEventStore, DEFAULT_MAX_EVENTS } = require('./EventStore');
const logger = require('../logger');

/**
 * Create an EventStore backed by an append-only NDJSON log and atomic cursor file.
 *
 * @param {object} options
 * @param {string} options.path - Path to the event log (cursor is stored beside it).
 * @param {number} [options.maxEvents=10000] - Maximum number of retained events.
 * @returns {import('./EventStore').EventStore}
 */
function createFileEventStore({ path: filePath, maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('FileEventStore requires a non-empty path');
  }

  const resolvedPath = path.resolve(filePath);
  const cursorPath = `${resolvedPath}.cursor`;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const store = createEventStore({
    maxEvents,
    onAppend: (event) => {
      const record = JSON.stringify(event);
      if (record === undefined) {
        throw new TypeError('Indexer event could not be serialized');
      }
      fs.appendFileSync(resolvedPath, `${record}\n`, 'utf8');
    },
  });
  loadEvents();
  loadCursor();

  function loadEvents() {
    let contents;
    try {
      contents = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {return;}
      throw err;
    }

    const hasTrailingNewline = contents.endsWith('\n');
    const lines = contents.split('\n');
    if (hasTrailingNewline) {lines.pop();}
    else if (contents.length > 0) {
      lines.pop();
      logger.warn('Ignoring truncated trailing indexer event record', { path: resolvedPath });
    }

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) {continue;}
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          throw new TypeError('Event record must be a JSON object');
        }
        store.append([event]);
      } catch (err) {
        logger.warn('Ignoring corrupt indexer event record', {
          path: resolvedPath,
          line: index + 1,
          error: err.message,
        });
      }
    }
  }

  function loadCursor() {
    let contents;
    try {
      contents = fs.readFileSync(cursorPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {return;}
      throw err;
    }

    try {
      const cursor = JSON.parse(contents);
      if (typeof cursor !== 'string') {
        throw new TypeError('Cursor file must contain a JSON string');
      }
      store.setCursor(cursor);
    } catch (err) {
      logger.warn('Ignoring corrupt indexer cursor file', {
        path: cursorPath,
        error: err.message,
      });
    }
  }

  function setCursor(cursor) {
    const temporaryPath = `${cursorPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(String(cursor)), 'utf8');
      fs.renameSync(temporaryPath, cursorPath);
    } finally {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    }
    store.setCursor(cursor);
  }

  function clear() {
    store.clear();
    fs.writeFileSync(resolvedPath, '', 'utf8');
    try {
      fs.unlinkSync(cursorPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {throw err;}
    }
  }

  return {
    append: store.append,
    query: store.query,
    getCursor: store.getCursor,
    setCursor,
    size: store.size,
    clear,
  };
}

module.exports = { createFileEventStore };
