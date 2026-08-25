'use strict';

// Unit tests for the v5 (letscash / CashCat) LAUNCH money path.
//
// Fully offline. The factory read/build/decode surface is a FAKE (a duck-typed
// object with the same method names evm/v5/factory exports), the keystore is a
// fake that records every signing request, and the provider is a fake that
// records every broadcast. Nothing here touches a chain.
//
// The load-bearing guarantees, one test each:
//   * params.creator is FORCED to the launcher (CreatorMustBeSender safety).
//   * value = launchFee + firstBuyIn for a native launch.
//   * a launch that will not simulate is REFUSED and NOTHING is signed.
//   * preflight broadcasts NOTHING.
//   * fireLaunch broadcasts, THEN parses the receipt for token/poolId/hook.
//   * the per-pool hook comes from the RECEIPT (authoritative), not the config.
//   * a reverted launch is REPORTED, not swallowed.

const test = require('node:test');
const assert = require('node:assert');
const { Wallet, Transaction, parseEther, formatEther, getAddress, ZeroAddress } = require('ethers');

const { prepareLaunch, fireLaunch, reconcileLaunch, resultFromReceipt } = require('./launch');
const config = require('../config');

const DEV = getAddress('0x' + '11'.repeat(20));
const OTHER = getAddress('0x' + '22'.repeat(20));
const TOKEN = getAddress('0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc'); // ends "cc"
const POOLID = '0x' + 'ab'.repeat(32);
const SALT = '0x' + '00'.repeat(28) + '9ece7da6';
const FACTORY = getAddress(require('../config').letscash.factory);
// A hook that is NOT the config default — so a test can prove the fired result's
// hook came from the receipt, not from config.letscash.hook.
const RECEIPT_HOOK = getAddress('0xEfe669814e5Eec33406Bd50ffa8331618D076aEc');

const FEE = 500000000000000n; // 0.0005 ETH

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeKs(dev = { id: 'dev', address: DEV, role: 'v5dev' }) {
  const ks = { signCalls: [], lastSignable: null };
  ks.walletWithRole = (r) => (r === 'v5dev' ? dev : null);
  ks.walletsWithRole = () => [];
  ks.signer = (id) => {
    ks.signCalls.push(id);
    return {
      signTransaction: async (tx) => {
        ks.lastSignable = tx;
        return '0xSIGNEDRAW';
      },
    };
  };
  return ks;
}

function fakeProvider(over = {}) {
  const p = { broadcasts: [], order: [] };
  p.getBalance = over.getBalance || (async () => 10n ** 20n); // 100 ETH
  p.getTransactionCount = over.getTransactionCount || (async () => 7);
  p.estimateGas = over.estimateGas || (async () => 500000n);
  p.broadcastTransaction =
    over.broadcastTransaction ||
    (async (raw) => {
      p.broadcasts.push(raw);
      p.order.push(`BROADCAST:${raw}`);
      return { hash: `hash:${raw}` };
    });
  p.getTransactionReceipt = over.getTransactionReceipt || (async () => null);
  return p;
}

// A fake factory. `seen` records the inputs load-bearing tests assert on.
function fakeFactory(over = {}, seen = {}) {
  return {
    getConfigs:
      over.getConfigs ||
      (async () => ({
        launchEnabled: true,
        launchFeeWei: FEE.toString(),
        firstConfigId: 1000,
        nextConfigId: 1003,
        configs: [
          {
            configId: 1000,
            quoteAsset: ZeroAddress,
            quoteIsNative: true,
            quoteSymbol: 'ETH',
            enabled: true,
            supply: '1000000000000000000000000000',
            taxLabel: '1%',
            mode: 'creator',
          },
        ],
      })),
    mineSalt:
      over.mineSalt ||
      (async (args) => {
        seen.mineSender = args.sender;
        return { salt: SALT, token: TOKEN };
      }),
    predictToken: over.predictToken || (async () => TOKEN),
    hasVanitySuffix: over.hasVanitySuffix || (() => true),
    buildLaunchTx:
      over.buildLaunchTx ||
      ((args) => {
        seen.build = args;
        const fee = BigInt(args.launchFeeWei);
        const fb = BigInt(args.firstBuyIn || 0);
        const native = getAddress(args.quote) === ZeroAddress;
        return {
          to: FACTORY,
          data: '0x75154d70',
          value: native ? fee + fb : fee,
          quote: getAddress(args.quote),
          firstBuyFromAllowance: !native && fb > 0n,
        };
      }),
    simulateLaunch:
      over.simulateLaunch ||
      (async (_txFields, from) => {
        seen.simFrom = from;
        return { ok: true, token: TOKEN, poolId: POOLID };
      }),
    parseLaunchReceipt: over.parseLaunchReceipt || ((r) => r.__parsed || null),
    explainRevert: over.explainRevert || ((e) => (e && e.reason) || String((e && e.data) || e)),
  };
}

function prepDeps(overFactory = {}, overProvider = {}, seen = {}) {
  const ks = fakeKs();
  const provider = fakeProvider(overProvider);
  return {
    ks,
    provider,
    seen,
    deps: {
      keystore: ks,
      factory: fakeFactory(overFactory, seen),
      provider,
      runner: provider,
      getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    },
  };
}

const baseInput = {
  params: { name: 'Bongo Cat', symbol: 'BONGOCAT', logo: 'ipfs://x', creator: OTHER },
  configId: 1000,
  firstBuyEth: '0.1',
};

// ── prepareLaunch ─────────────────────────────────────────────────────────────

test('params.creator is FORCED to the launcher, ignoring whatever the caller sent', async () => {
  const { deps, seen } = prepDeps();
  const plan = await prepareLaunch(baseInput, deps);
  assert.equal(plan.params.creator, DEV, 'creator must be the v5dev launcher, not the caller value');
  // and every downstream call saw the launcher as the sender
  assert.equal(getAddress(seen.build.params.creator), DEV);
  assert.equal(getAddress(seen.mineSender), DEV);
  assert.equal(getAddress(seen.simFrom), DEV);
});

test('value = launchFee + firstBuyIn for a native (ETH) launch', async () => {
  const { deps, ks } = prepDeps();
  const plan = await prepareLaunch(baseInput, deps);
  const expected = FEE + parseEther('0.1');
  assert.equal(plan.launch.valueEth, formatEther(expected));
  assert.equal(plan.launch.firstBuyEth, formatEther(parseEther('0.1')));
  // the signed transaction carried exactly that value
  assert.equal(ks.lastSignable.value, expected);
});

test('a doomed simulate REFUSES to sign — nothing is signed, the reason is surfaced', async () => {
  const { deps, ks } = prepDeps({
    simulateLaunch: async () => ({ ok: false, reason: 'ConfigDisabled' }),
  });
  await assert.rejects(() => prepareLaunch(baseInput, deps), /nothing was signed.*ConfigDisabled/s);
  assert.equal(ks.signCalls.length, 0, 'the keystore must never be asked to sign a doomed launch');
});

test('the sign guarantee is not vacuous: a valid launch DOES sign exactly once', async () => {
  const { deps, ks } = prepDeps();
  const plan = await prepareLaunch(baseInput, deps);
  assert.equal(ks.signCalls.length, 1);
  assert.equal(plan.launch.raw, '0xSIGNEDRAW');
});

test('preflight broadcasts NOTHING', async () => {
  const { deps, provider } = prepDeps();
  await prepareLaunch(baseInput, deps);
  assert.equal(provider.broadcasts.length, 0, 'prepareLaunch must not broadcast');
});

test('a prediction that disagrees with the factory is refused (would strand the Sell/Bundle steps)', async () => {
  const OTHER_TOKEN = getAddress('0x' + '99'.repeat(19) + 'cc');
  const { deps, ks } = prepDeps({
    // mineSalt says TOKEN, but the factory simulate says a DIFFERENT address.
    simulateLaunch: async () => ({ ok: true, token: OTHER_TOKEN, poolId: POOLID }),
  });
  await assert.rejects(() => prepareLaunch(baseInput, deps), /prediction disagrees/);
  assert.equal(ks.signCalls.length, 0);
});

test('no v5dev launcher wallet is a clear, early error', async () => {
  const ks = fakeKs(null);
  const provider = fakeProvider();
  await assert.rejects(
    () =>
      prepareLaunch(baseInput, {
        keystore: ks,
        factory: fakeFactory(),
        provider,
        runner: provider,
        getFees: async () => ({ maxFeePerGas: 1n }),
      }),
    /no v5dev launcher wallet/
  );
});

test('a config quoted in something other than ETH refuses a non-zero first buy', async () => {
  const { deps } = prepDeps({
    getConfigs: async () => ({
      launchEnabled: true,
      launchFeeWei: FEE.toString(),
      firstConfigId: 1000,
      nextConfigId: 1003,
      configs: [
        {
          configId: 1002,
          quoteAsset: getAddress(require('../config').letscash.usdg),
          quoteIsNative: false,
          quoteSymbol: 'USDG',
          enabled: true,
          supply: '1',
          taxLabel: '3%',
          mode: 'creator',
        },
      ],
    }),
  });
  await assert.rejects(
    () => prepareLaunch({ ...baseInput, configId: 1002 }, deps),
    /non-ETH atomic first buy is not supported/
  );
});

// ── fireLaunch ────────────────────────────────────────────────────────────────

// A real signed launch tx, so Transaction.from() in the fire-time re-check can
// parse it. Signed offline (no provider) from a throwaway key.
async function signedLaunchRaw() {
  const w = Wallet.createRandom();
  return w.signTransaction({
    to: FACTORY,
    data: '0x75154d70',
    value: FEE + parseEther('0.1'),
    nonce: 0,
    gasLimit: 500000n,
    chainId: 4663,
    type: 2,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  });
}

function planFor(raw) {
  return {
    protocol: 'v5',
    token: TOKEN,
    poolId: POOLID,
    configId: 1000,
    launch: { walletId: 'dev', address: DEV, raw },
  };
}

// A receipt carrying the marker parseLaunchReceipt (the fake) reads.
function confirmedReceipt(parsed) {
  return { status: 1, blockNumber: 4242, logs: [], __parsed: parsed };
}

test('fireLaunch broadcasts, THEN awaits the receipt (broadcast precedes any receipt read)', async () => {
  const raw = await signedLaunchRaw();
  const order = [];
  const provider = fakeProvider({
    broadcastTransaction: async (r) => {
      order.push('BROADCAST');
      return { hash: 'H' };
    },
    getTransactionReceipt: async () => {
      order.push('RECEIPT');
      return confirmedReceipt({
        token: TOKEN,
        poolId: POOLID,
        hook: RECEIPT_HOOK,
        firstBuyIn: '100000000000000000',
        firstBuyOut: '68057245261861571047346184',
        creator: DEV,
        feeRecipient: DEV,
        quote: ZeroAddress,
        pool: null,
        poolIdMismatch: false,
      });
    },
  });

  const res = await fireLaunch(planFor(raw), {
    provider,
    factory: fakeFactory(),
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, hash) => rpc.getTransactionReceipt(hash),
  });

  assert.deepEqual(order, ['BROADCAST', 'RECEIPT'], 'the launch is broadcast before its receipt is read');
  assert.equal(res.token, TOKEN);
  assert.equal(res.poolId, POOLID);
  assert.equal(res.firstBuyOut, '68057245261861571047346184');
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.launch.blockNumber, 4242);
});

test('the per-pool HOOK is taken from the receipt, not from the config default', async () => {
  const raw = await signedLaunchRaw();
  const provider = fakeProvider({
    getTransactionReceipt: async () =>
      confirmedReceipt({
        token: TOKEN,
        poolId: POOLID,
        hook: RECEIPT_HOOK, // deliberately NOT config.letscash.hook
        firstBuyOut: '1',
        firstBuyIn: '1',
        creator: DEV,
        feeRecipient: DEV,
        quote: ZeroAddress,
        pool: null,
        poolIdMismatch: false,
      }),
  });
  const res = await fireLaunch(planFor(raw), {
    provider,
    factory: fakeFactory(),
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, hash) => rpc.getTransactionReceipt(hash),
  });
  assert.equal(res.hook, RECEIPT_HOOK);
  assert.notEqual(res.hook.toLowerCase(), getAddress(require('../config').letscash.hook).toLowerCase());
});

test('a reverted launch is REPORTED, not swallowed — and nothing is parsed', async () => {
  const raw = await signedLaunchRaw();
  let parsed = false;
  const provider = fakeProvider({
    getTransactionReceipt: async () => ({ status: 0, blockNumber: 9, logs: [] }),
  });
  const res = await fireLaunch(planFor(raw), {
    provider,
    factory: fakeFactory(),
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, hash) => rpc.getTransactionReceipt(hash),
    parseLaunchReceipt: () => {
      parsed = true;
      return null;
    },
  });
  assert.equal(res.launch.status, 'reverted');
  assert.match(res.reverted, /reverted/);
  assert.equal(res.hook, null);
  assert.equal(parsed, false, 'a reverted receipt is not parsed for a token/pool that was never created');
});

test('the fire-time re-check aborts on a definitive revert — nothing is broadcast', async () => {
  const raw = await signedLaunchRaw();
  const provider = fakeProvider({
    estimateGas: async () => {
      const err = new Error('execution reverted');
      err.data = '0x199f5f57'; // QuoteNotApproved()
      throw err;
    },
  });
  await assert.rejects(
    () =>
      fireLaunch(planFor(raw), {
        provider,
        factory: fakeFactory(),
        dryRun: false,
        warmPool: async () => {},
        waitForReceipt: (rpc, hash) => rpc.getTransactionReceipt(hash),
      }),
    /reverts as of now, so nothing was broadcast/
  );
  assert.equal(provider.broadcasts.length, 0);
});

test('a dry run broadcasts nothing and reports where the launch would land', async () => {
  const provider = fakeProvider();
  const res = await fireLaunch(planFor('0xdeadbeef'), {
    provider,
    factory: fakeFactory(),
    dryRun: true,
    warmPool: async () => {},
  });
  assert.equal(provider.broadcasts.length, 0);
  assert.equal(res.simulated, true);
  assert.equal(res.token, TOKEN);
  assert.equal(res.launch.status, 'simulated');
});

test('fireLaunch refuses a plan with no signed launch', async () => {
  await assert.rejects(
    () =>
      fireLaunch(
        { protocol: 'v5', token: TOKEN, launch: { address: DEV } },
        { provider: fakeProvider(), factory: fakeFactory(), dryRun: false, warmPool: async () => {} }
      ),
    /no signed launch/
  );
});

// ── end-to-end: what prepareLaunch SIGNS is what fireLaunch broadcasts ─────────
// The other tests stub the signer to a canned string, so the money fields on the
// ACTUAL signed bytes, and the fire-time re-check that must parse them, are never
// exercised together. Here a real ethers Wallet signs, so the raw is a genuine tx
// that Transaction.from() decodes and the recheck actually runs against.
function realSigningKs(wallet, dev = { id: 'dev', address: DEV, role: 'v5dev' }) {
  const ks = { signCalls: [] };
  ks.walletWithRole = (r) => (r === 'v5dev' ? dev : null);
  ks.walletsWithRole = () => [];
  ks.signer = (id) => {
    ks.signCalls.push(id);
    return wallet; // a real Wallet — signs offline
  };
  return ks;
}

test('the SIGNED tx carries the exact value + nonce (not just the intermediate signable)', async () => {
  const wallet = Wallet.createRandom();
  const ks = realSigningKs(wallet);
  const provider = fakeProvider(); // getTransactionCount → 7
  const plan = await prepareLaunch(baseInput, {
    keystore: ks,
    factory: fakeFactory(),
    provider,
    runner: provider,
    getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
  });

  // Decode the REAL signed bytes — this is what actually leaves the server.
  const tx = Transaction.from(plan.launch.raw);
  assert.equal(getAddress(tx.to), FACTORY, 'signed tx must target the factory');
  assert.equal(tx.value, FEE + parseEther('0.1'), 'signed value = launchFee + firstBuyIn');
  assert.equal(tx.nonce, 7, 'signed at the pending nonce the provider reported');
  assert.equal(Number(tx.chainId), config.chainId, 'signed for this chain');
  assert.equal(getAddress(tx.from), getAddress(wallet.address), 'signed by the launcher key');
});

test('fireLaunch runs the fire-time recheck against the REAL signed tx (parses value from it)', async () => {
  const wallet = Wallet.createRandom();
  const ks = realSigningKs(wallet);
  const prepProvider = fakeProvider();
  const plan = await prepareLaunch(baseInput, {
    keystore: ks,
    factory: fakeFactory(),
    provider: prepProvider,
    runner: prepProvider,
    getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
  });

  // A provider whose estimateGas records the tx the recheck reconstructs from raw.
  let rechecked = null;
  const fireProvider = fakeProvider({
    estimateGas: async (tx) => {
      rechecked = tx;
      return 500000n;
    },
    getTransactionReceipt: async () =>
      confirmedReceipt({
        token: TOKEN,
        poolId: POOLID,
        hook: RECEIPT_HOOK,
        firstBuyIn: '1',
        firstBuyOut: '1',
        creator: DEV,
        feeRecipient: DEV,
        quote: ZeroAddress,
        pool: null,
        poolIdMismatch: false,
      }),
  });

  const res = await fireLaunch(plan, {
    provider: fireProvider,
    factory: fakeFactory(),
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, hash) => rpc.getTransactionReceipt(hash),
  });

  assert.ok(rechecked, 'the recheck must actually run — Transaction.from(raw) parsed, not silently skipped');
  assert.equal(rechecked.value, FEE + parseEther('0.1'), 'the recheck sees the signed value, from the raw bytes');
  assert.equal(getAddress(rechecked.to), FACTORY);
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.hook, RECEIPT_HOOK);
});

// ── reconcileLaunch: the recovery path for a stranded 'pending' launch ─────────
test('reconcileLaunch reports confirmed and reads the authoritative hook from the receipt', async () => {
  const provider = fakeProvider({
    getTransactionReceipt: async () =>
      confirmedReceipt({
        token: TOKEN,
        poolId: POOLID,
        hook: RECEIPT_HOOK,
        firstBuyIn: '1',
        firstBuyOut: '2',
        creator: DEV,
        feeRecipient: DEV,
        quote: ZeroAddress,
        pool: null,
        poolIdMismatch: false,
      }),
  });
  const res = await reconcileLaunch(
    { hash: 'H', token: TOKEN, poolId: POOLID },
    { provider, factory: fakeFactory() }
  );
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.hook, RECEIPT_HOOK, 'the reconciled hook is the receipt hook');
  assert.equal(res.hookResolved, true);
  assert.equal(res.token, TOKEN);
});

test('reconcileLaunch reports reverted without parsing, keeping the predicted token only as a breadcrumb', async () => {
  const provider = fakeProvider({
    getTransactionReceipt: async () => ({ status: 0, blockNumber: 5, logs: [] }),
  });
  let parsed = false;
  const res = await reconcileLaunch(
    { hash: 'H', token: TOKEN, poolId: POOLID },
    { provider, factory: fakeFactory(), parseLaunchReceipt: () => ((parsed = true), null) }
  );
  assert.equal(res.launch.status, 'reverted');
  assert.equal(res.hook, null);
  assert.equal(parsed, false, 'a reverted receipt is never parsed');
  assert.equal(res.token, TOKEN, 'the predicted token rides along as an explorer breadcrumb only');
});

test('reconcileLaunch still-pending when the receipt has not appeared', async () => {
  const provider = fakeProvider({ getTransactionReceipt: async () => null });
  const res = await reconcileLaunch({ hash: 'H', token: TOKEN }, { provider, factory: fakeFactory() });
  assert.equal(res.launch.status, 'pending');
  assert.match(res.pending, /did not appear/);
});

test('reconcileLaunch requires a hash', async () => {
  await assert.rejects(() => reconcileLaunch({}, { provider: fakeProvider() }), /hash is required/);
});

// ── a LOST broadcast response must still park (not throw past the guard) ────────
test('a broadcast that throws AFTER the tx may have landed returns pending, not a throw', async () => {
  const raw = await signedLaunchRaw();
  const realHash = Transaction.from(raw).hash;
  const provider = fakeProvider({
    broadcastTransaction: async () => {
      // The node accepted the tx, but the HTTP response was lost — a real class of
      // busy-RPC failure. We must NOT let this throw past the caller's park.
      throw new Error('timeout waiting for eth_sendRawTransaction response');
    },
  });
  const res = await fireLaunch(planFor(raw), {
    provider,
    factory: fakeFactory(),
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, hash) => rpc.getTransactionReceipt(hash),
  });
  assert.equal(res.launch.status, 'pending', 'a lost broadcast response is treated as in-flight, so the wallet parks');
  assert.equal(res.launch.hash, realHash, 'the deterministic signed-tx hash is carried, so /resolve can find it');
  assert.match(res.pending, /broadcast response was lost/);
});

// ── a DROPPED (evicted) tx must be recoverable, not park forever ───────────────
test('reconcileLaunch reports dropped when the tx left the mempool without mining (nonce freed)', async () => {
  const provider = fakeProvider({
    getTransactionReceipt: async () => null, // never mined
    getTransactionCount: async () => 5, // next nonce == the launch nonce ⇒ tx is gone
  });
  const res = await reconcileLaunch(
    { hash: '0xH', address: DEV, nonce: 5, token: TOKEN },
    { provider, factory: fakeFactory() }
  );
  assert.equal(res.launch.status, 'dropped');
  assert.match(res.dropped, /dropped/);
});

test('reconcileLaunch stays pending while the tx is still in the mempool (nonce still occupied)', async () => {
  const provider = fakeProvider({
    getTransactionReceipt: async () => null,
    getTransactionCount: async () => 6, // next nonce is past the launch nonce ⇒ tx still pending at 5
  });
  const res = await reconcileLaunch(
    { hash: '0xH', address: DEV, nonce: 5, token: TOKEN },
    { provider, factory: fakeFactory() }
  );
  assert.equal(res.launch.status, 'pending', 'the tx still occupies its nonce, so it is genuinely in flight');
});

// ── resultFromReceipt honesty (the shape the route persists) ───────────────────
test('a confirmed-but-unparsed receipt is flagged hookResolved:false, not a silent null hook', () => {
  const res = resultFromReceipt(
    { status: 1, blockNumber: 1, logs: [] },
    { token: TOKEN, poolId: POOLID },
    'H',
    { parseReceipt: () => null }
  );
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.hook, null);
  assert.equal(res.hookResolved, false, 'a null hook on a confirmed launch must announce itself');
  assert.match(res.warning, /no TokenLaunched/);
});
