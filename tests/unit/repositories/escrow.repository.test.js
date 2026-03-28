const EscrowRepository = require('../../../src/repositories/escrow.repository');
const SorobanEscrowRepository = require('../../../src/repositories/soroban-escrow.repository');

const { callSorobanContract } = require('../../../src/services/soroban');
jest.mock('../../../src/services/soroban', () => ({
  callSorobanContract: jest.fn((fn) => fn())
}));

describe('EscrowRepository Interface', () => {
  const repo = new EscrowRepository();

  test('getEscrowState should throw error if not implemented', async () => {
    await expect(repo.getEscrowState('1')).rejects.toThrow('Method not implemented1');
  });
});

describe('SorobanEscrowRepository', () => {
  let repo;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new SorobanEscrowRepository();
  });

  test('should fetch escrow state from Soroban', async () => {
    const invoiceId = 'test-id';
    const state = await repo.getEscrowState(invoiceId);

    expect(state.invoiceId).toBe(invoiceId);
    expect(state.status).toBe('not_found');
    expect(state.fundedAmount).toBe(0);
    expect(state.lastUpdated).toBeDefined();
    expect(callSorobanContract).toHaveBeenCalled();
  });

  test('should handle repository fetch failures', async () => {
    callSorobanContract.mockImplementationOnce(() => { 
      throw new Error('Network error'); 
    });
    
    await expect(repo.getEscrowState('1')).rejects.toThrow('Escrow fetch failed: Network error');
  });
});

const InMemoryEscrowRepository = require('../../../src/repositories/in-memory-escrow.repository');

describe('InMemoryEscrowRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new InMemoryEscrowRepository();
  });

  test('should return default state for non-existent escrow', async () => {
    const invoiceId = 'test-id';
    const state = await repo.getEscrowState(invoiceId);

    expect(state.invoiceId).toBe(invoiceId);
    expect(state.status).toBe('not_found');
    expect(state.fundedAmount).toBe(0);
    expect(state.lastUpdated).toBeDefined();
  });

  test('should store and retrieve escrow state', async () => {
    const invoiceId = 'test-id';
    const stateData = { status: 'funded', fundedAmount: 500 };
    await repo.setEscrowState(invoiceId, stateData);

    const state = await repo.getEscrowState(invoiceId);
    expect(state.invoiceId).toBe(invoiceId);
    expect(state.status).toBe('funded');
    expect(state.fundedAmount).toBe(500);
    expect(state.lastUpdated).toBeDefined();
  });

  test('should clear all escrows', async () => {
    const invoiceId = 'test-id';
    await repo.setEscrowState(invoiceId, { status: 'funded' });
    await repo.clear();

    const state = await repo.getEscrowState(invoiceId);
    expect(state.status).toBe('not_found');
  });
});
