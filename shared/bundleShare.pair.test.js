'use strict';

// THE PAIRED CURVE — the seam where the console and the preflight have to agree.
//
// A launch config's phantomQuote/graduationThreshold ARE the curve on a native
// launch and are NOT the curve on a paired one: the factory keeps a separate set
// per approved quote asset (pairTokenEconomics) and the launch runs on those, in
// the pair token's own units.
//
// The preflight (bundle/prepareV2.js) has always made that substitution inline.
// The console never made it at all, so it walked pair-token amounts through the
// native 1.68 ETH phantom reserve and reported 61.20% of supply for a bundle the
// preflight put at 14.20% — the same bundle, two runtimes, a 4.3x disagreement.
// pairedLaunchConfig is that one expression, moved to where both can call it.
//
// EVERY FIGURE BELOW WAS READ LIVE off PonsV2LaunchFactory
// 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e (Robinhood Chain, chainId 4663) at
// block 56,972,301, not copied from a doc:
//
//   launch config #0   supply 1e9 · curveFeeBps 100 · phantom 1.68 ETH · graduates 4.2 ETH
//   pairTokenEconomics NVDA  16.64 / 41.6   (18 dec)
//                      SPCX  28.88 / 72.2   (18 dec)
//                      TSLA  10.4  / 26.0   (18 dec)
//                      GOOGL  9.68 / 24.2   (18 dec)
//                      AAPL   9.68 / 24.2   (18 dec)
//                      GME  147.6  / 369.0  (18 dec)
//                      USDG 3236   / 8090   ( 6 dec)
//
// Native 1.68 against GME's 147.6 is 88x, and against USDG's 3236 (at six
// decimals) it is not even the same order of anything. There is no pair for
// which the native constants are a usable approximation.

const test = require('node:test');
const assert = require('node:assert');

const { pairedLaunchConfig, hasPairEconomics, bundleShare, shareV2 } = require('./bundleShare');

const E18 = 10n ** 18n;

// Launch config #0, live.
const V2 = {
  id: 0,
  supply: (1_000_000_000n * E18).toString(),
  curveFeeBps: 100,
  phantomQuote: (168n * 10n ** 16n).toString(), // 1.68 ETH
  graduationThreshold: (42n * 10n ** 17n).toString(), // 4.2 ETH
  poolFee: 0,
  tickSpacing: 200,
  enabled: true,
};

// pairTokenEconomics, live, in each pair's own decimals.
const ECON = {
  NVDA: { phantomQuote: 16_640n * 10n ** 15n, graduationThreshold: 41_600n * 10n ** 15n, decimals: 18 },
  SPCX: { phantomQuote: 28_880n * 10n ** 15n, graduationThreshold: 72_200n * 10n ** 15n, decimals: 18 },
  GME: { phantomQuote: 147_600n * 10n ** 15n, graduationThreshold: 369_000n * 10n ** 15n, decimals: 18 },
  USDG: { phantomQuote: 3_236_000_000n, graduationThreshold: 8_090_000_000n, decimals: 6 },
};

/**
 * THE ORACLE — the exact expression bundle/prepareV2.js ran before this helper
 * existed, transcribed unchanged from the source. It is what the preflight has
 * always fed bundleShare, and moving it must not have moved a single figure the
 * preflight reports. If pairedLaunchConfig ever drifts from this, the warning
 * that stops a launch has changed, and that is the one thing this was not
 * allowed to do.
 */
function legacyShareLaunchConfig(launchConfig, nonNative, pairEconomics) {
  return nonNative && pairEconomics
    ? {
        ...launchConfig,
        phantomQuote: pairEconomics.phantomQuote.toString(),
        graduationThreshold: pairEconomics.graduationThreshold.toString(),
      }
    : launchConfig;
}

// ── the substitution ────────────────────────────────────────────────────────

test('pairedLaunchConfig is byte-identical to the expression prepareV2 has always run', () => {
  const cases = [
    [true, ECON.NVDA],
    [true, ECON.SPCX],
    [true, ECON.GME],
    [true, ECON.USDG],
    // A non-native pair whose economics could not be read — prepareV2 fell back
    // to the config, and so must this.
    [true, null],
    // Native, both ways round.
    [false, null],
    [false, ECON.NVDA],
  ];
  for (const [nonNative, econ] of cases) {
    const mine = pairedLaunchConfig(V2, nonNative ? econ : null);
    const legacy = legacyShareLaunchConfig(V2, nonNative, econ);
    assert.deepEqual(mine, legacy, `nonNative=${nonNative} econ=${econ && econ.phantomQuote}`);
    // And every key of the config that is NOT one of the two curve constants is
    // carried through untouched — supply and curveFeeBps decide the same share.
    for (const k of Object.keys(V2)) {
      if (k === 'phantomQuote' || k === 'graduationThreshold') continue;
      assert.deepEqual(mine[k], V2[k], `${k} moved`);
    }
  }
});

test('native is the IDENTITY — the same object, not a copy of it', () => {
  assert.equal(pairedLaunchConfig(V2, null), V2);
  assert.equal(pairedLaunchConfig(V2, undefined), V2);
  assert.equal(pairedLaunchConfig(V2, false), V2);
  assert.equal(pairedLaunchConfig(null, ECON.NVDA), null);
});

test('a string economics from the API and a BigInt one from the chain agree', () => {
  // The preflight reads BigInts off the contract; the console reads decimal
  // strings out of /api/v2/configs. Same launch, same curve, same figures.
  const fromChain = pairedLaunchConfig(V2, ECON.NVDA);
  const fromApi = pairedLaunchConfig(V2, {
    phantomQuote: ECON.NVDA.phantomQuote.toString(),
    graduationThreshold: ECON.NVDA.graduationThreshold.toString(),
  });
  assert.deepEqual(fromApi, fromChain);
  assert.equal(fromChain.phantomQuote, '16640000000000000000');
  assert.equal(fromChain.graduationThreshold, '41600000000000000000');
});

// ── "can this be priced at all" ─────────────────────────────────────────────

test('hasPairEconomics refuses a curve with no phantom reserve', () => {
  assert.equal(hasPairEconomics(ECON.NVDA), true);
  assert.equal(hasPairEconomics(ECON.USDG), true);
  assert.equal(hasPairEconomics({ phantomQuote: '16640000000000000000' }), true);
  // Zero is not a small curve, it is no curve: every buy against it returns zero
  // tokens and every share reads 0.00%. A caller that gets false here must draw
  // NOTHING — never the native figures.
  assert.equal(hasPairEconomics({ phantomQuote: '0' }), false);
  assert.equal(hasPairEconomics({ phantomQuote: null }), false);
  assert.equal(hasPairEconomics({}), false);
  assert.equal(hasPairEconomics(null), false);
  assert.equal(hasPairEconomics(undefined), false);
});

// ── the size of the error the console was making ────────────────────────────

test('THE LIVE SCREEN: the native constants overstate an NVDA bundle by 4x', () => {
  // Measured on a live screen, launch config #0 paired with NVDA: a bundle
  // summing to 2.974657 NVDA, and the panel printing "BUNDLE TAKES 61.20% OF
  // SUPPLY · DEV BUY 2.86% FIRST".
  //
  // THE DEV BUY IN THAT READING IS 0.05, NOT 0.529695. It is worth pinning why,
  // because 0.529695 NVDA is what 0.05 ETH is worth at the live rate and the two
  // get swapped for each other exactly the way this whole class of bug does. Both
  // are pinned below. Only 0.05 reproduces what was on the screen — 61.20% and
  // 2.86% to four significant figures, from one number — and the Dev buy field is
  // denominated in the PAIR token (prepareV2 parses it at pairDecimals, and the
  // input is labelled "Dev buy (NVDA)"), so 0.05 in that field is 0.05 NVDA.
  const buys = [{ key: 'w', amountEth: '2.974657' }];
  const pairCfg = pairedLaunchConfig(V2, ECON.NVDA);
  const walk = (launchConfig, devBuyEth, paired) =>
    bundleShare({
      protocol: 'v2',
      launchConfig,
      devBuyEth,
      buys,
      ...(paired ? { pairDecimals: 18, pairSymbol: 'NVDA' } : {}),
    });

  // ── what was on the screen ────────────────────────────────────────────────
  const screen = walk(V2, '0.05', false);
  assert.equal((screen.bundle.bps / 100).toFixed(2), '61.20');
  assert.equal((screen.dev.estBps / 100).toFixed(2), '2.86');
  assert.equal(screen.marketCap.finalEth, '13.006019'); // drawn as ETH; $32.2k at ~$2,476

  // ── what that same screen state actually is, on NVDA's curve ──────────────
  const truth = walk(pairCfg, '0.05', true);
  assert.equal((truth.bundle.bps / 100).toFixed(3), '14.954');
  assert.equal((truth.dev.estBps / 100).toFixed(3), '0.296');
  assert.equal(truth.marketCap.finalEth, '23.167672'); // NVDA, not ETH
  assert.ok(screen.bundle.bps / truth.bundle.bps > 4, 'the overstatement is over 4x');

  // ── and the same bundle read with a 0.529695 NVDA dev buy ─────────────────
  // Every figure here was derived independently off the chain constants
  // (net after fee: dev 0.524398, bundle 2.944910, total 3.469308) and this
  // module reproduces all of them.
  const bigDev = walk(pairCfg, '0.529695', true);
  assert.equal((bigDev.dev.estBps / 100).toFixed(3), '3.055'); // 0.524398 / (16.64 + 0.524398)
  assert.equal((bigDev.total.bps / 100).toFixed(3), '17.252'); // 3.469308 / (16.64 + 3.469308)
  assert.equal((bigDev.bundle.bps / 100).toFixed(3), '14.197'); // 17.252 − 3.055
  assert.equal(bigDev.marketCap.finalEth, '24.301940'); // (16.64+3.469308)² / 16.64
  assert.equal(bigDev.graduation.raisedEth, '3.469308');
  assert.equal(
    ((100 * Number(bigDev.graduation.raisedEth)) / Number(bigDev.graduation.thresholdEth)).toFixed(2),
    '8.34'
  );
  // On the native curve the SAME bundle reads 43.59% / 23.79% — which is not what
  // the screen said, and is why the screen's dev buy was 0.05 and not this.
  const bigDevOnNative = walk(V2, '0.529695', false);
  assert.equal((bigDevOnNative.bundle.bps / 100).toFixed(2), '43.59');
  assert.equal((bigDevOnNative.dev.estBps / 100).toFixed(2), '23.79');

  // Whichever of the two the field held, the curve is the pair's.
  assert.equal(truth.pairSymbol, 'NVDA');
  assert.equal(truth.isNative, false);
  assert.equal(truth.marketCap.openingEth, '16.640000'); // the phantom reserve
  assert.equal(screen.marketCap.openingEth, '1.680000');
});

test('the graduation warning is measured against the PAIR threshold, not 4.2 ETH', () => {
  // 5 NVDA into the curve. Against native's 4.2 ETH threshold that reads as a
  // launch that graduates on the way in — the one state a bundle cannot sell out
  // of, and a warning that would talk an operator out of a fine launch. Against
  // NVDA's real 41.6 it is nowhere near.
  const buys = [{ key: 'w', amountEth: '5' }];
  const wrong = shareV2({ launchConfig: V2, buys });
  assert.equal(wrong.graduation.crosses, true);
  assert.equal(wrong.graduation.thresholdEth, '4.200000');

  const right = shareV2({
    launchConfig: pairedLaunchConfig(V2, ECON.NVDA),
    buys,
    pairSymbol: 'NVDA',
  });
  assert.equal(right.graduation.crosses, false);
  assert.equal(right.graduation.thresholdEth, '41.600000');
});

test('a 6-decimal pair needs BOTH the economics and the decimals to be right', () => {
  // USDG is the case where getting one of the two right and not the other is
  // still catastrophic. 1,000 USDG on the real curve is ~23.4% of supply.
  const buys = [{ key: 'w', amountEth: '1000' }];
  const right = shareV2({
    launchConfig: pairedLaunchConfig(V2, ECON.USDG),
    buys,
    pairDecimals: 6,
    pairSymbol: 'USDG',
  });
  assert.ok(right.bundle.bps > 2300 && right.bundle.bps < 2400, `got ${right.bundle.bps}`);
  assert.equal(right.marketCap.openingEth, '3236.000000');
  assert.equal(right.graduation.thresholdEth, '8090.000000');

  // Right economics, wrong decimals: "1000" parsed as 1000e18 against a 3236e6
  // reserve swallows the entire curve.
  const wrongDecimals = shareV2({ launchConfig: pairedLaunchConfig(V2, ECON.USDG), buys });
  assert.ok(wrongDecimals.bundle.bps > 9900, `got ${wrongDecimals.bundle.bps}`);

  // Right decimals, wrong economics: the native 1.68e18 phantom read at six
  // decimals is 1.68 TRILLION USDG of depth, so a 1,000 USDG buy that really
  // takes 23.4% of the supply reports 0.00% — the same class of error in the
  // other direction, and the one that would have an operator size UP.
  const wrongEcon = shareV2({ launchConfig: V2, buys, pairDecimals: 6, pairSymbol: 'USDG' });
  assert.equal(wrongEcon.bundle.bps, 0, `got ${wrongEcon.bundle.bps}`);
});

test('every approved pair moves the answer, so none may be defaulted', () => {
  const buys = [{ key: 'w', amountEth: '3' }];
  const seen = new Set();
  for (const [symbol, econ] of Object.entries(ECON)) {
    const share = shareV2({
      launchConfig: pairedLaunchConfig(V2, econ),
      buys,
      pairDecimals: econ.decimals,
      pairSymbol: symbol,
    });
    seen.add(share.bundle.bps);
  }
  const nativeBps = shareV2({ launchConfig: V2, buys }).bundle.bps;
  assert.equal(seen.size, Object.keys(ECON).length, 'two pairs gave the same share');
  assert.equal(seen.has(nativeBps), false, 'a pair agreed with the native curve');
});
