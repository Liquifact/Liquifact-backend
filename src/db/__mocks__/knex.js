'use strict';

// Mock Knex instance for tests — avoids the need for the actual knex package.
// mockQuery is both a fluent builder (every method returns this) AND
// thenable (awaiting the chain resolves to []), matching real Knex behaviour.
const mockQuery = {
  where: jest.fn().mockReturnThis(),
  whereNotIn: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  whereRaw: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  returning: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  del: jest.fn().mockResolvedValue(1),
  insert: jest.fn().mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]),
  update: jest.fn().mockResolvedValue(1),
  delete: jest.fn().mockResolvedValue(1),
  first: jest.fn().mockResolvedValue(null),
  andWhere: jest.fn().mockReturnThis(),
  orWhere: jest.fn().mockReturnThis(),
  // Make mockQuery thenable so `await query` resolves to []
  then: jest.fn((resolve) => resolve([])),
};

const db = jest.fn(() => mockQuery);
db.raw = jest.fn().mockResolvedValue();
db.transaction = jest.fn(async (callback) => {
  // The callback receives the same mock db instance as trx
  await callback(db);
});

module.exports = db;
