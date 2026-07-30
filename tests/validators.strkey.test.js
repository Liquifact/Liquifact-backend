'use strict';

const { StrKey } = require('@stellar/stellar-sdk');
const {
  isValidStellarAccountAddress,
  isValidStellarContractAddress,
  isValidStellarAddress,
} = require('../src/utils/validators');

const VALID_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 21));
const VALID_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 22));

describe('shared Stellar StrKey validators', () => {
  it('accepts account public keys only through the account helper', () => {
    expect(isValidStellarAccountAddress(VALID_ACCOUNT)).toBe(true);
    expect(isValidStellarAccountAddress(VALID_CONTRACT)).toBe(false);
  });

  it('accepts contract IDs only through the contract helper', () => {
    expect(isValidStellarContractAddress(VALID_CONTRACT)).toBe(true);
    expect(isValidStellarContractAddress(VALID_ACCOUNT)).toBe(false);
  });

  it('accepts account and contract StrKeys through the either-form helper', () => {
    expect(isValidStellarAddress(VALID_ACCOUNT)).toBe(true);
    expect(isValidStellarAddress(VALID_CONTRACT)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['lowercase account', VALID_ACCOUNT.toLowerCase()],
    ['mixed-case account', `${VALID_ACCOUNT.slice(0, 8).toLowerCase()}${VALID_ACCOUNT.slice(8)}`],
    ['trailing whitespace', `${VALID_ACCOUNT} `],
    ['too short', VALID_ACCOUNT.slice(0, -1)],
    ['too long', `${VALID_ACCOUNT}A`],
    ['wrong prefix', `X${VALID_ACCOUNT.slice(1)}`],
    ['same-character account lookalike', 'G'.repeat(56)],
    ['same-character contract lookalike', 'C'.repeat(56)],
  ])('rejects %s', (_label, value) => {
    expect(isValidStellarAddress(value)).toBe(false);
    expect(isValidStellarAccountAddress(value)).toBe(false);
    expect(isValidStellarContractAddress(value)).toBe(false);
  });
});
