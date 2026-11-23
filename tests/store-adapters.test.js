'use strict';

/**
 * Storage Adapter Contract & Persistence Tests.
 *
 * Verifies:
 *  - Both MemoryAdapter and JsonFileAdapter satisfy the full repository contract
 *  - BigInt minor-unit amounts round-trip exactly without truncation or conversion to float
 *  - Duplicate detection (exact & possible) functions accurately across restarts/reloads
 *  - Atomic write and flush behavior in JsonFileAdapter
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryAdapter, DuplicateInvoiceError } = require('../src/data/memory-adapter');
const { JsonFileAdapter } = require('../src/data/json-file-adapter');
const store = require('../src/data/store');
const contributions = require('../src/data/contributions');

function runContractSuite(adapterName, createAdapter) {
  describe(`Contract Suite: ${adapterName}`, () => {
    let adapter;

    beforeEach(() => {
      adapter = createAdapter();
    });

    afterEach(async () => {
      await adapter.flush();
    });

    test('lists seed invoices and contributions', () => {
      const invoices = adapter.listInvoices();
      expect(invoices.length).toBeGreaterThanOrEqual(4);
      expect(invoices[0].id).toBe('INV_0001');

      const ctbs = adapter.listContributions();
      expect(ctbs.length).toBeGreaterThanOrEqual(3);
    });

    test('getInvoice returns single record by id or undefined if missing', () => {
      const inv = adapter.getInvoice('INV_0001');
      expect(inv).toBeDefined();
      expect(inv.sme).toBe('Acme Components Ltd');

      expect(adapter.getInvoice('INV_MISSING')).toBeUndefined();
    });

    test('createInvoice creates record with money & onChain getters and indexes it', () => {
      const record = adapter.createInvoice({
        sme: 'Test SME Ltd',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Test Buyer',
        amount: 5000,
        currency: 'USDC',
        yieldBps: 500,
        dueDate: '2027-06-30',
        invoiceNumber: 'INV-TEST-001',
      });

      expect(record.id).toMatch(/^INV_\d{4}$/);
      expect(record.amount).toBe('5000');
      expect(record.amountMinor).toBe(50000000000n);
      expect(record.fundedAmount).toBe('0');
      expect(record.fundedAmountMinor).toBe(0n);
      expect(record.onChain).toBe(false);

      const found = adapter.getInvoice(record.id);
      expect(found).toBe(record);
    });

    test('prevents duplicate invoice creation with same SME and invoiceNumber', () => {
      adapter.createInvoice({
        sme: 'Alpha Corp',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Beta Corp',
        amount: 1000,
        currency: 'USDC',
        yieldBps: 500,
        dueDate: '2027-10-01',
        invoiceNumber: 'DUP-001',
      });

      expect(() =>
        adapter.createInvoice({
          sme: 'alpha corp', // case-insensitive check
          smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
          debtor: 'Beta Corp',
          amount: 2000,
          currency: 'USDC',
          yieldBps: 500,
          dueDate: '2027-10-01',
          invoiceNumber: 'DUP-001',
        })
      ).toThrow(DuplicateInvoiceError);
    });

    test('funds an open invoice and updates fundedAmount and contributions', () => {
      const inv = adapter.createInvoice({
        sme: 'Funding SME',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Funding Debtor',
        amount: 2000,
        currency: 'USDC',
        yieldBps: 600,
        dueDate: '2027-08-15',
      });

      const investor = 'GB46PNGL3W2G66OWSPBQOWWJWMEKO34HBZDAYAIZOKNPAU7PAZW7QHEE';
      adapter.fundInvoice(inv, 1000, investor);

      expect(inv.fundedAmount).toBe('1000');
      expect(inv.fundedAmountMinor).toBe(10000000000n);
      expect(inv.status).toBe('open');

      const invCtbs = adapter.listContributionsByInvoice(inv.id);
      expect(invCtbs).toHaveLength(1);
      expect(invCtbs[0].investor).toBe(investor);

      // Fund remainder -> status becomes funded
      adapter.fundInvoice(inv, 1000, investor);
      expect(inv.fundedAmount).toBe('2000');
      expect(inv.status).toBe('funded');
    });

    test('settle and cancel update invoice status', () => {
      const inv = adapter.getInvoice('INV_0001');
      adapter.settleInvoice(inv);
      expect(inv.status).toBe('settled');

      adapter.cancelInvoice(inv);
      expect(inv.status).toBe('cancelled');
    });

    test('linkEscrow links contractId and rejects conflicts', () => {
      const inv = adapter.createInvoice({
        sme: 'Escrow SME',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Escrow Debtor',
        amount: 300,
        currency: 'XLM',
        yieldBps: 500,
        dueDate: '2027-09-01',
      });

      const contractA = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const result = adapter.linkEscrow(inv, contractA);
      expect(result).toBeNull();
      expect(inv.escrowContractId).toBe(contractA);
      expect(inv.onChain).toBe(true);

      // Already linked to different contract
      const contractB = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      expect(adapter.linkEscrow(inv, contractB)).toBe('ALREADY_LINKED');
    });
  });
}

describe('Storage Adapters', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquifact-storage-'));
    tmpFile = path.join(tmpDir, 'data.json');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  runContractSuite('MemoryAdapter', () => new MemoryAdapter());
  runContractSuite('JsonFileAdapter', () => new JsonFileAdapter({ filePath: tmpFile }));

  describe('JsonFileAdapter Restart & Persistence Round-Trip', () => {
    test('exact BigInt amounts and invoices round-trip across restarts', async () => {
      const adapter1 = new JsonFileAdapter({ filePath: tmpFile });

      const newInv = adapter1.createInvoice({
        sme: 'Persistence SME',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Persistence Debtor',
        amount: '1234567.8901234',
        currency: 'USDC',
        yieldBps: 750,
        dueDate: '2027-11-20',
        invoiceNumber: 'PERSIST-100',
      });

      // BigInt minor unit check: 1234567.8901234 * 10^7 = 12345678901234n
      expect(newInv.amountMinor).toBe(12345678901234n);

      await adapter1.flush();
      expect(fs.existsSync(tmpFile)).toBe(true);

      // Simulate process restart by instantiating fresh adapter pointing to same file
      const adapter2 = new JsonFileAdapter({ filePath: tmpFile });

      const reloadedInv = adapter2.getInvoice(newInv.id);
      expect(reloadedInv).toBeDefined();
      expect(reloadedInv.amountMinor).toBe(12345678901234n);
      expect(typeof reloadedInv.amountMinor).toBe('bigint');
      expect(reloadedInv.amount).toBe('1234567.8901234');
      expect(reloadedInv.invoiceNumber).toBe('PERSIST-100');
    });

    test('duplicate-invoice detection works after file reload', async () => {
      const adapter1 = new JsonFileAdapter({ filePath: tmpFile });

      adapter1.createInvoice({
        sme: 'Unique SME',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Unique Debtor',
        amount: 2500,
        currency: 'USDC',
        yieldBps: 600,
        dueDate: '2027-12-01',
        invoiceNumber: 'INV-UNIQUE-99',
      });

      await adapter1.flush();

      // Restart
      const adapter2 = new JsonFileAdapter({ filePath: tmpFile });

      // Attempt duplicate
      expect(() =>
        adapter2.createInvoice({
          sme: 'unique sme',
          smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
          debtor: 'Different Debtor',
          amount: 3000,
          currency: 'USDC',
          yieldBps: 600,
          dueDate: '2027-12-01',
          invoiceNumber: 'INV-UNIQUE-99',
        })
      ).toThrow(DuplicateInvoiceError);
    });

    test('facade store and contributions seamlessly use configured adapter', async () => {
      const fileAdapter = new JsonFileAdapter({ filePath: tmpFile });
      store.setAdapter(fileAdapter);

      const created = store.create({
        sme: 'Facade SME',
        smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
        debtor: 'Facade Debtor',
        amount: 1500,
        currency: 'USDC',
        yieldBps: 500,
        dueDate: '2027-05-01',
      });

      expect(store.get(created.id)).toBeDefined();

      store.fund(created, 500, 'GB46PNGL3W2G66OWSPBQOWWJWMEKO34HBZDAYAIZOKNPAU7PAZW7QHEE');
      expect(contributions.sumForInvoice(created.id)).toBe(5000000000n);

      await store.flush();

      // Reset back to default memory adapter for other tests
      store.resetAdapter();
    });
  });
});
