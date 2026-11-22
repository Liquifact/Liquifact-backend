'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  GENESIS_HASH,
  computeHash,
  createAuditLog,
  createFileStore,
  createMemoryStore,
  createConfiguredStore,
  AuditIntegrityError,
} = require('../src/audit/audit-log');
const { loadConfig, ConfigError } = require('../src/config');

const event = (n, extra = {}) => ({
  action: 'invoice.fund',
  resourceType: 'invoice',
  resourceId: `INV_${String(n).padStart(4, '0')}`,
  actor: 'investor-1',
  ip: '203.0.113.9',
  outcome: 'success',
  statusCode: 200,
  before: { fundedAmount: n, status: 'open' },
  after: { fundedAmount: n + 1, status: 'open' },
  ...extra,
});

describe('audit file store (createFileStore)', () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquifact-audit-test-'));
    logFile = path.join(tmpDir, 'audit.ndjson');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('restart continuity of seq and prevHash', () => {
    test('entries survive reconstructing the log from the same file and continue seq/prevHash', () => {
      const firstStore = createFileStore({ path: logFile });
      const firstLog = createAuditLog({ store: firstStore });

      const e1 = firstLog.append(event(1));
      const e2 = firstLog.append(event(2));
      const e3 = firstLog.append(event(3));

      expect(e1.seq).toBe(1);
      expect(e1.prevHash).toBe(GENESIS_HASH);
      expect(e2.seq).toBe(2);
      expect(e2.prevHash).toBe(e1.hash);
      expect(e3.seq).toBe(3);
      expect(e3.prevHash).toBe(e2.hash);

      // Simulate process restart by constructing a new store + log pointing at the same file
      const secondStore = createFileStore({ path: logFile });
      const secondLog = createAuditLog({ store: secondStore });

      expect(secondLog.entries()).toHaveLength(3);
      expect(secondLog.entries().map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(secondLog.verify()).toEqual({ valid: true, entries: 3 });

      const e4 = secondLog.append(event(4));
      expect(e4.seq).toBe(4);
      expect(e4.prevHash).toBe(e3.hash);

      // Third restart verifies all 4 entries
      const thirdLog = createAuditLog({ store: createFileStore({ path: logFile }) });
      expect(thirdLog.entries().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(thirdLog.verify()).toEqual({ valid: true, entries: 4 });
    });

    test('fsyncs on every append and deepFreezes entries on read', () => {
      const spyFsync = jest.spyOn(fs, 'fsyncSync');
      try {
        const store = createFileStore({ path: logFile });
        const log = createAuditLog({ store });
        log.append(event(1));
        log.append(event(2));
        expect(spyFsync).toHaveBeenCalledTimes(2);

        const [readEntry] = log.entries();
        expect(Object.isFrozen(readEntry)).toBe(true);
        expect(Object.isFrozen(readEntry.before)).toBe(true);
        expect(Object.isFrozen(readEntry.after)).toBe(true);
        expect(() => {
          readEntry.after.fundedAmount = 999;
        }).toThrow(TypeError);
      } finally {
        spyFsync.mockRestore();
      }
    });

    test('honours maxEntries cap in memory while preserving seq/prevHash continuity across restarts', () => {
      const store1 = createFileStore({ path: logFile, maxEntries: 2 });
      const log1 = createAuditLog({ store: store1 });
      log1.append(event(1));
      log1.append(event(2));
      const e3 = log1.append(event(3));

      expect(log1.entries().map((e) => e.seq)).toEqual([2, 3]);
      expect(log1.verify()).toEqual({ valid: true, entries: 2 });

      const store2 = createFileStore({ path: logFile, maxEntries: 2 });
      const log2 = createAuditLog({ store: store2 });
      expect(log2.entries().map((e) => e.seq)).toEqual([2, 3]);
      const e4 = log2.append(event(4));
      expect(e4.seq).toBe(4);
      expect(e4.prevHash).toBe(e3.hash);
      expect(log2.verify()).toEqual({ valid: true, entries: 2 });
    });
  });

  describe('tamper detection', () => {
    test('editing a stored line makes verify() fail on the live log and refuses to start on reboot', () => {
      const store = createFileStore({ path: logFile });
      const log = createAuditLog({ store });
      log.append(event(10));
      log.append(event(20));
      log.append(event(30));

      // Tamper with line 2 on disk
      const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
      const tampered = JSON.parse(lines[1]);
      tampered.after.fundedAmount = 999999;
      lines[1] = JSON.stringify(tampered);
      fs.writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');

      // Live verify() detects the edit at seq 2
      expect(log.verify()).toEqual({ valid: false, brokenAt: 2 });

      // Booting a new store refuses to start by throwing AuditIntegrityError
      expect(() => createFileStore({ path: logFile })).toThrow(AuditIntegrityError);
      try {
        createFileStore({ path: logFile });
      } catch (err) {
        expect(err.brokenAt).toBe(2);
      }

      // Or flags verify() as broken when onCorrupt: 'flag' is configured
      const flaggedLog = createAuditLog({
        store: createFileStore({ path: logFile, onCorrupt: 'flag' }),
      });
      expect(flaggedLog.verify()).toEqual({ valid: false, brokenAt: 2 });
      expect(() => flaggedLog.append(event(40))).toThrow(AuditIntegrityError);
    });

    test('deleting or reordering a line breaks the hash chain at the affected sequence', () => {
      const log = createAuditLog({ store: createFileStore({ path: logFile }) });
      log.append(event(1));
      log.append(event(2));
      log.append(event(3));

      const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
      // Remove middle line (seq 2)
      fs.writeFileSync(logFile, `${[lines[0], lines[2]].join('\n')}\n`, 'utf8');

      expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
      expect(() => createFileStore({ path: logFile })).toThrow(AuditIntegrityError);
    });

    test('recomputing a tampered entry hash still fails verification at the next entry', () => {
      const log = createAuditLog({ store: createFileStore({ path: logFile }) });
      log.append(event(1));
      log.append(event(2));
      log.append(event(3));

      const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
      const tampered = JSON.parse(lines[1]);
      tampered.actor = 'attacker';
      const { hash, ...rest } = tampered;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      tampered.hash = computeHash(rest);
      lines[1] = JSON.stringify(tampered);
      fs.writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');

      expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
      expect(() => createFileStore({ path: logFile })).toThrow(AuditIntegrityError);
    });
  });

  describe('truncated final line and malformed NDJSON', () => {
    test('detects a truncated final line (partial JSON without trailing newline) on boot and verify', () => {
      const log = createAuditLog({ store: createFileStore({ path: logFile }) });
      log.append(event(1));
      log.append(event(2));

      // Simulate a crash mid-write on entry 3 (truncated JSON, no trailing newline)
      fs.appendFileSync(logFile, '{"seq":3,"at":"2026-11-22T00:00:00.000Z","action":"invoice.fund"', 'utf8');

      expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });

      expect(() => createFileStore({ path: logFile })).toThrow(AuditIntegrityError);
      try {
        createFileStore({ path: logFile });
      } catch (err) {
        expect(err.brokenAt).toBe(3);
        expect(err.reason).toBe('truncated_line');
      }

      const flaggedLog = createAuditLog({
        store: createFileStore({ path: logFile, onCorrupt: 'flag' }),
      });
      expect(flaggedLog.verify()).toEqual({ valid: false, brokenAt: 3 });
    });

    test('detects a final line missing its trailing newline even if the JSON braces balanced', () => {
      const log = createAuditLog({ store: createFileStore({ path: logFile }) });
      log.append(event(1));
      log.append(event(2));

      // Strip the final newline from the file
      const raw = fs.readFileSync(logFile, 'utf8');
      fs.writeFileSync(logFile, raw.slice(0, -1), 'utf8');

      expect(log.verify()).toEqual({ valid: false, brokenAt: 2 });
      expect(() => createFileStore({ path: logFile })).toThrow(AuditIntegrityError);
    });
  });

  describe('rotation linkage across segments', () => {
    test('rotates when exceeding rotateBytes and links new segment first entry to previous segment last hash', () => {
      // Each entry line is ~350-420 bytes; rotateBytes: 500 forces rotation after every 1-2 entries
      const store = createFileStore({ path: logFile, rotateBytes: 500 });
      const log = createAuditLog({ store });

      const written = [];
      for (let i = 1; i <= 5; i += 1) {
        written.push(log.append(event(i)));
      }

      const segments = store.segments();
      expect(segments.length).toBeGreaterThan(1);
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);

      // Verify linkage at every segment boundary
      let previousLast = null;
      for (const segPath of segments) {
        const segLines = fs
          .readFileSync(segPath, 'utf8')
          .trimEnd()
          .split('\n')
          .map((l) => JSON.parse(l));
        expect(segLines.length).toBeGreaterThan(0);
        if (previousLast) {
          expect(segLines[0].seq).toBe(previousLast.seq + 1);
          expect(segLines[0].prevHash).toBe(previousLast.hash);
        } else {
          expect(segLines[0].seq).toBe(1);
          expect(segLines[0].prevHash).toBe(GENESIS_HASH);
        }
        previousLast = segLines[segLines.length - 1];
      }

      expect(log.verify()).toEqual({ valid: true, entries: 5 });

      // Restarting replays all rotated segments + active file in order and continues the chain
      const reopenedStore = createFileStore({ path: logFile, rotateBytes: 500 });
      const reopenedLog = createAuditLog({ store: reopenedStore });
      expect(reopenedLog.entries().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(reopenedLog.verify()).toEqual({ valid: true, entries: 5 });

      const e6 = reopenedLog.append(event(6));
      expect(e6.seq).toBe(6);
      expect(e6.prevHash).toBe(written[4].hash);
      expect(reopenedLog.verify()).toEqual({ valid: true, entries: 6 });
    });

    test('tampering with an earlier rotated segment fails verification across segments', () => {
      const store = createFileStore({ path: logFile, rotateBytes: 450 });
      const log = createAuditLog({ store });
      for (let i = 1; i <= 4; i += 1) {
        log.append(event(i));
      }

      const firstSegment = `${logFile}.1`;
      expect(fs.existsSync(firstSegment)).toBe(true);

      const segLines = fs.readFileSync(firstSegment, 'utf8').trimEnd().split('\n');
      const firstEntry = JSON.parse(segLines[0]);
      firstEntry.after.fundedAmount = 424242;
      segLines[0] = JSON.stringify(firstEntry);
      fs.writeFileSync(firstSegment, `${segLines.join('\n')}\n`, 'utf8');

      expect(log.verify()).toEqual({ valid: false, brokenAt: 1 });
      expect(() => createFileStore({ path: logFile, rotateBytes: 450 })).toThrow(AuditIntegrityError);
    });
  });

  describe('configuration and default store selection', () => {
    test('default store remains in-memory when AUDIT_LOG_FILE is unset', () => {
      const cfg = loadConfig({});
      expect(cfg.auditLogFile).toBeNull();
      expect(cfg.auditRotateBytes).toBe(0);
      expect(cfg.auditMaxEntries).toBe(10000);

      const defaultStore = createConfiguredStore(cfg);
      expect(defaultStore.path).toBeUndefined();

      const memStore = createMemoryStore();
      expect(typeof defaultStore.append).toBe(typeof memStore.append);
    });

    test('selects file store when AUDIT_LOG_FILE is configured and validates env vars', () => {
      const cfg = loadConfig({
        AUDIT_LOG_FILE: logFile,
        AUDIT_MAX_ENTRIES: '250',
        AUDIT_ROTATE_BYTES: '4096',
      });
      expect(cfg.auditLogFile).toBe(logFile);
      expect(cfg.auditMaxEntries).toBe(250);
      expect(cfg.auditRotateBytes).toBe(4096);

      const configuredStore = createConfiguredStore(cfg);
      expect(configuredStore.path).toBe(path.resolve(logFile));

      const log = createAuditLog({ store: configuredStore });
      log.append(event(1));
      expect(fs.existsSync(logFile)).toBe(true);
    });

    test('rejects invalid AUDIT_MAX_ENTRIES, AUDIT_ROTATE_BYTES, and AUDIT_LOG_FILE', () => {
      expect(() => loadConfig({ AUDIT_MAX_ENTRIES: '0' })).toThrow(ConfigError);
      expect(() => loadConfig({ AUDIT_MAX_ENTRIES: '-5' })).toThrow(ConfigError);
      expect(() => loadConfig({ AUDIT_MAX_ENTRIES: 'abc' })).toThrow(ConfigError);
      expect(() => loadConfig({ AUDIT_ROTATE_BYTES: '0' })).toThrow(ConfigError);
      expect(() => loadConfig({ AUDIT_ROTATE_BYTES: '-100' })).toThrow(ConfigError);
      expect(() => loadConfig({ AUDIT_ROTATE_BYTES: 'not-a-number' })).toThrow(ConfigError);
      expect(() => loadConfig({ AUDIT_LOG_FILE: '   ' })).toThrow(ConfigError);
      expect(() => createFileStore({})).toThrow(TypeError);
    });
  });
});
