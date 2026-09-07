'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther, parseUnits, formatEther } = require('ethers');

const { swapBundleToPair, sizeEthForPair } = require('./swapToPair');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const W1 = { id: 'w1', role: 'bundle', address: '0x1111111111111111111111111111111111111111' };
const W2 = { id: 'w2', role: 'bundle', address: '0x2222222222222222222222222222222222222222' };
const W3 = { id: 'w3', role: 'bundle', address: '0x3333333333333333333333333333333333333333' };

// 1 gwei, so the reserve is a readable 0.00185 ETH: 0.00045 for the 450k swap,
// 0.001 for 2 x (100k approve + 400k buy), and the 0.0004 buffer.
const FEES = { type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
const RESERVE = parseEther('0.00185');

/**
 * A constant-product-ish pool: out = in * rate * depth / (depth + in).
 *
 * The 1/(1+in/depth) term is what makes a linear sizing guess an UNDER-estimate,
 * so the sizing loop under test has to actually iterate. A large `depth` is a deep
 * pool (NVDA at 0.01%); a small one is MSTR at 79%.
 */
function pool({ rate = 20n, depth = parseEther('100000') } = {}) {
  return (amountIn) => (BigInt(amountIn) * rate * depth) / (depth + BigInt(amountIn));
}

/**
 * Everything swapBundleToPair touches, faked. Balances are walked forward by the
 * fake signer, so a delta the module measures is measuring something that moved.
 */
function harness({
  wallets = [W1],
  ethBalances = { [W1.address]: parseEther('1') },
  pairBalances = {},
  quote = pool(),
  decimals = 18,
  approved = [
    { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18, native: true },
    { symbol: 'NVDA', address: NVDA, decimals: 18 },
  ],
  feeTier = 500,
  discoverThrows = null,
  sendThrows = null, // (address) => Error|null
  receiptStatus = 1,
  fillFactor = null, // deliver less than quoted, to model a moved price
} = {}) {
  const eth = { ...ethBalances };
  const pair = { ...pairBalances };
  const sent = [];
  // What the route was asked to BUILD. The broadcast keeps only to/data/value, so
  // the floor has to be inspected here rather than on the sent transaction.
  const built = [];
  const probe = 10n ** 15n;

  const route = {
    discoverPairFee: async () => {
      if (discoverThrows) throw new Error(discoverThrows);
      return feeTier;
    },
    quoteEthToPair: async ({ amountInWei }) => ({ amountOut: quote(amountInWei), usdgFee: feeTier }),
    assessBuyImpact: async ({ amountInWei }) => {
      const amt = BigInt(amountInWei);
      const fullOut = quote(amt);
      const probeOut = quote(probe);
      const kept = Number((fullOut * probe * 10_000n) / (probeOut * amt));
      return { impactBps: Math.max(0, Math.min(10_000, 10_000 - kept)), fullOut, usdgFee: feeTier };
    },
    buildSwapEthToPair: ({ amountInWei, minOut, recipient }) => {
      built.push({ amountIn: BigInt(amountInWei), minOut: BigInt(minOut), recipient });
      return { to: '0xcaf681a66d020601342297493863E78C959E5cb2', data: '0xswap', value: BigInt(amountInWei) };
    },
  };

  const deps = {
    dryRun: false,
    buyGasLimit: 400_000,
    gasBufferEth: '0.0004',
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
          sent.push({ ...tx, walletId: id, address: w.address, hash });
          const gas = 450_000n * 1_000_000_000n;
          eth[w.address] = (eth[w.address] ?? 0n) - BigInt(tx.value) - gas;
          if (receiptStatus === 1) {
            const out = quote(BigInt(tx.value));
            const filled = fillFactor ? (out * BigInt(fillFactor)) / 10_000n : out;
            pair[w.address] = (pair[w.address] ?? 0n) + filled;
          }
          return { hash };
        },
      }),
    },
    route,
    resolvePairTokens: async () => approved,
    getFees: async () => FEES,
    readTokenBalance: async (_t, owner) => pair[owner] ?? 0n,
    waitForReceipt: async (_rpc, hash) => ({ status: receiptStatus, blockNumber: 99, hash }),
  };

  return { deps, sent, built, eth, pair, quote, decimals };
}

const row = (out, id) => out.results.find((r) => r.walletId === id);

// ── sizing ────────────────────────────────────────────────────────────────────

test('sizing inverts an exact-input quote: the ETH it picks buys at least what is needed', async () => {
  const q = pool({ rate: 20n, depth: parseEther('50') }); // shallow enough that impact bites
  const route = { quoteEthToPair: async ({ amountInWei }) => ({ amountOut: q(amountInWei) }) };
  const need = parseUnits('20', 18); // ~1 ETH at spot, but impact means more than 1

  const { ethIn, quotedOut, rounds } = await sizeEthForPair({ pairToken: NVDA, need }, { route, provider: {} });

  assert.ok(quotedOut >= need, 'the sized input must quote at least the requirement');
  assert.ok(ethIn > parseEther('1'), 'a linear guess under-sizes on a pool with impact — it must be corrected up');
  assert.ok(rounds > 1, 'it must have re-quoted rather than trusted the linear guess');
  // And it must not wildly over-size: the correction stops as soon as it clears.
  assert.ok(ethIn < parseEther('1.2'), `sized ${formatEther(ethIn)} ETH for a ~1 ETH requirement`);
});

test('a wallet ends up holding what its Buy amount demands, and the swap is floored at that', async () => {
  const { deps, sent, built, pair } = harness();
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(out.swapped, 1);
  assert.equal(out.failed, 0);
  const r = row(out, 'w1');
  assert.equal(r.status, 'swapped');
  assert.ok(Number(r.holdingPair) >= 10, `ended holding ${r.holdingPair} NVDA`);
  assert.equal(pair[W1.address] >= parseUnits('10', 18), true);

  // The floor is real and is the requirement itself — never 0 on a public AMM.
  assert.equal(sent.length, 1);
  assert.ok(built[0].minOut >= parseUnits('10', 18), `minOut was ${built[0].minOut}`);
  // And the input carries the 3% margin over what the requirement alone quotes at.
  assert.ok(BigInt(sent[0].value) > parseEther('0.5'));
  assert.equal(out.totalEth, formatEther(BigInt(sent[0].value)));
});

test('a partial holder is topped up by the shortfall, not made to buy the whole amount', async () => {
  const { deps, built } = harness({ pairBalances: { [W1.address]: parseUnits('6', 18) } });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(row(out, 'w1').status, 'swapped');
  // The floor is the SHORTFALL (4), not the requirement (10).
  assert.ok(built[0].minOut >= parseUnits('4', 18));
  assert.ok(built[0].minOut < parseUnits('10', 18));
  assert.ok(Number(row(out, 'w1').holdingPair) >= 10);
});

test('a pair token with non-18 decimals is sized in ITS units, not ether', async () => {
  const { deps, built } = harness({
    approved: [{ symbol: 'USDGX', address: NVDA, decimals: 6 }],
    quote: pool({ rate: 2000n }),
  });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '25.5' }] },
    deps
  );
  assert.equal(out.pairDecimals, 6);
  assert.equal(row(out, 'w1').needPair, '25.5');
  assert.ok(built[0].minOut >= parseUnits('25.5', 6));
  // 25.5 units at 6 decimals is 25_500_000 — a wei-denominated bug would ask for 1e18 of them.
  assert.ok(built[0].minOut < parseUnits('26', 6));
});

// ── the skips and the refusals ────────────────────────────────────────────────

test('a wallet that already holds enough is skipped, not swapped again', async () => {
  const { deps, sent } = harness({ pairBalances: { [W1.address]: parseUnits('12', 18) } });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(out.skippedAlreadyFunded, 1);
  assert.equal(out.swapped, 0);
  assert.equal(sent.length, 0, 'nothing may be broadcast for a wallet that is already funded');
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-already-funded');
  assert.equal(r.holdingPair, '12.0');
  assert.match(r.reason, /already holds/);
  assert.equal(out.totalEth, '0.0');
});

test('a wallet that cannot cover the swap plus its gas is refused, and NOTHING is sent', async () => {
  // Enough for the swap input but not for the reserve behind it.
  const { deps, sent, eth } = harness({ ethBalances: { [W1.address]: parseEther('0.5001') } });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(out.skippedShort, 1);
  assert.equal(out.swapped, 0);
  assert.equal(sent.length, 0, 'a short wallet must not be half-spent');
  assert.equal(eth[W1.address], parseEther('0.5001'), 'its ETH is untouched');
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-short');
  assert.match(r.reason, /Nothing was sent/);
  assert.match(r.reason, /reserved for the swap, the launch's approve \+ buy, and the gas buffer/);
});

test('a wallet holding NO ETH is still PRICED — the console sizes the Fund column before step 4 funds anything', async () => {
  // The auto-fill case: the operator has typed a total, nothing has been funded
  // yet, so every wallet is skipped-short. The refusal is unchanged; what it must
  // also carry is the number, because that number IS the Fund column.
  const { deps, sent } = harness({ ethBalances: { [W1.address]: 0n } });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, dryRun: true, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(sent.length, 0);
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-short', 'an empty wallet is still refused');
  assert.ok(Number(r.swapEth) > 0, 'and still reports what its swap would cost');
  // The prose and the field are the same figure, so neither can drift from the other.
  assert.ok(r.reason.includes(`${r.swapEth} to buy`), r.reason);
  // The reserve behind the refusal, reported so the console funds to the number
  // the refusal is measured against rather than to a second guess at it.
  assert.equal(out.gasReserveEth, formatEther(RESERVE));
  assert.equal(
    parseEther(r.swapEth) + parseEther(out.gasReserveEth),
    parseEther(r.reason.match(/needs ([\d.]+) /)[1]),
    'swapEth + gasReserveEth is exactly what the wallet was asked for'
  );
});

test('the gas reserve leaves the launch its approve AND its buy, at double the current fee', async () => {
  // Price the swap first, then hand the wallet one wei less than the whole plan
  // costs. The boundary is what pins the reserve: swap gas + 2 x (approve + buy)
  // gas + the buffer prepareV2's own preflight demands.
  const priced = await (async () => {
    const { deps } = harness();
    const out = await swapBundleToPair(
      { variant: 'v1', pairToken: NVDA, dryRun: true, targets: [{ walletId: 'w1', amountPair: '10' }] },
      deps
    );
    return parseEther(row(out, 'w1').swapEth);
  })();

  const short = harness({ ethBalances: { [W1.address]: priced + RESERVE - 1n } });
  const a = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    short.deps
  );
  assert.equal(row(a, 'w1').status, 'skipped-short', 'one wei under the reserve must refuse');
  assert.equal(short.sent.length, 0);

  const exact = harness({ ethBalances: { [W1.address]: priced + RESERVE } });
  const b = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    exact.deps
  );
  assert.equal(row(b, 'w1').status, 'swapped', 'and exactly the reserve must be enough');
  // What is left is the reserve itself, minus the swap's own gas which has now been paid.
  assert.equal(exact.eth[W1.address], RESERVE - 450_000n * 1_000_000_000n);
});

test('a pool the swap would drain is refused by the impact guard, not by the floor', async () => {
  // A pool so shallow that buying 10 NVDA moves it far past the 10% cap — this is
  // MSTR/SHOP/TTWO, which are really approved. The quoter SATURATES instead of
  // reverting, so only this check can see it.
  const { deps, sent } = harness({
    quote: pool({ rate: 20n, depth: parseEther('3') }),
    ethBalances: { [W1.address]: parseEther('100') },
  });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );

  assert.equal(out.skippedImpact, 1);
  assert.equal(sent.length, 0, 'a pool-draining swap must never be broadcast');
  const r = row(out, 'w1');
  assert.equal(r.status, 'skipped-impact');
  assert.ok(r.impactBps > 1000);
  assert.match(r.reason, /would move the NVDA pool/);
  assert.match(r.reason, /Nothing was sent/);
});

// ── isolation ─────────────────────────────────────────────────────────────────

test('one wallet failing to broadcast never stops the others', async () => {
  const { deps, sent } = harness({
    wallets: [W1, W2, W3],
    ethBalances: { [W1.address]: parseEther('1'), [W2.address]: parseEther('1'), [W3.address]: parseEther('1') },
    sendThrows: (addr) => (addr === W2.address ? new Error('replacement transaction underpriced') : null),
  });

  const out = await swapBundleToPair(
    {
      variant: 'v1',
      pairToken: NVDA,
      targets: [
        { walletId: 'w1', amountPair: '10' },
        { walletId: 'w2', amountPair: '10' },
        { walletId: 'w3', amountPair: '10' },
      ],
    },
    deps
  );

  assert.equal(out.count, 3);
  assert.equal(out.swapped, 2);
  assert.equal(out.failed, 1);
  assert.equal(sent.length, 2, 'the two healthy wallets still swapped');
  assert.equal(row(out, 'w1').status, 'swapped');
  assert.equal(row(out, 'w3').status, 'swapped');
  const bad = row(out, 'w2');
  assert.equal(bad.status, 'failed');
  assert.match(bad.reason, /failed to broadcast/);
  assert.equal(bad.holdingPair, '0.0', 'a failed wallet still reports what it holds');
});

test('a mixed run reports every wallet, and the ETH total counts only what was spent', async () => {
  const { deps, sent } = harness({
    wallets: [W1, W2, W3],
    ethBalances: {
      [W1.address]: parseEther('1'),
      [W2.address]: parseEther('1'),
      [W3.address]: parseEther('0.0001'), // cannot cover anything
    },
    pairBalances: { [W2.address]: parseUnits('99', 18) },
  });

  const out = await swapBundleToPair(
    {
      variant: 'v1',
      pairToken: NVDA,
      targets: [
        { walletId: 'w1', amountPair: '10' },
        { walletId: 'w2', amountPair: '10' },
        { walletId: 'w3', amountPair: '10' },
      ],
    },
    deps
  );

  assert.equal(out.count, 3);
  assert.equal(out.swapped, 1);
  assert.equal(out.skippedAlreadyFunded, 1);
  assert.equal(out.skippedShort, 1);
  assert.equal(out.failed, 0);
  assert.equal(out.results.length, 3, 'every wallet is reported, whatever happened to it');
  assert.ok(out.results.every((r) => r.status && r.holdingPair !== null));
  assert.equal(out.totalEth, formatEther(BigInt(sent[0].value)), 'only the wallet that swapped is in the total');
});

test('a reverted swap is reported as a failure that kept its ETH', async () => {
  const { deps } = harness({ receiptStatus: 0 });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );
  const r = row(out, 'w1');
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /reverted/);
  assert.match(r.reason, /the ETH was not spent/);
  assert.equal(out.totalEth, '0.0', 'a reverted swap spends nothing');
});

test('a confirmed swap that still leaves the wallet short is reported, never called success', async () => {
  // The fill lands 20% under the quote — impossible past the on-chain floor, so this
  // is the lagging-balance case. It must not be counted as swapped.
  const { deps } = harness({ fillFactor: 8000 });
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );
  assert.equal(out.swapped, 0);
  assert.equal(out.swappedShort, 1);
  assert.equal(row(out, 'w1').status, 'swapped-short');
  assert.match(row(out, 'w1').reason, /re-read the balance before arming/);
});

// ── whole-run refusals: nothing is priced, nothing is sent ────────────────────

test('a pair token that is not approved RIGHT NOW is refused', async () => {
  const { deps, sent } = harness({
    // The live read is what decides: this list is what the factory answers today.
    approved: [{ symbol: 'SPCX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18 }],
  });
  await assert.rejects(
    swapBundleToPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] }, deps),
    /is not an approved pair token right now/
  );
  assert.equal(sent.length, 0);
});

test('the seed list is only a hint — an un-approved seed token is still refused', async () => {
  // USDG is in pairTokens.js's SEED_CANDIDATES. Membership there is not approval.
  const { deps } = harness({ approved: [{ symbol: 'NVDA', address: NVDA, decimals: 18 }] });
  await assert.rejects(
    swapBundleToPair({ variant: 'v1', pairToken: USDG, targets: [{ walletId: 'w1', amountPair: '10' }] }, deps),
    /is not an approved pair token right now/
  );
});

test('a native launch is refused — its bundle buys are already in ETH', async () => {
  const { deps } = harness();
  await assert.rejects(
    swapBundleToPair(
      {
        variant: 'v1',
        pairToken: '0x0000000000000000000000000000000000000000',
        targets: [{ walletId: 'w1', amountPair: '10' }],
      },
      deps
    ),
    /native-ETH launch needs no pair token/
  );
});

test('a pair token with no funded USDG pool is refused once, before any wallet is touched', async () => {
  const { deps, sent } = harness({ discoverThrows: 'no USDG<->0x… pool with liquidity' });
  await assert.rejects(
    swapBundleToPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] }, deps),
    /no ETH→NVDA route/
  );
  assert.equal(sent.length, 0);
});

test('a target that is not this launcher\'s bundle wallet refuses the whole request', async () => {
  const { deps, sent } = harness({ wallets: [W1] });
  await assert.rejects(
    swapBundleToPair(
      {
        variant: 'v1',
        pairToken: NVDA,
        targets: [
          { walletId: 'w1', amountPair: '10' },
          { walletId: 'stranger', amountPair: '10' },
        ],
      },
      deps
    ),
    /stranger is not a v1 bundle wallet/
  );
  assert.equal(sent.length, 0, 'not even the valid target is spent when the request is confused');
});

test('a non-positive or unparseable amount refuses the request rather than sending 0', async () => {
  const { deps } = harness();
  await assert.rejects(
    swapBundleToPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '0' }] }, deps),
    /amountPair must be positive/
  );
  await assert.rejects(
    swapBundleToPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: 'abc' }] }, deps),
    /is not a valid NVDA amount/
  );
});

test('an empty or oversized targets list is refused', async () => {
  const { deps } = harness();
  await assert.rejects(swapBundleToPair({ variant: 'v1', pairToken: NVDA, targets: [] }, deps), /targets\[\] is required/);
  await assert.rejects(
    swapBundleToPair(
      { variant: 'v1', pairToken: NVDA, targets: Array.from({ length: 101 }, () => ({ walletId: 'w1', amountPair: '1' })) },
      deps
    ),
    /capped at 100/
  );
});

test('the same wallet named twice is refused rather than guessed at', async () => {
  const { deps, sent } = harness();
  await assert.rejects(
    swapBundleToPair(
      {
        variant: 'v1',
        pairToken: NVDA,
        targets: [
          { walletId: 'w1', amountPair: '10' },
          { walletId: 'w1', amountPair: '4' },
        ],
      },
      deps
    ),
    /is named twice in targets/
  );
  assert.equal(sent.length, 0);
});

test('an empty pool is refused once for the run, not discovered per wallet', async () => {
  const { deps, sent } = harness({ quote: () => 0n });
  await assert.rejects(
    swapBundleToPair({ variant: 'v1', pairToken: NVDA, targets: [{ walletId: 'w1', amountPair: '10' }] }, deps),
    /the pool is empty/
  );
  assert.equal(sent.length, 0);
});

// ── dry run ───────────────────────────────────────────────────────────────────

test('a dry run prices the whole plan and broadcasts nothing', async () => {
  const { deps, sent, eth } = harness({
    wallets: [W1, W2],
    ethBalances: { [W1.address]: parseEther('1'), [W2.address]: parseEther('1') },
  });
  const out = await swapBundleToPair(
    {
      variant: 'v1',
      pairToken: NVDA,
      dryRun: true,
      targets: [
        { walletId: 'w1', amountPair: '10' },
        { walletId: 'w2', amountPair: '10' },
      ],
    },
    deps
  );

  assert.equal(out.dryRun, true);
  assert.equal(out.wouldSwap, 2);
  assert.equal(out.swapped, 0);
  assert.equal(sent.length, 0);
  assert.equal(eth[W1.address], parseEther('1'));
  assert.ok(Number(out.totalEth) > 0, 'the priced total is what the console shows before spending');
  assert.equal(row(out, 'w1').status, 'would-swap');
});

test('a DRY_RUN deployment cannot be talked into sending', async () => {
  const { deps, sent } = harness();
  deps.dryRun = true;
  const out = await swapBundleToPair(
    { variant: 'v1', pairToken: NVDA, dryRun: false, targets: [{ walletId: 'w1', amountPair: '10' }] },
    deps
  );
  assert.equal(out.dryRun, true);
  assert.equal(sent.length, 0);
});
