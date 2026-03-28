const { applyQueryOptions } = require('../../src/utils/queryBuilder');

describe('Query Builder Utility', () => {
  let mockQuery;

  beforeEach(() => {
    mockQuery = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };
  });

  const config = {
    allowedFilters: ['status', 'smeId', 'dateFrom', 'dateTo'],
    allowedSortFields: ['amount', 'date'],
    columnMap: {
      smeId: 'sme_id',
      dateFrom: 'date',
      dateTo: 'date',
    },
  };

  it('should apply simple filters correctly', () => {
    const options = {
      filters: { status: 'paid', smeId: '123' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
    expect(mockQuery.where).toHaveBeenCalledWith('sme_id', '123');
  });

  it('should ignore non-whitelisted filters', () => {
    const options = {
      filters: { status: 'paid', hack: 'DROP TABLE users' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
    expect(mockQuery.where).not.toHaveBeenCalledWith('hack', expect.anything());
  });

  it('should handle date range filters', () => {
    const options = {
      filters: { dateFrom: '2023-01-01', dateTo: '2023-12-31' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.where).toHaveBeenCalledWith('date', '>=', '2023-01-01');
    expect(mockQuery.where).toHaveBeenCalledWith('date', '<=', '2023-12-31');
  });

  it('should apply valid sorting with desc order', () => {
    const options = {
      sorting: { sortBy: 'amount', order: 'desc' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
  });

  it('should handle missing order with default desc', () => {
    const options = {
      sorting: { sortBy: 'amount' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
  });

  it('should handle empty allowedSortFields', () => {
    const emptyConfig = { allowedFilters: [], allowedSortFields: [] };
    applyQueryOptions(mockQuery, {}, emptyConfig);
    expect(mockQuery.orderBy).not.toHaveBeenCalled();
  });

  it('should use default sorting if sortBy is invalid', () => {
    const options = {
      sorting: { sortBy: 'invalid' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
  });

  it('should apply default order if invalid', () => {
    const options = {
      sorting: { sortBy: 'date', order: 'sideways' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.orderBy).toHaveBeenCalledWith('date', 'desc');
  });

  it('should ignore filters with undefined, null, or empty string values', () => {
    const options = {
      filters: { status: undefined, smeId: null, dateFrom: '' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.where).not.toHaveBeenCalled();
  });

  it('should use key as column if not in columnMap', () => {
    const options = {
      filters: { status: 'paid' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
  });

  it('should handle mixed case order', () => {
    const options = {
      sorting: { sortBy: 'amount', order: 'ASC' },
    };
    applyQueryOptions(mockQuery, options, config);

    expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'asc');
  });
});
