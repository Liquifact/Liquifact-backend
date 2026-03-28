const db = require('../../src/db/knex');
const { getInvoices } = require('../../src/services/invoice.service');

// Mock Knex
jest.mock('../../src/db/knex', () => {
  const mockDb = jest.fn(() => mockDb);
  mockDb.select = jest.fn().mockReturnThis();
  mockDb.where = jest.fn().mockReturnThis();
  mockDb.orderBy = jest.fn().mockReturnThis();
  mockDb.then = jest.fn((resolve) => resolve([{ id: 1 }])); // Mocking the promise
  return mockDb;
});

describe('Invoice Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call db with correct parameters', async () => {
    const queryParams = {
      filters: { status: 'paid' },
      sorting: { sortBy: 'amount', order: 'asc' }
    };

    const results = await getInvoices(queryParams);

    expect(db).toHaveBeenCalledWith('invoices');
    expect(db().select).toHaveBeenCalledWith('*');
    expect(db().where).toHaveBeenCalledWith('status', 'paid');
    expect(db().orderBy).toHaveBeenCalledWith('amount', 'asc');
    expect(results).toEqual([{ id: 1 }]);
  });

  it('should handle database errors', async () => {
    // Mocking rejection manually
    db().then.mockImplementationOnce((resolve, reject) => reject(new Error('DB Error')));

    await expect(getInvoices({})).rejects.toThrow('Database error while fetching invoices');
  });
});
