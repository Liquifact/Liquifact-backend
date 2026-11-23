'use strict';

const config = require('../config');
const { defaultStore } = require('./EventStore');
const { createFileEventStore } = require('./FileEventStore');

const configuredStore = config.indexerStateFile
  ? createFileEventStore({ path: config.indexerStateFile })
  : defaultStore;

module.exports = { defaultStore: configuredStore };
