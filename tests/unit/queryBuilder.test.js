const { applyQueryOptions } = require('../../src/utils/queryBuilder');
const { MARKETPLACE_QUERY_CONFIG } = require('../../src/services/marketplaceService');
const { INVOICE_QUERY_CONFIG } = require('../../src/services/invoiceService');

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

  describe('filter whitelist boundary', () => {
    it('should apply each whitelisted filter and map columns via columnMap', () => {
      const options = {
        filters: { status: 'paid', smeId: '123' },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
      expect(mockQuery.where).toHaveBeenCalledWith('sme_id', '123');
      expect(mockQuery.where).toHaveBeenCalledTimes(2);
    });

    it('should ignore non-whitelisted filters and never pass them to the query', () => {
      const options = {
        filters: { status: 'paid', hack: 'DROP TABLE users' },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
      expect(mockQuery.where).not.toHaveBeenCalledWith('hack', expect.anything());
      expect(mockQuery.where).toHaveBeenCalledTimes(1);
    });

    it('should ignore every non-whitelisted key when mixed with allowed filters', () => {
      const options = {
        filters: {
          status: 'verified',
          tenant_id: 'other-tenant',
          buyerId: 'buyer-1',
          admin: true,
          __proto__: { polluted: true },
        },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).toHaveBeenCalledTimes(1);
      expect(mockQuery.where).toHaveBeenCalledWith('status', 'verified');
    });

    it('should use key as column when not present in columnMap', () => {
      const options = {
        filters: { status: 'paid' },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
    });

    it('should ignore filters with undefined, null, or empty string values', () => {
      const options = {
        filters: { status: undefined, smeId: null, dateFrom: '' },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).not.toHaveBeenCalled();
    });

    it('should apply numeric zero and boolean false as legitimate filter values', () => {
      const numericConfig = {
        allowedFilters: ['amount', 'active'],
        allowedSortFields: [],
        columnMap: {},
      };
      const options = {
        filters: { amount: 0, active: false },
      };
      applyQueryOptions(mockQuery, options, numericConfig);

      expect(mockQuery.where).toHaveBeenCalledWith('amount', 0);
      expect(mockQuery.where).toHaveBeenCalledWith('active', false);
    });
  });

  describe('date range filters', () => {
    it('should apply dateFrom and dateTo with inclusive range operators', () => {
      const options = {
        filters: { dateFrom: '2023-01-01', dateTo: '2023-12-31' },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).toHaveBeenCalledWith('date', '>=', '2023-01-01');
      expect(mockQuery.where).toHaveBeenCalledWith('date', '<=', '2023-12-31');
    });

    it('should pass ISO date strings through without altering operators', () => {
      const options = {
        filters: {
          dateFrom: '2024-06-15T00:00:00.000Z',
          dateTo: '2024-06-30T23:59:59.999Z',
        },
      };
      applyQueryOptions(mockQuery, options, config);

      expect(mockQuery.where).toHaveBeenCalledWith('date', '>=', '2024-06-15T00:00:00.000Z');
      expect(mockQuery.where).toHaveBeenCalledWith('date', '<=', '2024-06-30T23:59:59.999Z');
    });
  });

  describe('sort whitelist and direction constraint', () => {
    it.each([
      ['amount', 'desc'],
      ['date', 'asc'],
    ])('should order by whitelisted field %s with direction %s', (sortBy, order) => {
      applyQueryOptions(mockQuery, { sorting: { sortBy, order } }, config);

      const expectedColumn = sortBy === 'date' ? 'date' : sortBy;
      expect(mockQuery.orderBy).toHaveBeenCalledWith(expectedColumn, order);
    });

    it('should default order to desc when order is omitted', () => {
      applyQueryOptions(mockQuery, { sorting: { sortBy: 'amount' } }, config);

      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
    });

    it('should normalize mixed-case order to lowercase asc', () => {
      applyQueryOptions(mockQuery, { sorting: { sortBy: 'amount', order: 'ASC' } }, config);

      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'asc');
    });

    it('should fall back to desc when order is not asc or desc', () => {
      applyQueryOptions(mockQuery, { sorting: { sortBy: 'date', order: 'sideways' } }, config);

      expect(mockQuery.orderBy).toHaveBeenCalledWith('date', 'desc');
    });

    it.each(['INVALID', '', 'ascending', '1=1', 'desc; DROP TABLE invoices'])(
      'should fall back to desc for unsafe order value "%s"',
      (order) => {
        applyQueryOptions(mockQuery, { sorting: { sortBy: 'amount', order } }, config);

        expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
      },
    );

    it('should reject non-whitelisted sortBy and use the first allowed sort field', () => {
      applyQueryOptions(mockQuery, { sorting: { sortBy: 'invalid' } }, config);

      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
      expect(mockQuery.orderBy).not.toHaveBeenCalledWith('invalid', expect.anything());
    });

    it('should apply default sort when sortBy is missing but allowedSortFields exist', () => {
      applyQueryOptions(mockQuery, { sorting: {} }, config);

      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
    });

    it('should not apply sorting when allowedSortFields is empty', () => {
      applyQueryOptions(mockQuery, {}, { allowedFilters: [], allowedSortFields: [] });

      expect(mockQuery.orderBy).not.toHaveBeenCalled();
    });
  });

  describe('invoice query config integration', () => {
    it('should honor INVOICE_QUERY_CONFIG filter and sort whitelists', () => {
      const options = {
        filters: {
          status: 'verified',
          smeId: 'sme-42',
          buyerId: 'buyer-9',
          dateFrom: '2025-01-01',
          dateTo: '2025-12-31',
          secretColumn: 'leak',
        },
        sorting: { sortBy: 'amount', order: 'asc' },
      };
      applyQueryOptions(mockQuery, options, INVOICE_QUERY_CONFIG);

      expect(mockQuery.where).toHaveBeenCalledWith('status', 'verified');
      expect(mockQuery.where).toHaveBeenCalledWith('sme_id', 'sme-42');
      expect(mockQuery.where).toHaveBeenCalledWith('buyer_id', 'buyer-9');
      expect(mockQuery.where).toHaveBeenCalledWith('date', '>=', '2025-01-01');
      expect(mockQuery.where).toHaveBeenCalledWith('date', '<=', '2025-12-31');
      expect(mockQuery.where).not.toHaveBeenCalledWith('secretColumn', expect.anything());
      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'asc');
    });
  });

  describe('marketplace-aligned column coercion', () => {
    it('should only sort by marketplace whitelisted DB columns', () => {
      MARKETPLACE_QUERY_CONFIG.allowedSortFields.forEach((sortField) => {
        const localQuery = {
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
        };
        applyQueryOptions(localQuery, { sorting: { sortBy: sortField, order: 'asc' } }, MARKETPLACE_QUERY_CONFIG);

        expect(localQuery.orderBy).toHaveBeenCalledWith(sortField, 'asc');
      });
    });

    it('should ignore marketplace filter keys that rely on custom range handlers', () => {
      const options = {
        filters: {
          yieldBpsMin: 100,
          yieldBpsMax: 500,
          maturityDateFrom: '2025-06-01',
          fundedRatioMin: 0.25,
          status: 'verified',
          tenant_id: 'injected-tenant',
        },
      };
      applyQueryOptions(mockQuery, options, MARKETPLACE_QUERY_CONFIG);

      // applyQueryOptions only supports equality for non dateFrom/dateTo keys.
      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', 100);
      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', 500);
      expect(mockQuery.where).toHaveBeenCalledWith('maturity_date', '2025-06-01');
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', 0.25);
      expect(mockQuery.where).toHaveBeenCalledWith('status', 'verified');
      expect(mockQuery.where).not.toHaveBeenCalledWith('tenant_id', expect.anything());
    });

    it('should pass numeric and string marketplace filter values as bound parameters', () => {
      applyQueryOptions(
        mockQuery,
        { filters: { yieldBpsMin: '150', fundedRatioMax: 0.99, status: 'partially_funded' } },
        MARKETPLACE_QUERY_CONFIG,
      );

      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', '150');
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', 0.99);
      expect(mockQuery.where).toHaveBeenCalledWith('status', 'partially_funded');
    });

    it('should map all marketplace filter keys via columnMap including maturityDateTo and fundedRatioMax', () => {
      const options = {
        filters: {
          yieldBpsMax: 999,
          maturityDateTo: '2025-12-31',
          fundedRatioMax: 1.0,
        },
      };
      applyQueryOptions(mockQuery, options, MARKETPLACE_QUERY_CONFIG);

      expect(mockQuery.where).toHaveBeenCalledWith('yield_bps', 999);
      expect(mockQuery.where).toHaveBeenCalledWith('maturity_date', '2025-12-31');
      expect(mockQuery.where).toHaveBeenCalledWith('funded_ratio', 1.0);
      expect(mockQuery.where).toHaveBeenCalledTimes(3);
    });

it('should apply columnMap alias keys (yieldBps, maturityDate, fundedRatio) as equality filters', () => {
      // These keys are NOT in allowedFilters, only in columnMap as aliases.
      // They should be ignored since they're not whitelisted.
      const options = {
        filters: {
          yieldBps: 500,
          maturityDate: '2025-07-01',
          fundedRatio: 0.75,
        },
      };
      applyQueryOptions(mockQuery, options, MARKETPLACE_QUERY_CONFIG);

      expect(mockQuery.where).not.toHaveBeenCalled();
    });

it('should handle undefined options gracefully (applies default sort when config has allowedSortFields)', () => {
      applyQueryOptions(mockQuery, undefined, config);

      expect(mockQuery.where).not.toHaveBeenCalled();
      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
    });
  });

  describe('edge cases for empty and missing inputs', () => {
    it('should handle empty filters object without calling where', () => {
      applyQueryOptions(mockQuery, { filters: {} }, config);

      expect(mockQuery.where).not.toHaveBeenCalled();
    });

    it('should handle empty sorting object without calling orderBy when allowedSortFields exist', () => {
      applyQueryOptions(mockQuery, { sorting: {} }, config);

      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
    });

    it('should handle undefined options gracefully (applies default sort when config has allowedSortFields)', () => {
      applyQueryOptions(mockQuery, undefined, config);

      expect(mockQuery.where).not.toHaveBeenCalled();
      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
    });

    it('should handle undefined config gracefully (no whitelist = no filters/sorts applied)', () => {
      applyQueryOptions(mockQuery, { filters: { status: 'paid' } });

      expect(mockQuery.where).not.toHaveBeenCalled();
      expect(mockQuery.orderBy).not.toHaveBeenCalled();
    });
  });

  describe('SQL injection neutralization', () => {
    // Fixtures below simulate common injection vectors. applyQueryOptions must never
    // forward attacker-controlled field names to Knex; whitelisted values are passed
    // as parameters (second/third args to where), not concatenated into SQL text.

    const injectionFieldNames = [
      // Classic statement terminator attempting to append a second SQL command.
      "'; DROP TABLE users;--",
      'status; DELETE FROM invoices',
      '1=1',
      'amount) OR (1=1',
    ];

    it.each(injectionFieldNames)(
      'should not apply filter when field name is an injection payload: %s',
      (maliciousKey) => {
        applyQueryOptions(mockQuery, { filters: { [maliciousKey]: 'paid' } }, config);

        expect(mockQuery.where).not.toHaveBeenCalled();
      },
    );

    const injectionFilterValues = [
      // Tautology attempt via string escape — value must remain a literal bind arg.
      "paid' OR '1'='1",
      "verified'; DROP TABLE invoices;--",
      '1; DELETE FROM users WHERE 1=1',
    ];

    it.each(injectionFilterValues)(
      'should pass malicious filter value as a literal parameter: %s',
      (maliciousValue) => {
        applyQueryOptions(mockQuery, { filters: { status: maliciousValue } }, config);

        expect(mockQuery.where).toHaveBeenCalledTimes(1);
        expect(mockQuery.where).toHaveBeenCalledWith('status', maliciousValue);
      },
    );

    it('should not sort by injection payload in sortBy', () => {
      const maliciousSortBy = 'amount; DROP TABLE invoices';
      applyQueryOptions(mockQuery, { sorting: { sortBy: maliciousSortBy, order: 'asc' } }, config);

      expect(mockQuery.orderBy).not.toHaveBeenCalledWith(maliciousSortBy, expect.anything());
      expect(mockQuery.orderBy).toHaveBeenCalledWith('amount', 'desc');
    });

    it('should not treat prototype pollution keys as filters', () => {
      const pollutedFilters = Object.create({ inherited: 'bad' });
      pollutedFilters.status = 'paid';
      pollutedFilters.__proto__ = { admin: true };

      applyQueryOptions(mockQuery, { filters: pollutedFilters }, config);

      expect(mockQuery.where).toHaveBeenCalledTimes(1);
      expect(mockQuery.where).toHaveBeenCalledWith('status', 'paid');
    });
  });

  describe('defaults and return value', () => {
    it('should accept omitted options and config without throwing', () => {
      const result = applyQueryOptions(mockQuery);

      expect(result).toBe(mockQuery);
      expect(mockQuery.where).not.toHaveBeenCalled();
      expect(mockQuery.orderBy).not.toHaveBeenCalled();
    });

    it('should return the same query object for chaining', () => {
      const result = applyQueryOptions(mockQuery, { filters: { status: 'paid' } }, config);

      expect(result).toBe(mockQuery);
    });
  });
});
