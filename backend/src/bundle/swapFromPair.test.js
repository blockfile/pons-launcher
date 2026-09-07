'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther, parseUnits, formatEther } = require('ethers');

const { swapBundleFromPair, exitGasWei } = require('./swapFromPair');
const { gasReserveWei, SWAP_GAS, APPROVE_GAS } = require('./swapToPair');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const W1 = { id: 'w1', role: 'bundle', address: '0x1111111111111111111111111111111111111111' };
const W2 = { id: 'w2', role: 'bundle', address: '0x2222222222222222222222222222222222222222' };
const W3 = { id: 'w3', role: 'bundle', address: '0x3333333333333333333333333333333333333333' };

// 1 gwei, so the exit gas is a readable 0.00055 ETH: 0.0001 for the 100k approve
// and 0.00045 for the 450k swap. Nothing else is held back on this side.
const FEES = { type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
const EXIT_GAS = parseEther('0.00055');

/**
 * A constant-product-ish pool, run in the SELL direction: pair token in, wei out.
 *
 *   out = in * depth / ((depth + in) * rate)
 *
 * `rate` is pair-per-ETH (20 NVDA to the ETH), so 10 NVDA is about half an ETH; the
 * 1/(1+in/depth) term is the price impact, and a small `depth` is MSTR/SHOP/TTWO —
 * an approved pair that really does quote 79-93% impact at size.
 */
function pool({ rate = 20n, depth = parseUnits('100000', 18) } = {}) {
  return (amountIn) => (BigInt(amountIn) * depth) / ((depth + BigInt(amountIn)) * rate);
}

/**
 * Everything swapBundleFromPair touches, faked. Both balances are walked forward by
 * the fake signer — the pair token leaves the wallet and the ETH arrives — so a
 * delta the module measures is measuring something that moved.
 */
function harness({
  wallets = [W1],
  ethBalances = { [W1.address]: parseEther('1') },
  pairBalances = { [W1.address]: parseUnits('10', 18) },
  quote = pool(),
  approved = [
    { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18, native: true },
    { symbol: 'NVDA', address: NVDA, decimals: 18 },
  ],
  feeTier = 500,
  discoverThrows = null,
  sendThrows = null, // (address) => Error|null
  receiptStatus = 1,
  stalePairRead = false, // the balance read lags the swap's block
} = {}) {
  const eth = { ...ethBalances };
  const pair = { ...pairBalances };
  const sent = [];
  // What the route was asked to BUILD. The broadcast keeps only to/data/value, so
  // the floor and the amount have to be inspected here rather than on the sent tx.
  const approves = [];
  const swaps = [];
  const gasOf = new Map();
  const PRICE = FEES.maxFeePerGas;
  const probe = 10n ** 15n;

  const route = {
    discoverPairFee: async () => {
      if (discoverThrows) throw new Error(discoverThrows);
      return feeTier;
    },
    quotePairToEth: async ({ amountIn }) => ({ amountOut: quote(amountIn), usdgFee: feeTier }),
    assessSellImpact: async ({ amountIn }) => {
      const amt = BigInt(amountIn);
      const fullOut = quote(amt);
      const probeOut = quote(probe);
      const kept = probeOut > 0n && amt > 0n ? Number((fullOut * probe * 10_000n) / (probeOut * amt)) : 0;
      return { impactBps: Math.max(0, Math.min(10_000, 10_000 - kept)), fullOut, usdgFee: feeTier };
    },
    buildApproveToRouter: ({ pairToken, amount }) => {
      approves.push({ pairToken, amount: BigInt(amount) });
      return { to: pairToken, data: '0xapprove', value: 0n };
    },
    buildSwapPairToEth: ({ amountIn, minOut, recipient }) => {
      swaps.push({ amountIn: BigInt(amountIn), minOut: BigInt(minOut), recipient });
      return { to: '0xcaf681a66d020601342297493863E78C959E5cb2', data: '0xswap', value: 0n };
    },
  };

  const deps = {
    dryRun: false,
    maxImpactBps: 1000,
    provider: {
      getBalance: async (a) => eth[a] ?? 0n,
      getTransactionCount: async () => 7,
    },
    keystore: {
      bundleWallets: () => wallets,
      walletsWithRole: () => wallets,
      signer: (id) => ({
        sendTransaction: async (tx) => {
          const w = wallets.find((x) => x.id === id);
          if (sendThrows) {
            const err = sendThrows(w.address);
            if (err) throw err;
          }
          const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`;
          const isSwap = tx.data === '0xswap';
          const gasUsed = isSwap ? 450_000n : 100_000n;
          gasOf.set(hash, gasUsed);
          sent.push({ ...tx, kind: isSwap ? 'swap' : 'approve', walletId: id, address: w.address, hash });
          eth[w.address] = (eth[w.address] ?? 0n) - gasUsed * PRICE;
          if (isSwap && receiptStatus === 1) {
            const s = swaps[swaps.length - 1];
            if (!stalePairRead) pair[w.address] = (pair[w.address] ?? 0n) - s.amountIn;
            eth[w.address] += quote(s.amountIn);
          }
          return { hash };
        },
      }),
    },
    route,
    resolvePairTokens: async () => approved,
    getFees: async () => FEES,
    readTokenBalance: async (_t, owner) => pair[owner] ?? 0n,
    waitForReceipt: async (_rpc, hash) => ({
      status: gasOf.get(hash) === 450_000n ? receiptStatus : 1,
      blockNumber: 99,
      hash,
      gasUsed: gasOf.get(hash) ?? 0n,
      effectiveGasPrice: PRICE,
    }),
  };

  return { deps, sent, approves, swaps, eth, pair, quote };
}

const row = (out, id) => out.results.find((r) => r.walletId === id);
const swapsOf = (sent) => sent.filter((s) => s.kind === 'swap');

// ── the recovery case: no amount, sell everything ─────────────────────────────

test('an omitted amount sells the WHOLE balance, floored at the quote less 3%', async () => {
  const { deps, sent, swaps, approves, pair } = harness();
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);

  assert.equal(out.swapped, 1);
  assert.equal(out.failed, 0);
  const r = row(out, 'w1');
  assert.equal(r.status, 'swapped');
  assert.equal(r.askedPair, null, 'the whole balance is not an amount the caller gave');
  assert.equal(r.heldPair, '10.0');
  assert.equal(r.sellPair, '10.0');
  assert.equal(r.soldPair, '10.0');
  assert.equal(r.holdingPair, '0.0', 'the wallet is empty of the pair token afterwards');
  assert.equal(pair[W1.address], 0n);

  // Two transactions, in this order: the ERC-20 must be approved before the router
  // can pull it. This is the one structural difference from the buy direction.
  assert.equal(sent.length, 2);
  assert.equal(sent[0].kind, 'approve');
  assert.equal(sent[1].kind, 'swap');
  assert.equal(sent[0].nonce, 7);
  assert.equal(sent[1].nonce, 8, 'sequential nonces — n+1 cannot mine before n');
  assert.equal(sent[0].gasLimit, APPROVE_GAS);
  assert.equal(sent[1].gasLimit, SWAP_GAS);
  assert.equal(approves[0].amount, parseUnits('10', 18), 'the approve is bounded at what is sold');
  assert.equal(swaps[0].amountIn, parseUnits('10', 18));

  // A REAL floor, never 0 — the live quote less 3%.
  assert.ok(swaps[0].minOut > 0n, 'never a floorless swap');
  assert.equal(swaps[0].minOut, (parseEther(r.quotedEth) * 9700n) / 10_000n);
  assert.equal(r.minEth, formatEther(swaps[0].minOut));

  // What arrived, measured gross of the gas both legs paid.
  assert.equal(r.receivedEth, r.quotedEth);
  assert.equal(out.totalEthOut, r.receivedEth);
  assert.equal(out.totalPairSold, '10.0');
});

test('a named amount sells exactly that much and leaves the rest', async () => {
  const { deps, swaps, approves, pair } = harness({ pairBalances: { [W1.address]: parseUnits('10', 18) } });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '4' }] },
    deps
  );

  const r = row(out, 'w1');
  assert.equal(r.status, 'swapped');
  assert.equal(r.askedPair, '4.0');
  assert.equal(r.sellPair, '4.0');
  assert.equal(r.soldPair, '4.0');
  assert.equal(r.holdingPair, '6.0', 'the remainder is left where it was');
  assert.equal(pair[W1.address], parseUnits('6', 18));
  assert.equal(swaps[0].amountIn, parseUnits('4', 18));
  assert.equal(approves[0].amount, parseUnits('4', 18), 'the approve is bounded at the amount, not the balance');
});

test('a pair token with non-18 decimals is sold in ITS units, not ether', async () => {
  // 6-decimal quote asset: 25.5 units is 25_500_000, and a wei-denominated bug
  // would try to sell 2.55e19 of them.
  const q = (amountIn) => (BigInt(amountIn) * 10n ** 12n) / 2000n;
  const { deps, swaps } = harness({
    approved: [{ symbol: 'USDGX', address: NVDA, decimals: 6 }],
    pairBalances: { [W1.address]: parseUnits('100', 6) },
    quote: q,
  });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '25.5' }] },
    deps
  );

  assert.equal(out.pairDecimals, 6);
  assert.equal(row(out, 'w1').status, 'swapped');
  assert.equal(swaps[0].amountIn, parseUnits('25.5', 6));
  assert.equal(row(out, 'w1').holdingPair, '74.5');
});

// ── the skips, each one NAMED ─────────────────────────────────────────────────

test('a wallet holding nothing is skipped and named, and nothing is broadcast for it', async () => {
  const { deps, sent } = harness({ pairBalances: {} });
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);

  assert.equal(out.skippedEmpty, 1);
  assert.equal(out.swapped, 0);
  assert.equal(sent.length, 0);
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-empty');
  assert.equal(r.heldPair, '0.0');
  assert.match(r.reason, /holds no NVDA/);
  assert.equal(out.totalEthOut, '0.0');
});

test('a balance worth less than the gas to sell it is DUST, refused rather than sold at a loss', async () => {
  // 0.001 NVDA quotes ~0.00005 ETH, against 0.00055 ETH of approve + swap gas.
  const { deps, sent } = harness({ pairBalances: { [W1.address]: parseUnits('0.001', 18) } });
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);

  assert.equal(out.skippedDust, 1);
  assert.equal(sent.length, 0, 'a sale that costs more than it returns must not be broadcast');
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-dust');
  assert.match(r.reason, /less than the 0\.00055 ETH of gas/);
  assert.match(r.reason, /Nothing was sold/);
});

test('a wallet asked for more than it holds is refused, not part-sold', async () => {
  const { deps, sent } = harness({ pairBalances: { [W1.address]: parseUnits('3', 18) } });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(out.skippedShortPair, 1);
  assert.equal(sent.length, 0, 'selling what it happens to hold would be a request nobody made');
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-short-pair');
  assert.equal(r.heldPair, '3.0');
  assert.match(r.reason, /omit the amount to sell the whole balance/);
});

test('a wallet that cannot pay for the approve AND the swap is refused, and NOTHING is sent', async () => {
  const short = harness({ ethBalances: { [W1.address]: EXIT_GAS - 1n } });
  const a = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] },
    short.deps
  );
  assert.equal(a.skippedShort, 1);
  assert.equal(short.sent.length, 0, 'a wallet short of gas must not be half-run');
  assert.equal(short.pair[W1.address], parseUnits('10', 18), 'its pair token is untouched');
  assert.equal(row(a, 'w1').status, 'skipped-short');
  assert.match(row(a, 'w1').reason, /needs 0\.00055 ETH for the approve and the swap/);

  // The boundary is the whole of the reserve, and exactly it is enough.
  const exact = harness({ ethBalances: { [W1.address]: EXIT_GAS } });
  const b = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] },
    exact.deps
  );
  assert.equal(row(b, 'w1').status, 'swapped');
  assert.equal(b.gasReserveEth, formatEther(EXIT_GAS));
});

test("the exit reserve is the approve + the swap, and NOT the funding direction's reserve", () => {
  // Derived beside swapToPair's, from the same two constants at the same fee basis
  // — but without the launch's later approve + buy (at double) and without the
  // preflight buffer, because this wallet is LEAVING the launch, not joining it.
  assert.equal(exitGasWei(FEES), (APPROVE_GAS + SWAP_GAS) * FEES.maxFeePerGas);
  assert.equal(exitGasWei(FEES), EXIT_GAS);
  const funding = gasReserveWei(FEES, { buyGasLimit: 400_000, gasBufferEth: '0.0004' });
  assert.ok(exitGasWei(FEES) < funding, 'the exit must not hold back gas for a launch it is abandoning');
  assert.equal(funding - exitGasWei(FEES), parseEther('0.0013'), '2 x (100k + 400k) gas + the 0.0004 buffer');
});

// ── the impact guard: the load-bearing one on this side ───────────────────────

test('a sell that would drain the pool is refused by the impact guard, not by the floor', async () => {
  // MSTR/SHOP/TTWO: a really-approved pair whose pool a whole-balance sell empties.
  // The quoter SATURATES instead of reverting, so a floor sized from its quote would
  // happily "expect" the drained output — only this check can see it.
  const { deps, sent } = harness({
    quote: pool({ rate: 20n, depth: parseUnits('3', 18) }),
    pairBalances: { [W1.address]: parseUnits('30', 18) },
  });
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);

  assert.equal(out.skippedImpact, 1);
  assert.equal(sent.length, 0, 'a pool-draining sell must never be broadcast');
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-impact');
  assert.ok(r.impactBps > 1000, `impact was ${r.impactBps} bps`);
  assert.match(r.reason, /would move the pool/);
  assert.match(r.reason, /Nothing was sold/);
});

test('the same wallet sells fine once the amount is small enough for the pool', async () => {
  // The guard refuses a SIZE, not a token — the operator can still recover in slices.
  const { deps, sent } = harness({
    quote: pool({ rate: 20n, depth: parseUnits('3', 18) }),
    pairBalances: { [W1.address]: parseUnits('30', 18) },
  });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '0.15' }] },
    deps
  );
  assert.equal(row(out, 'w1').status, 'swapped');
  assert.equal(swapsOf(sent).length, 1);
  assert.equal(row(out, 'w1').holdingPair, '29.85');
});

// ── the floor ─────────────────────────────────────────────────────────────────

test('minOut is the quote less 3% and is never 0, so a bad fill reverts with the token intact', async () => {
  const { deps, swaps } = harness();
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);
  const r = row(out, 'w1');
  const quoted = parseEther(r.quotedEth);
  assert.equal(swaps[0].minOut, (quoted * 9700n) / 10_000n);
  assert.ok(swaps[0].minOut > 0n);
  // The margin is swapToPair's own OVERSHOOT_BPS, read from the same constant.
  assert.equal(quoted - swaps[0].minOut, quoted - (quoted * 9700n) / 10_000n);
});

test('a reverted swap leaves the wallet holding its pair token, and says so', async () => {
  const { deps, sent, pair } = harness({ receiptStatus: 0 });
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);

  assert.equal(out.failed, 1);
  assert.equal(out.swapped, 0);
  assert.equal(pair[W1.address], parseUnits('10', 18), 'nothing left the wallet');
  const r = row(out, 'w1');
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /still in the wallet/);
  assert.match(r.reason, /only gas was spent/);
  assert.equal(r.receivedEth, null);
  assert.equal(swapsOf(sent).length, 1);
  assert.equal(out.totalEthOut, '0.0');
});

test('a confirmed swap whose balance read lags is reported as swapped, with the lag named', async () => {
  const { deps } = harness({ stalePairRead: true });
  const out = await swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps);

  const r = row(out, 'w1');
  assert.equal(r.status, 'swapped', 'the receipt is the authority, not a lagging balance read');
  assert.equal(r.soldPair, '0.0');
  assert.match(r.reason, /balance read lags/);
  // The swap enforced its floor, so the reported ETH is never below it.
  assert.ok(parseEther(r.receivedEth) >= parseEther(r.minEth));
});

// ── isolation ─────────────────────────────────────────────────────────────────

test('one wallet failing to broadcast never stops the others', async () => {
  const { deps, sent } = harness({
    wallets: [W1, W2, W3],
    ethBalances: {
      [W1.address]: parseEther('1'),
      [W2.address]: parseEther('1'),
      [W3.address]: parseEther('1'),
    },
    pairBalances: {
      [W1.address]: parseUnits('10', 18),
      [W2.address]: parseUnits('10', 18),
      [W3.address]: parseUnits('10', 18),
    },
    sendThrows: (addr) => (addr === W2.address ? new Error('replacement fee too low') : null),
  });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }, { walletId: 'w2' }, { walletId: 'w3' }] },
    deps
  );

  assert.equal(out.swapped, 2);
  assert.equal(out.failed, 1);
  assert.equal(row(out, 'w1').status, 'swapped');
  assert.equal(row(out, 'w3').status, 'swapped');
  assert.equal(row(out, 'w2').status, 'failed');
  assert.match(row(out, 'w2').reason, /failed to broadcast/);
  assert.match(row(out, 'w2').reason, /No NVDA was sold/);
  assert.equal(swapsOf(sent).length, 2);
  // Every target is accounted for — there is no silent half-done state.
  assert.equal(out.count, 3);
  assert.equal(out.results.length, 3);
});

test('every target is reported, whatever happened to it', async () => {
  const { deps } = harness({
    wallets: [W1, W2, W3],
    ethBalances: { [W1.address]: parseEther('1'), [W2.address]: 0n, [W3.address]: parseEther('1') },
    pairBalances: { [W1.address]: parseUnits('10', 18), [W2.address]: parseUnits('10', 18) },
  });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }, { walletId: 'w2' }, { walletId: 'w3' }] },
    deps
  );

  assert.equal(out.count, 3);
  assert.equal(row(out, 'w1').status, 'swapped');
  assert.equal(row(out, 'w2').status, 'skipped-short');
  assert.equal(row(out, 'w3').status, 'skipped-empty');
  assert.equal(out.swapped + out.skippedShort + out.skippedEmpty, 3);
});

// ── the dry run ───────────────────────────────────────────────────────────────

test('a dry run prices every wallet and sends nothing', async () => {
  const { deps, sent, pair } = harness({
    wallets: [W1, W2],
    ethBalances: { [W1.address]: parseEther('1'), [W2.address]: parseEther('1') },
    pairBalances: { [W1.address]: parseUnits('10', 18), [W2.address]: parseUnits('5', 18) },
  });
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, dryRun: true, targets: [{ walletId: 'w1' }, { walletId: 'w2' }] },
    deps
  );

  assert.equal(sent.length, 0, 'a dry run sends nothing at all');
  assert.equal(out.dryRun, true);
  assert.equal(out.wouldSwap, 2);
  assert.equal(out.swapped, 0);
  assert.equal(pair[W1.address], parseUnits('10', 18));
  assert.equal(out.totalPairSold, '15.0', 'what the console shows as the total to be sold');
  assert.ok(Number(out.totalQuotedEth) > 0, 'and what it is expected to return');
  assert.equal(out.totalEthOut, '0.0', 'nothing arrived, because nothing was sent');
  for (const r of out.results) {
    assert.equal(r.status, 'would-swap');
    assert.ok(Number(r.quotedEth) > 0);
    assert.ok(Number(r.minEth) > 0);
    assert.equal(r.hash, null);
    assert.equal(r.approveHash, null);
  }
});

test('a DRY_RUN deployment can never send, whatever the request says', async () => {
  const { deps, sent } = harness();
  const out = await swapBundleFromPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] },
    { ...deps, dryRun: true }
  );
  assert.equal(out.dryRun, true);
  assert.equal(sent.length, 0);
});

// ── whole-run refusals: nothing is sent, for anyone ───────────────────────────

test('an unapproved pair token refuses the whole run', async () => {
  const { deps, sent } = harness({
    approved: [{ symbol: 'SPCX', address: USDG, decimals: 18 }],
  });
  await assert.rejects(
    swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps),
    /is not an approved pair token right now/
  );
  assert.equal(sent.length, 0);
});

test('the native asset is refused — there is no pair token to sell', async () => {
  const { deps, sent } = harness();
  await assert.rejects(
    swapBundleFromPair(
      { variant: 'v1', pairToken: '0x0000000000000000000000000000000000000000', targets: [{ walletId: 'w1' }] },
      deps
    ),
    /native-ETH launch needs no pair token/
  );
  assert.equal(sent.length, 0);
});

test('a pair with no funded pool refuses the whole run rather than 31 times over', async () => {
  const { deps, sent } = harness({ discoverThrows: 'no USDG<->NVDA pool with liquidity' });
  await assert.rejects(
    swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }] }, deps),
    /no NVDA->ETH route/
  );
  assert.equal(sent.length, 0);
});

test("a target that is not this launcher's bundle wallet refuses the whole run", async () => {
  const { deps, sent } = harness({ wallets: [W1] });
  await assert.rejects(
    swapBundleFromPair(
      { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1' }, { walletId: 'nope' }] },
      deps
    ),
    /nope is not a v1 bundle wallet/
  );
  assert.equal(sent.length, 0, 'not even the valid target may be sold from');
});

test('a wallet named twice refuses the whole run rather than guessing', async () => {
  const { deps, sent } = harness();
  await assert.rejects(
    swapBundleFromPair(
      { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '1' }, { walletId: 'w1' }] },
      deps
    ),
    /is named twice/
  );
  assert.equal(sent.length, 0);
});

test('an empty, missing or absurd targets[] is refused', async () => {
  const { deps } = harness();
  await assert.rejects(
    swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [] }, deps),
    /targets\[\] is required/
  );
  await assert.rejects(swapBundleFromPair({ variant: 'v1', pairToken: NVDA }, deps), /targets\[\] is required/);
  await assert.rejects(
    swapBundleFromPair(
      { variant: 'v1', pairToken: NVDA, targets: new Array(101).fill({ walletId: 'w1' }) },
      deps
    ),
    /capped at 100/
  );
});

test('a zero or unreadable amount is refused — it is never promoted to "everything"', async () => {
  const { deps, sent } = harness();
  await assert.rejects(
    swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '0' }] }, deps),
    /must be positive — omit it entirely/
  );
  await assert.rejects(
    swapBundleFromPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: 'abc' }] }, deps),
    /is not a valid NVDA amount/
  );
  assert.equal(sent.length, 0);
});

test('an absent amount and a blank one both mean "sell everything"', async () => {
  for (const amountPair of [undefined, null, '', '   ']) {
    const { deps, swaps } = harness();
    const out = await swapBundleFromPair(
      { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair }] },
      deps
    );
    assert.equal(row(out, 'w1').status, 'swapped', `${String(amountPair)} must mean the whole balance`);
    assert.equal(swaps[0].amountIn, parseUnits('10', 18));
  }
});
