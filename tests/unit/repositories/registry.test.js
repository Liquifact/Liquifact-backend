const {
  createInvoiceRepository,
  createEscrowRepository,
  RepositoryRegistry,
} = require('../../../src/repositories');
const InMemoryInvoiceRepository = require('../../../src/repositories/in-memory-invoice.repository');
const InMemoryEscrowRepository = require('../../../src/repositories/in-memory-escrow.repository');
const SorobanEscrowRepository = require('../../../src/repositories/soroban-escrow.repository');

describe('Repository Registry & Factories', () => {
  describe('createInvoiceRepository', () => {
    test('should create InMemoryInvoiceRepository by default', () => {
      const repo = createInvoiceRepository();
      expect(repo).toBeInstanceOf(InMemoryInvoiceRepository);
    });

    test('should create InMemoryInvoiceRepository when memory is specified', () => {
      const repo = createInvoiceRepository('memory');
      expect(repo).toBeInstanceOf(InMemoryInvoiceRepository);
    });
  });

  describe('createEscrowRepository', () => {
    test('should create SorobanEscrowRepository by default', () => {
      const repo = createEscrowRepository();
      expect(repo).toBeInstanceOf(SorobanEscrowRepository);
    });

    test('should create InMemoryEscrowRepository when memory is specified', () => {
      const repo = createEscrowRepository('memory');
      expect(repo).toBeInstanceOf(InMemoryEscrowRepository);
    });

    test('should create SorobanEscrowRepository when soroban is specified', () => {
      const repo = createEscrowRepository('soroban');
      expect(repo).toBeInstanceOf(SorobanEscrowRepository);
    });
  });

  describe('RepositoryRegistry', () => {
    test('should initialize default repositories', () => {
      const registry = new RepositoryRegistry();
      expect(registry.invoiceRepo).toBeInstanceOf(InMemoryInvoiceRepository);
      expect(registry.escrowRepo).toBeInstanceOf(SorobanEscrowRepository);
    });

    test('should allow overriding providers via options', () => {
      const registry = new RepositoryRegistry({
        invoiceProvider: 'memory',
        escrowProvider: 'memory'
      });
      expect(registry.invoiceRepo).toBeInstanceOf(InMemoryInvoiceRepository);
      expect(registry.escrowRepo).toBeInstanceOf(InMemoryEscrowRepository);
    });

    test('should allow direct injection of repositories', () => {
      const mockInvoiceRepo = { type: 'mock-invoice' };
      const mockEscrowRepo = { type: 'mock-escrow' };
      
      const registry = new RepositoryRegistry({
        invoiceRepo: mockInvoiceRepo,
        escrowRepo: mockEscrowRepo
      });
      
      expect(registry.invoiceRepo).toBe(mockInvoiceRepo);
      expect(registry.escrowRepo).toBe(mockEscrowRepo);
    });
  });

  describe('Environment Variable Configuration', () => {
    const originalInvoiceRepo = process.env.INVOICE_REPO;
    const originalEscrowRepo = process.env.ESCROW_REPO;

    afterEach(() => {
      process.env.INVOICE_REPO = originalInvoiceRepo;
      process.env.ESCROW_REPO = originalEscrowRepo;
    });

    test('should use environment variables for provider selection', () => {
      process.env.INVOICE_REPO = 'memory';
      process.env.ESCROW_REPO = 'memory';

      const registry = new RepositoryRegistry();
      expect(registry.invoiceRepo).toBeInstanceOf(InMemoryInvoiceRepository);
      expect(registry.escrowRepo).toBeInstanceOf(InMemoryEscrowRepository);
    });
  });
});
