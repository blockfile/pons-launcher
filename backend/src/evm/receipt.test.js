'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { waitForReceipt } = require('./receipt');

test('returns the receipt as soon as it appears', async () => {
  let calls = 0;
  const rpc = {
    async getTransactionReceipt() {
      calls++;
      return calls < 3 ? null : { status: 1, blockNumber: 42 };
    },
  };
  const started = Date.now();
  const r = await waitForReceipt(rpc, '0xabc', { pollMs: 5, timeoutMs: 1000 });
  assert.equal(r.blockNumber, 42);
  assert.equal(calls, 3);
  // The whole point: it must not wait anywhere near ethers' 4s default.
  assert.ok(Date.now() - started < 500, 'should return promptly, not on a slow poll');
});

test('a blip mid-poll does not abort the wait', async () => {
  let calls = 0;
  const rpc = {
    async getTransactionReceipt() {
      calls++;
      if (calls === 1) throw new Error('method not found');
      return { status: 1, blockNumber: 7 };
    },
  };
  const r = await waitForReceipt(rpc, '0xabc', { pollMs: 1, timeoutMs: 1000 });
  assert.equal(r.blockNumber, 7);
});

test('gives up with null rather than hanging forever', async () => {
  const rpc = { async getTransactionReceipt() { return null; } };
  const r = await waitForReceipt(rpc, '0xabc', { pollMs: 1, timeoutMs: 30 });
  // null lets the caller report "launch never landed" instead of blocking a
  // request until something times out further up the stack.
  assert.equal(r, null);
});
