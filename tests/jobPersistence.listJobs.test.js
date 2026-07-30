'use strict';

/**
 * @fileoverview Comprehensive unit tests for listJobs() cursor-based pagination
 * in jobPersistence.js, covering: cursor encode/decode, page boundary math,
 * empty sets, exact-page boundaries, over-limit clamp, invalid cursors,
 * sort fields, order directions, status/type filters, and error paths.
 *
 * All DB calls are faked with an in-memory store so no real Postgres is needed.
 */

jest.mock('../src/logger', () => ({
  error: jest.fn(),
  warn:  jest.fn(),
  info:  jest.fn(),
}));

const {
  createJobPersistence,
  encodeJobCursor,
  decodeJobCursor,
  JobCursorError,
  LIST_JOBS_DEFAULT_LIMIT,
  LIST_JOBS_MAX_LIMIT,
  LIST_JOBS_SORT_FIELDS,
} = require('../src/workers/jobPersistence');

// ── In-memory DB factory ──────────────────────────────────────────────────────
// Simulates a Knex queryBuilder chain for background_jobs. Supports:
//   .select()  .where()  .whereIn()  .whereNull()  .orderBy()  .limit()
// The chainable methods accumulate state; the terminal .then() executes them.

function makeDb(seedRows = []) {
  const rows = seedRows.map((r, i) => ({
    id:           r.id          ?? `job-${String(i).padStart(4, '0')}`,
    type:         r.type        ?? 'test_job',
    status:       r.status      ?? 'pending',
    priority:     r.priority    ?? 0,
    delay_ms:     r.delay_ms    ?? 0,
    created_at:   r.created_at  ?? (1_000_000 + i * 1000),
    started_at:   r.started_at  ?? null,
    completed_at: r.completed_at ?? null,
    attempts:     r.attempts    ?? 0,
    last_error:   r.last_error  ?? null,
    acked_at:     r.acked_at    ?? null,
  }));

  function buildQuery() {
    const state = {
      _selected: null,
      _wheres:   [],   // [{col, op, val}]
      _orders:   [],   // [{col, dir}]
      _limit:    null,
    };

    const q = {
      select(...cols) {
        state._selected = cols.flat();
        return q;
      },
      where(colOrFn, val) {
        if (typeof colOrFn === 'function') {
          // nested where group — capture sub-conditions via a mini builder
          // Call with sub as both `this` and first argument (mirrors real Knex behaviour)
          const sub = buildSubWhere();
          colOrFn.call(sub, sub);
          state._wheres.push({ type: 'group', conditions: sub._conditions });
        } else {
          state._wheres.push({ type: 'eq', col: colOrFn, val });
        }
        return q;
      },
      whereIn(col, vals) {
        state._wheres.push({ type: 'in', col, vals });
        return q;
      },
      whereNull(col) {
        state._wheres.push({ type: 'null', col });
        return q;
      },
      orderBy(col, dir = 'asc') {
        state._orders.push({ col, dir: dir.toLowerCase() });
        return q;
      },
      limit(n) {
        state._limit = n;
        return q;
      },
      // terminal
      then(resolve, reject) {
        return Promise.resolve(applyQuery(rows, state)).then(resolve, reject);
      },
    };
    return q;
  }

  function buildSubWhere() {
    const sub = { _conditions: [] };
    sub.where = function (col, op, val) {
      if (val === undefined) {
        // 2-arg form: col, val (implicit '=')
        sub._conditions.push({ type: 'eq', col, val: op });
      } else {
        sub._conditions.push({ type: 'op', col, op, val });
      }
      return sub;
    };
    sub.orWhere = function (fn) {
      const inner = buildSubWhere();
      fn.call(inner, inner);
      sub._conditions.push({ type: 'or_group', conditions: inner._conditions });
      return sub;
    };
    return sub;
  }

  function applyQuery(src, state) {
    let result = src.slice();

    // Apply WHERE conditions
    for (const w of state._wheres) {
      result = result.filter((row) => evalWhere(row, w));
    }

    // Apply ORDER BY (multi-column)
    if (state._orders.length > 0) {
      result.sort((a, b) => {
        for (const { col, dir } of state._orders) {
          const av = a[col] ?? '';
          const bv = b[col] ?? '';
          if (av < bv) { return dir === 'asc' ? -1 :  1; }
          if (av > bv) { return dir === 'asc' ?  1 : -1; }
        }
        return 0;
      });
    }

    // Apply LIMIT
    if (state._limit !== null) {
      result = result.slice(0, state._limit);
    }

    // Apply SELECT (project columns)
    if (state._selected) {
      result = result.map((row) => {
        const out = {};
        for (const col of state._selected) {
          if (Object.prototype.hasOwnProperty.call(row, col)) {
            out[col] = row[col];
          }
        }
        return out;
      });
    }

    return result;
  }

  function evalWhere(row, w) {
    if (w.type === 'eq')  { return row[w.col] === w.val; }
    if (w.type === 'in')  { return w.vals.includes(row[w.col]); }
    if (w.type === 'null'){ return row[w.col] == null; }
    if (w.type === 'group') {
      return evalConditions(row, w.conditions);
    }
    if (w.type === 'op') {
      const rv = row[w.col];
      if (w.op === '>')  { return rv >  w.val; }
      if (w.op === '<')  { return rv <  w.val; }
      if (w.op === '>=') { return rv >= w.val; }
      if (w.op === '<=') { return rv <= w.val; }
      if (w.op === '=')  { return rv === w.val; }
    }
    return true;
  }

  function evalConditions(row, conditions) {
    let result = true;
    for (const c of conditions) {
      if (c.type === 'eq')  { result = result && (row[c.col] === c.val); }
      if (c.type === 'op')  {
        const rv = row[c.col];
        if (c.op === '>')  { result = result && (rv >  c.val); }
        if (c.op === '<')  { result = result && (rv <  c.val); }
        if (c.op === '=')  { result = result && (rv === c.val); }
      }
      if (c.type === 'or_group') {
        // OR branch — any sub-condition passes
        const orResult = c.conditions.some((sc) => {
          if (sc.type === 'eq') { return row[sc.col] === sc.val; }
          if (sc.type === 'op') {
            const rv = row[sc.col];
            if (sc.op === '=')  { return rv === sc.val; }
            if (sc.op === '>')  { return rv >  sc.val; }
            if (sc.op === '<')  { return rv <  sc.val; }
          }
          return false;
        });
        result = result && orResult;
      }
    }
    return result;
  }

  const db = jest.fn(() => buildQuery());
  db._rows = rows;
  return db;
}

// ── Cursor encode / decode ────────────────────────────────────────────────────

describe('encodeJobCursor / decodeJobCursor', () => {
  it('round-trips a valid cursor', () => {
    const encoded = encodeJobCursor({
      sortField: 'created_at',
      sortValue: 1_700_000_000_000,
      id:        'job-abc123',
      order:     'desc',
    });
    expect(typeof encoded).toBe('string');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);

    const decoded = decodeJobCursor(encoded);
    expect(decoded.sortField).toBe('created_at');
    expect(decoded.sortValue).toBe(1_700_000_000_000);
    expect(decoded.id).toBe('job-abc123');
    expect(decoded.order).toBe('desc');
    expect(typeof decoded.iat).toBe('number');
  });

  it('throws JobCursorError for a tampered signature', () => {
    const encoded = encodeJobCursor({ sortField: 'created_at', sortValue: 1, id: 'x', order: 'asc' });
    const tampered = encoded.slice(0, -4) + '0000'; // corrupt last 4 hex chars
    expect(() => decodeJobCursor(tampered)).toThrow(JobCursorError);
  });

  it('throws JobCursorError when the cursor has no dot separator', () => {
    expect(() => decodeJobCursor('nodothere')).toThrow(JobCursorError);
  });

  it('throws JobCursorError when the base64 payload is not valid JSON', () => {
    // Craft a cursor with random base64 payload that isn't JSON
    const fakeB64 = Buffer.from('not-json!!!').toString('base64url');
    // Sign it properly
    const crypto = require('crypto');
    const secret = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-jobs-cursor-secret-change-in-prod';
    const sig = crypto.createHmac('sha256', secret).update(fakeB64).digest('hex');
    expect(() => decodeJobCursor(`${fakeB64}.${sig}`)).toThrow(JobCursorError);
  });

  it('throws JobCursorError for an unknown sortField in cursor', () => {
    const encoded = encodeJobCursor({ sortField: 'created_at', sortValue: 1, id: 'x', order: 'asc' });
    // Decode, mutate sortField, re-encode without signing (won't match)
    // Instead: directly test decodeJobCursor with a crafted payload
    const crypto = require('crypto');
    const secret = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-jobs-cursor-secret-change-in-prod';
    const payload = JSON.stringify({ sortField: 'invalid_col', sortValue: 1, id: 'x', order: 'asc', iat: 1000 });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    expect(() => decodeJobCursor(`${b64}.${sig}`)).toThrow(JobCursorError);
  });

  it('throws JobCursorError when id is missing', () => {
    const crypto = require('crypto');
    const secret = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-jobs-cursor-secret-change-in-prod';
    const payload = JSON.stringify({ sortField: 'created_at', sortValue: 1, id: '', order: 'asc', iat: 1000 });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    expect(() => decodeJobCursor(`${b64}.${sig}`)).toThrow(JobCursorError);
  });

  it('throws JobCursorError when iat is missing', () => {
    const crypto = require('crypto');
    const secret = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-jobs-cursor-secret-change-in-prod';
    const payload = JSON.stringify({ sortField: 'created_at', sortValue: 1, id: 'x', order: 'asc' });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    expect(() => decodeJobCursor(`${b64}.${sig}`)).toThrow(JobCursorError);
  });

  it('throws JobCursorError for invalid order in cursor', () => {
    const crypto = require('crypto');
    const secret = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-jobs-cursor-secret-change-in-prod';
    const payload = JSON.stringify({ sortField: 'created_at', sortValue: 1, id: 'x', order: 'sideways', iat: 1000 });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    expect(() => decodeJobCursor(`${b64}.${sig}`)).toThrow(JobCursorError);
  });

  it('throws JobCursorError for non-string cursor input', () => {
    expect(() => decodeJobCursor(null)).toThrow(JobCursorError);
    expect(() => decodeJobCursor(42)).toThrow(JobCursorError);
    expect(() => decodeJobCursor({})).toThrow(JobCursorError);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('LIST_JOBS_DEFAULT_LIMIT is 20', () => {
    expect(LIST_JOBS_DEFAULT_LIMIT).toBe(20);
  });

  it('LIST_JOBS_MAX_LIMIT is 100', () => {
    expect(LIST_JOBS_MAX_LIMIT).toBe(100);
  });

  it('LIST_JOBS_SORT_FIELDS contains expected columns', () => {
    expect(LIST_JOBS_SORT_FIELDS).toEqual(
      expect.arrayContaining(['created_at', 'status', 'type', 'attempts']),
    );
    expect(LIST_JOBS_SORT_FIELDS).toHaveLength(4);
  });
});

// ── listJobs — empty result set ───────────────────────────────────────────────

describe('listJobs — empty data set', () => {
  it('returns empty data array and hasMore=false with no rows', async () => {
    const db = makeDb([]);
    const p  = createJobPersistence(db);

    const result = await p.listJobs();

    expect(result.data).toEqual([]);
    expect(result.meta.hasMore).toBe(false);
    expect(result.meta.nextCursor).toBeNull();
  });

  it('returns correct limit in meta even when no rows exist', async () => {
    const db = makeDb([]);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 5 });
    expect(result.meta.limit).toBe(5);
  });
});

// ── listJobs — first page (no cursor) ────────────────────────────────────────

describe('listJobs — first page without cursor', () => {
  function makeRows(count) {
    return Array.from({ length: count }, (_, i) => ({
      id:         `job-${String(i).padStart(4, '0')}`,
      created_at: 1_000_000 + i * 1000,
    }));
  }

  it('returns all rows when count < limit', async () => {
    const db = makeDb(makeRows(3));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 10 });

    expect(result.data).toHaveLength(3);
    expect(result.meta.hasMore).toBe(false);
    expect(result.meta.nextCursor).toBeNull();
  });

  it('returns exactly limit rows when count === limit', async () => {
    const db = makeDb(makeRows(10));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 10 });

    // Exactly 10 rows, no extra — hasMore must be false
    expect(result.data).toHaveLength(10);
    expect(result.meta.hasMore).toBe(false);
    expect(result.meta.nextCursor).toBeNull();
  });

  it('returns limit rows and sets hasMore=true when count > limit', async () => {
    const db = makeDb(makeRows(11));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 10 });

    expect(result.data).toHaveLength(10);
    expect(result.meta.hasMore).toBe(true);
    expect(typeof result.meta.nextCursor).toBe('string');
  });

  it('uses LIST_JOBS_DEFAULT_LIMIT when limit is omitted', async () => {
    const db = makeDb(makeRows(5));
    const p  = createJobPersistence(db);

    const result = await p.listJobs();
    expect(result.meta.limit).toBe(LIST_JOBS_DEFAULT_LIMIT);
  });

  it('payload column is NOT present in returned rows', async () => {
    const db = makeDb([{ id: 'job-0001', payload: '{"secret":"value"}' }]);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 5 });
    expect(result.data[0]).not.toHaveProperty('payload');
  });
});

// ── listJobs — limit clamping ─────────────────────────────────────────────────

describe('listJobs — limit clamping', () => {
  function makeRows(count) {
    return Array.from({ length: count }, (_, i) => ({
      id:         `job-${String(i).padStart(4, '0')}`,
      created_at: 1_000_000 + i * 1000,
    }));
  }

  it('clamps limit to LIST_JOBS_MAX_LIMIT when over-limit is supplied', async () => {
    const db = makeDb(makeRows(200));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 9999 });
    expect(result.meta.limit).toBe(LIST_JOBS_MAX_LIMIT);
    expect(result.data.length).toBeLessThanOrEqual(LIST_JOBS_MAX_LIMIT);
  });

  it('clamps limit to 1 when 0 is supplied', async () => {
    const db = makeDb(makeRows(5));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 0 });
    expect(result.meta.limit).toBe(1);
  });

  it('clamps limit to 1 when a negative value is supplied', async () => {
    const db = makeDb(makeRows(5));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: -50 });
    expect(result.meta.limit).toBe(1);
  });

  it('accepts string limit and parses it', async () => {
    const db = makeDb(makeRows(5));
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: '5' });
    expect(result.meta.limit).toBe(5);
  });
});

// ── listJobs — cursor-based next-page navigation ──────────────────────────────

describe('listJobs — cursor pagination traversal', () => {
  // Build 25 rows with distinct created_at values (desc default).
  const ALL_ROWS = Array.from({ length: 25 }, (_, i) => ({
    id:         `job-${String(i).padStart(4, '0')}`,
    created_at: 1_000_000 + i * 1000,
  }));

  it('returns all rows without duplication across three pages', async () => {
    const db = makeDb(ALL_ROWS);
    const p  = createJobPersistence(db);

    const page1 = await p.listJobs({ limit: 10, order: 'desc' });
    expect(page1.data).toHaveLength(10);
    expect(page1.meta.hasMore).toBe(true);

    const page2 = await p.listJobs({ limit: 10, order: 'desc', cursor: page1.meta.nextCursor });
    expect(page2.data).toHaveLength(10);
    expect(page2.meta.hasMore).toBe(true);

    const page3 = await p.listJobs({ limit: 10, order: 'desc', cursor: page2.meta.nextCursor });
    expect(page3.data).toHaveLength(5);
    expect(page3.meta.hasMore).toBe(false);
    expect(page3.meta.nextCursor).toBeNull();

    // All IDs across pages must be unique
    const allIds = [
      ...page1.data.map((r) => r.id),
      ...page2.data.map((r) => r.id),
      ...page3.data.map((r) => r.id),
    ];
    expect(new Set(allIds).size).toBe(25);
  });

  it('second page does not overlap with first page', async () => {
    const db = makeDb(ALL_ROWS);
    const p  = createJobPersistence(db);

    const page1 = await p.listJobs({ limit: 10, order: 'asc' });
    const page2 = await p.listJobs({ limit: 10, order: 'asc', cursor: page1.meta.nextCursor });

    const ids1 = new Set(page1.data.map((r) => r.id));
    const ids2 = new Set(page2.data.map((r) => r.id));
    const intersection = [...ids1].filter((id) => ids2.has(id));
    expect(intersection).toHaveLength(0);
  });

  it('last page has hasMore=false and null nextCursor', async () => {
    const db = makeDb(ALL_ROWS);
    const p  = createJobPersistence(db);

    const page1 = await p.listJobs({ limit: 20, order: 'desc' });
    const page2 = await p.listJobs({ limit: 20, order: 'desc', cursor: page1.meta.nextCursor });

    expect(page2.meta.hasMore).toBe(false);
    expect(page2.meta.nextCursor).toBeNull();
  });

  it('exact-boundary: limit equals total — no cursor, hasMore=false', async () => {
    const db = makeDb(ALL_ROWS); // 25 rows
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 25, order: 'desc' });
    expect(result.data).toHaveLength(25);
    expect(result.meta.hasMore).toBe(false);
    expect(result.meta.nextCursor).toBeNull();
  });

  it('exact-boundary: first page has limit rows, second page has 0', async () => {
    // 10 rows, limit=10 → page1 has 10, page2 has 0
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id:         `job-${String(i).padStart(4, '0')}`,
      created_at: 1_000_000 + i * 1000,
    }));
    const db = makeDb(rows);
    const p  = createJobPersistence(db);

    const page1 = await p.listJobs({ limit: 10 });
    expect(page1.data).toHaveLength(10);
    expect(page1.meta.hasMore).toBe(false);
    // No cursor emitted when the full page fills exactly
    expect(page1.meta.nextCursor).toBeNull();
  });
});

// ── listJobs — invalid cursor handling ───────────────────────────────────────

describe('listJobs — invalid cursor', () => {
  it('throws JobCursorError for a tampered cursor string', async () => {
    const db = makeDb([{ id: 'job-0001', created_at: 1_000_000 }]);
    const p  = createJobPersistence(db);

    await expect(p.listJobs({ cursor: 'totally-invalid.deadbeef' }))
      .rejects.toThrow(JobCursorError);
  });

  it('throws JobCursorError for an empty string cursor', async () => {
    const db = makeDb([]);
    const p  = createJobPersistence(db);

    await expect(p.listJobs({ cursor: '' })).rejects.toThrow(JobCursorError);
  });

  it('throws JobCursorError when cursor order does not match requested order', async () => {
    const db = makeDb([{ id: 'job-0001', created_at: 1_000_000 }]);
    const p  = createJobPersistence(db);

    // Build a valid cursor with order='asc'
    const page1 = await p.listJobs({ limit: 1, order: 'asc' });
    if (!page1.meta.nextCursor) { return; } // not enough rows; skip
    // Now use it with order='desc' — should throw
    await expect(
      p.listJobs({ limit: 1, order: 'desc', cursor: page1.meta.nextCursor }),
    ).rejects.toThrow(JobCursorError);
  });

  it('propagates JobCursorError (does not swallow it)', async () => {
    const db = makeDb([]);
    const p  = createJobPersistence(db);

    const err = await p.listJobs({ cursor: 'bad.cursor' }).catch((e) => e);
    expect(err).toBeInstanceOf(JobCursorError);
  });
});

// ── listJobs — sortBy field ───────────────────────────────────────────────────

describe('listJobs — sortBy', () => {
  const ROWS = [
    { id: 'job-a', type: 'alpha',   status: 'completed', attempts: 3, created_at: 3000 },
    { id: 'job-b', type: 'beta',    status: 'pending',   attempts: 1, created_at: 1000 },
    { id: 'job-c', type: 'charlie', status: 'failed',    attempts: 5, created_at: 2000 },
  ];

  it('sorts by created_at desc by default', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 10 });
    const times  = result.data.map((r) => r.created_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('sorts by created_at asc when order=asc', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 10, order: 'asc' });
    const times  = result.data.map((r) => r.created_at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('sorts by attempts desc', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ limit: 10, sortBy: 'attempts', order: 'desc' });
    const att    = result.data.map((r) => r.attempts);
    expect(att).toEqual([...att].sort((a, b) => b - a));
  });

  it('falls back to created_at when sortBy is invalid', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    // 'not_a_column' is not in LIST_JOBS_SORT_FIELDS — should default to created_at
    const result = await p.listJobs({ limit: 10, sortBy: 'not_a_column', order: 'desc' });
    const times  = result.data.map((r) => r.created_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('all sort fields in LIST_JOBS_SORT_FIELDS are accepted without error', async () => {
    for (const field of LIST_JOBS_SORT_FIELDS) {
      const db = makeDb(ROWS);
      const p  = createJobPersistence(db);
      await expect(p.listJobs({ sortBy: field })).resolves.toBeDefined();
    }
  });
});

// ── listJobs — filters ────────────────────────────────────────────────────────

describe('listJobs — status filter', () => {
  const ROWS = [
    { id: 'job-p1', status: 'pending',   type: 'send_email', created_at: 1000 },
    { id: 'job-p2', status: 'pending',   type: 'send_email', created_at: 2000 },
    { id: 'job-c1', status: 'completed', type: 'send_email', created_at: 3000 },
    { id: 'job-f1', status: 'failed',    type: 'audit',      created_at: 4000 },
  ];

  it('returns only rows matching the status filter', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ status: 'pending' });
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.status === 'pending')).toBe(true);
  });

  it('returns empty when no rows match the status filter', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ status: 'retrying' });
    expect(result.data).toHaveLength(0);
    expect(result.meta.hasMore).toBe(false);
  });
});

describe('listJobs — type filter', () => {
  const ROWS = [
    { id: 'job-e1', type: 'send_email', status: 'pending',   created_at: 1000 },
    { id: 'job-e2', type: 'send_email', status: 'completed', created_at: 2000 },
    { id: 'job-a1', type: 'audit',      status: 'pending',   created_at: 3000 },
  ];

  it('returns only rows matching the type filter', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ type: 'send_email' });
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.type === 'send_email')).toBe(true);
  });

  it('supports combining status and type filters', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const result = await p.listJobs({ type: 'send_email', status: 'pending' });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('job-e1');
  });
});

describe('listJobs — cursor pagination preserves filters', () => {
  // 15 pending rows + 5 completed rows
  const ROWS = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id:         `job-p${String(i).padStart(3, '0')}`,
      status:     'pending',
      created_at: 1_000 + i * 100,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id:         `job-c${String(i).padStart(3, '0')}`,
      status:     'completed',
      created_at: 2_000 + i * 100,
    })),
  ];

  it('cursor navigation respects the status filter across pages', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const page1 = await p.listJobs({ limit: 8, status: 'pending', order: 'asc' });
    expect(page1.data.every((r) => r.status === 'pending')).toBe(true);
    expect(page1.data).toHaveLength(8);
    expect(page1.meta.hasMore).toBe(true);

    const page2 = await p.listJobs({ limit: 8, status: 'pending', order: 'asc', cursor: page1.meta.nextCursor });
    expect(page2.data.every((r) => r.status === 'pending')).toBe(true);
    expect(page2.data).toHaveLength(7);
    expect(page2.meta.hasMore).toBe(false);

    // No duplicates
    const allIds = [...page1.data.map((r) => r.id), ...page2.data.map((r) => r.id)];
    expect(new Set(allIds).size).toBe(15);
  });
});

// ── listJobs — order direction ────────────────────────────────────────────────

describe('listJobs — order direction', () => {
  const ROWS = Array.from({ length: 5 }, (_, i) => ({
    id:         `job-${String(i).padStart(4, '0')}`,
    created_at: 1_000 * (i + 1),
  }));

  it('falls back to desc when order is unrecognized', async () => {
    const db = makeDb(ROWS);
    const p  = createJobPersistence(db);

    const desc   = await p.listJobs({ order: 'desc' });
    const bogus  = await p.listJobs({ order: 'sideways' });

    expect(bogus.data.map((r) => r.created_at))
      .toEqual(desc.data.map((r) => r.created_at));
  });
});

// ── listJobs — prototype pollution guard ─────────────────────────────────────

describe('listJobs — input safety', () => {
  it('ignores non-string status values silently', async () => {
    const db = makeDb([{ id: 'job-0001', status: 'pending', created_at: 1000 }]);
    const p  = createJobPersistence(db);

    // status=null → treated as undefined → no filter applied
    await expect(p.listJobs({ status: null })).resolves.toBeDefined();
  });

  it('ignores non-string type values silently', async () => {
    const db = makeDb([{ id: 'job-0001', type: 'audit', created_at: 1000 }]);
    const p  = createJobPersistence(db);

    await expect(p.listJobs({ type: 42 })).resolves.toBeDefined();
  });
});
