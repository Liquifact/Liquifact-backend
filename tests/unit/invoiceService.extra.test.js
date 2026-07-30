const db = require('../../src/db/knex');
const invoiceService = require('../../src/services/invoiceService');

jest.mock('../../src/db/knex', () => {
  const mockDb = jest.fn(() => mockDb);
  mockDb.select = jest.fn().mockReturnThis();
  mockDb.where = jest.fn().mockReturnThis();
  mockDb.whereNull = jest.fn().mockReturnThis();
  mockDb.whereIn = jest.fn().mockReturnThis();
  mockDb.orderBy = jest.fn().mockReturnThis();
  mockDb.insert = jest.fn().mockReturnThis();
  mockDb.update = jest.fn().mockReturnThis();
  mockDb.returning = jest.fn().mockReturnThis();
  mockDb.first = jest.fn().mockReturnThis();
  mockDb.then = jest.fn((resolve) => resolve([]));
  return mockDb;
});

describe('Consolidated Invoice Service - extra', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getInvoices tenant variant calls db with tenant filter', async () => {
    await invoiceService.getInvoices('tenant_1');
    expect(db).toHaveBeenCalledWith('invoices');
    expect(db().where).toHaveBeenCalledWith({ tenant_id: 'tenant_1' });
    expect(db().whereNull).toHaveBeenCalledWith('deleted_at');
  });

  test('getInvoiceById returns null when not found', async () => {
    db().first.mockReturnValueOnce(null);
    const res = await invoiceService.getInvoiceById('missing', 't1');
    expect(res).toBeNull();
  });

  test('createInvoice inserts and returns new invoice', async () => {
    const created = { invoice_id: 'inv_123' };
    db().returning.mockReturnValueOnce([created]);
    const res = await invoiceService.createInvoice({ amount: 10, customer: 'X' }, 't1');
    expect(db).toHaveBeenCalledWith('invoices');
    expect(res).toEqual(created);
  });

  test('updateInvoice returns updated invoice or null', async () => {
    const updated = { invoice_id: 'inv_1', status: 'paid' };
    db().returning.mockReturnValueOnce([updated]);
    const res = await invoiceService.updateInvoice('inv_1', { status: 'paid' }, 't1');
    expect(res).toEqual(updated);
  });

  test('deleteInvoice sets deleted_at and returns updated', async () => {
    const updated = { invoice_id: 'inv_2', deleted_at: 'now' };
    db().returning.mockReturnValueOnce([updated]);
    const res = await invoiceService.deleteInvoice('inv_2', 't1');
    expect(res).toEqual(updated);
  });

  test('KYC helpers: getInvoicesByKycStatus and updateInvoiceKycStatus', () => {
    const fixtures = invoiceService.mockInvoices;
    expect(Array.isArray(invoiceService.getInvoicesByKycStatus('user_1'))).toBe(true);
    const inv = fixtures[0];
    expect(() => invoiceService.updateInvoiceKycStatus(inv.id, 'verified', 'rec')).not.toThrow();
    expect(() => invoiceService.updateInvoiceKycStatus('nope', 'verified')).toThrow();
    expect(() => invoiceService.updateInvoiceKycStatus(inv.id, 'bogus')).toThrow();
  });
});
