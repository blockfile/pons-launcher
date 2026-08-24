'use strict';

// prepareV2 in ETH-zap bundle-funding mode.
//
// The mode exists so a bundle can buy a NON-ETH-paired token while every wallet
// holds only ETH. What these assert is the delta from the pre-signed pair path:
//
//   1. Buys are sized in ETH, from each wallet's NATIVE balance (like the native
//      path), not from a pair-token balance.
//   2. Buys are NOT pre-signed — the swap-zap route bakes in recipient=taker and
//      calls the token's curve, which does not exist until the launch confirms,
//      so the quote is fetched at fire time. Here the keystore signs ONLY the
//      launch; no bundle wallet is ever asked to sign.
//   3. The launch is a plain launchToken even when a dev buy is requested — the
//      atomic launchAndBuy takes the pair token a zap-funded dev does not hold.
//      A requested dev buy becomes another post-launch zap buyer.
//   4. A native pair IGNORES the flag: it is the unchanged pre-signed native path.
//
// Nothing here touches a chain — every dependency is injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, parseEther, formatEther, ZeroAddress } = require('ethers');
const { prepareV2 } = require('./prepareV2');

const DEV = getAddress('0x' + '11'.repeat(20));
const W1 = getAddress('0x' + '22'.repeat(20));
const W2 = getAddress('0x' + '33'.repeat(20));
const CURVE = getAddress('0x' + 'cc'.repeat(20));
const TOKEN = getAddress('0x' + 'dd'.repeat(20));
const FORWARDER = getAddress('0x' + 'ff'.repeat(20));
const FACTORY = getAddress('0x' + 'fa'.repeat(20));
const SPCX = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');

const LAUNCH_FEE = 10n ** 15n; // 0.001 ETH

function harness(o = {}) {
  const pair = o.pairToken ?? SPCX;
  const nativeBalances = o.nativeBalances || {};
  const signed = [];
  const captured = {};
  let readTokenBalanceCalls = 0;

  const ks = {
    devWallet: () => ({ id: 'dev', address: DEV, role: 'dev' }),
    list: () => [
      { id: 'dev', address: DEV, role: 'dev' },
      { id: 'w1', address: W1, role: 'bundle' },
      { id: 'w2', address: W2, role: 'bundle' },
    ],
    signer: (id) => ({
      async signTransaction(tx) {
        signed.push({ id, tx });
        return `SIGNED:${id}:${tx.nonce}:${tx.to}`;
      },
    }),
  };

  const v2 = {
    MAX_EXEMPTIONS_VIA_FORWARDER: 31,
    MAX_SNIPE_TAX_EXEMPTIONS: 32,
    preflightGate: async () => ({ problems: [], canLaunch: true, enabled: true, approved: true }),
    getConfigs: async () => ({
      launchConfigs: [
        {
          id: 0,
          enabled: true,
          supply: (10n ** 27n).toString(),
          phantomQuote: (168n * 10n ** 16n).toString(),
          graduationThreshold: (42n * 10n ** 17n).toString(),
          curveFeeBps: 100,
        },
      ],
      maxCreatorTaxBps: 1000,
      launchFee: LAUNCH_FEE.toString(),
      snipeTaxStartBps: 9900,
      snipeTaxSeconds: 3,
    }),
    newSalt: () => '0x' + '00'.repeat(32),
    pairEconomics: async () => ({
      phantomQuote: 5000n * 10n ** 18n,
      graduationThreshold: 20000n * 10n ** 18n,
      decimals: 18,
    }),
    predictAddresses: async () => ({ token: TOKEN, curve: CURVE, wiring: { forwarder: FORWARDER } }),
    simulateLaunch: async () => ({ token: TOKEN, curve: CURVE }),
    buildLaunchAndBuyTx: async (args) => {
      captured.launchAndBuy = args;
      return { to: FORWARDER, data: '0xdeadbeef', value: args.value };
    },
    buildLaunchTx: async (args) => {
      captured.launchTx = args;
      return { to: FACTORY, data: '0xbeef', value: args.value };
    },
    explainRevert: (e) => String(e),
  };

  const provider = {
    estimateGas: async () => 3_000_000n,
    getBalance: async (addr) => nativeBalances[getAddress(addr)] ?? 10n ** 20n, // 100 ETH default
    getTransactionCount: async () => 5,
  };

  const getFees = async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n });
  const readTokenBalance = async () => {
    readTokenBalanceCalls += 1;
    return 0n;
  };
  const getSymbol = async () => 'SPCX';

  return {
    signed,
    captured,
    get readTokenBalanceCalls() {
      return readTokenBalanceCalls;
    },
    deps: { keystore: ks, v2, provider, getFees, readTokenBalance, getSymbol, variant: 'v1' },
  };
}

const BASE = {
  params: { name: 'Space X', symbol: 'SPX', logo: 'ipfs://x' },
  launchConfigId: 0,
  bundleFunding: 'ethZap',
  pairToken: SPCX,
};

test('sizes buys in ETH from native balance and pre-signs NOTHING but the launch', async () => {
  const h = harness({
    nativeBalances: { [W1]: parseEther('2'), [W2]: parseEther('2') },
  });
  const plan = await prepareV2(
    {
      ...BASE,
      wallets: [
        { walletId: 'w1', amountEth: '0.5' },
        { walletId: 'w2', amountEth: '0.75' },
      ],
    },
    h.deps
  );

  assert.equal(plan.mode, 'ethZap');
  assert.equal(plan.bundleFunding, 'ethZap');
  assert.equal(plan.pairSymbol, 'SPCX');
  assert.equal(plan.share, null, 'the curve share is not precomputed in zap mode');

  // Buys are the ETH amounts, in wei, and carry NO raw and NO approve.
  assert.equal(plan.buys.length, 2);
  const b1 = plan.buys.find((b) => b.address === W1);
  const b2 = plan.buys.find((b) => b.address === W2);
  assert.equal(b1.amountIn, parseEther('0.5').toString());
  assert.equal(b1.amountEth, '0.5');
  assert.equal(b2.amountIn, parseEther('0.75').toString());
  for (const b of plan.buys) {
    assert.equal(b.zap, true);
    assert.equal(b.exempt, true);
    assert.equal(b.raw, undefined, 'a zap buy is NOT pre-signed');
    assert.equal(b.approve, undefined, 'a zap buy has no approve');
    assert.equal(b.nonce, undefined, 'the nonce is fetched at fire time, not baked here');
  }

  // Only the launch was signed. No bundle wallet was ever asked to sign.
  assert.ok(plan.launch.raw, 'the launch is signed');
  assert.equal(h.signed.filter((s) => s.id !== 'dev').length, 0, 'no bundle wallet signs at prepare time');
  assert.equal(h.signed.filter((s) => s.id === 'dev').length, 1, 'the dev signs exactly the launch');

  // The launch is a plain launchToken (no forwarder, no atomic buy), value = fee.
  assert.ok(h.captured.launchTx, 'a plain launchToken was built');
  assert.equal(h.captured.launchAndBuy, undefined, 'launchAndBuy is never used in zap mode');
  assert.equal(plan.launch.valueEth, formatEther(LAUNCH_FEE));
  assert.equal(plan.launch.atomic, false);

  // Pair-token balances are never read — the wallets fund in ETH.
  assert.equal(h.readTokenBalanceCalls, 0, 'no pair-token balance is read in zap mode');

  // Full exemption cap: the plain launch path allows 32, not the forwarder's 31.
  assert.equal(plan.snipeTax.max, 32);
  assert.equal(plan.zapBuyGas, String(require('../config').zapBuyGasLimit));
});

test('"all" mode spends the whole balance minus zap gas and buffer', async () => {
  const h = harness({ nativeBalances: { [W1]: parseEther('3') } });
  const plan = await prepareV2(
    { ...BASE, wallets: [{ walletId: 'w1', mode: 'all' }] },
    h.deps
  );
  const b = plan.buys[0];
  // amountIn = 3 ETH − gas(zapBuyGas × maxFee) − buffer, all positive and < 3.
  assert.ok(BigInt(b.amountIn) > 0n);
  assert.ok(BigInt(b.amountIn) < parseEther('3'));
});

test('a requested dev buy becomes a post-launch zap buyer (isDev), not an atomic launch buy', async () => {
  const h = harness({
    nativeBalances: { [DEV]: parseEther('10'), [W1]: parseEther('2') },
  });
  const plan = await prepareV2(
    { ...BASE, devBuyEth: '0.2', wallets: [{ walletId: 'w1', amountEth: '0.5' }] },
    h.deps
  );

  // The launch itself carries NO dev buy — plain launchToken, fee-only value.
  assert.equal(h.captured.launchAndBuy, undefined);
  assert.equal(plan.launch.valueEth, formatEther(LAUNCH_FEE));

  // The dev appears as a zap buyer, flagged isDev, sized in ETH.
  const devBuy = plan.buys.find((b) => b.isDev);
  assert.ok(devBuy, 'the dev is a post-launch zap buyer');
  assert.equal(devBuy.address, DEV);
  assert.equal(devBuy.amountIn, parseEther('0.2').toString());
  assert.equal(devBuy.zap, true);
  // The dev is NOT added to the declared exemption list — the factory exempts it.
  assert.ok(!plan.snipeTax.exemptions.includes(DEV));
  // Still nothing pre-signed but the launch.
  assert.equal(h.signed.filter((s) => s.id !== 'dev').length, 0);
});

test('a dev with too little ETH for the zap gets a warning, not a broken plan', async () => {
  const h = harness({
    nativeBalances: { [DEV]: LAUNCH_FEE + parseEther('0.01'), [W1]: parseEther('2') },
  });
  const plan = await prepareV2(
    { ...BASE, devBuyEth: '5', wallets: [{ walletId: 'w1', amountEth: '0.5' }] },
    h.deps
  );
  assert.ok(!plan.buys.some((b) => b.isDev), 'the dev zap was skipped');
  assert.ok(plan.warnings.some((w) => /dev zap skipped/.test(w)));
  // The bundle wallet is unaffected.
  assert.ok(plan.buys.some((b) => b.address === W1));
});

test('an underfunded wallet is skipped with a reason, the rest proceed', async () => {
  const h = harness({
    nativeBalances: { [W1]: parseEther('0.00001'), [W2]: parseEther('2') },
  });
  const plan = await prepareV2(
    {
      ...BASE,
      wallets: [
        { walletId: 'w1', amountEth: '0.5' },
        { walletId: 'w2', amountEth: '0.5' },
      ],
    },
    h.deps
  );
  assert.equal(plan.buys.length, 1, 'only the funded wallet is in the bundle');
  assert.equal(plan.buys[0].address, W2);
  assert.ok(plan.warnings.some((w) => w.includes(W1) && /skipped/.test(w)));
});

test('the ETH-zap non-atomic caveat is always warned', async () => {
  const h = harness({ nativeBalances: { [W1]: parseEther('2') } });
  const plan = await prepareV2({ ...BASE, wallets: [{ walletId: 'w1', amountEth: '0.5' }] }, h.deps);
  assert.ok(
    plan.warnings.some((w) => /not guaranteed to be first|AFTER the launch confirms/.test(w)),
    'the non-atomic race caveat must be stated'
  );
});

test('a NATIVE pair ignores bundleFunding:ethZap — it is the unchanged pre-signed native path', async () => {
  const h = harness({ pairToken: ZeroAddress, nativeBalances: { [W1]: parseEther('2') } });
  const plan = await prepareV2(
    {
      params: { name: 'N', symbol: 'N', logo: 'ipfs://x' },
      launchConfigId: 0,
      pairToken: ZeroAddress,
      bundleFunding: 'ethZap', // ignored on native
      wallets: [{ walletId: 'w1', amountEth: '0.5' }],
    },
    h.deps
  );
  assert.equal(plan.mode, 'presigned', 'native is unchanged — pre-signed, not zap');
  assert.notEqual(plan.bundleFunding, 'ethZap');
  // The buy was pre-signed on the native path.
  assert.ok(plan.buys[0].raw, 'a native buy is pre-signed');
  assert.ok(h.signed.some((s) => s.id === 'w1'), 'the native wallet signed its buy');
});

test('an unknown bundleFunding value is rejected up front', async () => {
  const h = harness({});
  await assert.rejects(
    () => prepareV2({ ...BASE, bundleFunding: 'wat', wallets: [] }, h.deps),
    /unknown bundleFunding/
  );
});
