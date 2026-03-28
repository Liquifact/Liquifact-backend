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

  it('drops branches that exceed max depth', () => {
    const input = { level1: { level2: { level3: { keep: 'nope' } } } };
    expect(sanitizeValue(input, { maxDepth: 2 })).toEqual({ level1: { level2: {} } });
  });
});
