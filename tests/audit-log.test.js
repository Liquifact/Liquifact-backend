'use strict';

const {
  GENESIS_HASH,
  canonicalJson,
  computeHash,
  verifyChain,
  redact,
  truncateIp,
  createMemoryStore,
  createAuditLog,
} = require('../src/audit/audit-log');

/** Store backed by a plain array the test can tamper with, standing in for "someone edited the storage". */
function arrayStore() {
  const items = [];
  return {
    items,
    last: () => (items.length ? items[items.length - 1] : null),
    append: (entry) => items.push(entry),
    entries: () => items,
    size: () => items.length,
  };
}

const event = (n, extra = {}) => ({
  action: 'invoice.fund',
  resourceType: 'invoice',
  resourceId: 'INV_0002',
  actor: 'anonymous',
  ip: '203.0.113.9',
  outcome: 'success',
  statusCode: 200,
  before: { fundedAmount: n, status: 'open' },
  after: { fundedAmount: n + 1, status: 'open' },
  ...extra,
});

/** @returns {{ log: object, store: object }} a log with four entries (seq 1..4) in a tamperable store */
function chainOfFour() {
  const store = arrayStore();
  const log = createAuditLog({ store });
  [10, 20, 30, 40].forEach((n) => log.append(event(n)));
  return { log, store };
}

describe('canonicalJson', () => {
  test('sorts keys at every depth and uses no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test('is independent of key insertion order and skips undefined', () => {
    expect(canonicalJson({ a: 1, b: 2, c: undefined })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe('append and hash chain', () => {
  test('first entry links to the genesis hash; hash = sha256(prevHash + canonicalJSON)', () => {
    const log = createAuditLog();
    const entry = log.append(event(1));
    expect(entry.seq).toBe(1);
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    const { hash, ...rest } = entry;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeHash(rest)).toBe(hash);
  });

  test('each entry links to the previous one', () => {
    const { store } = chainOfFour();
    expect(store.items.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(store.items[1].prevHash).toBe(store.items[0].hash);
    expect(store.items[3].prevHash).toBe(store.items[2].hash);
  });

  test('records before/after, outcome and status code', () => {
    const entry = createAuditLog().append(event(5));
    expect(entry.before).toEqual({ fundedAmount: 5, status: 'open' });
    expect(entry.after).toEqual({ fundedAmount: 6, status: 'open' });
    expect(entry.outcome).toBe('success');
    expect(entry.statusCode).toBe(200);
    expect(entry.requestId).toBeNull();
  });

  test('rejects malformed events', () => {
    const log = createAuditLog();
    expect(() => log.append(event(1, { action: '' }))).toThrow(TypeError);
    expect(() => log.append(event(1, { outcome: 'maybe' }))).toThrow(TypeError);
    expect(() => log.append(event(1, { statusCode: 'ok' }))).toThrow(TypeError);
    expect(() => log.append()).toThrow(TypeError);
  });

  test('an untampered chain verifies', () => {
    const { log } = chainOfFour();
    expect(log.verify()).toEqual({ valid: true, entries: 4 });
    expect(verifyChain([])).toEqual({ valid: true, entries: 0 });
  });
});

describe('tamper detection', () => {
  test('changing an entry\'s after field is detected at that entry', () => {
    const { log, store } = chainOfFour();
    store.items[1].after = { fundedAmount: 999999, status: 'funded' };
    expect(log.verify()).toEqual({ valid: false, brokenAt: 2 });
  });

  test('changing the actor or outcome is detected', () => {
    const { log, store } = chainOfFour();
    store.items[2].actor = 'someone-else';
    expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  test('deleting a middle entry is detected at the entry that followed it', () => {
    const { log, store } = chainOfFour();
    store.items.splice(1, 1);
    expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  test('reordering entries is detected at the first entry out of place', () => {
    const { log, store } = chainOfFour();
    [store.items[1], store.items[2]] = [store.items[2], store.items[1]];
    expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  test('recomputing the hash of a tampered entry still breaks the next link', () => {
    const { log, store } = chainOfFour();
    const target = store.items[1];
    target.after = { fundedAmount: 1, status: 'open' };
    const { hash, ...rest } = target;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    target.hash = computeHash(rest);
    expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  test('a deletion is still detected when the rest of the chain is re-hashed (sequence gap)', () => {
    const { log, store } = chainOfFour();
    store.items.splice(1, 1);
    for (let i = 1; i < store.items.length; i += 1) {
      const entry = store.items[i];
      entry.prevHash = store.items[i - 1].hash;
      const { hash, ...rest } = entry;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      entry.hash = computeHash(rest);
    }
    expect(log.verify()).toEqual({ valid: false, brokenAt: 3 });
  });

  test('rewriting the first entry\'s prevHash is detected', () => {
    const { log, store } = chainOfFour();
    store.items[0].prevHash = 'f'.repeat(64);
    expect(log.verify()).toEqual({ valid: false, brokenAt: 1 });
  });

  test('a malformed entry is reported, not thrown', () => {
    const { log, store } = chainOfFour();
    store.items[2] = null;
    expect(log.verify().valid).toBe(false);
  });
});

describe('memory store', () => {
  test('keeps only the most recent maxEntries and still verifies from the oldest retained prevHash', () => {
    const log = createAuditLog({ store: createMemoryStore({ maxEntries: 3 }) });
    for (let n = 1; n <= 5; n += 1) {
      log.append(event(n));
    }
    const kept = log.entries();
    expect(kept.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(kept[0].prevHash).not.toBe(GENESIS_HASH);
    expect(log.verify()).toEqual({ valid: true, entries: 3 });
    expect(log.append(event(6)).seq).toBe(6);
  });

  test('stored entries cannot be edited through the store', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    log.append(event(1));
    const [entry] = log.entries();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.after)).toBe(true);
    expect(() => {
      entry.after.fundedAmount = 12345;
    }).toThrow(TypeError);
    log.entries().pop();
    expect(log.entries()).toHaveLength(1);
    expect(log.verify().valid).toBe(true);
  });

  test('falls back to the default bound for an invalid maxEntries', () => {
    const store = createMemoryStore({ maxEntries: 0 });
    createAuditLog({ store }).append(event(1));
    expect(store.size()).toBe(1);
  });
});

describe('query', () => {
  test('filters by resourceId and action, and pages with after/limit', () => {
    const log = createAuditLog();
    log.append(event(1));
    log.append(event(2, { resourceId: 'INV_0001', action: 'invoice.create' }));
    log.append(event(3));
    log.append(event(4));
    expect(log.query({ resourceId: 'INV_0001' }).data.map((e) => e.seq)).toEqual([2]);
    expect(log.query({ action: 'invoice.fund' }).data.map((e) => e.seq)).toEqual([1, 3, 4]);
    const first = log.query({ action: 'invoice.fund', limit: 2 });
    expect(first.data.map((e) => e.seq)).toEqual([1, 3]);
    expect(first.nextAfter).toBe(3);
    const second = log.query({ action: 'invoice.fund', limit: 2, after: first.nextAfter });
    expect(second.data.map((e) => e.seq)).toEqual([4]);
    expect(second.nextAfter).toBeNull();
  });
});

describe('redaction', () => {
  test('drops sensitive keys at any depth and any casing', () => {
    const clean = redact({
      amount: 5,
      secret: 'a',
      Seed: 'b',
      nested: { password: 'c', apiKey: 'd', 'x-api-key': 'e', list: [{ token: 'f', ok: 1 }] },
      Authorization: 'Bearer zzz',
      headers: { authorization: 'Bearer yyy', accept: 'json' },
      accessToken: 'g',
    });
    expect(clean).toEqual({ amount: 5, nested: { list: [{ ok: 1 }] }, headers: { accept: 'json' } });
    expect(JSON.stringify(clean)).not.toMatch(/zzz|yyy/);
  });

  test('masks bearer/basic credentials that appear as values', () => {
    expect(redact({ note: 'Bearer abc.def.ghi' })).toEqual({ note: '[redacted]' });
  });

  test('is JSON-safe and bounded', () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(() => JSON.stringify(redact(circular))).not.toThrow();
    expect(redact({ n: NaN, u: undefined, f: () => 1, big: 10n })).toEqual({ n: null, big: '10' });
    expect(redact({ s: 'x'.repeat(5000) }).s.length).toBeLessThan(600);
  });

  test('append never stores secrets, in any field', () => {
    const log = createAuditLog();
    const entry = log.append(
      event(1, {
        actor: 'Bearer top-secret-actor',
        before: { secret: 'hunter2', fundedAmount: 1 },
        after: { nested: { password: 'hunter3' } },
        metadata: { authorization: 'Bearer hunter4', token: 'hunter5', seed: 'hunter6', keep: 'yes' },
      }),
    );
    const stored = JSON.stringify(entry);
    ['hunter', 'top-secret-actor', 'Bearer'].forEach((s) => expect(stored).not.toContain(s));
    expect(entry.metadata).toEqual({ keep: 'yes' });
  });

  test('oversized fields are cut to a marker instead of stored whole', () => {
    const huge = {};
    for (let i = 0; i < 200; i += 1) {
      huge[`key${i}`] = 'v'.repeat(100);
    }
    const entry = createAuditLog().append(event(1, { metadata: huge }));
    expect(entry.metadata).toEqual({ truncated: true });
  });
});

describe('truncateIp', () => {
  test('IPv4 to /24', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0/24');
  });

  test('IPv4-mapped IPv6 is treated as IPv4', () => {
    expect(truncateIp('::ffff:198.51.100.23')).toBe('198.51.100.0/24');
  });

  test('IPv6 to /48, including compressed forms', () => {
    expect(truncateIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
    expect(truncateIp('2001:db8:abcd::1')).toBe('2001:db8:abcd::/48');
    expect(truncateIp('2001:db8::')).toBe('2001:db8:0::/48');
    expect(truncateIp('::1')).toBe('0:0:0::/48');
    expect(truncateIp('fe80::1%eth0')).toBe('fe80:0:0::/48');
  });

  test('non-IPs become null and the raw address is never stored', () => {
    expect(truncateIp('not-an-ip')).toBeNull();
    expect(truncateIp(undefined)).toBeNull();
    const entry = createAuditLog().append(event(1, { ip: '203.0.113.77' }));
    expect(entry.ip).toBe('203.0.113.0/24');
    expect(JSON.stringify(entry)).not.toContain('203.0.113.77');
  });
});
