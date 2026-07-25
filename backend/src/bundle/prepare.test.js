'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ZeroAddress } = require('ethers');

const { randomSalt, toSignable, prepare } = require('./prepare');
const { toTokenParams } = require('../evm/factory');

test('randomSalt is a distinct bytes32', () => {
  const a = randomSalt();
  const b = randomSalt();
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('toSignable drops `from` and pins nonce, gas and chain', () => {
  const populated = { to: '0xrouter', data: '0xdead', value: 5n, from: '0xsender' };
  const signable = toSignable(populated, {
    nonce: 7,
    gasLimit: 400000n,
    fees: { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
    chainId: 4663n,
  });

  // signTransaction rejects a populated `from`.
  assert.equal('from' in signable, false);
  assert.equal(signable.nonce, 7);
  assert.equal(signable.gasLimit, 400000n);
  assert.equal(signable.chainId, 4663n);
  assert.equal(signable.maxFeePerGas, 2n);
  assert.equal(signable.to, '0xrouter');
  assert.equal(signable.value, 5n);
});

test('token params fill in every social and default the fee wallet', () => {
  const params = toTokenParams({ name: 'Pons Cat', symbol: 'PONSCAT' });

  assert.equal(params.name, 'Pons Cat');
  assert.equal(params.description, '');
  // All five socials must be present — the tuple is positional, and a missing
  // field would shift every later value.
  assert.deepEqual(Object.keys(params.socials), [
    'twitter',
    'telegram',
    'discord',
    'website',
    'farcaster',
  ]);
  assert.ok(Object.values(params.socials).every((v) => v === ''));
  // Zero fee wallet => the launching wallet receives the atomic buy.
  assert.equal(params.feeWallet, ZeroAddress);
});

test('token params checksum a supplied fee wallet', () => {
  const lower = '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb';
  const params = toTokenParams({ name: 'x', symbol: 'X', feeWallet: lower });
  assert.equal(params.feeWallet, '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB');
});

// A blank logo would be baked into the CREATE2 preimage forever, so prepare
// must reject it before any wallet or chain work — same guard style as the
// name/symbol check just above it.
test('prepare rejects a launch with no logo', async () => {
  await assert.rejects(
    () => prepare({ params: { name: 'x', symbol: 'X', logo: '' } }),
    /logo is required/
  );
});
