const InMemoryInvoiceRepository = require('../../../src/repositories/in-memory-invoice.repository');
const InvoiceRepository = require('../../../src/repositories/invoice.repository');

describe('InvoiceRepository Interface', () => {
  const repo = new InvoiceRepository();

  test('findAll should throw error if not implemented', async () => {
    await expect(repo.findAll()).rejects.toThrow('Method not implemented');
  });

  test('findById should throw error if not implemented', async () => {
    await expect(repo.findById('1')).rejects.toThrow('Method not implemented1');
  });

  test('create should throw error if not implemented', async () => {
    await expect(repo.create({})).rejects.toThrow('Method not implemented{}');
  });

  test('update should throw error if not implemented', async () => {
    await expect(repo.update('1', {})).rejects.toThrow('Method not implemented1{}');
  });

  test('delete should throw error if not implemented', async () => {
    await expect(repo.delete('1')).rejects.toThrow('Method not implemented1');
  });
});

describe('InMemoryInvoiceRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
  });

  test('should start empty', async () => {
    const invoices = await repo.findAll();
    expect(invoices).toEqual([]);
  });

  test('should create a new invoice', async () => {
    const data = { amount: 100, currency: 'USDC', description: 'Test' };
    const invoice = await repo.create(data);

    expect(invoice).toMatchObject(data);
    expect(invoice.id).toBeDefined();
    expect(invoice.createdAt).toBeDefined();
    expect(invoice.updatedAt).toBeDefined();
    expect(invoice.status).toBe('pending_verification');
  });

  test('should find an invoice by ID', async () => {
    const created = await repo.create({ amount: 100 });
    const found = await repo.findById(created.id);

    expect(found).toEqual(created);
  });

  test('should return null for non-existent ID', async () => {
    const found = await repo.findById('non-existent');
    expect(found).toBeNull();
  });

  test('should find all invoices', async () => {
    await repo.create({ amount: 100 });
    await repo.create({ amount: 200 });

    const invoices = await repo.findAll();
    expect(invoices.length).toBe(2);
  });

  test('should update an invoice', async () => {
    const created = await repo.create({ amount: 100, status: 'pending' });
    const updated = await repo.update(created.id, { status: 'paid' });

    expect(updated.status).toBe('paid');
    expect(updated.amount).toBe(100);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  test('should return null when updating non-existent invoice', async () => {
    const updated = await repo.update('non-existent', { status: 'paid' });
    expect(updated).toBeNull();
  });

  test('should delete an invoice', async () => {
    const created = await repo.create({ amount: 100 });
    const deleted = await repo.delete(created.id);
    
    expect(deleted).toBe(true);
    const found = await repo.findById(created.id);
    expect(found).toBeNull();
  });

  test('should return false when deleting non-existent invoice', async () => {
    const deleted = await repo.delete('non-existent');
    expect(deleted).toBe(false);
  });

  test('should soft delete an invoice', async () => {
    const created = await repo.create({ amount: 100 });
    const softDeleted = await repo.softDelete(created.id);

    expect(softDeleted.deletedAt).not.toBeNull();
    
    const foundNormal = await repo.findAll();
    expect(foundNormal.find(inv => inv.id === created.id)).toBeUndefined();

    const foundAll = await repo.findAll({ includeDeleted: true });
    expect(foundAll.find(inv => inv.id === created.id)).toBeDefined();
  });

  test('should restore a soft-deleted invoice', async () => {
    const created = await repo.create({ amount: 100 });
    await repo.softDelete(created.id);
    
    const restored = await repo.restore(created.id);
    expect(restored.deletedAt).toBeNull();

    const foundNormal = await repo.findAll();
    expect(foundNormal.find(inv => inv.id === created.id)).toBeDefined();
  });

  test('should return null when soft deleting non-existent invoice', async () => {
    const result = await repo.softDelete('non-existent');
    expect(result).toBeNull();
  });

  test('should return null when restoring non-existent invoice', async () => {
    const result = await repo.restore('non-existent');
    expect(result).toBeNull();
  });

  test('should clear all invoices', async () => {
    await repo.create({ amount: 100 });
    await repo.clear();
    const invoices = await repo.findAll();
    expect(invoices).toEqual([]);
  });
});
