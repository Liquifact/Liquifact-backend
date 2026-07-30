'use strict';

const {
  isValidStellarAccountAddress,
  isValidStellarContractAddress,
  isValidStellarAddress,
} = require('../src/utils/stellarAddress');

describe('utils/stellarAddress', () => {
  const account = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK';

  it('accepts valid G... account addresses', () => {
    expect(isValidStellarAccountAddress(account)).toBe(true);
    expect(isValidStellarAddress(account)).toBe(true);
  });

  it('rejects malformed account addresses', () => {
    expect(isValidStellarAccountAddress('GSHORT')).toBe(false);
    expect(isValidStellarAddress('not-an-address')).toBe(false);
  });

  it('accepts valid C... contract addresses when checksum is valid', () => {
    const contract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    expect(isValidStellarContractAddress(contract)).toBe(true);
    expect(isValidStellarAddress(contract)).toBe(true);
  });
});
