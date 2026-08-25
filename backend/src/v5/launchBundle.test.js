'use strict';

// Unit tests for the COMBINED launch+bundle orchestrator (v5/launchBundle.js).
// Fully offline: the launch and buy paths are injected, so this exercises ONLY
// the compose logic — ordering, the confirm gate, the keep-the-launch guards, and
// that the bundle is signed against the REAL receipt pool. The underlying paths
// have their own tests (launch.test.js, buy.test.js).

const test = require('node:test');
const assert = require('node:assert');
const { getAddress } = require('ethers');

const { launchThenBundle } = require('./launchBundle');

const TOKEN = getAddress('0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc');
const HOOK = getAddress('0xEfe669814e5Eec33406Bd50ffa8331618D076aEc');
const USDG = getAddress('0x1234567890123456789012345678901234567890');

// A fireLaunch result, confirmed by default; override any field.
function launchResult(over = {}) {
  return {
    protocol: 'v5',
    token: TOKEN,
    poolId: '0x' + 'ab'.repeat(32),
    hook: HOOK,
    hookResolved: true,
    quote: '0x0000000000000000000000000000000000000000', // native ETH
    firstBuyOut: '1000',
    launch: { hash: '0xlaunch', status: 'confirmed', blockNumber: 9 },
    ...over,
  };
}

// Build injectable deps that record what the compose layer called.
function deps(over = {}) {
  const calls = { prepareLaunch: [], fireLaunch: [], prepareBuys: [], fireBuys: [] };
  const d = {
    keystore: {},
    prepareLaunch: async (input) => {
      calls.prepareLaunch.push(input);
      return over.launchPlan || { launch: { walletId: 'dev', address: '0xdev', nonce: 3, firstBuyEth: '0.05' }, token: TOKEN, params: { symbol: 'CAT' }, quote: '0x0', configId: 1000 };
    },
    fireLaunch: async (plan) => {
      calls.fireLaunch.push(plan);
      return over.launchResult || launchResult();
    },
    prepareBundleBuys: async (input) => {
      calls.prepareBuys.push(input);
      if (over.prepareBuysThrows) throw new Error(over.prepareBuysThrows);
      return over.buyPlan || { kind: 'bundle-buy', token: input.token, symbol: 'CAT', walletCount: 2, totalEth: '0.03', buys: [{ walletId: 'b1', raw: '0xr1' }, { walletId: 'b2', raw: '0xr2' }] };
    },
    fireBundleBuys: async (plan) => {
      calls.fireBuys.push(plan);
      return over.buyResult || { kind: 'bundle-buy', token: plan.token, symbol: 'CAT', bought: 2, failed: 0, pending: 0, buys: [] };
    },
  };
  return { d, calls };
}

const BASE = {
  params: { name: 'Cat', symbol: 'CAT' },
  configId: 1000,
  firstBuyEth: '0.05',
  buys: [
    { walletId: 'b1', amountEth: '0.01' },
    { walletId: 'b2', amountEth: '0.02' },
  ],
};

test('confirmed launch → fires the bundle against the RECEIPT token + hook', async () => {
  const { d, calls } = deps();
  const out = await launchThenBundle(BASE, d);
  assert.equal(out.launch.launch.status, 'confirmed');
  assert.equal(calls.prepareBuys.length, 1);
  const buyInput = calls.prepareBuys[0];
  assert.equal(getAddress(buyInput.token), TOKEN, 'buys target the launched token');
  assert.equal(getAddress(buyInput.hook), HOOK, 'buys are pinned to the receipt hook');
  assert.equal(buyInput.quote, 'eth');
  assert.equal(buyInput.buys.length, 2);
  assert.ok(out.bundle && out.bundle.bought === 2);
  assert.equal(out.bundleSkipped, null);
});

test('the launch runs BEFORE the bundle, and the bundle only after a confirm', async () => {
  const order = [];
  const { d } = deps();
  const wrapped = {
    ...d,
    fireLaunch: async (p) => { order.push('launch'); return launchResult(); },
    fireBundleBuys: async (p) => { order.push('bundle'); return { kind: 'bundle-buy', bought: 2, failed: 0, pending: 0, buys: [] }; },
  };
  await launchThenBundle(BASE, wrapped);
  assert.deepEqual(order, ['launch', 'bundle']);
});

test('the bundle fields are stripped from the launch input', async () => {
  const { d, calls } = deps();
  await launchThenBundle({ ...BASE, slippageBps: 300, buyGas: 800000, confirm: true }, d);
  const launchInput = calls.prepareLaunch[0];
  assert.equal(launchInput.buys, undefined, 'buys never reach prepareLaunch');
  assert.equal(launchInput.slippageBps, undefined, 'slippageBps is the bundle floor, not the launch first-buy floor');
  assert.equal(launchInput.buyGas, undefined);
  assert.equal(launchInput.confirm, undefined, 'confirm is a route gate, not a launch field');
  assert.equal(launchInput.configId, 1000, 'the real launch fields pass through');
  // …and slippageBps DID reach the bundle.
  assert.equal(calls.prepareBuys[0].slippageBps, 300);
  assert.equal(calls.prepareBuys[0].buyGas, 800000);
});

test('a reverted launch fires no bundle', async () => {
  const { d, calls } = deps({ launchResult: launchResult({ launch: { hash: '0xl', status: 'reverted', blockNumber: null }, hook: null }) });
  const out = await launchThenBundle(BASE, d);
  assert.equal(out.bundle, null);
  assert.equal(out.bundleSkipped, null, 'a non-confirmed launch is "nothing to bundle", not a skip');
  assert.equal(calls.prepareBuys.length, 0);
  assert.equal(calls.fireBuys.length, 0);
});

test('a pending (lost-receipt) launch fires no bundle', async () => {
  const { d, calls } = deps({ launchResult: launchResult({ launch: { hash: '0xl', status: 'pending', blockNumber: null } }) });
  const out = await launchThenBundle(BASE, d);
  assert.equal(out.bundle, null);
  assert.equal(calls.prepareBuys.length, 0);
});

test('no buys → launch-only, no bundle', async () => {
  const { d, calls } = deps();
  const out = await launchThenBundle({ ...BASE, buys: [] }, d);
  assert.equal(out.bundle, null);
  assert.equal(out.bundleSkipped, null);
  assert.equal(calls.prepareBuys.length, 0);
});

test('all-zero buys are treated as no bundle', async () => {
  const { d, calls } = deps();
  const out = await launchThenBundle({ ...BASE, buys: [{ walletId: 'b1', amountEth: '0' }, { walletId: 'b2', amountEth: '0.0' }] }, d);
  assert.equal(out.bundle, null);
  assert.equal(calls.prepareBuys.length, 0);
});

test("an 'all − gas' buy (no amountEth) survives the filter and reaches the bundle", async () => {
  const { d, calls } = deps();
  // The bug the review caught: an 'all' entry has no amountEth, so an amount>0
  // filter would silently drop it and the wallet would never buy.
  const out = await launchThenBundle({ ...BASE, buys: [{ walletId: 'b1', mode: 'all' }] }, d);
  assert.equal(calls.prepareBuys.length, 1, 'the all-gas bundle still fires');
  assert.equal(calls.prepareBuys[0].buys.length, 1);
  assert.equal(calls.prepareBuys[0].buys[0].mode, 'all');
  assert.ok(out.bundle, 'the bundle result comes back');
});

test('confirmed launch but UNREADABLE hook → keeps the launch, skips the bundle with a reason', async () => {
  const { d, calls } = deps({ launchResult: launchResult({ hook: null, hookResolved: false }) });
  const out = await launchThenBundle(BASE, d);
  assert.equal(out.launch.launch.status, 'confirmed');
  assert.equal(out.bundle, null);
  assert.match(out.bundleSkipped, /hook could not be read/);
  assert.equal(calls.prepareBuys.length, 0, 'never sign a buy against an unpinned pool');
});

test('confirmed USDG-quoted launch → keeps the launch, skips the ETH-only bundle', async () => {
  const { d, calls } = deps({ launchResult: launchResult({ quote: USDG }) });
  const out = await launchThenBundle(BASE, d);
  assert.equal(out.launch.launch.status, 'confirmed');
  assert.equal(out.bundle, null);
  assert.match(out.bundleSkipped, /ETH-only/);
  assert.equal(calls.prepareBuys.length, 0);
});

test('a confirmed launch is NEVER discarded when the bundle prep throws', async () => {
  const { d, calls } = deps({ prepareBuysThrows: 'no v5bundle wallets to buy from' });
  const out = await launchThenBundle(BASE, d);
  assert.equal(out.launch.launch.status, 'confirmed', 'the launch success is banked');
  assert.equal(out.bundle, null);
  assert.match(out.bundleSkipped, /could not be completed: no v5bundle wallets/);
  assert.equal(calls.fireBuys.length, 0, 'nothing is fired when prep failed');
});

test('a confirmed launch is NEVER discarded when the bundle FIRE throws (post-confirm hardening)', async () => {
  const { d } = deps();
  // The one path the money-safety review flagged: prepare succeeds, then the
  // broadcast/fire throws. The confirmed, fee-spent launch must survive.
  const wrapped = { ...d, fireBundleBuys: async () => { throw new Error('rpc exploded mid-broadcast'); } };
  const out = await launchThenBundle(BASE, wrapped);
  assert.equal(out.launch.launch.status, 'confirmed', 'the launch success is banked even if the fire throws');
  assert.equal(out.bundle, null);
  assert.match(out.bundleSkipped, /could not be completed: rpc exploded/);
});
