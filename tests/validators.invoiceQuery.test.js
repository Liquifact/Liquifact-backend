'use strict';

const {
  validateInvoiceQueryParams,
  validateMarketplaceQueryParams,
} = require('../src/utils/validators');
const { ALL_INVOICE_STATUSES } = require('../src/services/invoiceStateMachine');

const statusErrorMessage = `Invalid status. Must be one of: ${ALL_INVOICE_STATUSES.join(', ')}`;

function acceptedStatusesFor(validator) {
  return ALL_INVOICE_STATUSES.filter((status) => validator({ status }).isValid);
}

describe('validateInvoiceQueryParams status vocabulary', () => {
  it('accepts every canonical invoice status', () => {
    for (const status of ALL_INVOICE_STATUSES) {
      const result = validateInvoiceQueryParams({ status });

      expect(result.isValid).toBe(true);
      expect(result.fieldErrors).toEqual({});
      expect(result.validatedParams.filters.status).toBe(status);
    }
  });

  it('keeps invoice-list and marketplace status validators aligned', () => {
    expect(acceptedStatusesFor(validateInvoiceQueryParams)).toEqual(ALL_INVOICE_STATUSES);
    expect(acceptedStatusesFor(validateMarketplaceQueryParams)).toEqual(ALL_INVOICE_STATUSES);
  });

  it('rejects unknown statuses with the canonical status list', () => {
    const result = validateInvoiceQueryParams({ status: 'not_a_real_status' });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.status).toBe(statusErrorMessage);
    expect(result.validatedParams.filters.status).toBeUndefined();
  });

  it('skips status validation when status is omitted', () => {
    const result = validateInvoiceQueryParams({});

    expect(result.isValid).toBe(true);
    expect(result.fieldErrors).toEqual({});
    expect(result.validatedParams.filters).not.toHaveProperty('status');
  });

  it('rejects invalid optional invoice filters', () => {
    const result = validateInvoiceQueryParams({
      smeId: '',
      dateTo: '2025/01/01',
    });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors).toEqual({
      smeId: 'Invalid smeId format',
      dateTo: 'Invalid dateTo format. Use YYYY-MM-DD',
    });
  });

  it('preserves sortBy and order validation semantics', () => {
    expect(validateInvoiceQueryParams({ sortBy: 'amount', order: 'DESC' })).toMatchObject({
      isValid: true,
      validatedParams: {
        sorting: {
          sortBy: 'amount',
          order: 'desc',
        },
      },
    });

    expect(validateInvoiceQueryParams({ sortBy: 'created_at', order: 'latest' })).toMatchObject({
      isValid: false,
      fieldErrors: {
        sortBy: 'Invalid sortBy. Must be one of: amount, date',
        order: 'Invalid order. Must be "asc" or "desc"',
      },
    });
  });
});

describe('validateMarketplaceQueryParams status vocabulary', () => {
  it('accepts canonical status with every valid marketplace filter shape', () => {
    const result = validateMarketplaceQueryParams({
      status: 'verified',
      yieldBpsMin: '100',
      yieldBpsMax: '1200',
      maturityDateFrom: '2026-01-01',
      maturityDateTo: '2026-12-31',
      fundedRatioMin: '25.5',
      fundedRatioMax: '75',
      sortBy: 'funded_ratio',
      order: 'ASC',
      cursor: 'opaque.cursor',
      page: '999',
      limit: '50',
    });

    expect(result).toEqual({
      isValid: true,
      fieldErrors: {},
      validatedParams: {
        filters: {
          status: 'verified',
          yieldBpsMin: 100,
          yieldBpsMax: 1200,
          maturityDateFrom: '2026-01-01',
          maturityDateTo: '2026-12-31',
          fundedRatioMin: 25.5,
          fundedRatioMax: 75,
        },
        sorting: {
          sortBy: 'funded_ratio',
          order: 'asc',
        },
        pagination: {
          cursor: 'opaque.cursor',
          limit: 50,
        },
      },
    });
  });

  it('validates offset pagination when no cursor is present', () => {
    expect(validateMarketplaceQueryParams({ page: '2', limit: '10' })).toMatchObject({
      isValid: true,
      validatedParams: {
        pagination: {
          page: 2,
          limit: 10,
        },
      },
    });
  });

  it('rejects unknown statuses and malformed marketplace params', () => {
    const result = validateMarketplaceQueryParams({
      status: 'unknown',
      yieldBpsMin: '-1',
      yieldBpsMax: 'NaN',
      maturityDateFrom: '01-01-2026',
      maturityDateTo: '2026/12/31',
      fundedRatioMin: '-0.1',
      fundedRatioMax: '101',
      sortBy: 'createdAt',
      order: 'latest',
      cursor: '',
      limit: '101',
    });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors).toEqual({
      status: statusErrorMessage,
      yieldBpsMin: 'yieldBpsMin must be a non-negative integer',
      yieldBpsMax: 'yieldBpsMax must be a non-negative integer',
      maturityDateFrom: 'Invalid maturityDateFrom format. Use YYYY-MM-DD',
      maturityDateTo: 'Invalid maturityDateTo format. Use YYYY-MM-DD',
      fundedRatioMin: 'fundedRatioMin must be a number between 0 and 100',
      fundedRatioMax: 'fundedRatioMax must be a number between 0 and 100',
      sortBy: 'Invalid sortBy. Must be one of: yield_bps, maturity_date, funded_ratio, amount, created_at',
      order: 'Invalid order. Must be "asc" or "desc"',
      cursor: 'cursor must be a non-empty string (max 2048 chars)',
      limit: 'limit must be an integer between 1 and 100',
    });
  });

  it('rejects invalid page when no cursor is present', () => {
    const result = validateMarketplaceQueryParams({ page: '0' });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.page).toBe('page must be an integer >= 1');
  });
});
