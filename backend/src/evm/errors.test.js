'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rpcMessage } = require('./errors');

test('an unclassifiable error surfaces what the node actually said', () => {
  // The real shape behind "could not coalesce error": ethers gave up, but the
  // provider's own message is right there in info.error.
  const err = {
    shortMessage: 'could not coalesce error',
    info: { error: { code: -32005, message: 'request limit reached' } },
  };
  const msg = rpcMessage(err);
  assert.match(msg, /request limit reached/);
  assert.match(msg, /-32005/, 'the code distinguishes a rate limit from a rejected transaction');
});

test('a message ethers understood is preferred to the raw one', () => {
  const err = {
    shortMessage: 'insufficient funds for intrinsic transaction cost',
    info: { error: { code: -32000, message: 'insufficient funds for gas * price + value: address 0x… have 0 want 21000000000001' } },
  };
  // ethers' summary is the readable one here, and it is not vague.
  assert.equal(rpcMessage(err), 'insufficient funds for intrinsic transaction cost');
});

test('falls back through the shapes an error can take', () => {
  assert.equal(rpcMessage({ error: { message: 'nonce too low' } }), 'nonce too low');
  assert.equal(rpcMessage(new Error('socket hang up')), 'socket hang up');
  assert.equal(rpcMessage(null), 'unknown error');
  assert.equal(rpcMessage(undefined), 'unknown error');
});

test('never returns the useless message on its own', () => {
  // With nothing underneath it there is nothing better to say, but it must not
  // swallow a real message when one exists.
  assert.equal(rpcMessage({ shortMessage: 'could not coalesce error', message: 'x' }), 'x');
});
