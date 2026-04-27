'use strict';

// Mock Knex instance for tests — avoids the need for the actual knex package.
const mockQuery = {
  where: jest.fn().mockReturnThis(),
  whereNotIn: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  whereRaw: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  returning: jest.fn().mockReturnThis(),
  del: jest.fn().mockResolvedValue(1),
  select: jest.fn().mockResolvedValue([]),
  insert: jest.fn().mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]),
  update: jest.fn().mockResolvedValue(1),
  delete: jest.fn().mockResolvedValue(1),
  first: jest.fn().mockResolvedValue(null),
  andWhere: jest.fn().mockReturnThis(),
  orWhere: jest.fn().mockReturnThis(),
};

const db = jest.fn(() => mockQuery);
db.raw = jest.fn();

module.exports = db;
