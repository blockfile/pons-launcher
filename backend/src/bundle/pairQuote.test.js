'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther, parseUnits, formatEther } = require('ethers');

const { convertPair, planFromBalance, floorUnits } = require('./pairQuote');
const { gasReserveWei, OVERSHOOT_BPS } = require('./swapToPair');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const NATIVE = '0x0000000000000000000000000000000000000000';
const W1 = { id: 'w1', role: 'bundle', address: '0x1111111111111111111111111111111111111111' };
const W2 = { id: 'w2', role: 'bundle', address: '0x2222222222222222222222222222222222222222' };
const W3 = { id: 'w3', role: 'bundle', address: '0x3333333333333333333333333333333333333333' };

// 1 gwei, the same basis swapToPair.test.js uses, so the reserve figures below
// are readable and comparable against that suite's.
const FEES = { type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
const BUY_GAS = 400_000;
const BUFFER_ETH = '0.0004';
// swapToPair's own reserve at these fees: 0.00045 (450k swap) + 0.001 (2 x
// (100k approve + 400k buy)) + 0.0004 buffer.
const SWAP_RESERVE = parseEther('0.00185');
// (100k approve + 600k sell) x 1 gwei x `sells`.
const sellReserve = (sells) => 700_000n * 1_000_000_000n * BigInt(sells);

/** The same constant-product-ish pool swapToPair.test.js models. */
function pool({ rate = 20n, depth = parseEther('100000') } = {}) {
  return (amountIn) => (BigInt(amountIn) * rate * depth) / (depth + BigInt(amountIn));
}

function harness({
  wallets = [W1],
  ethBalances = {},
  pairBalances = {},
  quote = pool(),
  approved = [
    { symbol: 'ETH', address: NATIVE, decimals: 18, native: true },
    { symbol: 'NVDA', address: NVDA, decimals: 18 },
  ],
  feeTier = 500,
  discoverThrows = null,
  maxImpactBps = 1000,
} = {}) {
  const probe = 10n ** 15n;
  const quotes = []; // every amountIn the quoter was asked about
  const route = {
    discoverPairFee: async () => {
      if (discoverThrows) throw new Error(discoverThrows);
      return feeTier;
    },
    quoteEthToPair: async ({ amountInWei }) => {
      quotes.push(BigInt(amountInWei));
      return { amountOut: quote(amountInWei), usdgFee: feeTier };
    },
    assessBuyImpact: async ({ amountInWei }) => {
      const amt = BigInt(amountInWei);
      quotes.push(amt);
      const fullOut = quote(amt);
      const probeOut = quote(probe);
      const kept = Number((fullOut * probe * 10_000n) / (probeOut * amt));
      return { impactBps: Math.max(0, Math.min(10_000, 10_000 - kept)), fullOut, usdgFee: feeTier };
    },
  };

  const balanceReads = [];
  const deps = {
    buyGasLimit: BUY_GAS,
    gasBufferEth: BUFFER_ETH,
    maxImpactBps,
    provider: {
      getBalance: async (a) => {
        balanceReads.push(a);
        return ethBalances[a] ?? 0n;
      },
    },
    keystore: {
      bundleWallets: () => wallets,
      walletsWithRole: () => wallets,
    },
    route,
    resolvePairTokens: async () => approved,
    getFees: async () => FEES,
    readTokenBalances: async (_t, owners) => owners.map((o) => pairBalances[o] ?? 0n),
  };
  return { deps, quotes, balanceReads, quote };
}

const row = (out, id) => out.results.find((r) => r.walletId === id);

// ── floorUnits: the direction of the rounding is the whole point ─────────────

test('the Buy amount is rounded DOWN, never to nearest', () => {
  // 1.2345678… at six places must become 1.234567, not 1.234568: a Buy amount
  // above what the wallet can buy is the "holds X, needs Y — skipped" state.
  assert.equal(floorUnits(parseUnits('1.2345678', 18), 18, 6), '1.234567');
  assert.equal(floorUnits(parseUnits('1.2345679', 18), 18, 6), '1.234567');
  assert.equal(floorUnits(parseUnits('0.0000009', 18), 18, 6), '0.0');
});

test('a low-decimal pair token is floored to ITS decimals, not to six', () => {
  // USDG is 6dp; a 2dp quote asset could not parse "0.123456" at all.
  assert.equal(floorUnits(parseUnits('12.345678', 6), 6, 2), '12.34');
});

// ── the converter ────────────────────────────────────────────────────────────

test('ETH -> pair is the plain exact-input quote, and says so in its own units', async () => {
  const { deps } = harness();
  const out = await convertPair({ pairToken: NVDA, ethIn: '0.5' }, deps);

  assert.equal(out.pairSymbol, 'NVDA');
  assert.equal(out.ethIn, '0.5');
  // rate 20 on a very deep pool.
  assert.ok(Number(out.pairOut) > 9.99 && Number(out.pairOut) <= 10, out.pairOut);
  assert.equal(out.pairIn, undefined, 'a direction that was not asked about must not be answered');
  assert.equal(out.ethCost, undefined);
  assert.ok(out.quotedAt, 'a rate is a quote and moves — it must carry when it was taken');
});

test('pair -> ETH is the cost to BUY, sized and margined like the funding swap', async () => {
  const { deps } = harness();
  const out = await convertPair({ pairToken: NVDA, pairIn: '10' }, deps);

  assert.equal(out.pairIn, '10.0');
  assert.equal(out.ethCostConverged, true);
  // ~0.5 ETH at spot, plus swapToPair's OVERSHOOT_BPS, and never less than spot:
  // pricing a BUY off a SELL quote is what would under-fund every wallet.
  assert.ok(Number(out.ethCost) > 0.5, `expected the buy cost to exceed spot, got ${out.ethCost}`);
  assert.ok(Number(out.ethCost) < 0.53, out.ethCost);
  assert.equal(out.overshootBps, OVERSHOOT_BPS);
});

test('both directions in one call share one routed fee tier', async () => {
  const { deps } = harness();
  const out = await convertPair({ pairToken: NVDA, ethIn: '1', pairIn: '10' }, deps);
  assert.equal(out.usdgFee, 500);
  assert.ok(out.pairOut && out.ethCost);
});

test('the converter refuses native, an unapproved token and a non-amount', async () => {
  const { deps } = harness();
  await assert.rejects(() => convertPair({ pairToken: NATIVE, ethIn: '1' }, deps), /native-ETH launch/);
  await assert.rejects(
    () => convertPair({ pairToken: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', ethIn: '1' }, deps),
    /not an approved pair token/
  );
  await assert.rejects(() => convertPair({ pairToken: NVDA, ethIn: 'lots' }, deps), /not a valid ETH amount/);
  await assert.rejects(() => convertPair({ pairToken: NVDA, ethIn: '0' }, deps), /must be positive/);
  await assert.rejects(() => convertPair({ pairToken: NVDA }, deps), /ethIn or pairIn is required/);
});

test('the converter resolves approvals from the CACHE, never with a refresh', async () => {
  const seen = [];
  const { deps } = harness();
  deps.resolvePairTokens = async (opts) => {
    seen.push(opts.refresh);
    return [
      { symbol: 'ETH', address: NATIVE, decimals: 18, native: true },
      { symbol: 'NVDA', address: NVDA, decimals: 18 },
    ];
  };
  await convertPair({ pairToken: NVDA, ethIn: '1' }, deps);
  assert.deepEqual(seen, [false], 'a debounced field must not force a whole-chain log scan per keystroke');
});

// ── the balance planner: the gas reserve ─────────────────────────────────────

test('the reserve is swapToPair OWN reserve plus gas for the sells, at the same fees', async () => {
  const { deps } = harness({ ethBalances: { [W1.address]: parseEther('1') } });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);

  const expectSwap = gasReserveWei(FEES, { buyGasLimit: BUY_GAS, gasBufferEth: BUFFER_ETH });
  assert.equal(expectSwap, SWAP_RESERVE, 'the imported reserve must be the arithmetic swapToPair documents');
  assert.equal(out.gasReserveEth, formatEther(SWAP_RESERVE));
  assert.equal(out.sellReserveEth, formatEther(sellReserve(10)));
  assert.equal(out.reserveEth, formatEther(SWAP_RESERVE + sellReserve(10)));
  assert.equal(out.sells, 10);
});

test('sells is clamped rather than trusted, and defaults to the console reserve', async () => {
  const { deps } = harness({ ethBalances: { [W1.address]: parseEther('1') } });
  assert.equal((await planFromBalance({ pairToken: NVDA }, deps)).sells, 10);
  assert.equal((await planFromBalance({ pairToken: NVDA, sells: 9999 }, deps)).sells, 50);
  assert.equal((await planFromBalance({ pairToken: NVDA, sells: -3 }, deps)).sells, 0);
});

// ── the balance planner: the conservative Buy amount ─────────────────────────

test('the Buy amount is one the funding swap can satisfy out of the same balance', async () => {
  const balance = parseEther('0.029');
  const { deps } = harness({ ethBalances: { [W1.address]: balance } });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);
  const r = row(out, 'w1');

  assert.equal(r.status, 'ok');
  const reserve = SWAP_RESERVE + sellReserve(10);
  const spendable = balance - reserve;
  assert.equal(r.spendableEth, formatEther(spendable));

  // THE INVARIANT THIS WHOLE FEATURE TURNS ON. swapBundleToPair sizes an input
  // whose quote clears the requirement and then broadcasts 103% of it, and it
  // refuses the wallet unless balance >= thatInput + its own gas reserve. So:
  const need = parseUnits(r.buyPair, 18);
  // 1. re-do its sizing against the same pool. Invert it exactly:
  //    out = in*rate*depth/(depth+in)  =>  in = out*depth/(rate*depth - out)
  const q = pool();
  const depth = parseEther('100000');
  const rate = 20n;
  const den = rate * depth - need;
  const sizedIn = (need * depth + den - 1n) / den; // ceil, as the real sizer rounds up
  assert.ok(q(sizedIn) >= need - 1n, 'sanity: the inversion reproduces the pool');
  const broadcast = (sizedIn * (10_000n + BigInt(OVERSHOOT_BPS))) / 10_000n;
  // 2. and the wallet must still clear the run's own check
  assert.ok(
    balance >= broadcast + SWAP_RESERVE,
    `the planned Buy amount would be refused as short: needs ${formatEther(broadcast + SWAP_RESERVE)}, ` +
      `holds ${formatEther(balance)}`
  );
  // 3. with the sell reserve still intact afterwards
  assert.ok(balance - broadcast >= SWAP_RESERVE + sellReserve(10) - parseEther('0.0001'));
});

test('the Buy amount is the quote LESS the margin, never the quote itself', async () => {
  const { deps } = harness({ ethBalances: { [W1.address]: parseEther('1') } });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);
  const r = row(out, 'w1');

  const quoted = Number(r.quotedPair);
  const buy = Number(r.buyPair);
  assert.ok(buy < quoted, 'writing the optimistic quote is the bug this margin exists to prevent');
  const ratio = buy / quoted;
  assert.ok(ratio > 0.965 && ratio <= 0.97, `expected ~${(10_000 - OVERSHOOT_BPS) / 10_000}, got ${ratio}`);
});

test('what a wallet already holds is added, so its ETH is not left unspent', async () => {
  const held = parseUnits('4', 18);
  const { deps } = harness({
    wallets: [W1, W2],
    ethBalances: { [W1.address]: parseEther('1'), [W2.address]: parseEther('1') },
    pairBalances: { [W2.address]: held },
  });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);

  assert.equal(row(out, 'w1').heldPair, '0.0');
  assert.equal(row(out, 'w2').heldPair, '4.0');
  // Same balance, same quote — the only difference is the 4 already in hand, and
  // swapBundleToPair tops up the SHORTFALL, so the difference is exactly 4.
  const diff = Number(row(out, 'w2').buyPair) - Number(row(out, 'w1').buyPair);
  assert.ok(Math.abs(diff - 4) < 1e-6, `expected the held 4 NVDA to be carried through, got ${diff}`);
});

// ── the balance planner: skipping, named ─────────────────────────────────────

test('a wallet that cannot cover the reserve is skipped and NAMED, not given a zero buy', async () => {
  const { deps } = harness({
    wallets: [W1, W2, W3],
    ethBalances: {
      [W1.address]: parseEther('0.029'),
      [W2.address]: parseEther('0.001'), // under the reserve
      [W3.address]: 0n,
    },
  });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);

  assert.equal(out.usable, 1);
  assert.equal(out.skippedNoEth, 2);
  for (const id of ['w2', 'w3']) {
    const r = row(out, id);
    assert.equal(r.status, 'skipped-no-eth');
    assert.equal(r.buyPair, null, 'a skipped wallet must get NO Buy amount rather than 0');
    assert.match(r.reason, /reserved/);
    assert.ok(r.address, 'a skipped wallet must be named');
  }
  // Every wallet appears, whatever happened to it.
  assert.equal(out.count, 3);
  assert.equal(out.results.length, 3);
});

test('a wallet whose swap would drain a thin pool is refused, exactly as the run would refuse it', async () => {
  const { deps } = harness({
    ethBalances: { [W1.address]: parseEther('5') },
    quote: pool({ rate: 20n, depth: parseEther('1') }), // MSTR-shaped
    maxImpactBps: 500,
  });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-impact');
  assert.equal(r.buyPair, null);
  assert.match(r.reason, /price impact/);
  assert.equal(out.usable, 0);
  assert.equal(out.skippedImpact, 1);
});

test('one wallet failing does not take the others with it', async () => {
  const { deps } = harness({
    wallets: [W1, W2],
    ethBalances: { [W1.address]: parseEther('0.05'), [W2.address]: parseEther('0.05') },
  });
  deps.provider.getBalance = async (a) => {
    if (a === W1.address) throw new Error('rpc hiccup');
    return parseEther('0.05');
  };
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);
  assert.equal(row(out, 'w1').status, 'failed');
  assert.match(row(out, 'w1').reason, /rpc hiccup/);
  assert.equal(row(out, 'w2').status, 'ok');
  assert.equal(out.usable, 1);
  assert.equal(out.failed, 1);
});

test('a pair with no route refuses the whole plan before any wallet is priced', async () => {
  const { deps, balanceReads } = harness({
    ethBalances: { [W1.address]: parseEther('1') },
    discoverThrows: 'no USDG pool with liquidity',
  });
  await assert.rejects(() => planFromBalance({ pairToken: NVDA }, deps), /no ETH to NVDA route/);
  assert.equal(balanceReads.length, 0);
});

// ── the totals the operator is shown before committing ───────────────────────

test('the totals state the ETH ceiling and the pair total WITHOUT ever summing across them', async () => {
  const { deps } = harness({
    wallets: [W1, W2, W3],
    ethBalances: {
      [W1.address]: parseEther('0.029'),
      [W2.address]: parseEther('0.022'),
      [W3.address]: parseEther('0.0005'),
    },
  });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);

  assert.equal(out.usable, 2);
  assert.equal(out.skippedNoEth, 1);
  const swaps = out.results.filter((r) => r.status === 'ok').map((r) => Number(r.swapEth));
  assert.ok(Math.abs(Number(out.totalSwapEth) - swaps.reduce((a, b) => a + b, 0)) < 1e-9);
  const buys = out.results.filter((r) => r.status === 'ok').map((r) => Number(r.buyPair));
  assert.ok(Math.abs(Number(out.totalBuyPair) - buys.reduce((a, b) => a + b, 0)) < 1e-6);
  // The two totals are different assets and are reported as different fields.
  assert.notEqual(out.totalSwapEth, out.totalBuyPair);
  assert.equal(out.pairSymbol, 'NVDA');
});

test('the planned swap input is a CEILING: it is never more than the wallet may spend', async () => {
  const balance = parseEther('0.029');
  const { deps } = harness({ ethBalances: { [W1.address]: balance } });
  const out = await planFromBalance({ pairToken: NVDA, sells: 10 }, deps);
  const r = row(out, 'w1');
  const spendable = balance - (SWAP_RESERVE + sellReserve(10));
  const swapIn = parseEther(r.swapEth);
  const broadcast = (swapIn * (10_000n + BigInt(OVERSHOOT_BPS))) / 10_000n;
  assert.ok(broadcast <= spendable, 'the +3% the run adds on top must still fit inside the spendable balance');
});

test('a plan against a launcher with no bundle wallets refuses rather than returning an empty run', async () => {
  const { deps } = harness({ wallets: [] });
  await assert.rejects(() => planFromBalance({ pairToken: NVDA }, deps), /no v1 bundle wallets/);
});
