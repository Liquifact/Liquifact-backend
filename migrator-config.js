'use strict';

module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgresql://localhost:5432/liquifact_dev',
    dir: 'migrations',
  },
  test: {
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgresql://localhost:5432/liquifact_test',
    dir: 'migrations',
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    dir: 'migrations',
  },
};
