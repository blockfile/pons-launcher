'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const { quoteSellOut, tokensToRaise, SELL_HEADROOM_PCT, BPS } = require('./sizing');

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

// A curve part-way up: 40 ETH of quote against 800M tokens, 1% fee, 1% creator
// tax. The shapes below vary each of these independently.
const CURVE = {
  quoteReserve: parseEther('40'),
  tokenReserve: TOKENS(800_000_000),
  feeBps: 100,
  creatorTaxBps: 100,
};

test('selling nothing raises nothing', () => {
  assert.equal(quoteSellOut({ tokensIn: 0n, ...CURVE }), 0n);
  assert.equal(quoteSellOut({ tokensIn: -5n, ...CURVE }), 0n);
});

test('a bigger sell raises more, and the marginal price is worse', () => {
  const one = quoteSellOut({ tokensIn: TOKENS(1_000_000), ...CURVE });
  const ten = quoteSellOut({ tokensIn: TOKENS(10_000_000), ...CURVE });
  assert.ok(ten > one, 'more tokens must raise more ETH');
  assert.ok(ten < one * 10n, 'ten times the tokens must raise less than ten times the ETH');
});

// THE ROUND TRIP. This is the property the whole module exists for: size a sell
// for a target, quote what that many tokens would actually raise, and it must
// not come up short. A cycle that raises less than it needs stops the run.
test('sizing for a target, then quoting it back, always raises at least the target', () => {
  for (const eth of ['0.001', '0.01', '0.05', '0.1', '0.5', '1', '2', '5']) {
    const targetWei = parseEther(eth);
    const tokensIn = tokensToRaise({ targetWei, ...CURVE, headroomPct: 0 });
    const raised = quoteSellOut({ tokensIn, ...CURVE });
    assert.ok(raised >= targetWei, `${eth} ETH: sized ${tokensIn} tokens but raised only ${raised}`);
  }
});

test('the round trip holds across fee and tax shapes, including zero', () => {
  const shapes = [
    { feeBps: 0, creatorTaxBps: 0 },
    { feeBps: 100, creatorTaxBps: 0 },
    { feeBps: 0, creatorTaxBps: 500 },
    { feeBps: 300, creatorTaxBps: 700 },
    { feeBps: 1, creatorTaxBps: 1 },
  ];
  for (const shape of shapes) {
    const curve = { ...CURVE, ...shape };
    for (const eth of ['0.01', '0.25', '3']) {
      const targetWei = parseEther(eth);
      const tokensIn = tokensToRaise({ targetWei, ...curve, headroomPct: 0 });
      const raised = quoteSellOut({ tokensIn, ...curve });
      assert.ok(
        raised >= targetWei,
        `fee ${shape.feeBps} tax ${shape.creatorTaxBps} at ${eth} ETH: raised ${raised}`
      );
    }
  }
});

test('the round trip holds on a thin curve and a deep one', () => {
  for (const quoteReserve of [parseEther('0.5'), parseEther('40'), parseEther('4000')]) {
    const curve = { ...CURVE, quoteReserve };
    const targetWei = parseEther('0.05');
    const tokensIn = tokensToRaise({ targetWei, ...curve, headroomPct: 0 });
    assert.ok(quoteSellOut({ tokensIn, ...curve }) >= targetWei, `reserve ${quoteReserve}`);
  }
});

test('headroom is applied before solving, so it sizes above the bare target', () => {
  const targetWei = parseEther('1');
  const bare = tokensToRaise({ targetWei, ...CURVE, headroomPct: 0 });
  const padded = tokensToRaise({ targetWei, ...CURVE, headroomPct: 10 });
  assert.ok(padded > bare, 'headroom must increase the tokens sold');

  // And it must actually be worth ~10% more ETH, not just be a larger number.
  const raised = quoteSellOut({ tokensIn: padded, ...CURVE });
  assert.ok(raised >= (targetWei * 110n) / 100n, `10% headroom raised only ${raised}`);
});

test('the default headroom is 10 percent', () => {
  assert.equal(SELL_HEADROOM_PCT, 10);
  const targetWei = parseEther('1');
  assert.equal(
    tokensToRaise({ targetWei, ...CURVE }),
    tokensToRaise({ targetWei, ...CURVE, headroomPct: SELL_HEADROOM_PCT })
  );
});

test('rounding always favours selling more, never less', () => {
  // Deliberately awkward numbers, so every division has a remainder to drop.
  const curve = { quoteReserve: 7_777_777_777_777_777n, tokenReserve: 333_333_333_333n, feeBps: 137, creatorTaxBps: 41 };
  for (let target = 1n; target < 5000n; target += 337n) {
    const tokensIn = tokensToRaise({ targetWei: target, ...curve, headroomPct: 0 });
    assert.ok(quoteSellOut({ tokensIn, ...curve }) >= target, `target ${target}`);
  }
});

test('it refuses when the curve cannot pay the target at any size', () => {
  // The curve holds 40 ETH. No quantity of tokens extracts 50 from it — the
  // constant product only approaches the reserve asymptotically.
  assert.throws(
    () => tokensToRaise({ targetWei: parseEther('50'), ...CURVE, headroomPct: 0 }),
    /cannot pay/
  );
});

test('it refuses a target the headroom pushes out of reach', () => {
  // 39 ETH is payable; 39 + 10% is not. The refusal must consider what will
  // actually be sold, not the bare target.
  assert.doesNotThrow(() => tokensToRaise({ targetWei: parseEther('39'), ...CURVE, headroomPct: 0 }));
  assert.throws(() => tokensToRaise({ targetWei: parseEther('39'), ...CURVE, headroomPct: 10 }), /cannot pay/);
});

test('it refuses a non-positive target', () => {
  assert.throws(() => tokensToRaise({ targetWei: 0n, ...CURVE }), /positive/);
  assert.throws(() => tokensToRaise({ targetWei: -1n, ...CURVE }), /positive/);
});

test('it refuses an empty curve rather than dividing by zero', () => {
  assert.throws(() => tokensToRaise({ targetWei: 1n, ...CURVE, quoteReserve: 0n }), /cannot pay/);
  assert.throws(() => tokensToRaise({ targetWei: 1n, ...CURVE, tokenReserve: 0n }), /no tokens/);
});

test('it refuses fees that would take everything', () => {
  assert.throws(
    () => tokensToRaise({ targetWei: parseEther('1'), ...CURVE, feeBps: 9000, creatorTaxBps: 1000 }),
    /takes the whole/
  );
});

test('BPS is ten thousand', () => {
  assert.equal(BPS, 10_000n);
});
