'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseEther } = require('ethers');

const { spendableFromBalance } = require('./funding');

// "Entire balance minus gas" is the arithmetic most likely to quietly produce
// an unsendable transaction, so it is pinned down here.

const GAS_LIMIT = 400000n;
const COST = parseEther('0.001'); // pretend gas cost for the buy
const BUFFER = parseEther('0.0004');

test('spends the balance less gas and buffer', () => {
  const balance = parseEther('1');
  const spendable = spendableFromBalance(balance, COST, GAS_LIMIT, BUFFER);
  assert.equal(spendable, balance - COST - BUFFER);
});

test('never returns a negative amount', () => {
  assert.equal(spendableFromBalance(parseEther('0.0001'), COST, GAS_LIMIT, BUFFER), 0n);
  assert.equal(spendableFromBalance(0n, COST, GAS_LIMIT, BUFFER), 0n);
});

test('returns zero when the balance exactly covers gas and buffer', () => {
  assert.equal(spendableFromBalance(COST + BUFFER, COST, GAS_LIMIT, BUFFER), 0n);
});

test('leaves a wallet able to pay for its own buy', () => {
  const balance = parseEther('0.5');
  const spendable = spendableFromBalance(balance, COST, GAS_LIMIT, BUFFER);
  // What is left behind must still cover the gas the buy will burn.
  assert.ok(balance - spendable >= COST, 'remainder must cover gas');
});

test('accepts a fee object instead of a precomputed cost', () => {
  const fees = { maxFeePerGas: 1_000_000_000n }; // 1 gwei
  const spendable = spendableFromBalance(parseEther('1'), fees, GAS_LIMIT, BUFFER);
  assert.equal(spendable, parseEther('1') - 1_000_000_000n * GAS_LIMIT - BUFFER);
});
