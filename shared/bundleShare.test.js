'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseEthToWei,
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

test('the same ETH buys less the later it lands in the bundle', () => {
  const buys = Array.from({ length: 3 }, (_, i) => ({ key: `w${i}`, amountEth: '0.2' }));
  const share = shareV2({ launchConfig: V2, buys });

  assert.ok(share.buys[0].estBps > share.buys[1].estBps);
  assert.ok(share.buys[1].estBps > share.buys[2].estBps);

  // Quoting them independently — the mistake this exists to prevent — would
  // report each wallet at the first one's price and overstate the tail.
  const independent = share.buys[0].estBps * 3;
  assert.ok(independent > share.bundle.bps, 'sequential must be worse than independent');
  assert.equal(share.exact, true);
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

test('a v1 bundle totals the share every wallet takes', () => {
  const buys = Array.from({ length: 27 }, (_, i) => ({ key: `w${i}`, amountEth: '0.00156489' }));
  const share = shareV1({ launchConfig: V1, buys });

  // ~11.5 bps each, and 27 of them.
  assert.ok(share.buys[0].estBps > 5 && share.buys[0].estBps < 20);
  assert.ok(Math.abs(share.bundle.bps - share.buys[0].estBps * 27) < 0.01);
  assert.equal(share.bundle.eth, '0.042252');
  assert.deepEqual(share.over, []);

  // v1 has no impact term, so the last wallet is quoted the first one's price.
  // It will not get it — which is why this side is never labelled exact.
  assert.equal(share.buys[26].estBps, share.buys[0].estBps);
  assert.equal(share.exact, false);
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
