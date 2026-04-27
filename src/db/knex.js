const knex = require('knex');
require('dotenv').config();

const config = require('../../knexfile')[process.env.NODE_ENV || 'development'];

// Only initialize if we're not in a test environment, or use a mock
const db = process.env.NODE_ENV === 'test' 
  ? knex(config) // Use config for test
  : knex(config);

module.exports = db;
