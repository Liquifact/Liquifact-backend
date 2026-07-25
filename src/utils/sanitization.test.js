const { sanitizeUserString, sanitizeValue } = require('./sanitization');

describe('sanitizeUserString', () => {
  it('normalizes unicode, strips controls, collapses whitespace, and trims', () => {
    expect(sanitizeUserString('  ACME\u0000 \n\t Corp  ')).toBe('ACME Corp');
  });

  it('caps string length', () => {
    expect(sanitizeUserString('abcdefgh', { maxLength: 5 })).toBe('abcde');
  });

  it('uses default maxLength when option is non-integer', () => {
    const long = 'a'.repeat(5000);
    expect(sanitizeUserString(long).length).toBe(4096);
  });
});

describe('sanitizeValue', () => {
  it('recursively sanitizes nested strings and arrays', () => {
    const input = {
      customer: '  John \n Doe  ',
      tags: ['  urgent ', ' \t vip  '],
      metadata: { note: '  paid\u0000today  ' },
    };

    expect(sanitizeValue(input)).toEqual({
      customer: 'John Doe',
      tags: ['urgent', 'vip'],
      metadata: { note: 'paidtoday' },
    });
  });

  it('removes dangerous object keys at top level', () => {
    const input = {
      safe: 'ok',
      __proto__: { polluted: true },
      constructor: 'bad',
      prototype: 'bad',
    };

    expect(sanitizeValue(input)).toEqual({ safe: 'ok' });
  });

  it('removes dangerous keys deeply nested inside objects', () => {
    const input = {
      level1: {
        safe: 'yes',
        __proto__: { polluted: true },
        level2: {
          constructor: 'drop',
          prototype: 'drop',
          keep: 'value',
        },
      },
    };

    expect(sanitizeValue(input)).toEqual({
      level1: { safe: 'yes', level2: { keep: 'value' } },
    });
  });

  it('strips prototype-polluting keys inside array elements', () => {
    const input = [
      { safe: 'a', __proto__: { evil: true } },
      { safe: 'b', constructor: 'bad' },
    ];

    expect(sanitizeValue(input)).toEqual([{ safe: 'a' }, { safe: 'b' }]);
  });

  it('does not mutate Object.prototype after sanitizing a crafted payload', () => {
    // Attempt pollution via a parsed-like object with dangerous key
    const dangerous = JSON.parse('{"__proto__":{"polluted":true},"safe":"yes"}');
    sanitizeValue(dangerous);

    expect({}.polluted).toBeUndefined();
  });

  it('does not mutate Object.prototype from deeply nested pollution attempt', () => {
    const deep = {
      a: { b: { __proto__: { injected: 'yes' }, constructor: { prototype: { injected: 'yes' } } } },
    };
    sanitizeValue(deep);

    expect({}.injected).toBeUndefined();
    expect(Object.prototype.injected).toBeUndefined();
  });

  it('drops branches that exceed max depth', () => {
    const input = { level1: { level2: { level3: { keep: 'nope' } } } };
    expect(sanitizeValue(input, { maxDepth: 2 })).toEqual({ level1: { level2: {} } });
  });

  it('passes through primitives (number, boolean, null) unchanged', () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
  });

  it('filters undefined results from arrays', () => {
    // Items at maxDepth+1 are dropped (return undefined); array filters them out
    const input = { a: [{ b: 'deep' }] };
    // maxDepth=1 → array is at depth 1, its items at depth 2 which exceeds maxDepth=1
    expect(sanitizeValue(input, { maxDepth: 1 })).toEqual({ a: [] });
  });

  it('uses default maxDepth when option is non-integer', () => {
    // Should not throw on a reasonably nested object when maxDepth option is invalid
    const result = sanitizeValue({ x: 'hello' }, { maxDepth: 'bad' });
    expect(result).toEqual({ x: 'hello' });
  });

  it('uses default maxStringLength when option is non-integer', () => {
    const long = 'b'.repeat(5000);
    const result = sanitizeValue(long, { maxStringLength: 'bad' });
    expect(result.length).toBe(4096);
  });

  it('uses provided maxStringLength when it is a valid integer', () => {
    const result = sanitizeValue('hello world', { maxStringLength: 5 });
    expect(result).toBe('hello');
  });
});
