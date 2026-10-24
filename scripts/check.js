'use strict';

// "Build" for a plain-JS service: make sure the app and the serverless entry load.
const app = require('../api/index.js');
if (typeof app !== 'function') {
  throw new Error('api/index.js must export an Express app');
}
console.log('build ok: Express app loads');
