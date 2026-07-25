/**
 * Invoice State Validation — Shared Validation Helper Tests
 *
 * Covers:
 *   - buildInvoiceStateError — error object factory
 *   - normalizeTenantId — tenant extraction from request
 *   - normalizeInvoiceId — invoice ID normalisation
 *   - resolveInvoiceStateContext — full context resolution with error cases
 *
 * @jest-environment node
 */

const {
  buildInvoiceStateError,
  normalizeTenantId,
  normalizeInvoiceId,
  resolveInvoiceStateContext,
} = require('../src/routes/invoiceStateValidation');
const invoiceService = require('../src/services/invoiceService');

/* ------------------------------------------------------------------ */
/*  buildInvoiceStateError                                             */
/* ------------------------------------------------------------------ */
describe('buildInvoiceStateError', () => {
  it('should return an object with statusCode and error sub-object', () => {
    const result = buildInvoiceStateError('TEST_CODE', 'Test message');
    expect(result).toEqual({
      statusCode: 400,
      error: { code: 'TEST_CODE', message: 'Test message' },
    });
  });

  it('should use the provided statusCode', () => {
    const result = buildInvoiceStateError('NOT_FOUND', 'Not found.', 404);
    expect(result.statusCode).toBe(404);
  });

  it('should include details when provided as a non-empty object', () => {
    const result = buildInvoiceStateError('ERR', 'msg', 400, { field: 'value' });
    expect(result.error.details).toEqual({ field: 'value' });
  });

  it('should omit details when provided as an empty object', () => {
    const result = buildInvoiceStateError('ERR', 'msg', 400, {});
    expect(result.error.details).toBeUndefined();
  });

  it('should omit details when provided as null', () => {
    const result = buildInvoiceStateError('ERR', 'msg', 400, null);
    expect(result.error.details).toBeUndefined();
  });

  it('should omit details when provided as undefined', () => {
    const result = buildInvoiceStateError('ERR', 'msg', 400, undefined);
    expect(result.error.details).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeTenantId                                                  */
/* ------------------------------------------------------------------ */
describe('normalizeTenantId', () => {
  it('should extract tenant from x-tenant-id header', () => {
    const req = { headers: { 'x-tenant-id': 'tenant-alpha' } };
    expect(normalizeTenantId(req)).toBe('tenant-alpha');
  });

  it('should extract tenant from x-tenant header', () => {
    const req = { headers: { 'x-tenant': 'tenant-beta' } };
    expect(normalizeTenantId(req)).toBe('tenant-beta');
  });

  it('should prefer x-tenant-id over x-tenant when both are present', () => {
    const req = { headers: { 'x-tenant-id': 'primary', 'x-tenant': 'secondary' } };
    expect(normalizeTenantId(req)).toBe('primary');
  });

  it('should fall back to req.tenantId when no headers present', () => {
    const req = { tenantId: 'tenant-from-prop' };
    expect(normalizeTenantId(req)).toBe('tenant-from-prop');
  });

  it('should trim the tenant value', () => {
    const req = { headers: { 'x-tenant-id': '  tenant-with-spaces  ' } };
    expect(normalizeTenantId(req)).toBe('tenant-with-spaces');
  });

  it('should return empty string when tenant is missing', () => {
    const req = { headers: {} };
    expect(normalizeTenantId(req)).toBe('');
  });

  it('should return empty string when req is null', () => {
    expect(normalizeTenantId(null)).toBe('');
  });

  it('should return empty string when req is undefined', () => {
    expect(normalizeTenantId(undefined)).toBe('');
  });

  it('should return empty string when tenantId property is not a string', () => {
    const req = { tenantId: 123 };
    expect(normalizeTenantId(req)).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeInvoiceId                                                 */
/* ------------------------------------------------------------------ */
describe('normalizeInvoiceId', () => {
  it('should trim whitespace from invoice ID', () => {
    expect(normalizeInvoiceId('  inv-001  ')).toBe('inv-001');
  });

  it('should return the same string when already trimmed', () => {
    expect(normalizeInvoiceId('inv-001')).toBe('inv-001');
  });

  it('should return empty string for null', () => {
    expect(normalizeInvoiceId(null)).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(normalizeInvoiceId(undefined)).toBe('');
  });

  it('should return empty string for non-string types (number)', () => {
    expect(normalizeInvoiceId(123)).toBe('');
  });

  it('should return empty string for non-string types (object)', () => {
    expect(normalizeInvoiceId({ id: 'inv' })).toBe('');
  });

  it('should return empty string for empty string', () => {
    expect(normalizeInvoiceId('')).toBe('');
  });

  it('should return empty string for whitespace-only string', () => {
    expect(normalizeInvoiceId('   ')).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  resolveInvoiceStateContext                                         */
/* ------------------------------------------------------------------ */
describe('resolveInvoiceStateContext', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('should return MISSING_TENANT error when tenant is missing', async () => {
    const req = { headers: {} };
    const result = await resolveInvoiceStateContext(req, 'inv-001');

    expect(result.error).toBeDefined();
    expect(result.error.statusCode).toBe(400);
    expect(result.error.error.code).toBe('MISSING_TENANT');
    expect(result.error.error.message).toBe('Tenant context is required.');
  });

  it('should return MISSING_INVOICE_ID error when invoice ID is null', async () => {
    const req = { headers: { 'x-tenant-id': 'tenant-a' } };
    const result = await resolveInvoiceStateContext(req, null);

    expect(result.error).toBeDefined();
    expect(result.error.statusCode).toBe(400);
    expect(result.error.error.code).toBe('MISSING_INVOICE_ID');
    expect(result.error.error.message).toBe('Invoice ID is required.');
  });

  it('should return MISSING_INVOICE_ID error when invoice ID is empty string', async () => {
    const req = { headers: { 'x-tenant-id': 'tenant-a' } };
    const result = await resolveInvoiceStateContext(req, '');

    expect(result.error).toBeDefined();
    expect(result.error.error.code).toBe('MISSING_INVOICE_ID');
  });

  it('should return MISSING_INVOICE_ID error when invoice ID is whitespace', async () => {
    const req = { headers: { 'x-tenant-id': 'tenant-a' } };
    const result = await resolveInvoiceStateContext(req, '   ');

    expect(result.error).toBeDefined();
    expect(result.error.error.code).toBe('MISSING_INVOICE_ID');
  });

  it('should return INVOICE_NOT_FOUND error when invoice does not exist', async () => {
    jest.spyOn(invoiceService, 'getInvoiceById').mockResolvedValue(null);

    const req = { headers: { 'x-tenant-id': 'tenant-a' } };
    const result = await resolveInvoiceStateContext(req, 'inv-999');

    expect(result.error).toBeDefined();
    expect(result.error.statusCode).toBe(404);
    expect(result.error.error.code).toBe('INVOICE_NOT_FOUND');
    expect(result.error.error.message).toBe('Invoice not found.');

    expect(invoiceService.getInvoiceById).toHaveBeenCalledWith('inv-999', 'tenant-a');
  });

  it('should return success with context when invoice is found', async () => {
    const mockInvoice = { invoice_id: 'inv-001', status: 'pending', amount: 1000 };
    jest.spyOn(invoiceService, 'getInvoiceById').mockResolvedValue(mockInvoice);

    const req = { headers: { 'x-tenant-id': 'tenant-alpha' } };
    const result = await resolveInvoiceStateContext(req, 'inv-001');

    expect(result.error).toBeUndefined();
    expect(result.invoiceId).toBe('inv-001');
    expect(result.tenantId).toBe('tenant-alpha');
    expect(result.invoice).toBe(mockInvoice);
  });

  it('should use x-tenant header when x-tenant-id is absent', async () => {
    const mockInvoice = { invoice_id: 'inv-002', status: 'approved' };
    jest.spyOn(invoiceService, 'getInvoiceById').mockResolvedValue(mockInvoice);

    const req = { headers: { 'x-tenant': 'tenant-beta' } };
    const result = await resolveInvoiceStateContext(req, 'inv-002');

    expect(result.error).toBeUndefined();
    expect(result.tenantId).toBe('tenant-beta');
    expect(invoiceService.getInvoiceById).toHaveBeenCalledWith('inv-002', 'tenant-beta');
  });

  it('should normalise invoice ID before lookup', async () => {
    const mockInvoice = { invoice_id: 'inv-003', status: 'pending' };
    jest.spyOn(invoiceService, 'getInvoiceById').mockResolvedValue(mockInvoice);

    const req = { headers: { 'x-tenant-id': 'tenant-c' } };
    const result = await resolveInvoiceStateContext(req, '  inv-003  ');

    expect(result.error).toBeUndefined();
    expect(result.invoiceId).toBe('inv-003');
    expect(invoiceService.getInvoiceById).toHaveBeenCalledWith('inv-003', 'tenant-c');
  });

  it('should pass through invoiceService errors', async () => {
    const dbError = new Error('Database connection failed');
    jest.spyOn(invoiceService, 'getInvoiceById').mockRejectedValue(dbError);

    const req = { headers: { 'x-tenant-id': 'tenant-a' } };

    await expect(resolveInvoiceStateContext(req, 'inv-001')).rejects.toThrow('Database connection failed');
  });
});
