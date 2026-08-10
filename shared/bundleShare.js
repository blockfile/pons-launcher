'use strict';

// How much of the supply a bundle's ETH actually buys.
//
// ONE COPY, TWO RUNTIMES. The console runs this on every keystroke while the
// operator sizes each wallet; prepare() and prepareV2() run it again at
// preflight, before anything is signed. Those two answers have to be the same
// answer — a live figure that disagrees with the warning which stops a launch
// is worse than no live figure at all. So the arithmetic lives here, outside
// both, as CommonJS the backend requires directly and Vite hands to the browser
// (see the plugin in frontend/vite.config.js).
//
// NOTHING IN THIS FILE MAY IMPORT ANYTHING. It has to load in a browser, so
// there is no ethers here and no provider — parseEthToWei below exists for
// exactly that reason.
//
// THE TWO PROTOCOLS ARE NOT EQUALLY KNOWABLE, and every caller has to say which
// it is showing:
//
//   v1 is an ESTIMATE. There is no pool until the launch runs, so everything
//      here is derived from the state the launch config opens with — the whole
//      supply at the config's initial tick. That fixes the price AND the depth,
//      so the impact of the bundle's own buys is modelled; what is not modelled
//      is the pool's own fee and the fact that a real v3 position is not a
//      full-range constant product. Both push a real fill DOWN, so this side
//      still reads a little high and still carries a ~.
//   v2 is ARITHMETIC. The curve is a constant product against a phantom
//      reserve, and the launch config fixes both before the launch is sent, so
//      walking the buys through it is what the curve will do, not a guess at it.
//
// WHAT IS KNOWN AND WHAT IS NOT. Both protocols price against a constant
// product, and on a constant product the tokens out for a given total in are
// PATH-INDEPENDENT: 0.72 ETH as one trade and 0.72 ETH split twelve ways leave
// the pool in exactly the same place, in any order. So the bundle TOTAL is one
// walk with the summed input and it is not hedged.
//
// Per wallet is the opposite. fire.js broadcasts every buy at once and the
// sequencer picks the order, so where a wallet lands is genuinely unknown and
// it is the only unknown: a wallet gets the most landing first, behind nothing
// but the dev buy, and the least landing last, behind the whole rest of the
// bundle. Both ends are computed exactly; the answer is the RANGE between them.
// A single per-wallet number is a claim about ordering that nobody can make —
// it is what made twelve wallets buying 0.06 ETH each all report the same
// 4.43%, which was never true of more than one of them.

const BPS = 10_000n;
const WEI = 10n ** 18n;

/**
 * ETH as the operator typed it → wei.
 *
 * Decimal string arithmetic rather than value * 1e18, because a double cannot
 * hold 0.6 ETH in wei exactly and this feeds a comparison against an on-chain
 * cap. ethers' parseEther would do it, but ethers cannot come into this file.
 */
function parseEthToWei(value) {
  if (typeof value === 'bigint') return value;
  const s = String(value ?? '').trim();
  if (!s) return 0n;

  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) {
    // Exponent notation and anything else a number input can emit. Precision
    // past a few decimals cannot matter to a figure that is drawn on a screen.
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e18)) : 0n;
  }
  const whole = m[1] || '0';
  const frac = (m[2] || '').slice(0, 18).padEnd(18, '0');
  return BigInt(whole + frac);
}

/** Base units → a decimal string, without ethers' formatUnits. */
function formatWei(wei, places = 6) {
  const v = toBig(wei);
  const whole = v / WEI;
  if (places <= 0) return whole.toString();
  const frac = (v % WEI).toString().padStart(18, '0').slice(0, places);
  return `${whole}.${frac}`;
}

/** Anything the chain or the API hands us for a uint256 → BigInt, never a throw. */
function toBig(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  try {
    return BigInt(typeof value === 'number' ? Math.round(value) : String(value).trim());
  } catch (_err) {
    return 0n;
  }
}

// ── pons v1: the opening tick ───────────────────────────────────────────────
//
// Estimating how much of a token a bundle buy will receive, so a buy that would
// breach the launch-window caps can be caught BEFORE it is signed.
//
// During the restriction window every non-dev address is capped at
// maxWalletBps of supply, and a buy over it does not clamp — it REVERTS, and
// the pool's TransferHelper masks the reason as "TF". There is no pool to quote
// against at signing time, so the estimate comes from the initial tick the
// launch config pins.
//
// On the sign of initialTick: a Uniswap tick is quoted as token1-per-token0,
// so its sign follows the pool's address ordering rather than the economics.
// A launchpad always opens with the token cheap against the pair token — a
// billion-token supply against a fraction of an ETH — so the magnitude is the
// exchange rate whichever side the token lands on. An earlier version of this
// derived the direction from address ordering and got it inverted, which
// reported 0.00% for a buy that was really 0.11% of supply. DO NOT "FIX" THE
// Math.abs.
//
// Anchored to a real launch: token 0x4aE28f7022F0db76F9B791ff3DEe6bE67B40137F,
// initialTick -204200, where 0.003 ETH bought 2,186,029 tokens.
//
// estimateTokensOut and capCheck below are the OPENING PRICE with no impact
// term — the price for an infinitely small buy — and they stay that way. That
// is the yardstick the cap warning has always used, and preflight calls
// capCheck directly (bundle/prepare.js) while the console reaches it through
// shareV1, so moving it would move the warning under one caller and not the
// other. It reports slightly MORE tokens than a wallet will really get, which
// errs toward warning early: the safe direction for a cap whose breach REVERTS.
//
// The share figures the operator reads are a different question, and they use
// the impact term — see openingPool.

const Q = 1.0001;

/**
 * Tokens received per whole pair token at the pool's opening price.
 */
function rateFromTick(initialTick) {
  const tick = Math.abs(Number(initialTick));
  if (!Number.isFinite(tick)) return 0;
  const rate = Math.pow(Q, tick);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * Tokens a buy of `amountInWei` native wei receives at the opening price.
 * @returns {number} whole tokens (not wei); 0 on unusable input
 */
function estimateTokensOut({ amountInWei, initialTick }) {
  const rate = rateFromTick(initialTick);
  if (!rate) return 0;

  const amountIn = Number(amountInWei) / 1e18;
  if (!Number.isFinite(amountIn) || amountIn <= 0) return 0;

  const out = amountIn * rate;
  return Number.isFinite(out) && out > 0 ? out : 0;
}

/**
 * Where a buy lands against the launch-window caps.
 * @returns {{estTokens:number, estBps:number, exceedsWallet:boolean, exceedsTx:boolean}}
 */
function capCheck({ amountInWei, launchConfig }) {
  const supply = Number(launchConfig.supply) / 1e18;
  const estTokens = estimateTokensOut({ amountInWei, initialTick: launchConfig.initialTick });

  if (!supply || !estTokens) {
    return { estTokens: 0, estBps: 0, exceedsWallet: false, exceedsTx: false };
  }

  const estBps = (estTokens / supply) * 10000;
  return {
    estTokens,
    estBps,
    exceedsWallet: estBps > Number(launchConfig.maxWalletBps),
    exceedsTx: estBps > Number(launchConfig.maxTxBps),
  };
}

/**
 * The pool a v1 launch config opens, as reserves.
 *
 * NOTHING NEW IS INVENTED HERE. capCheck reads the opening state for its PRICE
 * and stops; the same state also fixes the DEPTH. A constant product holding
 * the whole supply quotes tokens-per-pair-token equal to tokenReserve /
 * quoteReserve, and the tick says that ratio is `rate`, so the pair-token side
 * of the pool it opens is supply / rate. Same tick, same supply, same opening
 * price at zero size — read for size as well as for price.
 *
 * STILL AN ESTIMATE, AND STILL A GENEROUS ONE. The real pool is a Uniswap v3
 * range position rather than a full-range constant product, and its 1% fee is
 * not modelled. Both take the real fill DOWN from this. What it fixes is the
 * order of magnitude: on the launch this file is anchored to, 0.003 ETH reads
 * 1.0% over the chain's 2,186,029 tokens instead of the flat rate's 1.2%, and
 * the gap widens with size — twelve wallets at 0.06 ETH are 53% of supply at
 * the flat rate and 35% here. The flat rate was not a slightly high estimate of
 * a bundle that size, it was the wrong number.
 *
 * @returns {{quoteReserve: bigint, tokenReserve: bigint}} zeroed when the
 *   config cannot be priced at all, so every figure downstream degrades to 0
 *   rather than to NaN.
 */
function openingPool(launchConfig) {
  const supply = toBig(launchConfig?.supply);
  const rate = rateFromTick(launchConfig?.initialTick);
  if (supply <= 0n || !rate) return { quoteReserve: 0n, tokenReserve: 0n };

  // The tick is a float (1.0001^n), so this crosses to BigInt once, here. Every
  // buy walked against these reserves is exact integer arithmetic from now on.
  const quoteReserve = BigInt(Math.round(Number(supply) / rate));
  return quoteReserve > 0n
    ? { quoteReserve, tokenReserve: supply }
    : { quoteReserve: 0n, tokenReserve: 0n };
}

// ── pons v2: the bonding curve ──────────────────────────────────────────────
//
// A v2 launch has no pool. The curve holds the whole supply and quotes against
// a PHANTOM quote reserve the config supplies — config #0 live is supply 1e9,
// phantomQuote 1.68 ETH, so k = 1.68e9 from the first block and the price is
// known before the launch is sent. That is why this side is arithmetic rather
// than an estimate.
//
// FEES COME OFF THE INPUT ON A BUY. The sibling reading of the SELL side found
// its fees taken off the OUTPUT (see evm/v2/holdings.quoteSellOut, reproduced
// to the wei against two live curves), and that is not a second rule: the curve
// fee and the creator tax are both charged in the QUOTE asset, which is the
// input of a buy and the output of a sell. So a buy of q puts q − fees into the
// reserve, and the token side is never touched by a fee.
//
// Anchored to real curves rather than to the formula:
//   · 0.00012 ETH bought 70,684 tokens on a fresh config #0 curve. This returns
//     70,709 — 0.04% high.
//   · 1 ETH on the same curve returns 370.8M tokens, 37% of supply, which is
//     the order the chain gives.
// That 0.04% is the part not re-derived from the curve's own source, which is
// not in this repo. It errs HIGH on tokens, so the share this reports is a
// hair generous and never quietly small.

/**
 * One buy against a constant product, and the reserves it leaves behind.
 *
 * BOTH PROTOCOLS COME THROUGH HERE. A constant product is a constant product:
 * v2 passes the curve's phantom reserve and its fee, v1 passes the reserves
 * openingPool derives from the tick and no fee (the pool's own fee is not
 * modelled — see openingPool). Two implementations of x*y=k in one file would
 * be two chances to get it wrong.
 *
 * @param {object} input
 * @param {bigint|string} input.quoteInWei gross quote sent, fees included
 * @param {bigint|string} input.quoteReserve including the phantom reserve
 * @param {bigint|string} input.tokenReserve
 * @param {number} input.feeBps curve fee + creator tax, both on the quote leg
 * @returns {{tokensOut: bigint, netIn: bigint, quoteReserve: bigint, tokenReserve: bigint}}
 */
function constantProductBuy({ quoteInWei, quoteReserve, tokenReserve, feeBps = 0 }) {
  const q = toBig(quoteInWei);
  let quote = toBig(quoteReserve);
  let tokens = toBig(tokenReserve);
  if (q <= 0n || quote <= 0n || tokens <= 0n) {
    return { tokensOut: 0n, netIn: 0n, quoteReserve: quote, tokenReserve: tokens };
  }

  const netIn = q - (q * toBig(feeBps)) / BPS;
  if (netIn <= 0n) {
    return { tokensOut: 0n, netIn: 0n, quoteReserve: quote, tokenReserve: tokens };
  }

  // Constant product: the reserve takes the net in, and the buyer takes
  // whatever keeps k where it was.
  const tokensOut = (tokens * netIn) / (quote + netIn);
  quote += netIn;
  tokens -= tokensOut;
  return { tokensOut, netIn, quoteReserve: quote, tokenReserve: tokens };
}

// The name the v2 callers and their tests know it by. Same function; the curve
// was simply the first thing in here that needed it.
const v2Buy = constantProductBuy;

// ── the bundle ──────────────────────────────────────────────────────────────

/**
 * What a bundle takes in total, and what each wallet in it can take, against
 * the pool state the dev buy has already left behind.
 *
 * THE TOTAL IS ARITHMETIC, NOT A GUESS. Tokens out for a given total in are
 * path-independent on a constant product, so one walk with the summed input is
 * the answer for every possible landing order — the same answer, exactly. It
 * gets no range and no hedge.
 *
 * PER WALLET IS A RANGE, because landing order is the one thing here that is
 * undetermined: fire.js broadcasts the buys together and the sequencer orders
 * them. `best` is this wallet first, with only the dev buy ahead of it; `worst`
 * is it last, with every other wallet in the bundle ahead of it. The rest of
 * the bundle is applied as ONE trade of (total − this wallet) rather than leg
 * by leg, which is the same thing for the same reason the total is.
 *
 * Note that sum(best) ≥ total ≥ sum(worst): the ends of the ranges are each
 * wallet's own extreme, and they cannot all land first.
 */
function bundleRange({ quoteReserve, tokenReserve, feeBps = 0, weis }) {
  let totalIn = 0n;
  for (const wei of weis) totalIn += wei;

  const total = constantProductBuy({ quoteInWei: totalIn, quoteReserve, tokenReserve, feeBps });

  const legs = weis.map((wei) => {
    const best = constantProductBuy({ quoteInWei: wei, quoteReserve, tokenReserve, feeBps });
    // Everything except this wallet, ahead of it. For a bundle of one that is
    // a zero-value buy, which moves nothing — so best and worst coincide, which
    // is correct: with nobody to be behind, its position is not in doubt.
    const ahead = constantProductBuy({
      quoteInWei: totalIn - wei,
      quoteReserve,
      tokenReserve,
      feeBps,
    });
    const worst = constantProductBuy({
      quoteInWei: wei,
      quoteReserve: ahead.quoteReserve,
      tokenReserve: ahead.tokenReserve,
      feeBps,
    });
    return { wei, best: best.tokensOut, worst: worst.tokensOut };
  });

  return { legs, totalIn, totalTokens: total.tokensOut };
}

/** wei for one leg, whichever way the caller happens to hold the amount. */
function legWei(leg) {
  if (leg == null) return 0n;
  if (leg.amountWei !== undefined && leg.amountWei !== null && leg.amountWei !== '') {
    return toBig(leg.amountWei);
  }
  return parseEthToWei(leg.amountEth);
}

/** bps of supply, to two decimal places, from base units on both sides. */
function bpsOf(amount, supply) {
  const s = toBig(supply);
  if (s <= 0n) return 0;
  // Scaled in BigInt before it ever becomes a double: the numerator here is
  // ~1e27 and a double carries 15 digits, which is not enough to subtract two
  // of them and still trust the tail.
  return Number((toBig(amount) * BPS * 100n) / s) / 100;
}

/**
 * A v1 bundle, against the pool the launch config opens.
 *
 * The bundle total is the pool walked once with the summed ETH — order cannot
 * change it — and each wallet gets the range between landing first and landing
 * last. It was quoting one number per wallet, off the opening tick with no
 * impact term, that had twelve wallets buying 0.06 ETH each all reporting the
 * same 4.43%: wallet 1's price, handed to all twelve.
 *
 * The whole thing is still an ESTIMATE — there is no pool until the launch runs
 * — and `exact: false` says so. What changed is that it is now an estimate of
 * the right quantity.
 */
function shareV1({ launchConfig, devBuyWei, devBuyEth, buys = [] }) {
  const supply = toBig(launchConfig?.supply);
  const pool = openingPool(launchConfig);

  // The dev buy is inside the launch transaction, so it is ahead of the entire
  // bundle and its own figure is not a range — its position is the one thing
  // about this that is fixed. It moves the price every bundle wallet then pays,
  // so the bundle is priced from what it leaves behind.
  const dev = legWei({ amountWei: devBuyWei, amountEth: devBuyEth });
  const devOut = dev > 0n ? constantProductBuy({ quoteInWei: dev, ...pool }) : null;
  const open = devOut
    ? { quoteReserve: devOut.quoteReserve, tokenReserve: devOut.tokenReserve }
    : pool;

  const weis = buys.map((buy) => legWei(buy));
  const {
    legs: ranges,
    totalIn: bundleWei,
    totalTokens: bundleTokens,
  } = bundleRange({ ...open, weis });

  let cursor = open;
  let cumulative = devOut ? devOut.tokensOut : 0n;

  const legs = buys.map((buy, i) => {
    const wei = weis[i];
    // The running total through this row. Path independence again: this is
    // what the wallets down to and including this one hold BETWEEN them in any
    // landing order — only the split between them moves.
    const seq = constantProductBuy({ quoteInWei: wei, ...cursor });
    cursor = { quoteReserve: seq.quoteReserve, tokenReserve: seq.tokenReserve };
    cumulative += seq.tokensOut;

    // THE CAP FLAG STAYS ON THE OPENING PRICE. preflight calls capCheck itself
    // (bundle/prepare.js) and cannot see this walk, so flagging on anything
    // else here would hand the operator one set of doomed wallets while the
    // preflight that stops the launch used another. It is the higher figure of
    // the two, so it warns early rather than late — and it sits above the range
    // drawn beside it, which is why capBps travels out to the table: a flag has
    // to be able to say what it was measured against.
    const cap = capCheck({ amountInWei: wei, launchConfig });

    return {
      key: buy.key,
      amountEth: formatWei(wei),
      // est* is the TOP of the range — this wallet landing first, behind only
      // the dev buy. It keeps that name because the plan and the launch history
      // record one figure per wallet, and "up to" is the only honest one to
      // record. worst* is the same wallet landing last.
      estTokens: Number(ranges[i].best) / 1e18,
      estBps: bpsOf(ranges[i].best, supply),
      worstTokens: Number(ranges[i].worst) / 1e18,
      worstBps: bpsOf(ranges[i].worst, supply),
      cumulativeBps: bpsOf(cumulative, supply),
      capBps: cap.estBps,
      exceedsWallet: cap.exceedsWallet,
      exceedsTx: cap.exceedsTx,
    };
  });

  const devTokens = devOut ? devOut.tokensOut : 0n;
  const devLeg = devOut
    ? {
        key: 'dev',
        amountEth: formatWei(dev),
        estTokens: Number(devTokens) / 1e18,
        estBps: bpsOf(devTokens, supply),
        // Equal ends: not a range, because there is nowhere else it can land.
        worstTokens: Number(devTokens) / 1e18,
        worstBps: bpsOf(devTokens, supply),
        cumulativeBps: bpsOf(devTokens, supply),
        capBps: bpsOf(devTokens, supply),
        // Never flagged, whatever its size. The dev buy happens inside the
        // launch transaction, before the restriction window applies to
        // anything, so the caps are not its caps — marking it would train the
        // operator to ignore the one marker that means a reverted buy.
        exceedsWallet: false,
        exceedsTx: false,
      }
    : null;

  const totalTokens = bundleTokens + devTokens;
  return {
    protocol: 'v1',
    // The caller MUST render this differently when it is false. v1 has no pool
    // to quote against until the launch has already happened.
    exact: false,
    dev: devLeg,
    buys: legs,
    bundle: {
      eth: formatWei(bundleWei),
      tokens: Number(bundleTokens) / 1e18,
      bps: bpsOf(bundleTokens, supply),
    },
    total: {
      eth: formatWei(bundleWei + dev),
      tokens: Number(totalTokens) / 1e18,
      bps: bpsOf(totalTokens, supply),
    },
    over: legs.filter((l) => l.exceedsWallet || l.exceedsTx).map((l) => l.key),
    caps: {
      maxWalletBps: Number(launchConfig?.maxWalletBps || 0),
      maxTxBps: Number(launchConfig?.maxTxBps || 0),
    },
    graduation: null,
  };
}

/**
 * A v2 bundle, walked through the curve.
 *
 * ORDER IS THE POINT, and so is not knowing it. The dev buy goes first because
 * it is inside the launch transaction itself; after that each wallet buys a
 * curve the ones that landed before it have already moved, so the same ETH buys
 * less the later it lands. Which wallet that is, the sequencer decides — hence
 * a range per wallet and one exact figure for the bundle. Quoting each wallet
 * independently at the opening price would overstate the tail; quoting it at
 * its row number would be a guess dressed as arithmetic.
 *
 * The curve arithmetic itself is untouched: same constantProductBuy, same fee
 * on the same leg, same sequential walk for the graduation threshold.
 */
function shareV2({ launchConfig, creatorTaxBps = 0, devBuyWei, devBuyEth, buys = [] }) {
  const supply = toBig(launchConfig?.supply);
  const threshold = toBig(launchConfig?.graduationThreshold);
  const feeBps = Number(launchConfig?.curveFeeBps || 0) + Number(creatorTaxBps || 0);

  let quoteReserve = toBig(launchConfig?.phantomQuote);
  let tokenReserve = supply;
  // What the curve has actually RAISED — the net quote that stayed in it. The
  // fees left for the escrow and the creator, so they are not part of it, and
  // graduation is measured on this rather than on quoteReserve, which starts
  // 1.68 ETH ahead of zero because of the phantom.
  let raised = 0n;
  let crossesAt = null;

  const step = (key, wei) => {
    const before = raised;
    const r = v2Buy({ quoteInWei: wei, quoteReserve, tokenReserve, feeBps });
    quoteReserve = r.quoteReserve;
    tokenReserve = r.tokenReserve;
    raised += r.netIn;
    if (crossesAt === null && threshold > 0n && before < threshold && raised >= threshold) {
      crossesAt = key;
    }
    return r;
  };

  const dev = legWei({ amountWei: devBuyWei, amountEth: devBuyEth });
  const devOut = dev > 0n ? step('dev', dev) : null;

  // The curve the bundle actually meets, once the launch transaction's own dev
  // buy has been taken off it.
  const weis = buys.map((buy) => legWei(buy));
  const {
    legs: ranges,
    totalIn: bundleWei,
    totalTokens: bundleTokens,
  } = bundleRange({ quoteReserve, tokenReserve, feeBps, weis });

  const legs = [];
  let cumulative = devOut ? devOut.tokensOut : 0n;
  buys.forEach((buy, i) => {
    // The sequential walk stays because two things are measured along it: the
    // quote the curve has RAISED, which is what graduation is checked against,
    // and the running total through a row.
    const r = step(buy.key, weis[i]);
    cumulative += r.tokensOut;
    legs.push({
      key: buy.key,
      amountEth: formatWei(weis[i]),
      // The top of the range — this wallet landing first, behind only the dev
      // buy. See shareV1 for why the top keeps the est* name.
      estTokens: Number(ranges[i].best) / 1e18,
      estTokensRaw: ranges[i].best.toString(),
      estBps: bpsOf(ranges[i].best, supply),
      worstTokens: Number(ranges[i].worst) / 1e18,
      worstTokensRaw: ranges[i].worst.toString(),
      worstBps: bpsOf(ranges[i].worst, supply),
      cumulativeBps: bpsOf(cumulative, supply),
      exceedsWallet: false, // v2 has no restriction window and no caps
      exceedsTx: false,
    });
  });

  const devLeg = devOut
    ? {
        key: 'dev',
        amountEth: formatWei(dev),
        estTokens: Number(devOut.tokensOut) / 1e18,
        estTokensRaw: devOut.tokensOut.toString(),
        estBps: bpsOf(devOut.tokensOut, supply),
        // Equal ends: the dev buy is inside the launch transaction, so there is
        // nowhere else for it to land.
        worstTokens: Number(devOut.tokensOut) / 1e18,
        worstTokensRaw: devOut.tokensOut.toString(),
        worstBps: bpsOf(devOut.tokensOut, supply),
        cumulativeBps: bpsOf(devOut.tokensOut, supply),
        exceedsWallet: false,
        exceedsTx: false,
      }
    : null;

  const totalTokens = bundleTokens + (devOut ? devOut.tokensOut : 0n);
  return {
    protocol: 'v2',
    // Exact: the config fixes the curve before the launch, so this is the
    // curve's own arithmetic rather than a reading of it.
    exact: true,
    dev: devLeg,
    buys: legs,
    bundle: {
      eth: formatWei(bundleWei),
      tokens: Number(bundleTokens) / 1e18,
      bps: bpsOf(bundleTokens, supply),
    },
    total: {
      eth: formatWei(bundleWei + dev),
      tokens: Number(totalTokens) / 1e18,
      bps: bpsOf(totalTokens, supply),
    },
    over: [],
    caps: null,
    graduation: threshold > 0n
      ? {
          thresholdEth: formatWei(threshold),
          raisedEth: formatWei(raised),
          // Graduating on the way IN is the one state a bundle cannot sell out
          // of through the curve, so this is a warning and not a note.
          crosses: raised >= threshold,
          crossesAt,
        }
      : null,
  };
}

/**
 * The one entry point both the console and preflight call.
 *
 * @param {object} input
 * @param {'v1'|'v2'} input.protocol
 * @param {object} input.launchConfig straight from /configs or /v2/configs —
 *   never a hardcoded copy, because these are read live from the factory and
 *   the owner can change them between one launch and the next.
 * @param {string|number|bigint} [input.devBuyEth] ETH, or pass devBuyWei
 * @param {number} [input.creatorTaxBps] v2 only; it rides on the same quote leg
 *   as the curve fee, so it changes what every buy receives.
 * @param {Array<{key:string, amountEth?:string, amountWei?:string|bigint}>} input.buys
 *   IN EXECUTION ORDER.
 * @returns {object} JSON-safe: numbers and strings, never a BigInt.
 */
function bundleShare({ protocol, launchConfig, devBuyEth, devBuyWei, creatorTaxBps = 0, buys = [] }) {
  if (!launchConfig) return null;
  return protocol === 'v2'
    ? shareV2({ launchConfig, creatorTaxBps, devBuyWei, devBuyEth, buys })
    : shareV1({ launchConfig, devBuyWei, devBuyEth, buys });
}

module.exports = {
  parseEthToWei,
  formatWei,
  rateFromTick,
  estimateTokensOut,
  capCheck,
  openingPool,
  constantProductBuy,
  v2Buy,
  shareV1,
  shareV2,
  bundleShare,
};
