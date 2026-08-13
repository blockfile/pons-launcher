'use strict';

// The fire-time re-check. Its whole reason for existing is to add safety WITHOUT
// ever holding up the bundle, so the load-bearing test is the timeout: a slow
// node must let the launch proceed, never block it. The other cases pin that it
// aborts only on a real revert and shrugs off transient errors.

const test = require('node:test');
const assert = require('node:assert');
const { recheckLaunch } = require('./fireV2');

const TX = { to: '0x' + '11'.repeat(20), data: '0x', value: 0n, from: '0x' + '22'.repeat(20) };
const explain = () => 'ExemptionListTooLong';

test('proceeds when the launch still simulates', async () => {
  const rpc = { estimateGas: async () => 500000n };
  const r = await recheckLaunch(rpc, TX, explain);
  assert.equal(r.ok, true);
});

test('ABORTS on a definitive revert (has revert data)', async () => {
  const rpc = {
    estimateGas: async () => {
      throw { data: '0x021c0d43' };
    },
  };
  const r = await recheckLaunch(rpc, TX, explain);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ExemptionListTooLong/);
});

test('PROCEEDS on a transient/network error (no revert data)', async () => {
  const rpc = {
    estimateGas: async () => {
      throw new Error('ETIMEDOUT socket hang up');
    },
  };
  const r = await recheckLaunch(rpc, TX, explain);
  assert.equal(r.ok, true, 'a network blip must not block the bundle');
});

test('ABORTS on a bare revert with NO data (CALL_EXCEPTION)', async () => {
  // A revert()/require() with no message carries no data; only the ethers code
  // marks it as a revert. This used to slip through as "transient".
  const rpc = {
    estimateGas: async () => {
      const e = new Error('execution reverted');
      e.code = 'CALL_EXCEPTION';
      e.data = '0x';
      throw e;
    },
  };
  const r = await recheckLaunch(rpc, TX, explain);
  assert.equal(r.ok, false, 'a bare revert must stop the bundle');
});

test('ABORTS when revert data hides in .revert.data or .value', async () => {
  for (const err of [{ revert: { data: '0x021c0d43' } }, { value: '0x021c0d43' }]) {
    const rpc = { estimateGas: async () => { throw err; } };
    const r = await recheckLaunch(rpc, TX, explain);
    assert.equal(r.ok, false, `revert data in ${JSON.stringify(err)} must abort`);
  }
});

test('NEVER blocks the bundle: a slow node times out and proceeds', async () => {
  // estimateGas that never resolves — the timeout must win.
  const rpc = { estimateGas: () => new Promise(() => {}) };
  const started = Date.now();
  const r = await recheckLaunch(rpc, TX, explain, { timeoutMs: 30 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, true);
  assert.ok(elapsed < 500, `re-check must return promptly on a slow node, took ${elapsed}ms`);
});

test('the timeout is bounded by timeoutMs, not by the node', async () => {
  // Resolves far too late; the cap must fire first.
  const rpc = { estimateGas: () => new Promise((res) => setTimeout(() => res(1n), 5000)) };
  const started = Date.now();
  const r = await recheckLaunch(rpc, TX, explain, { timeoutMs: 40 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  assert.ok(elapsed < 300, `must not wait for the slow node, took ${elapsed}ms`);
});

test('a provider without estimateGas proceeds rather than crashing', async () => {
  const r = await recheckLaunch({}, TX, explain);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});
