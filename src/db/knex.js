const knex = require('knex');
require('dotenv').config();

const config = {
  client: 'pg',
  connection: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/liquifact',
  pool: {
    min: 2,
    max: 10
  }
};

// Only initialize if we're not in a test environment, or use a mock
const db = process.env.NODE_ENV === 'test' 
  ? knex({ client: 'pg' }) // Mock-friendly or will be replaced in tests
  : knex(config);

module.exports = db;
