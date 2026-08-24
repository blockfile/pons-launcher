'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEther, parseEther } = require('ethers');

const {
  quoteSellOut,
  quoteBuyOut,
  tokensToRaise,
  sliceFor,
  simulateChain,
  SELL_HEADROOM_PCT,
  DEFAULT_VARIANCE_PCT,
  MAX_VARIANCE_PCT,
  BPS,
} = require('./sizing');

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

// ── quoteBuyOut ─────────────────────────────────────────────────────────────

test('buying nothing receives nothing', () => {
  assert.equal(quoteBuyOut({ quoteIn: 0n, ...CURVE }), 0n);
});

test('a bigger buy receives more, at a worse average price', () => {
  const one = quoteBuyOut({ quoteIn: parseEther('1'), ...CURVE });
  const ten = quoteBuyOut({ quoteIn: parseEther('10'), ...CURVE });
  assert.ok(ten > one);
  assert.ok(ten < one * 10n, 'ten times the ETH must not receive ten times the tokens');
});

// THE ROUND-TRIP BLEED, AND WHERE IT COMES FROM. A V3 run buys the position and
// then sells all of it back, so what the bundle wallets can be funded with is
// always less than the big buy. Two costs, and they behave completely
// differently — which is why the plan estimates the position rather than
// assuming it equals the big buy:
//
//   fees     fee + creator tax, paid on the way in AND on the way out. Flat,
//            roughly 2× the rate, whatever the size.
//   impact   buying moves the price up and selling moves it back down through
//            your own footprint. Negligible on a small buy, brutal on a large
//            one relative to the curve's reserve.
test('a small buy round-trips back at close to the fee cost alone', () => {
  const inWei = parseEther('0.1'); // 0.25% of a 40 ETH reserve
  const back = quoteSellOut({ tokensIn: quoteBuyOut({ quoteIn: inWei, ...CURVE }), ...CURVE });
  assert.ok(back < inWei, 'a round trip cannot come back whole');
  // 1% fee + 1% tax each way ≈ 4%; impact adds only a little at this size.
  assert.ok(back > (inWei * 94n) / 100n, `expected ~4% of cost, lost ${formatEther(inWei - back)} ETH`);
});

test('a large buy round-trips back far worse, and impact is why', () => {
  // 5 ETH into a 40 ETH reserve is an eighth of the curve. The fees are the
  // same 4%; everything beyond that is the operator paying their own price
  // impact twice. An operator sizing a big buy needs to see this.
  const inWei = parseEther('5');
  const back = quoteSellOut({ tokensIn: quoteBuyOut({ quoteIn: inWei, ...CURVE }), ...CURVE });
  const lostPct = Number(((inWei - back) * 10_000n) / inWei) / 100;
  assert.ok(lostPct > 10, `expected heavy impact, lost only ${lostPct}%`);
  assert.ok(lostPct < 40, `lost ${lostPct}%, which would mean the maths is wrong rather than costly`);
});

// ── sliceFor ────────────────────────────────────────────────────────────────

test('with no variance every slice is exactly the running mean', () => {
  const slice = sliceFor({ valueWei: parseEther('20'), remainingWallets: 20, variancePct: 0 });
  assert.equal(slice, parseEther('1'));
});

test('the default variance is thirty percent', () => {
  assert.equal(DEFAULT_VARIANCE_PCT, 30);
});

test('a slice stays within the variance band around the mean', () => {
  const value = parseEther('500');
  for (const roll of [0, 0.13, 0.5, 0.87, 1]) {
    const slice = sliceFor({ valueWei: value, remainingWallets: 20, variancePct: 30, roll });
    assert.ok(slice >= parseEther('17.5'), `${slice} below the -30% floor`);
    assert.ok(slice <= parseEther('32.5'), `${slice} above the +30% ceiling`);
  }
});

test('the extremes of the roll hit the edges of the band', () => {
  const value = parseEther('500');
  assert.equal(sliceFor({ valueWei: value, remainingWallets: 20, variancePct: 30, roll: 0 }), parseEther('17.5'));
  assert.equal(sliceFor({ valueWei: value, remainingWallets: 20, variancePct: 30, roll: 1 }), parseEther('32.5'));
  assert.equal(sliceFor({ valueWei: value, remainingWallets: 20, variancePct: 30, roll: 0.5 }), parseEther('25'));
});

test('the last wallet takes the whole remainder, whatever the variance', () => {
  for (const variancePct of [0, 30, 90]) {
    for (const roll of [0, 0.5, 1]) {
      assert.equal(
        sliceFor({ valueWei: parseEther('7.3'), remainingWallets: 1, variancePct, roll }),
        parseEther('7.3'),
        'the position must land on zero, not near it'
      );
    }
  }
});

// THE PROPERTY THE WHOLE DESIGN RESTS ON. Walk a position down through N
// wallets, recomputing the mean each time, and it must not run out early —
// every wallet gets a positive slice and the last one clears the rest.
test('recomputing the mean exhausts the position exactly, over any wallet count', () => {
  for (const wallets of [2, 3, 7, 20, 50]) {
    let remaining = parseEther('500');
    const slices = [];
    for (let i = 0; i < wallets; i += 1) {
      const left = wallets - i;
      // Worst case for early exhaustion: every early cycle rolls the maximum.
      const slice = sliceFor({ valueWei: remaining, remainingWallets: left, variancePct: 30, roll: 1 });
      assert.ok(slice > 0n, `wallet ${i + 1} of ${wallets} got nothing`);
      assert.ok(slice <= remaining, `wallet ${i + 1} of ${wallets} was sold more than is left`);
      slices.push(slice);
      remaining -= slice;
    }
    assert.equal(remaining, 0n, `${wallets} wallets left ${remaining} behind`);
  }
});

test('it exhausts exactly even when every cycle rolls the minimum', () => {
  let remaining = parseEther('500');
  const wallets = 20;
  for (let i = 0; i < wallets; i += 1) {
    remaining -= sliceFor({ valueWei: remaining, remainingWallets: wallets - i, variancePct: 30, roll: 0 });
  }
  assert.equal(remaining, 0n);
});

test('a slice never exceeds what is left', () => {
  const slice = sliceFor({ valueWei: 100n, remainingWallets: 2, variancePct: 90, roll: 1 });
  assert.ok(slice <= 100n);
});

test('a slice is never zero, even when the position is nearly dust', () => {
  const slice = sliceFor({ valueWei: 3n, remainingWallets: 3, variancePct: 90, roll: 0 });
  assert.ok(slice > 0n, 'a cycle that sells nothing leaves a hole in the tape');
});

test('it refuses an exhausted position', () => {
  assert.throws(() => sliceFor({ valueWei: 0n, remainingWallets: 3 }), /nothing left/);
});

test('it refuses a variance above the cap', () => {
  assert.throws(
    () => sliceFor({ valueWei: parseEther('1'), remainingWallets: 3, variancePct: MAX_VARIANCE_PCT + 1 }),
    /variance/
  );
});

test('it refuses a nonsense wallet count', () => {
  assert.throws(() => sliceFor({ valueWei: parseEther('1'), remainingWallets: 0 }), /positive integer/);
});

test('simulateChain: a deep curve sustains every wallet', () => {
  const q = 100n * 10n ** 18n; // 100 ETH quote reserve
  const t = 10n ** 27n; // deep token reserve
  const feeBps = 100;
  const tokensBought = quoteBuyOut({ quoteIn: parseEther('1'), quoteReserve: q, tokenReserve: t, feeBps });
  const r = simulateChain({
    tokensBought,
    quoteReserve: q,
    tokenReserve: t,
    feeBps,
    walletCount: 10,
    mainGas: 10n ** 14n,
    buyGas: 10n ** 14n,
    buffer: 4n * 10n ** 14n,
    relayFeePct: 3,
  });
  assert.equal(r.feasible, true);
  assert.equal(r.sustainedWallets, 10);
  assert.equal(r.reason, null);
});

test('simulateChain: a position too small for the wallet count is refused, not started', () => {
  // Same deep curve, but the big buy is tiny relative to the gas each of 25
  // wallets needs — the mean slice cannot clear the gas + buy floor.
  const q = parseEther('0.1');
  const t = 10n ** 24n;
  const feeBps = 100;
  const tokensBought = quoteBuyOut({ quoteIn: parseEther('0.05'), quoteReserve: q, tokenReserve: t, feeBps });
  const g = parseEther('0.00035'); // gas floor above the per-slice value
  const r = simulateChain({
    tokensBought,
    quoteReserve: q,
    tokenReserve: t,
    feeBps,
    walletCount: 25,
    mainGas: g,
    buyGas: g,
    buffer: g,
    relayFeePct: 3,
  });
  assert.equal(r.feasible, false);
  assert.ok(r.sustainedWallets < 25, `sustained ${r.sustainedWallets} of 25`);
  assert.ok(r.reason, 'a reason code is set');
  assert.equal(r.atCycle, r.sustainedWallets + 1);
});

test('simulateChain: refuses a non-positive wallet count', () => {
  assert.throws(
    () => simulateChain({ tokensBought: 1n, quoteReserve: 1n, tokenReserve: 1n, walletCount: 0, mainGas: 0n, buyGas: 0n, buffer: 0n }),
    /walletCount must be a positive integer/
  );
});
