'use strict';

const test = require('node:test');
const assert = require('node:assert');
const trade = require('./trade');
const swap = require('../evm/v5/swap');

// A syntactically-valid address that is NOT one of letscash's known hooks.
const DECOY_HOOK = '0x000000000000000000000000000000000000dEaD';
const TOKEN = '0x1111111111111111111111111111111111111111';

// ── the dusting guard (#1): an operator-supplied hook cannot bypass the allowlist ──

test('resolvePoolKey with restrictToKnown REFUSES an unknown hook before touching the chain', async () => {
  // The membership check runs before any RPC, so no provider is needed. This is the
  // load-bearing assertion: a decoy ERC-20 paired with the attacker's own hook seeds a
  // real, initialised, liquid pool that would otherwise satisfy "a pool exists". Pinning
  // the hook to the known-letscash set is what stops the honeypot.
  await assert.rejects(
    () => swap.resolvePoolKey({ token: TOKEN, quote: 'eth', hook: DECOY_HOOK, restrictToKnown: true }, {}),
    /not a known letscash hook/
  );
});

test('WITHOUT restrictToKnown the same unknown hook is probed, not refused (v5 launch path is unchanged)', async () => {
  // No allowlist error — it proceeds to probe the chain (and then fails for a different
  // reason: there is no provider / no live pool). The point is only that the refusal is
  // opt-in, so v5, which reads a trusted hook from its own launch receipt, still works
  // even for a brand-new hook deployment.
  const noRpc = { provider: { call: async () => { throw new Error('no rpc in this test'); } } };
  await assert.rejects(
    () => swap.resolvePoolKey({ token: TOKEN, quote: 'eth', hook: DECOY_HOOK }, noRpc),
    (err) => !/not a known letscash hook/.test(err.message)
  );
});

test('v6 readPool passes restrictToKnown:true, so the guard is always on for v6', async () => {
  let seen = null;
  const fakeSwap = {
    resolvePoolKey: async (args) => {
      seen = args;
      return { poolKey: { x: 1 }, poolId: '0xpid', hook: args.hook, liquidity: 1n };
    },
  };
  await trade.readPool({ token: TOKEN, hook: '0x2222222222222222222222222222222222222222' }, { swap: fakeSwap, rpc: {} });
  assert.equal(seen.restrictToKnown, true, 'readPool must pin the hook to the known-letscash set');
});

test('readPool REFUSES a token+decoy-hook pair end to end (the guard, wired)', async () => {
  // Through the real swap: an operator pasting { token: decoy, hook: attacker } is
  // rejected before any approval could ever be signed.
  await assert.rejects(
    () => trade.readPool({ token: TOKEN, hook: DECOY_HOOK }),
    /not a known letscash hook/
  );
});
