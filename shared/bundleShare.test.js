'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseEthToWei,
  estimateTokensOut,
  capCheck,
  openingPool,
  constantProductBuy,
  v2Buy,
  shareV1,
  shareV2,
  bundleShare,
} = require('./bundleShare');

// NOTHING HERE TOUCHES THE CHAIN. Both protocols are fixed by their launch
// config before a launch is sent, which is the whole reason this arithmetic can
// run as the operator types — so the fixtures are the live configs, and the
// answers are checked against readings taken from real launches.

const eth = (n) => parseEthToWei(String(n));

// pons v1 launch config, and the real launch the maths is anchored to:
//   token 0x4aE28f7022F0db76F9B791ff3DEe6bE67B40137F, initialTick -204200,
//   where 0.003 ETH bought 2,186,029 tokens.
const V1 = {
  supply: (1_000_000_000n * 10n ** 18n).toString(),
  initialTick: -204200,
  maxWalletBps: 500, // 5%
  maxTxBps: 550, // 5.5%
};

// pons v2 launch config #0, read live from the factory.
const V2 = {
  supply: (1_000_000_000n * 10n ** 18n).toString(),
  phantomQuote: (168n * 10n ** 16n).toString(), // 1.68 ETH
  graduationThreshold: (42n * 10n ** 17n).toString(), // 4.2 ETH
  curveFeeBps: 100, // 1%
  enabled: true,
};

const fresh = { quoteReserve: V2.phantomQuote, tokenReserve: V2.supply, feeBps: V2.curveFeeBps };

// ── parsing what the operator typed ────────────────────────────────────────

test('ETH is parsed as decimal string arithmetic, not through a double', () => {
  assert.equal(parseEthToWei('0.6'), 600000000000000000n);
  assert.equal(parseEthToWei('1'), 10n ** 18n);
  assert.equal(parseEthToWei('0.000000000000000001'), 1n);
  // A field mid-edit, or emptied. Neither is an error and neither is a buy.
  assert.equal(parseEthToWei(''), 0n);
  assert.equal(parseEthToWei('.'), 0n);
  assert.equal(parseEthToWei(undefined), 0n);
  assert.equal(parseEthToWei('-1'), 0n);
});

// ── v2: the curve's own arithmetic ─────────────────────────────────────────

test('a small buy on a fresh curve lands on what the chain paid out', () => {
  // 0.00012 ETH bought 70,684 tokens on a fresh config #0 curve.
  const { tokensOut } = v2Buy({ quoteInWei: eth('0.00012'), ...fresh });
  const tokens = Number(tokensOut) / 1e18;
  const ratio = tokens / 70684;
  assert.ok(ratio > 0.995 && ratio < 1.005, `expected ~70,684 tokens, got ${tokens}`);
  // High rather than low: the residual is fee accounting not re-derived from
  // the curve source, and a share that reads a hair generous is the safe way
  // round for both things this warns about.
  assert.ok(tokens > 70684, 'the estimate errs high');
});

test('one ETH takes about 37% of the supply', () => {
  const { tokensOut } = v2Buy({ quoteInWei: eth('1'), ...fresh });
  const pct = (Number(tokensOut) / Number(BigInt(V2.supply))) * 100;
  assert.ok(pct > 36.5 && pct < 37.5, `expected ~37% of supply, got ${pct}%`);
  const tokens = Number(tokensOut) / 1e18;
  assert.ok(tokens > 365e6 && tokens < 375e6, `expected ~370M tokens, got ${tokens}`);
});

test('the curve fee and the creator tax come off the INPUT', () => {
  // Both are charged in the quote asset, which is the input of a buy — so a 1%
  // fee has to be indistinguishable from sending 1% less with no fee. (The SELL
  // side takes them off the output; same rule, other leg.)
  const withFee = v2Buy({ quoteInWei: eth('0.5'), ...fresh, feeBps: 100 });
  const netInstead = v2Buy({ quoteInWei: eth('0.495'), ...fresh, feeBps: 0 });
  assert.equal(withFee.tokensOut, netInstead.tokensOut);

  // And the creator tax rides the same leg, so it compounds with the curve fee.
  const taxed = v2Buy({ quoteInWei: eth('0.5'), ...fresh, feeBps: 100 + 100 });
  assert.ok(taxed.tokensOut < withFee.tokensOut, 'the creator tax must cost the buyer tokens');
});

test('the same ETH buys less the later it lands, and where it lands is unknown', () => {
  const buys = Array.from({ length: 3 }, (_, i) => ({ key: `w${i}`, amountEth: '0.2' }));
  const share = shareV2({ launchConfig: V2, buys });

  // Three wallets buying the same amount are INTERCHANGEABLE: same range each,
  // because the sequencer decides which of them lands first, not the table.
  for (const leg of share.buys) {
    assert.equal(leg.estBps, share.buys[0].estBps);
    assert.equal(leg.worstBps, share.buys[0].worstBps);
  }
  // And the range is wide enough to matter: landing behind the other 0.4 ETH
  // costs a fifth of the fill.
  assert.ok(share.buys[0].worstBps < share.buys[0].estBps * 0.8);

  // Quoting every wallet at the top of its range — the mistake this exists to
  // prevent — overstates the bundle, because they cannot all land first. The
  // bottom of the range understates it for the same reason.
  assert.ok(share.buys[0].estBps * 3 > share.bundle.bps, 'they cannot all land first');
  assert.ok(share.buys[0].worstBps * 3 < share.bundle.bps, 'nor can they all land last');
  assert.equal(share.exact, true);
});

test('a constant product is path-independent: one trade of N equals k trades summing to N', () => {
  // THIS IS WHY THE BUNDLE TOTAL IS NOT A GUESS. Chopping the same ETH into
  // more wallets, in any order, leaves the pool in the same place — so the
  // total needs no range and no hedge, and only the split between the wallets
  // is undetermined.
  const curve = {
    quoteReserve: BigInt(V2.phantomQuote),
    tokenReserve: BigInt(V2.supply),
    feeBps: V2.curveFeeBps,
  };
  const walk = (amounts, { quoteReserve, tokenReserve, feeBps }) => {
    let out = 0n;
    for (const a of amounts) {
      const r = constantProductBuy({ quoteInWei: eth(a), quoteReserve, tokenReserve, feeBps });
      quoteReserve = r.quoteReserve;
      tokenReserve = r.tokenReserve;
      out += r.tokensOut;
    }
    return out;
  };

  const ragged = ['0.13', '0.02', '0.4', '0.07', '0.1']; // 0.72
  const single = walk(['0.72'], curve);
  for (const split of [Array(12).fill('0.06'), ragged, [...ragged].reverse()]) {
    const total = walk(split, curve);
    // Not bit-identical: every step floors, so k steps shed a few wei of token
    // against one. Parts in 1e26 — the property holds, the integer division is
    // the only thing between them.
    const drift = total > single ? total - single : single - total;
    assert.ok(drift < 100n, `${split.length} trades drifted ${drift} wei from one`);
  }

  // Same on the pool a v1 launch config opens, which is the same arithmetic
  // with no fee on the input.
  const v1pool = { ...openingPool(V1), feeBps: 0 };
  const v1drift = walk(Array(12).fill('0.06'), v1pool) - walk(['0.72'], v1pool);
  assert.ok(v1drift > -100n && v1drift < 100n, `v1 drifted ${v1drift} wei`);
});

test('the dev buy is taken off the curve before any bundle wallet', () => {
  const buys = [{ key: 'w0', amountEth: '0.2' }];
  const alone = shareV2({ launchConfig: V2, buys });
  const behindDev = shareV2({ launchConfig: V2, devBuyEth: '0.5', buys });

  assert.equal(alone.dev, null);
  assert.ok(behindDev.dev.estBps > 0, 'the dev buy has to be reported, not just applied');
  assert.ok(
    behindDev.buys[0].estBps < alone.buys[0].estBps,
    'a wallet buying behind the dev buy pays the price the dev buy left'
  );
  // The bundle total is the wallets; the dev buy is stated apart from it and
  // both together are the total.
  assert.ok(behindDev.total.bps > behindDev.bundle.bps);
  assert.ok(
    Math.abs(behindDev.total.bps - (behindDev.bundle.bps + behindDev.dev.estBps)) < 0.02
  );
});

test('a bundle that would graduate the curve on entry says so, and names the wallet', () => {
  const buys = Array.from({ length: 5 }, (_, i) => ({ key: `w${i}`, amountEth: '1' }));
  const share = shareV2({ launchConfig: V2, buys });

  assert.equal(share.graduation.crosses, true);
  // 4.2 ETH of net quote, at 1% off the input: the fifth wallet is the one that
  // takes it over, not the fourth.
  assert.equal(share.graduation.crossesAt, 'w4');
  assert.equal(share.graduation.thresholdEth, '4.200000');
});

test('a bundle that stays under the threshold reports no graduation', () => {
  const buys = Array.from({ length: 4 }, (_, i) => ({ key: `w${i}`, amountEth: '0.25' }));
  const share = shareV2({ launchConfig: V2, buys });
  assert.equal(share.graduation.crosses, false);
  assert.equal(share.graduation.crossesAt, null);
  assert.equal(share.graduation.raisedEth, '0.990000'); // 1 ETH in, 1% to fees
});

test('v2 has no caps to breach', () => {
  // There is no restriction window on a curve, so a big buy is expensive, not
  // fatal — reporting it as "over the cap" would be a v1 idea in a v2 launch.
  const share = shareV2({ launchConfig: V2, buys: [{ key: 'w0', amountEth: '2' }] });
  assert.equal(share.caps, null);
  assert.deepEqual(share.over, []);
  assert.equal(share.buys[0].exceedsWallet, false);
});

// ── v1: the opening tick, and the caps that revert ─────────────────────────

test('the v1 estimate still lands on the launch it is anchored to', () => {
  // 0.003 ETH bought 2,186,029 tokens on the real launch at tick -204200.
  const share = shareV1({ launchConfig: V1, buys: [{ key: 'w0', amountEth: '0.003' }] });
  const got = share.buys[0].estTokens;
  const ratio = got / 2186029;
  assert.ok(ratio > 1 && ratio < 1.02, `expected ~2,186,029 tokens, got ${got}`);

  // ABOVE the chain, never below. The pool's own 1% fee is not modelled and a
  // real v3 range position is not a full-range constant product; both take the
  // fill down from this, so it stays a ceiling — a tighter one than the flat
  // opening rate, which reads 2,212,948 for the same buy.
  const flat = estimateTokensOut({ amountInWei: eth('0.003'), initialTick: V1.initialTick });
  assert.ok(got < flat, 'the impact term has to cost the buyer something');
  assert.ok(flat / 2186029 > ratio, 'and has to land closer to what the chain paid');
});

test('a v1 bundle totals the share every wallet takes', () => {
  const buys = Array.from({ length: 27 }, (_, i) => ({ key: `w${i}`, amountEth: '0.00156489' }));
  const share = shareV1({ launchConfig: V1, buys });

  // ~11.5 bps each at the top of the range, and 27 of them.
  assert.ok(share.buys[0].estBps > 5 && share.buys[0].estBps < 20);
  assert.equal(share.bundle.eth, '0.042252');
  assert.deepEqual(share.over, []);

  // 0.042 ETH is small against this pool, so the impact is small — but it is
  // there, and the total is under the sum of the tops rather than equal to it.
  assert.ok(share.bundle.bps < share.buys[0].estBps * 27);
  assert.ok(share.bundle.bps > share.buys[0].worstBps * 27);

  // Two wallets buying the same amount get the same range whatever row they are
  // on — the table is not the landing order. What they do NOT get is the same
  // fill, which is why it is a range and not a number.
  assert.equal(share.buys[26].estBps, share.buys[0].estBps);
  assert.equal(share.buys[26].worstBps, share.buys[0].worstBps);
  assert.ok(share.buys[0].worstBps < share.buys[0].estBps);
  assert.equal(share.exact, false);
});

test('twelve wallets buying the same 0.06 ETH are not all quoted the same share', () => {
  // THE BUG. Every wallet was priced at the opening tick, so twelve wallets
  // buying 0.06 ETH each all reported 4.43% — wallet 1's price, handed to all
  // twelve — and 53.1% of supply for a bundle that really takes 34.7%.
  const buys = Array.from({ length: 12 }, (_, i) => ({ key: `w${i}`, amountEth: '0.06' }));
  const share = shareV1({ launchConfig: V1, buys });

  assert.equal(share.bundle.eth, '0.720000');
  assert.ok(share.bundle.bps > 3450 && share.bundle.bps < 3480, `total ${share.bundle.bps} bps`);

  const leg = share.buys[0];
  assert.ok(leg.estBps > 420 && leg.estBps < 426, `first ${leg.estBps} bps`);
  assert.ok(leg.worstBps > 192 && leg.worstBps < 197, `last ${leg.worstBps} bps`);
  // Landing last is worth less than half of landing first at this size. No
  // single number can stand for that.
  assert.ok(leg.worstBps < leg.estBps / 2);

  // The flat rate is still what the cap flag measures, and at this size it is
  // visibly above the top of the range it is drawn beside.
  assert.ok(Math.abs(leg.capBps - 442.59) < 0.01, `cap yardstick ${leg.capBps} bps`);
  assert.ok(leg.capBps > leg.estBps);
});

test('the cap flag still measures the opening price, so the console flags what preflight flags', () => {
  // preflight calls capCheck itself (bundle/prepare.js) and cannot see this
  // walk. If the flag moved onto the impact-aware figure, every wallet between
  // the two would be flagged in one place and not the other — and 0.0705 ETH is
  // exactly such a wallet: 520 bps at the opening price, 494 with the impact
  // term, against a 500 bps cap.
  const share = shareV1({ launchConfig: V1, buys: [{ key: 'w0', amountEth: '0.0705' }] });
  const cap = capCheck({ amountInWei: eth('0.0705'), launchConfig: V1 });

  assert.equal(share.buys[0].capBps, cap.estBps);
  assert.equal(share.buys[0].exceedsWallet, true);
  assert.deepEqual(share.over, ['w0']);
  // It errs early on purpose: the range beside it is genuinely lower, and
  // capBps is what lets the table explain the flag rather than contradict it.
  assert.ok(share.buys[0].estBps < share.buys[0].capBps);
});

test('a v1 wallet over the 5% cap is named, because that buy reverts', () => {
  const share = shareV1({
    launchConfig: V1,
    buys: [
      { key: 'ok', amountEth: '0.001' },
      { key: 'too-big', amountEth: '0.09' },
    ],
  });
  assert.deepEqual(share.over, ['too-big']);
  assert.equal(share.buys[1].exceedsWallet, true);
  assert.equal(share.buys[1].exceedsTx, true);
  assert.equal(share.caps.maxWalletBps, 500);
});

test('the v1 dev buy is uncapped and counted apart from the bundle', () => {
  // The dev buy happens inside the launch transaction, outside the restriction
  // window — 20% of supply there is legal, and flagging it would be noise.
  const share = shareV1({ launchConfig: V1, devBuyEth: '0.3', buys: [{ key: 'w0', amountEth: '0.001' }] });
  assert.ok(share.dev.estBps > 500);
  assert.equal(share.dev.exceedsWallet, false);
  assert.deepEqual(share.over, []);
  assert.ok(share.total.bps > share.bundle.bps);

  // It is AHEAD of the bundle now, not merely counted beside it: 0.3 ETH into
  // the pool is most of a third of the supply, and the wallet behind it buys
  // what that left. The dev buy itself is not a range — inside the launch
  // transaction, it cannot land anywhere but first.
  const alone = shareV1({ launchConfig: V1, buys: [{ key: 'w0', amountEth: '0.001' }] });
  assert.ok(share.buys[0].estBps < alone.buys[0].estBps, 'the dev buy has to move the price');
  assert.equal(share.dev.worstBps, share.dev.estBps);
});

// ── the shape both callers depend on ───────────────────────────────────────

test('bundleShare dispatches on protocol and answers in plain JSON', () => {
  const common = { buys: [{ key: 'w0', amountEth: '0.05' }], devBuyEth: '0.05' };
  const v1 = bundleShare({ protocol: 'v1', launchConfig: V1, ...common });
  const v2 = bundleShare({ protocol: 'v2', launchConfig: V2, creatorTaxBps: 50, ...common });

  assert.equal(v1.protocol, 'v1');
  assert.equal(v2.protocol, 'v2');
  // This object is embedded in the preflight response and in the launch
  // history, and JSON.stringify THROWS on a BigInt rather than skipping it.
  assert.doesNotThrow(() => JSON.stringify({ v1, v2 }));
  assert.equal(bundleShare({ protocol: 'v2', launchConfig: null, ...common }), null);
});

test('a half-typed amount is zero, not NaN', () => {
  const share = bundleShare({
    protocol: 'v2',
    launchConfig: V2,
    buys: [{ key: 'a', amountEth: '' }, { key: 'b', amountEth: '0.' }, { key: 'c', amountEth: '0.1' }],
  });
  assert.equal(share.buys[0].estBps, 0);
  assert.equal(share.buys[1].estBps, 0);
  assert.ok(share.buys[2].estBps > 0);
  assert.equal(share.bundle.eth, '0.100000');
});

test('amounts already resolved to wei are taken as they are', () => {
  // preflight has already turned "all − gas" into a wei amount by the time it
  // gets here, and re-parsing a decimal string would lose the tail of it.
  const share = shareV2({ launchConfig: V2, buys: [{ key: 'w0', amountWei: 123456789012345678n }] });
  assert.equal(share.bundle.eth, '0.123456');
  assert.equal(share.buys[0].amountEth, '0.123456');
});

test('v2 predicts a market cap: opens at the phantom quote and rises with the bundle', () => {
  // No buys: the cap the curve opens at is the phantom quote itself (1.68 ETH).
  const empty = shareV2({ launchConfig: V2, buys: [] });
  assert.ok(empty.marketCap, 'marketCap must be present');
  assert.ok(
    Math.abs(Number(empty.marketCap.openingEth) - 1.68) < 1e-6,
    `opening MC should be 1.68 ETH, got ${empty.marketCap.openingEth}`
  );
  assert.equal(empty.marketCap.openingEth, empty.marketCap.finalEth, 'no buys → final equals opening');

  // Dev buy plus a bundle walks the cap UP, monotonically, along the same order
  // the rows are priced in.
  const share = shareV2({
    launchConfig: V2,
    devBuyEth: '0.05',
    creatorTaxBps: 50,
    buys: [
      { key: 'a', amountEth: '0.04' },
      { key: 'b', amountEth: '0.04' },
      { key: 'c', amountEth: '0.04' },
    ],
  });
  assert.ok(Number(share.marketCap.finalEth) > 1.68, 'the bundle must raise the cap above opening');
  assert.ok(Number(share.dev.mcEth) >= 1.68, 'the dev buy is the first step up');

  // Every row carries its own predicted cap, and they only increase.
  const caps = [Number(share.dev.mcEth), ...share.buys.map((b) => Number(b.mcEth))];
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i] >= caps[i - 1], `cap must not fall between rows: ${caps[i - 1]} → ${caps[i]}`);
  }
  // The last row's cap is the whole-bundle final cap.
  assert.ok(
    Math.abs(caps[caps.length - 1] - Number(share.marketCap.finalEth)) < 1e-6,
    'the last row cap should equal the final bundle cap'
  );
});
