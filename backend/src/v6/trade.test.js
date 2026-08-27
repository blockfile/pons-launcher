'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getAddress } = require('ethers');
const trade = require('./trade');
const factory = require('../evm/v5/factory');

const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const FEE_RECIP = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444'; // a legit tokenMaster
const LEGIT_HOOK = '0x0000000000000000000000000000000000000075';
// A per-token vanity hook — deliberately NOT in the legit set, to exercise the fallback.
const VANITY_HOOK = '0x000000000000000000000000000000000000cccc';
const DECOY_HOOK = '0x000000000000000000000000000000000000dead';

// ── readPool is a FAST PROVENANCE guard: eth_getCode clone check + legit-hook probe ──

test('readPool REFUSES a decoy — its code is not an EIP-1167 clone of a tokenMaster', async () => {
  const fakeFactory = {
    legitSets: async () => ({ tokenMasters: new Set(), hooks: new Set([LEGIT_HOOK]) }),
    verifyProvenanceByCode: async () => ({ ok: false, reason: 'not an EIP-1167 clone of a letscash tokenMaster' }),
  };
  const fakeSwap = { resolvePoolKey: async () => ({ poolKey: {}, poolId: '0xp', hook: LEGIT_HOOK, liquidity: 1n }) };
  await assert.rejects(
    () => trade.readPool({ token: TOKEN }, { factory: fakeFactory, swap: fakeSwap, rpc: {} }),
    /not a letscash launch/
  );
});

test('readPool ACCEPTS a genuine clone and resolves by PROBING the legit hook set (no findLaunch)', async () => {
  let resolvedWith = null;
  const fakeFactory = {
    legitSets: async () => ({ tokenMasters: new Set([IMPL.toLowerCase()]), hooks: new Set([LEGIT_HOOK]) }),
    verifyProvenanceByCode: async () => ({ ok: true, impl: IMPL }),
    findLaunch: async () => {
      throw new Error('findLaunch must NOT be reached when the legit-hook probe finds a pool');
    },
  };
  const fakeSwap = {
    resolvePoolKey: async (args, resolveDeps) => {
      resolvedWith = { args, deps: resolveDeps };
      return { poolKey: { x: 1 }, poolId: '0xpid', hook: LEGIT_HOOK, liquidity: 5n };
    },
  };
  const pool = await trade.readPool({ token: TOKEN }, { factory: fakeFactory, swap: fakeSwap, rpc: {} });
  assert.equal(pool.hook, LEGIT_HOOK);
  assert.deepEqual(resolvedWith.deps.candidateHooks, [LEGIT_HOOK], 'the probe is restricted to the legit hook set');
  assert.equal(resolvedWith.args.hook, undefined, 'no explicit hook — it PROBES the legit set');
});

test('readPool IGNORES any operator-supplied hook — it only probes the legit set', async () => {
  let resolvedWith = null;
  const fakeFactory = {
    legitSets: async () => ({ tokenMasters: new Set([IMPL.toLowerCase()]), hooks: new Set([LEGIT_HOOK]) }),
    verifyProvenanceByCode: async () => ({ ok: true, impl: IMPL }),
  };
  const fakeSwap = {
    resolvePoolKey: async (args) => {
      resolvedWith = args;
      return { poolKey: {}, poolId: '0xp', hook: LEGIT_HOOK, liquidity: 1n };
    },
  };
  await trade.readPool({ token: TOKEN, hook: DECOY_HOOK }, { factory: fakeFactory, swap: fakeSwap, rpc: {} });
  assert.notEqual(resolvedWith.hook, DECOY_HOOK, 'operator hook never reaches resolvePoolKey');
  assert.equal(resolvedWith.hook, undefined, 'the probe forwards no explicit hook');
});

test('readPool falls back to findLaunch when no pool exists under a legit hook (vanity hook)', async () => {
  let launchHook = null;
  const fakeFactory = {
    legitSets: async () => ({ tokenMasters: new Set([IMPL.toLowerCase()]), hooks: new Set([LEGIT_HOOK]) }),
    verifyProvenanceByCode: async () => ({ ok: true, impl: IMPL }),
    findLaunch: async () => ({ token: TOKEN, creator: CREATOR, poolId: '0xvp', hook: VANITY_HOOK, configId: 2 }),
    refreshLegitSets: () => {},
  };
  const fakeSwap = {
    resolvePoolKey: async (args, resolveDeps) => {
      if (resolveDeps && resolveDeps.candidateHooks) throw new Error('no pool under the legit hooks'); // probe fails
      launchHook = args.hook; // the fallback passes the discovered vanity hook explicitly
      return { poolKey: {}, poolId: '0xvp', hook: args.hook, liquidity: 3n };
    },
  };
  const pool = await trade.readPool({ token: TOKEN }, { factory: fakeFactory, swap: fakeSwap, rpc: {} });
  assert.equal(pool.hook, VANITY_HOOK);
  assert.equal(pool.creator, CREATOR);
  assert.equal(launchHook, VANITY_HOOK, 'the fallback resolves under the discovered vanity hook');
});

test('readPool does not hang — the findLaunch fallback is time-bounded', async () => {
  const fakeFactory = {
    legitSets: async () => ({ tokenMasters: new Set([IMPL.toLowerCase()]), hooks: new Set([LEGIT_HOOK]) }),
    verifyProvenanceByCode: async () => ({ ok: true, impl: IMPL }),
    findLaunch: () => new Promise(() => {}), // never resolves
    refreshLegitSets: () => {},
  };
  const fakeSwap = {
    resolvePoolKey: async (args, resolveDeps) => {
      if (resolveDeps && resolveDeps.candidateHooks) throw new Error('no pool under the legit hooks');
      return { poolKey: {}, poolId: '0x', hook: args.hook, liquidity: 1n };
    },
  };
  await assert.rejects(
    () => trade.readPool({ token: TOKEN }, { factory: fakeFactory, swap: fakeSwap, rpc: {}, findLaunchTimeoutMs: 40 }),
    /timed out/
  );
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

// ── hasRecentSell — the on-chain sellability check (used when the quoter can't price) ──

const { Interface } = require('ethers');
const SWAP = new Interface([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
function swapLog(poolId, amount0) {
  const { data, topics } = SWAP.encodeEventLog(SWAP.getEvent('Swap'), [
    poolId, '0x0000000000000000000000000000000000000abc', amount0, -amount0, 0n, 0n, 0, 0,
  ]);
  return { data, topics };
}
const POOL = { poolId: '0x' + 'ab'.repeat(32) };

test('hasRecentSell returns true when a Swap moved ETH OUT (amount0 > 0 = a sell)', async () => {
  const rpc = { getBlockNumber: async () => 1000, getLogs: async () => [swapLog(POOL.poolId, 5n)] };
  assert.equal(await trade.hasRecentSell({ pool: POOL }, { rpc }), true);
});

test('hasRecentSell returns false when the pool shows only buys (amount0 < 0)', async () => {
  const rpc = { getBlockNumber: async () => 1000, getLogs: async () => [swapLog(POOL.poolId, -5n)] };
  assert.equal(await trade.hasRecentSell({ pool: POOL }, { rpc }), false);
});

test('hasRecentSell returns false when the pool has no swaps at all', async () => {
  const rpc = { getBlockNumber: async () => 1000, getLogs: async () => [] };
  assert.equal(await trade.hasRecentSell({ pool: POOL }, { rpc }), false);
});

test('hasRecentSell THROWS (inconclusive) when the whole-range call is refused — not false', async () => {
  const rpc = { getBlockNumber: async () => 1000, getLogs: async () => { throw new Error('range refused'); } };
  await assert.rejects(() => trade.hasRecentSell({ pool: POOL }, { rpc }));
});
