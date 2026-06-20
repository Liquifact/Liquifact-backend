const { sanitizeUserString, sanitizeValue } = require('./sanitization');

describe('sanitizeUserString', () => {
  it('normalizes unicode, strips controls, collapses whitespace, and trims', () => {
    const input = '  ACME\u0000 \n\t Corp  ';
    const output = sanitizeUserString(input);

    expect(output).toBe('ACME Corp');
  });

  it('caps string length', () => {
    const output = sanitizeUserString('abcdefgh', { maxLength: 5 });
    expect(output).toBe('abcde');
  });
});

describe('sanitizeValue', () => {
  it('recursively sanitizes nested strings and arrays', () => {
    const input = {
      customer: '  John \n Doe  ',
      tags: ['  urgent ', ' \t vip  '],
      metadata: {
        note: '  paid\u0000today  ',
      },
    };

    expect(sanitizeValue(input)).toEqual({
      customer: 'John Doe',
      tags: ['urgent', 'vip'],
      metadata: {
        note: 'paidtoday',
      },
    });
  });

  it('removes dangerous object keys', () => {
    const input = {
      safe: 'ok',
      __proto__: { polluted: true },
      constructor: 'bad',
      prototype: 'bad',
    };

    expect(sanitizeValue(input)).toEqual({ safe: 'ok' });
  });

  it('removes JSON-parsed prototype-pollution keys at every nesting level', () => {
    const input = JSON.parse(`{
      "safe": "ok",
      "__proto__": { "polluted": true },
      "nested": {
        "constructor": { "prototype": { "polluted": true } },
        "keep": "  value  "
      },
      "items": [
        { "__proto__": { "polluted": true }, "name": "  first  " },
        { "prototype": "drop", "name": "second" }
      ]
    }`);

    const output = sanitizeValue(input);

    expect(output).toEqual({
      safe: 'ok',
      nested: {
        keep: 'value',
      },
      items: [
        { name: 'first' },
        { name: 'second' },
      ],
    });
    expect(Object.prototype.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.getPrototypeOf(output.nested)).toBeNull();
  });

  it('does not let sanitized output mutate Object prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":"yes"},"safe":"ok"}');
    const output = sanitizeValue(input);

    Object.assign({}, output);

    expect(Object.prototype.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });

  it('drops branches that exceed max depth', () => {
    const input = { level1: { level2: { level3: { keep: 'nope' } } } };
    expect(sanitizeValue(input, { maxDepth: 2 })).toEqual({ level1: { level2: {} } });
  });

  it('caps array and object traversal for oversized payloads', () => {
    const input = {
      entries: ['one', 'two', 'three'],
      keyed: {
        a: 'one',
        b: 'two',
        c: 'three',
      },
    };

    expect(sanitizeValue(input, { maxArrayLength: 2, maxObjectKeys: 2 })).toEqual({
      entries: ['one', 'two'],
      keyed: {
        a: 'one',
        b: 'two',
      },
    });
  });
});
