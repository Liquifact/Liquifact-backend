describe('App load sanity check', () => {
  test('app creates without throwing', () => {
    const app = require('../src/index');
    expect(typeof app).toBe('function');
  });
});
