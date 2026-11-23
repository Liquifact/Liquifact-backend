'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../src/logger');
const { createFileEventStore } = require('../../src/indexer/FileEventStore');

describe('FileEventStore', () => {
  let directory;
  let filePath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'liquifact-event-store-'));
    filePath = path.join(directory, 'events.ndjson');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('recovers events and cursor after constructing a new store', () => {
    const first = createFileEventStore({ path: filePath });
    const event = { id: 'evt-1', ledger: 42, data: { investor: 'G123' } };
    expect(first.append([event])).toBe(1);
    first.setCursor('cursor-42');

    const restarted = createFileEventStore({ path: filePath });
    expect(restarted.query()).toEqual({ data: [event], nextCursor: null });
    expect(restarted.getCursor()).toBe('cursor-42');
  });

  test('keeps re-appends idempotent and reapplies the FIFO cap on startup', () => {
    const first = createFileEventStore({ path: filePath, maxEvents: 2 });
    const events = [{ id: 'evt-1' }, { id: 'evt-2' }, { id: 'evt-3' }];

    expect(first.append(events)).toBe(3);
    expect(first.append([{ id: 'evt-3' }])).toBe(0);
    expect(first.query({ limit: 10 }).data.map((event) => event.id)).toEqual(['evt-2', 'evt-3']);

    const restarted = createFileEventStore({ path: filePath, maxEvents: 2 });
    expect(restarted.query({ limit: 10 }).data.map((event) => event.id)).toEqual(['evt-2', 'evt-3']);
    expect(restarted.append([{ id: 'evt-3' }])).toBe(0);
  });

  test('ignores a truncated final record and skips corrupt complete records with warnings', () => {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ id: 'evt-1' })}\nnot-json\n{"id":"evt-truncated"`,
      'utf8',
    );
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const store = createFileEventStore({ path: filePath });
      expect(store.query().data).toEqual([{ id: 'evt-1' }]);
      expect(warn).toHaveBeenCalledWith(
        'Ignoring corrupt indexer event record',
        expect.objectContaining({ path: filePath, line: 2 }),
      );
      expect(warn).toHaveBeenCalledWith(
        'Ignoring truncated trailing indexer event record',
        expect.objectContaining({ path: filePath }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('atomically writes cursor updates and clears persisted state', () => {
    const store = createFileEventStore({ path: filePath });
    store.setCursor('cursor-1');
    expect(fs.readFileSync(`${filePath}.cursor`, 'utf8')).toBe('"cursor-1"');
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    store.append([{ id: 'evt-1' }]);
    store.clear();
    expect(store.getCursor()).toBeNull();
    expect(store.size()).toBe(0);
    expect(fs.existsSync(`${filePath}.cursor`)).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('');
  });
});
