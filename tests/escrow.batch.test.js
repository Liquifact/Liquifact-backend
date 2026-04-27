'use strict';

const { batchReadEscrowStates } = require('../src/services/escrowBatchRead');
const { readEscrowState } = require('../src/services/escrowRead');

// Mock the readEscrowState function
jest.mock('../src/services/escrowRead', () => ({
  readEscrowState: jest.fn(),
  validateInvoiceId: jest.requireActual('../src/services/escrowRead').validateInvoiceId,
}));

describe('escrowBatchRead Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should read multiple escrow states successfully', async () => {
    const invoiceIds = ['inv_1', 'inv_2', 'inv_3'];
    readEscrowState.mockImplementation(id => Promise.resolve({
      invoiceId: id,
      status: 'active',
      fundedAmount: 1000,
      legal_hold: false,
    }));

    const result = await batchReadEscrowStates(invoiceIds);

    expect(result.results).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(readEscrowState).toHaveBeenCalledTimes(3);
    expect(result.results[0].invoiceId).toBe('inv_1');
  });

  it('should isolate failures: one failing call should not stop the batch', async () => {
    const invoiceIds = ['inv_success', 'inv_fail', 'inv_success2'];
    
    readEscrowState.mockImplementation(id => {
      if (id === 'inv_fail') {
        return Promise.reject(new Error('RPC Failure'));
      }
      return Promise.resolve({
        invoiceId: id,
        status: 'active',
        fundedAmount: 1000,
        legal_hold: false,
      });
    });

    const result = await batchReadEscrowStates(invoiceIds);

    expect(result.results).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      invoiceId: 'inv_fail',
      error: 'RPC Failure',
      code: 'INTERNAL_ERROR',
    });
    expect(readEscrowState).toHaveBeenCalledTimes(3);
  });

  it('should enforce timeouts for individual calls', async () => {
    const invoiceIds = ['inv_slow'];
    
    // Mock a slow response
    readEscrowState.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ status: 'ok' }), 100);
    }));

    const result = await batchReadEscrowStates(invoiceIds, { timeout: 50 });

    expect(result.results).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('timed out');
    expect(result.errors[0].code).toBe('ETIMEDOUT');
  });

  it('should respect concurrency limits', async () => {
    const invoiceIds = ['inv_1', 'inv_2', 'inv_3', 'inv_4', 'inv_5'];
    let activeCalls = 0;
    let maxConcurrent = 0;

    readEscrowState.mockImplementation(() => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      return new Promise(resolve => {
        setTimeout(() => {
          activeCalls--;
          resolve({ status: 'ok' });
        }, 20);
      });
    });

    const concurrency = 2;
    await batchReadEscrowStates(invoiceIds, { concurrency });

    // With concurrency 2, we shouldn't have more than 2 active calls at a time
    expect(maxConcurrent).toBeLessThanOrEqual(concurrency);
    expect(readEscrowState).toHaveBeenCalledTimes(5);
  });
});
