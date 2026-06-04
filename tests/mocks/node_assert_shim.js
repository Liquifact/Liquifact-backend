
const expect = global.expect;
module.exports = {
  equal: (a, b) => expect(a).toBe(b),
  deepEqual: (a, b) => expect(a).toEqual(b),
  notEqual: (a, b) => expect(a).not.toBe(b),
  match: (a, b) => expect(a).toMatch(b),
  throws: (fn, err) => expect(fn).toThrow(err),
  rejects: (promise, err) => expect(promise).rejects.toThrow(err),
  ok: (val) => expect(val).toBeTruthy()
};
