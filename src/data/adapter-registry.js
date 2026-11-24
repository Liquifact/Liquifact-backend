'use strict';

/**
 * Adapter Registry singleton.
 * Maintains the active storage adapter (MemoryAdapter or JsonFileAdapter via DATA_FILE).
 */

const { MemoryAdapter } = require('./memory-adapter');
const { JsonFileAdapter } = require('./json-file-adapter');

function createDefaultAdapter() {
  const dataFile = process.env.DATA_FILE?.trim();
  if (dataFile) {
    return new JsonFileAdapter({ filePath: dataFile });
  }
  return new MemoryAdapter();
}

let activeAdapter = createDefaultAdapter();

function getAdapter() {
  return activeAdapter;
}

function setAdapter(adapter) {
  activeAdapter = adapter;
  return activeAdapter;
}

function resetAdapter() {
  activeAdapter = createDefaultAdapter();
  return activeAdapter;
}

module.exports = {
  getAdapter,
  setAdapter,
  resetAdapter,
};
