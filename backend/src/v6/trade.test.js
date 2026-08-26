'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getAddress } = require('ethers');
const trade = require('./trade');
const factory = require('../evm/v5/factory');

const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const FEE_RECIP = '0x3333333333333333333333333333333333333333';
// A per-token vanity hook — deliberately NOT one of swap.js's known candidateHooks,
// to prove the guard accepts the hook the FACTORY assigned, not an allowlist member.
const VANITY_HOOK = '0x000000000000000000000000000000000000cccc';
const DECOY_HOOK = '0x000000000000000000000000000000000000dead';

// ── readPool is a PROVENANCE guard: the token must be a genuine letscash launch ──

test('readPool REFUSES a token the factory never launched (a decoy ERC-20)', async () => {
  const fakeFactory = { findLaunch: async () => null };
  const fakeSwap = {
    resolvePoolKey: async () => {
      throw new Error('resolvePoolKey must NOT be reached for a token with no launch');
    },
  };
  await assert.rejects(
    () => trade.readPool({ token: TOKEN }, { factory: fakeFactory, swap: fakeSwap, rpc: {} }),
    /not a letscash launch/
  );
});

test('readPool ACCEPTS a genuine launch and resolves under the FACTORY hook — a vanity hook works', async () => {
  let resolvedWith = null;
  const fakeFactory = {
    findLaunch: async () => ({ token: TOKEN, creator: CREATOR, poolId: '0xpid', hook: VANITY_HOOK, configId: 3 }),
  };
  const fakeSwap = {
    resolvePoolKey: async (args) => {
      resolvedWith = args;
      return { poolKey: { x: 1 }, poolId: '0xpid', hook: args.hook, liquidity: 5n };
    },
  };
  const pool = await trade.readPool({ token: TOKEN }, { factory: fakeFactory, swap: fakeSwap, rpc: {} });
  assert.equal(resolvedWith.hook, VANITY_HOOK, 'the pool is resolved under the hook the FACTORY named, not an allowlist member');
  assert.equal(pool.hook, VANITY_HOOK);
  assert.equal(pool.creator, CREATOR);
});

test('readPool IGNORES any operator-supplied hook — only the factory hook is trusted', async () => {
  let resolvedWith = null;
  const fakeFactory = {
    findLaunch: async () => ({ token: TOKEN, creator: CREATOR, poolId: '0xp', hook: VANITY_HOOK, configId: 1 }),
  };
  const fakeSwap = {
    resolvePoolKey: async (args) => {
      resolvedWith = args;
      return { poolKey: {}, poolId: '0xp', hook: args.hook, liquidity: 1n };
    },
  };
  // A bogus attacker hook passed in the (now-ignored) field must never reach resolvePoolKey.
  await trade.readPool({ token: TOKEN, hook: DECOY_HOOK }, { factory: fakeFactory, swap: fakeSwap, rpc: {} });
  assert.equal(resolvedWith.hook, VANITY_HOOK, 'operator hook ignored; factory hook used');
});

// ── findLaunch — the on-chain provenance lookup ─────────────────────────────────

const LAUNCH_EVENT = factory.FACTORY_IFACE.getEvent('TokenLaunched');

// A valid TokenLaunched log, encoded through the real interface so parseLog decodes it.
function launchLog({ token = TOKEN, creator = CREATOR, poolId, hook = VANITY_HOOK }) {
  const { data, topics } = factory.FACTORY_IFACE.encodeEventLog(LAUNCH_EVENT, [
    token, creator, poolId, 3n, 0n, 0n, hook, FEE_RECIP,
  ]);
  return { data, topics };
}

test('findLaunch returns the parsed launch (authoritative hook, creator, poolId) from a matching log', async () => {
  const poolId = '0x' + 'ab'.repeat(32);
  const rpc = { getBlockNumber: async () => 1000, getLogs: async () => [launchLog({ poolId })] };
  const out = await factory.findLaunch(TOKEN, { provider: rpc });
  assert.equal(out.hook, getAddress(VANITY_HOOK));
  assert.equal(out.creator, getAddress(CREATOR));
  assert.equal(out.poolId, poolId);
  assert.equal(out.token, getAddress(TOKEN));
});

test('findLaunch returns null when the factory has no TokenLaunched for the token', async () => {
  const rpc = { getBlockNumber: async () => 1000, getLogs: async () => [] };
  assert.equal(await factory.findLaunch(TOKEN, { provider: rpc }), null);
});

test('findLaunch falls back to a windowed, splitting scan when the node refuses the whole range', async () => {
  const poolId = '0x' + 'cd'.repeat(32);
  let calls = 0;
  const rpc = {
    getBlockNumber: async () => 1_000_000,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls += 1;
      // Refuse the 0..head fast path; answer the head-adjacent window with the launch.
      if (fromBlock === 0 && toBlock === 1_000_000) throw new Error('range too wide');
      if (toBlock === 1_000_000) return [launchLog({ poolId })];
      return [];
    },
  };
  const out = await factory.findLaunch(TOKEN, { provider: rpc });
  assert.equal(out.poolId, poolId);
  assert.ok(calls >= 2, 'fell back past the refused full-range call to a bounded window');
});
