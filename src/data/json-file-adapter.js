'use strict';

/**
 * JSON File Storage Adapter.
 *
 * Persists invoices and contributions to a local JSON file with:
 *  - BigInt-safe string serialization for minor unit fields
 *  - Atomic write via temporary file rename (POSIX atomic replacement)
 *  - Debounced writes to prevent I/O thrashing under burst workloads
 *  - Automatic index reconstruction on load
 */

const fs = require('fs');
const path = require('path');
const {
  MemoryAdapter,
  withDerivedOnChain,
  withMoney,
} = require('./memory-adapter');

class JsonFileAdapter extends MemoryAdapter {
  /**
   * @param {object} options
   * @param {string} options.filePath Absolute or relative path to the JSON backing file.
   * @param {number} [options.debounceMs=25] Debounce interval in ms for writes.
   */
  constructor(options = {}) {
    if (!options.filePath) {
      throw new Error('JsonFileAdapter requires a filePath option');
    }
    const resolvedPath = path.resolve(options.filePath);
    super({ ...options, filePath: resolvedPath });
    this.filePath = resolvedPath;
    this.debounceMs = options.debounceMs ?? 25;
    this.saveTimer = null;

    // Load from file if present, or initialize with seed
    this.load();
  }

  init() {
    // No-op during super constructor; load() handles initialization
  }

  /**
   * Reads data from file or seeds initial state.
   */
  load() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (!fs.existsSync(this.filePath)) {
      super.reset();
      this.saveImmediate();
      return;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(content);

      this.contributions = (parsed.contributions || []).map((c) => ({
        ...c,
        amountMinor: BigInt(c.amountMinor),
      }));

      this.invoices = (parsed.invoices || []).map((inv) => {
        const record = {
          ...inv,
          amountMinor: BigInt(inv.amountMinor),
          fundedAmountMinor: BigInt(inv.fundedAmountMinor || 0),
        };
        withMoney(record);
        withDerivedOnChain(record);
        return record;
      });

      this.rebuildIndexes();
    } catch (err) {
      // If reading/parsing fails, initialize with clean seeds
      super.reset();
      this.saveImmediate();
    }
  }

  /**
   * Schedules a debounced atomic write to disk.
   */
  persist() {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveImmediate();
    }, this.debounceMs);

    if (typeof this.saveTimer.unref === 'function') {
      this.saveTimer.unref();
    }
  }

  /**
   * Performs an immediate atomic file write.
   */
  saveImmediate() {
    if (!this.filePath) {
      return;
    }
    const serializedInvoices = this.invoices.map((inv) => ({
      id: inv.id,
      sme: inv.sme,
      smeAddress: inv.smeAddress,
      debtor: inv.debtor,
      currency: inv.currency,
      yieldBps: inv.yieldBps,
      dueDate: inv.dueDate,
      status: inv.status,
      escrowContractId: inv.escrowContractId,
      createdAt: inv.createdAt,
      invoiceNumber: inv.invoiceNumber,
      duplicateOverride: inv.duplicateOverride,
      amountMinor: inv.amountMinor.toString(),
      fundedAmountMinor: inv.fundedAmountMinor.toString(),
    }));

    const serializedContributions = this.contributions.map((c) => ({
      id: c.id,
      invoiceId: c.invoiceId,
      investor: c.investor,
      createdAt: c.createdAt,
      amountMinor: c.amountMinor.toString(),
    }));

    const data = JSON.stringify(
      {
        invoices: serializedInvoices,
        contributions: serializedContributions,
      },
      null,
      2,
    );

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tempPath, data, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  /**
   * Flushes any pending debounced writes immediately.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveImmediate();
    return Promise.resolve();
  }

  /**
   * Resets data to seed and syncs to disk.
   */
  reset() {
    super.reset();
    this.saveImmediate();
  }
}

module.exports = { JsonFileAdapter };
