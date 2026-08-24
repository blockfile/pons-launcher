'use strict';

// prepareV2 against a NON-NATIVE quote asset (an ERC-20 pair token).
//
// Everything a native launch does is unchanged; what these assert is the delta:
//
//   a. each bundle wallet signs approve(curve, amountIn) then buy — two
//      transactions at consecutive nonces, the buy carrying value 0 — sized and
//      approved for the amount in the PAIR TOKEN's own decimals (USDG is 6).
//   b. a dev buy goes through the forwarder: the dev signs approve(forwarder,
//      quoteIn) then launchAndBuy, and the launch tx carries only the launch fee
//      as native value — never fee + devBuy, because the dev buy is paid in the
//      pair token.
//   d. a NATIVE launch is untouched: one transaction per wallet, no approvals,
//      the buy carrying its ETH as value.
//
// Nothing here touches a chain — every dependency is injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, Interface, parseEther, parseUnits, ZeroAddress } = require('ethers');
const { prepareV2 } = require('./prepareV2');

const DEV = getAddress('0x' + '11'.repeat(20));
const W1 = getAddress('0x' + '22'.repeat(20));
const W2 = getAddress('0x' + '33'.repeat(20));
const CURVE = getAddress('0x' + 'cc'.repeat(20));
const TOKEN = getAddress('0x' + 'dd'.repeat(20));
const FORWARDER = getAddress('0x' + 'ff'.repeat(20));
const FACTORY = getAddress('0x' + 'fa'.repeat(20));
// USDG — a real approved 6-decimal pair token.
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');

const LAUNCH_FEE = 10n ** 15n; // 0.001 ETH
const approveIface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const curveIface = new Interface([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
]);

/**
 * @param {object} o
 * @param {number} [o.pairDecimals]
 * @param {object} [o.pairBalances] token base units per wallet address
 * @param {bigint} [o.nativeBalance]
 * @param {string} [o.pairToken] ZeroAddress for the native regression case
 */
function harness(o = {}) {
  const pairDecimals = o.pairDecimals ?? 6;
  const pair = o.pairToken ?? USDG;
  const signed = []; // { id, tx } in the order they were signed
  const captured = {};

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
          // Native economics — deliberately different from the pair's, to prove
          // the ERC-20 path does NOT use them.
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
    // The pair token's own economics, in its own (6) decimals.
    pairEconomics: async () => ({
      phantomQuote: 5000n * 10n ** BigInt(pairDecimals), // 5,000 USDG
      graduationThreshold: 20000n * 10n ** BigInt(pairDecimals), // 20,000 USDG
      decimals: pairDecimals,
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
    getBalance: async () => o.nativeBalance ?? 10n ** 20n, // 100 ETH
    getTransactionCount: async () => 5,
  };

  const getFees = async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n });
  const readTokenBalance = async (token, owner) => {
    assert.equal(getAddress(token), getAddress(pair), 'balances must be read on the pair token');
    return (o.pairBalances && o.pairBalances[getAddress(owner)]) ?? 0n;
  };
  const getSymbol = async () => 'USDG';

  return {
    signed,
    captured,
    deps: { keystore: ks, v2, provider, getFees, readTokenBalance, getSymbol, variant: 'v1' },
  };
}

const BASE = {
  params: { name: 'Real World', symbol: 'RWA', logo: 'ipfs://x' },
  launchConfigId: 0,
};

test('a: each ERC-20 bundle wallet signs approve(curve) then buy at consecutive nonces', async () => {
  const big = 100n * 10n ** 6n; // 100 USDG each
  const { signed, deps } = harness({ pairBalances: { [W1]: big, [W2]: big } });

  const plan = await prepareV2(
    {
      ...BASE,
      pairToken: USDG,
      wallets: [
        { walletId: 'w1', amountEth: '5' }, // 5 USDG
        { walletId: 'w2', amountEth: '5' },
      ],
    },
    deps
  );

  assert.equal(plan.pairSymbol, 'USDG');
  assert.equal(plan.pairDecimals, 6);
  assert.equal(plan.buys.length, 2);

  for (const b of plan.buys) {
    // amountIn is 5 USDG in 6-dec base units, echoed in USDG (ethers formatUnits).
    assert.equal(b.amountIn, (5n * 10n ** 6n).toString());
    assert.equal(b.amountEth, '5.0');
    // There is an approve, and it is one nonce below the buy.
    assert.ok(b.approve, 'an ERC-20 buy must carry a pre-signed approve');
    assert.equal(getAddress(b.approve.spender), CURVE);
    assert.equal(b.approve.nonce + 1, b.nonce);
    assert.ok(b.approve.raw, 'the approve must be signed');
    assert.ok(b.raw, 'the buy must be signed');
  }

  // Each wallet signed exactly two txs: approve (to the pair token) then buy (to
  // the curve, value 0). The APPROVAL TARGET IS THE CURVE, not the forwarder.
  for (const id of ['w1', 'w2']) {
    const mine = signed.filter((s) => s.id === id);
    assert.equal(mine.length, 2, `${id} signs approve + buy`);

    const [approve, buy] = mine;
    assert.equal(getAddress(approve.tx.to), getAddress(USDG), 'approve is on the pair token');
    const dec = approveIface.decodeFunctionData('approve', approve.tx.data);
    assert.equal(getAddress(dec[0]), CURVE, 'approve spender is the curve');
    assert.equal(dec[1], 5n * 10n ** 6n, 'approve amount is exactly the buy amount, in 6-dec USDG');

    assert.equal(getAddress(buy.tx.to), CURVE, 'the buy calls the curve');
    assert.equal(buy.tx.value ?? 0n, 0n, 'an ERC-20 buy carries no native value');
    assert.equal(buy.tx.nonce, approve.tx.nonce + 1, 'buy sits at n+1');
  }

  // The share is walked against the PAIR economics (5,000 USDG phantom), not the
  // native config, and is denominated in USDG.
  assert.equal(plan.share.pairSymbol, 'USDG');
  assert.equal(plan.share.marketCap.openingEth, '5000.000000');
});

test('b: an ERC-20 dev buy approves the FORWARDER and the launch value is the fee only', async () => {
  const { signed, captured, deps } = harness({
    pairBalances: { [DEV]: 1000n * 10n ** 6n, [W1]: 100n * 10n ** 6n },
  });

  const plan = await prepareV2(
    { ...BASE, pairToken: USDG, devBuyEth: '10', wallets: [{ walletId: 'w1', amountEth: '5' }] },
    deps
  );

  // The launch went through the forwarder, and its NATIVE value is the fee alone
  // — the 10 USDG dev buy is pulled from the pair token, not sent as ETH.
  assert.equal(captured.launchAndBuy.value, LAUNCH_FEE, 'launch value must be launchFee only');
  assert.equal(captured.launchAndBuy.quoteIn, 10n * 10n ** 6n, 'quoteIn is 10 USDG in 6-dec');
  assert.equal(plan.launch.valueEth, '0.001', 'the plan reports fee-only native value');
  assert.equal(plan.launch.devBuyEth, '10.0', 'the dev buy is reported in USDG');

  // The dev signed approve(forwarder, 10 USDG) then the launch, and the plan
  // flags that it needs the approve first.
  assert.ok(plan.launch.approve, 'the dev approve must be present');
  assert.equal(getAddress(plan.launch.approve.spender), FORWARDER, 'the dev approves the FORWARDER');
  assert.equal(plan.launch.needsApprove, true);
  assert.equal(plan.launch.approve.nonce + 1, plan.launch.nonce, 'launch sits at n+1');

  const devSigned = signed.filter((s) => s.id === 'dev');
  assert.equal(devSigned.length, 2, 'the dev signs approve + launch');
  const [devApprove, devLaunch] = devSigned;
  assert.equal(getAddress(devApprove.tx.to), getAddress(USDG), 'dev approve is on the pair token');
  const dec = approveIface.decodeFunctionData('approve', devApprove.tx.data);
  assert.equal(getAddress(dec[0]), FORWARDER, 'dev approve spender is the forwarder');
  assert.equal(dec[1], 10n * 10n ** 6n);
  assert.equal(getAddress(devLaunch.tx.to), FORWARDER, 'the launch goes to the forwarder');

  // The fail-safe estimate used the PLAIN launch (no buy), which needs no
  // allowance, rather than the launchAndBuy that would revert without one.
  assert.ok(captured.launchTx, 'the plain launch was built for the fail-safe estimate');
});

test('b: an unapproved pair token is rejected up front with a clear error', async () => {
  const { deps } = harness({});
  deps.v2.preflightGate = async () => ({
    problems: [`pair token ${USDG} is not approved by the factory`],
    canLaunch: true,
    enabled: true,
    approved: false,
  });
  await assert.rejects(
    () => prepareV2({ ...BASE, pairToken: USDG, wallets: [] }, deps),
    /has not approved .* PairTokenNotApproved/
  );
});

test('d: a NATIVE launch is unchanged — one tx per wallet, no approvals, ETH as value', async () => {
  const { signed, captured, deps } = harness({ pairToken: ZeroAddress });

  const plan = await prepareV2(
    {
      ...BASE,
      pairToken: ZeroAddress,
      devBuyEth: '0.05',
      wallets: [
        { walletId: 'w1', amountEth: '0.1' },
        { walletId: 'w2', amountEth: '0.2' },
      ],
    },
    deps
  );

  // Native descriptors, and NO approve anywhere.
  assert.equal(plan.pairSymbol, 'ETH');
  assert.equal(plan.pairDecimals, 18);
  assert.equal(plan.launch.approve, undefined, 'a native launch signs no dev approve');
  assert.equal(plan.launch.needsApprove, undefined);
  // Native dev buy: the launch value is fee + devBuy.
  assert.equal(captured.launchAndBuy.value, LAUNCH_FEE + parseEther('0.05'));
  assert.equal(plan.launch.valueEth, '0.051'); // fee 0.001 + dev buy 0.05

  for (const b of plan.buys) {
    assert.equal(b.approve, undefined, 'a native buy carries no approve');
  }
  assert.equal(plan.buys[0].amountIn, parseEther('0.1').toString());
  assert.equal(plan.buys[0].amountEth, '0.1');

  // Each bundle wallet signed exactly ONE tx — the buy — carrying its ETH as
  // value. The dev signed one — the launch. No pair-token reads happened.
  for (const id of ['w1', 'w2']) {
    const mine = signed.filter((s) => s.id === id);
    assert.equal(mine.length, 1, `${id} signs exactly one tx on the native path`);
    assert.equal(getAddress(mine[0].tx.to), CURVE);
  }
  const devSigned = signed.filter((s) => s.id === 'dev');
  assert.equal(devSigned.length, 1, 'the dev signs exactly the launch on the native path');

  // The native buy carries its ETH as value.
  const buy = curveIface.parseTransaction({ data: signed.find((s) => s.id === 'w1').tx.data });
  assert.ok(buy, 'the native buy decodes as a curve buy');
  const w1buy = signed.find((s) => s.id === 'w1').tx;
  assert.equal(w1buy.value, parseEther('0.1'), 'a native buy sends its quote as value');
});
