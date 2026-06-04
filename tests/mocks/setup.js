
jest.mock('../../src/db/knex', () => {
  const m = jest.fn(() => m);
  m.where = jest.fn().mockReturnThis();
  m.whereNotIn = jest.fn().mockReturnThis();
  m.whereNull = jest.fn().mockReturnThis();
  m.whereIn = jest.fn().mockReturnThis();
  m.leftJoin = jest.fn().mockReturnThis();
  m.orderBy = jest.fn().mockReturnThis();
  m.limit = jest.fn().mockReturnThis();
  m.select = jest.fn().mockReturnThis();
  m.insert = jest.fn().mockReturnThis();
  m.update = jest.fn().mockReturnThis();
  m.del = jest.fn().mockResolvedValue(1);
  m.first = jest.fn().mockResolvedValue({ id: 'test', kyc_status: 'approved' });
  m.returning = jest.fn().mockReturnThis();
  m.delete = jest.fn().mockResolvedValue(1);
  m.andWhere = jest.fn().mockReturnThis();
  m.orWhere = jest.fn().mockReturnThis();
  m.count = jest.fn().mockResolvedValue([{ count: 25 }]);
  m.raw = jest.fn();
  return m;
}, { virtual: true });
