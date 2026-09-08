import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_STEPS,
  stepOrder,
  pairHoldings,
  shortOfPair,
  ethShortfall,
  pairChangeImpact,
  strandedRecord,
  strandingCleared,
  stepNeed,
  fundGate,
  swapGate,
  recoverGate,
  launchGate,
  listOf,
} from './quoteAsset.js';

const NATIVE = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', native: true };
const NVDA = { address: '0xNVDA', symbol: 'NVDA' };
const SPCX = { address: '0xSPCX', symbol: 'SPCX' };

// The numbering a v2 plan produces, so the copy can be checked for the step it
// actually names rather than for a number hardcoded in two places.
const V2_NUMS = { quote: 1, dev: 2, wallets: 3, fund: 4, launch: 5, sell: 6 };
// The same launcher priced in a quote asset: the swap station exists, so launch
// and sell move down one. Every piece of copy that names another station is
// checked against THIS map, not against a number written twice.
const V2P_NUMS = { quote: 1, dev: 2, wallets: 3, fund: 4, swap: 5, launch: 6, sell: 7 };
const V1_NUMS = { dev: 1, disperser: 2, wallets: 3, fund: 4, launch: 5, sell: 6 };

// ── ORDERING ────────────────────────────────────────────────────────────────

test('the quote asset is the FIRST station of a launcher that has one', () => {
  const v2 = stepOrder({ dispersers: false, quote: true });
  assert.deepEqual(v2, ['quote', 'dev', 'wallets', 'fund', 'launch', 'sell']);
  // The whole point of the change: it comes before the wallets are generated,
  // before they are funded, and before the launch form — not after all three.
  assert.ok(v2.indexOf('quote') < v2.indexOf('wallets'));
  assert.ok(v2.indexOf('quote') < v2.indexOf('fund'));
  assert.ok(v2.indexOf('quote') < v2.indexOf('launch'));
});

test('a launcher without a quote asset never draws the station', () => {
  const v1 = stepOrder({ dispersers: true, quote: false });
  assert.deepEqual(v1, ['dev', 'disperser', 'wallets', 'fund', 'launch', 'sell']);
  assert.equal(v1.includes('quote'), false);
});

test('the disperser station is still the one v2 does not have', () => {
  assert.equal(stepOrder({ dispersers: false, quote: true }).includes('disperser'), false);
  assert.equal(stepOrder({ dispersers: true, quote: false }).includes('disperser'), true);
});

test('every conditional key is a key the full list knows', () => {
  for (const key of stepOrder({ dispersers: true, quote: true })) {
    assert.ok(ALL_STEPS.includes(key), `${key} is not a known station`);
  }
});

// ── WHAT THE BUNDLE HOLDS ───────────────────────────────────────────────────

test('holdings count only wallets whose pair balance was actually read', () => {
  const held = pairHoldings([
    { id: 'a', address: '0xa', pairBalance: '12.5' },
    { id: 'b', address: '0xb', pairBalance: '0.0' },
    { id: 'c', address: '0xc', pairBalance: null }, // never read — a question, not a zero
    { id: 'd', address: '0xd', pairBalance: '2.5' },
  ]);
  assert.equal(held.wallets, 2);
  assert.equal(held.total, '15');
  assert.equal(held.unknown, 1);
});

test('a native listing (no pair balances at all) holds nothing and is all unknown', () => {
  const held = pairHoldings([{ id: 'a' }, { id: 'b' }]);
  assert.equal(held.wallets, 0);
  assert.equal(held.unknown, 2);
});

// ── WHICH WALLETS PREFLIGHT WOULD DROP ──────────────────────────────────────

test('a buying wallet holding less than its Buy amount is short', () => {
  const bundle = [
    { id: 'a', pairBalance: '1.0' },
    { id: 'b', pairBalance: '0.0' },
    { id: 'c', pairBalance: '5.0' },
  ];
  const rows = {
    a: { mode: 'fixed', buy: '0.5' }, // holds enough
    b: { mode: 'fixed', buy: '0.5' }, // holds none — preflight drops it
    c: { mode: 'all' }, // resolved server-side, names no requirement
  };
  const out = shortOfPair(bundle, rows);
  assert.equal(out.buying, 2);
  assert.equal(out.ready, 1);
  assert.equal(out.short, 1);
});

test('a wallet with no Buy amount is not counted as buying at all', () => {
  const out = shortOfPair([{ id: 'a', pairBalance: '0' }], { a: { mode: 'fixed', buy: '' } });
  assert.deepEqual(out, { short: 0, ready: 0, unknown: 0, buying: 0 });
});

test('an unread pair balance is never reported as short', () => {
  const out = shortOfPair([{ id: 'a', pairBalance: null }], { a: { mode: 'fixed', buy: '1' } });
  assert.equal(out.short, 0);
  assert.equal(out.unknown, 1);
});

// ── CHANGING THE QUOTE ASSET ────────────────────────────────────────────────

test('re-picking the same asset is a no-op and asks nothing', () => {
  const impact = pairChangeImpact({
    from: NVDA,
    to: { ...NVDA },
    holders: { wallets: 3, total: '12' },
    restated: 5,
    repriced: 5,
  });
  assert.equal(impact.same, true);
  assert.equal(impact.needsConfirm, false);
  assert.equal(impact.strands, null);
});

test('changing before any work is done costs nothing and asks nothing', () => {
  const impact = pairChangeImpact({
    from: NATIVE,
    to: NVDA,
    holders: { wallets: 0, total: '0' },
    restated: 0,
    repriced: 0,
  });
  assert.equal(impact.needsConfirm, false);
  assert.equal(impact.strands, null);
});

test('typed Buy amounts alone are enough to ask — the digits change meaning', () => {
  const impact = pairChangeImpact({
    from: NATIVE,
    to: NVDA,
    holders: { wallets: 0, total: '0' },
    restated: 4,
  });
  assert.equal(impact.needsConfirm, true);
  assert.equal(impact.restated, 4);
  // Nothing is STRANDED leaving native: ETH is what every wallet holds anyway.
  assert.equal(impact.strands, null);
});

test('wallets holding the old asset are named as stranded, with the total', () => {
  const impact = pairChangeImpact({
    from: NVDA,
    to: SPCX,
    holders: { wallets: 3, total: '12.5' },
    restated: 3,
    repriced: 3,
  });
  assert.equal(impact.needsConfirm, true);
  assert.deepEqual(impact.strands, {
    symbol: 'NVDA',
    address: '0xNVDA',
    wallets: 3,
    total: '12.5',
  });
  assert.equal(strandedRecord(impact).symbol, 'NVDA');
});

test('leaving native strands nothing even when every wallet is funded', () => {
  const impact = pairChangeImpact({
    from: NATIVE,
    to: NVDA,
    holders: { wallets: 31, total: '99' },
  });
  assert.equal(impact.strands, null);
  assert.equal(strandedRecord(impact), null);
});

test('a stranding is only cleared by being priced in that asset again AND empty', () => {
  const stranded = { address: '0xNVDA', symbol: 'NVDA', wallets: 3, total: '12.5' };
  // Priced in something else: the holding is invisible, not gone.
  assert.equal(strandingCleared(stranded, '0xSPCX', { wallets: 0 }), false);
  // Back on NVDA but the wallets still hold it.
  assert.equal(strandingCleared(stranded, '0xNVDA', { wallets: 3 }), false);
  // Back on NVDA and sold back to ETH.
  assert.equal(strandingCleared(stranded, '0xnvda', { wallets: 0 }), true);
  // Nothing remembered is nothing to clear.
  assert.equal(strandingCleared(null, '0xSPCX', { wallets: 9 }), true);
});

// ── WHAT EACH STEP SAYS IT NEEDS ────────────────────────────────────────────

test('every station of both plans states a precondition when it cannot run', () => {
  const fresh = {
    nums: V2_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    hasDev: false,
    bundleCount: 0,
    fundTargets: 0,
    buyTargets: 0,
    draftMissing: ['a name', 'a symbol', 'a logo'],
    sellCount: 0,
  };
  for (const key of stepOrder({ dispersers: false, quote: true })) {
    const need = stepNeed(key, fresh);
    assert.equal(typeof need, 'string', `${key} said nothing`);
    assert.ok(need.length > 0, `${key} said nothing`);
  }
});

test('a blocked step names the step that satisfies it, by its live number', () => {
  const f = { nums: V2_NUMS, hasDev: false, bundleCount: 0 };
  assert.match(stepNeed('wallets', f), /step 2/);
  assert.match(stepNeed('fund', f), /step 3/);
  // v1 numbers the same stations differently, and the copy follows the plan.
  assert.match(stepNeed('wallets', { nums: V1_NUMS, hasDev: false }), /step 1/);
  assert.match(
    stepNeed('fund', { nums: V1_NUMS, bundleCount: 4, fundTargets: 2, needsDisperser: true, dispersers: 0 }),
    /step 2/
  );
});

test('the fund step distinguishes "no wallets" from "no amounts typed"', () => {
  const none = stepNeed('fund', { nums: V2_NUMS, bundleCount: 0 });
  const typed = stepNeed('fund', { nums: V2_NUMS, bundleCount: 5, fundTargets: 0 });
  assert.match(none, /Needs bundle wallets/);
  assert.match(typed, /Fund amount/);
  assert.notEqual(none, typed);
});

test('a paired launch tells the dev step it also needs the quote asset', () => {
  const paired = stepNeed('dev', { paired: true, pairSymbol: 'NVDA', hasDev: false });
  const native = stepNeed('dev', { paired: false, hasDev: false });
  assert.match(paired, /NVDA/);
  assert.doesNotMatch(native, /NVDA/);
  // Once it exists the step stops justifying itself.
  assert.equal(stepNeed('dev', { hasDev: true }), null);
});

test('the launch step points at the SWAP station when wallets are short', () => {
  const need = stepNeed('launch', {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    draftMissing: [],
    buyTargets: 4,
    shortOfPair: 2,
  });
  assert.match(need, /2 do not/);
  // Step 5 on a paired plan is the swap. It used to say step 3 and name a box
  // inside the wallet table, which is where the control no longer is.
  assert.match(need, /step 5/);
  assert.doesNotMatch(need, /Pair funding/);
});

test('missing form fields outrank a pair shortfall — the nearer fix is said first', () => {
  const need = stepNeed('launch', {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    draftMissing: ['a logo'],
    buyTargets: 4,
    shortOfPair: 2,
  });
  assert.match(need, /a logo/);
  assert.doesNotMatch(need, /already hold/);
});

test('a launch that has already run stops listing what it needs', () => {
  const f = { nums: V2_NUMS, paired: true, pairSymbol: 'NVDA', draftMissing: [], buyTargets: 0, shortOfPair: 3 };
  assert.equal(typeof stepNeed('launch', f), 'string');
  assert.equal(stepNeed('launch', { ...f, launched: true }), null);
  // Every other station's line is a statement and survives being finished.
  assert.equal(typeof stepNeed('quote', { ...f, launched: true }), 'string');
});

test('a native launch never mentions a second token anywhere in the plan', () => {
  const f = {
    nums: V2_NUMS,
    paired: false,
    hasDev: true,
    bundleCount: 5,
    fundTargets: 5,
    buyTargets: 5,
    draftMissing: [],
    sellCount: 1,
  };
  for (const key of stepOrder({ dispersers: false, quote: true })) {
    const need = stepNeed(key, f) || '';
    assert.doesNotMatch(need, /NVDA|swap|quote asset/i, `${key} showed pair machinery on a native launch`);
  }
});

// ── WHICH CONTROLS ARE ENABLED WHEN ─────────────────────────────────────────

test('the funding run is dead without amounts, and says where to type them', () => {
  const gate = fundGate({ targets: 0, nums: V2_NUMS });
  assert.equal(gate.enabled, false);
  assert.match(gate.why, /step 3/);
});

test('a v1 funding run with amounts is still dead without a disperser', () => {
  const gate = fundGate({ targets: 4, needsDisperser: true, dispersers: 0, nums: V1_NUMS });
  assert.equal(gate.enabled, false);
  assert.match(gate.why, /disperser/);
  assert.match(gate.why, /step 2/);
});

test('v2 funds without a disperser and is enabled on amounts alone', () => {
  const gate = fundGate({ targets: 4, needsDisperser: false, dispersers: 0, nums: V2_NUMS });
  assert.equal(gate.enabled, true);
  assert.equal(gate.why, null);
});

test('a v1 run with both a disperser and amounts is enabled', () => {
  assert.deepEqual(fundGate({ targets: 4, needsDisperser: true, dispersers: 1, nums: V1_NUMS }), {
    enabled: true,
    why: null,
  });
});

test('preflight ignores the arm switch and the exemption cap; the launch does not', () => {
  const gate = launchGate({ draftMissing: [], overExempt: 2, live: true, armed: false });
  assert.equal(gate.preflight.enabled, true);
  assert.equal(gate.preflight.why, null);
  assert.equal(gate.fire.enabled, false);
  assert.match(gate.fire.why, /exempt/);
});

test('an unarmed live launch says so once the exemption cap is satisfied', () => {
  const gate = launchGate({ draftMissing: [], overExempt: 0, live: true, armed: false });
  assert.match(gate.fire.why, /Arm/);
  assert.equal(launchGate({ draftMissing: [], live: true, armed: true }).fire.enabled, true);
});

test('a dry run needs no arming', () => {
  assert.equal(launchGate({ draftMissing: [], live: false, armed: false }).fire.enabled, true);
});

test('missing fields stop both buttons and are listed in the form\'s own order', () => {
  const gate = launchGate({ draftMissing: ['a name', 'a symbol', 'a logo'], live: true, armed: true });
  assert.equal(gate.preflight.enabled, false);
  assert.equal(gate.fire.enabled, false);
  assert.equal(gate.fire.why, 'Needs a name, a symbol and a logo first.');
});

test('an upload still in flight blocks the launch on its own', () => {
  const gate = launchGate({ draftMissing: [], uploading: true });
  assert.equal(gate.preflight.enabled, false);
  assert.match(gate.preflight.why, /uploading/);
});

test('listOf reads as a sentence at one, two and three items', () => {
  assert.equal(listOf(['a logo']), 'a logo');
  assert.equal(listOf(['a symbol', 'a logo']), 'a symbol and a logo');
  assert.equal(listOf(['a name', 'a symbol', 'a logo']), 'a name, a symbol and a logo');
  assert.equal(listOf([]), '');
});

// ── THE SWAP STATION ────────────────────────────────────────────────────────
// Relay and the funding run both move NATIVE ETH only, so the quote asset can
// never be SENT to a bundle wallet — each wallet has to buy its own with its own
// ETH, between being funded and being armed. That is a third thing to do, and
// these are the tests that it is a station rather than a paragraph.

test('a PAIRED launch puts the swap between funding and launching', () => {
  const plan = stepOrder({ dispersers: false, quote: true, paired: true });
  assert.deepEqual(plan, ['quote', 'dev', 'wallets', 'fund', 'swap', 'launch', 'sell']);
  // The whole order the operator asked for: ETH first, then the asset, then arm.
  assert.ok(plan.indexOf('fund') < plan.indexOf('swap'));
  assert.ok(plan.indexOf('swap') < plan.indexOf('launch'));
});

test('a NATIVE v2 launch has no swap station at all — its plan is what it was', () => {
  assert.deepEqual(stepOrder({ dispersers: false, quote: true, paired: false }), [
    'quote',
    'dev',
    'wallets',
    'fund',
    'launch',
    'sell',
  ]);
});

test('v1 is untouched in shape whatever `paired` says — it has no quote asset to swap into', () => {
  const v1 = ['dev', 'disperser', 'wallets', 'fund', 'launch', 'sell'];
  assert.deepEqual(stepOrder({ dispersers: true, quote: false }), v1);
  assert.deepEqual(stepOrder({ dispersers: true, quote: false, paired: true }), v1);
});

test('the swap station states ETH as its precondition, and names the step that sends it', () => {
  const f = {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    // The operator's own screen: 31 bundle wallets holding 0.000478 ETH each,
    // each needing about 0.0107, against a NVDA column reading 0.000000.
    bundleCount: 31,
    swapTargets: 31,
    shortOfEth: 31,
    missingEth: '0.316822',
    shortOfPair: 31,
  };
  const need = stepNeed('swap', f);
  assert.match(need, /31/, 'says how many wallets are short');
  assert.match(need, /0\.316822 ETH/, 'says how much ETH is missing in total');
  assert.match(need, /step 4/, 'names the funding step as the one that supplies it');
});

test('the swap station asks for wallets, then amounts, then ETH — nearest fix first', () => {
  const base = { nums: V2P_NUMS, paired: true, pairSymbol: 'NVDA', shortOfEth: 8, shortOfPair: 5 };
  assert.match(stepNeed('swap', { ...base, bundleCount: 0 }), /Needs bundle wallets/);
  assert.match(
    stepNeed('swap', { ...base, bundleCount: 8, swapTargets: 0 }),
    /Buy amount/,
    'no amount typed outranks no ETH — one is a field, the other is a transfer'
  );
  assert.match(
    stepNeed('swap', { ...base, bundleCount: 8, swapTargets: 8 }),
    /8 of 8 wallets have too little ETH/
  );
});

test('once every buying wallet holds its quote asset the swap station stops asking', () => {
  const done = stepNeed('swap', {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    bundleCount: 8,
    swapTargets: 8,
    shortOfEth: 0,
    shortOfPair: 0,
  });
  assert.equal(done, null);
});

test('funded but not yet swapped, the station explains the mechanism rather than a shortfall', () => {
  const need = stepNeed('swap', {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    bundleCount: 8,
    swapTargets: 8,
    shortOfEth: 0,
    shortOfPair: 8,
  });
  assert.match(need, /cannot be sent/i);
  assert.match(need, /step 6/, 'and says it must happen before the launch is armed');
});

test('every station of a PAIRED plan states a precondition when it cannot run', () => {
  const fresh = {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    hasDev: false,
    bundleCount: 0,
    fundTargets: 0,
    buyTargets: 0,
    swapTargets: 0,
    shortOfEth: 0,
    draftMissing: ['a name', 'a symbol', 'a logo'],
    sellCount: 0,
  };
  for (const key of stepOrder({ dispersers: false, quote: true, paired: true })) {
    const need = stepNeed(key, fresh);
    assert.equal(typeof need, 'string', `${key} said nothing`);
    assert.ok(need.length > 0, `${key} said nothing`);
  }
});

test('the funding step says it sends ETH and only ETH, and where that ETH goes next', () => {
  const need = stepNeed('fund', {
    nums: V2P_NUMS,
    paired: true,
    pairSymbol: 'NVDA',
    bundleCount: 8,
    fundTargets: 8,
  });
  assert.match(need, /cannot be transferred/i);
  assert.match(need, /step 5/, 'points forward at the swap, not back at the table');
});

// ── HOW MUCH ETH IS MISSING ─────────────────────────────────────────────────
// The operator's own reading of the screen: 31 wallets holding 0.000478 ETH,
// each needing about 0.0107. That subtraction is done once, here.

const w = (id, balanceEth) => ({ id, address: `0x${id}`, balanceEth });

test('the dry run is the authority: swapEth plus the reserve is what a wallet needs', () => {
  const out = ethShortfall({
    bundle: [w('a', '0.000478'), w('b', '0.000478')],
    rows: { a: { buy: '1' }, b: { buy: '1' } },
    plan: {
      gasReserveEth: '0.008850',
      results: [
        { walletId: 'a', status: 'would-swap', swapEth: '0.001850' },
        { walletId: 'b', status: 'would-swap', swapEth: '0.001850' },
      ],
    },
  });
  assert.equal(out.short, 2);
  assert.equal(out.ready, 0);
  assert.equal(out.targets, 2);
  // (0.00185 + 0.00885 − 0.000478) × 2 — the operator's own screen, doubled.
  assert.equal(out.missing, '0.020444');
  assert.equal(out.need, '0.0214');
});

test('with no dry run the Fund column is the requirement — it is what the fill wrote', () => {
  const out = ethShortfall({
    bundle: [w('a', '0.000478'), w('b', '0.020000')],
    rows: { a: { buy: '1', fund: '0.010700' }, b: { buy: '1', fund: '0.010700' } },
  });
  assert.equal(out.short, 1);
  assert.equal(out.ready, 1);
  assert.equal(out.missing, '0.010222');
});

test('a wallet already holding its quote asset is ready, not short — it has no swap to fund', () => {
  const out = ethShortfall({
    bundle: [w('a', '0')],
    rows: { a: { buy: '1', fund: '5' } },
    plan: {
      gasReserveEth: '0.00885',
      results: [{ walletId: 'a', status: 'skipped-already-funded', swapEth: null }],
    },
  });
  assert.equal(out.short, 0);
  assert.equal(out.ready, 1);
  assert.equal(out.missing, '0');
});

test('a wallet with no requirement at all is unknown — never counted short', () => {
  const out = ethShortfall({ bundle: [w('a', '0')], rows: { a: { buy: '1' } } });
  assert.equal(out.unknown, 1);
  assert.equal(out.short, 0);
  assert.equal(out.targets, 1);
});

test('rows on "all − gas" and rows with no Buy amount are not in this question', () => {
  const out = ethShortfall({
    bundle: [w('a', '0'), w('b', '0'), w('c', '0')],
    rows: { a: { mode: 'all' }, b: { buy: '0' }, c: { buy: '2', fund: '1' } },
  });
  assert.equal(out.targets, 1);
  assert.equal(out.short, 1);
  assert.equal(out.missing, '1');
});

test('exactly enough is ready — the comparison is exact, not a float', () => {
  const out = ethShortfall({
    bundle: [w('a', '0.010700')],
    rows: { a: { buy: '1', fund: '0.0107' } },
  });
  assert.equal(out.short, 0);
  assert.equal(out.ready, 1);
});

test('an empty bundle is a finished question, not a crash', () => {
  const out = ethShortfall({});
  assert.deepEqual(
    { ...out },
    { ready: 0, short: 0, unknown: 0, targets: 0, missing: '0', need: '0' }
  );
});

// ── WHETHER THE SWAP CAN BE PRESSED ─────────────────────────────────────────
// The defect: "Buy NVDA for 0 wallets" drawn as a live button with the blocking
// reason in small text underneath.

const SHORT = { short: 31, missing: '0.3168220' };
const OK = { short: 0, missing: '0' };
const READY_PLAN = { wouldSwap: 4, skippedAlreadyFunded: 0, skippedShort: 0 };

test('a bundle short of ETH cannot buy, and the refusal says all three things', () => {
  const gate = swapGate({
    symbol: 'NVDA',
    bundleCount: 31,
    targets: 31,
    funding: SHORT,
    plan: { wouldSwap: 0, skippedShort: 31 },
    nums: V2P_NUMS,
  });
  assert.equal(gate.enabled, false);
  assert.equal(gate.blocked, 'eth');
  assert.match(gate.why, /31 wallets/, 'how many');
  assert.match(gate.why, /0\.316822 ETH/, 'how much is missing');
  assert.match(gate.why, /step 4/, 'which step provides it');
  // And the mechanism, because that is the thing the operator asked about.
  assert.match(gate.why, /cannot be transferred/i);
});

test('the ETH shortfall outranks the plan — a wallet cannot be refused for a pool it never reaches', () => {
  const gate = swapGate({
    symbol: 'NVDA',
    bundleCount: 31,
    targets: 31,
    funding: SHORT,
    plan: { wouldSwap: 0, skippedImpact: 31 },
    nums: V2P_NUMS,
  });
  assert.equal(gate.blocked, 'eth');
});

test('no wallets, then no amounts, then no ETH — the nearest fix is named first', () => {
  assert.equal(swapGate({ bundleCount: 0, funding: SHORT, nums: V2P_NUMS }).blocked, 'wallets');
  assert.equal(
    swapGate({ bundleCount: 31, targets: 0, funding: SHORT, nums: V2P_NUMS }).blocked,
    'amounts'
  );
  assert.equal(
    swapGate({ bundleCount: 31, targets: 31, funding: SHORT, nums: V2P_NUMS }).blocked,
    'eth'
  );
});

test('a bundle entirely on "all − gas" is told why it names no amount', () => {
  const gate = swapGate({
    symbol: 'NVDA',
    bundleCount: 4,
    targets: 0,
    allMode: 4,
    funding: OK,
    nums: V2P_NUMS,
  });
  assert.equal(gate.blocked, 'amounts');
  assert.match(gate.why, /all − gas/);
});

test('a PARTLY funded bundle is still offered — the shortfall refuses only when it refuses all', () => {
  // 20 of 31 can pay. Blocking the whole run because 11 cannot would be the same
  // defect the other way round: a live control drawn dead.
  const gate = swapGate({
    symbol: 'NVDA',
    bundleCount: 31,
    targets: 31,
    funding: { short: 11, missing: '0.11' },
    plan: { wouldSwap: 20, skippedShort: 11 },
    nums: V2P_NUMS,
  });
  assert.equal(gate.enabled, true);
  assert.equal(gate.blocked, null);
});

test('a funded bundle with a priced plan can actually buy', () => {
  const gate = swapGate({
    symbol: 'NVDA',
    bundleCount: 4,
    targets: 4,
    funding: OK,
    plan: READY_PLAN,
    nums: V2P_NUMS,
  });
  assert.equal(gate.enabled, true);
  assert.equal(gate.why, null);
  assert.equal(gate.blocked, null);
});

test('a plan that would swap nobody is a refusal, never an offer', () => {
  const already = swapGate({
    symbol: 'NVDA',
    bundleCount: 4,
    targets: 4,
    funding: OK,
    plan: { wouldSwap: 0, skippedAlreadyFunded: 4 },
    nums: V2P_NUMS,
  });
  assert.equal(already.enabled, false);
  assert.match(already.why, /already hold/);

  const thin = swapGate({
    symbol: 'NVDA',
    bundleCount: 4,
    targets: 4,
    funding: OK,
    plan: { wouldSwap: 0, skippedImpact: 4 },
    nums: V2P_NUMS,
  });
  assert.equal(thin.enabled, false);
  assert.match(thin.why, /too thin/);
});

test('an unpriced or failed quote is stated, and never armed through', () => {
  const pricing = swapGate({ symbol: 'NVDA', bundleCount: 4, targets: 4, funding: OK, nums: V2P_NUMS });
  assert.equal(pricing.enabled, false);
  assert.equal(pricing.blocked, 'pricing');

  const failed = swapGate({
    symbol: 'NVDA',
    bundleCount: 4,
    targets: 4,
    funding: OK,
    error: 'the pool is empty',
    nums: V2P_NUMS,
  });
  assert.equal(failed.enabled, false);
  assert.match(failed.why, /the pool is empty/);
});

// ── AND THE WAY BACK ────────────────────────────────────────────────────────

test('the recovery is dead when nothing is held, and says so rather than offering 0 wallets', () => {
  const empty = recoverGate({ symbol: 'NVDA', holders: 0 });
  assert.equal(empty.enabled, false);
  assert.match(empty.why, /No bundle wallet holds/);

  const dust = recoverGate({
    symbol: 'NVDA',
    holders: 3,
    plan: { wouldSwap: 0, skippedDust: 3 },
  });
  assert.equal(dust.enabled, false);
  assert.match(dust.why, /dust/);

  const live = recoverGate({ symbol: 'NVDA', holders: 3, plan: { wouldSwap: 3 } });
  assert.equal(live.enabled, true);
  assert.equal(live.why, null);
});
