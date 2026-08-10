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
//   v1 is an ESTIMATE. There is no pool until the launch runs, so the only
//      price that exists is the tick the launch config pins. It has no impact
//      term, which makes every v1 figure a CEILING — real fills come in
//      smaller, and smaller still the further down the bundle a wallet sits.
//   v2 is ARITHMETIC. The curve is a constant product against a phantom
//      reserve, and the launch config fixes both before the launch is sent, so
//      walking the buys through it in order is what the curve will do, not a
//      guess at it.

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
// The estimate ignores the price impact of the bundle's own buys, so it reports
// slightly MORE tokens than a wallet will really get. That errs toward warning
// early, which is the safe direction.

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
 * One buy against a v2 curve, and the reserves it leaves behind.
 *
 * @param {object} input
 * @param {bigint|string} input.quoteInWei gross quote sent, fees included
 * @param {bigint|string} input.quoteReserve including the phantom reserve
 * @param {bigint|string} input.tokenReserve
 * @param {number} input.feeBps curve fee + creator tax, both on the quote leg
 * @returns {{tokensOut: bigint, netIn: bigint, quoteReserve: bigint, tokenReserve: bigint}}
 */
function v2Buy({ quoteInWei, quoteReserve, tokenReserve, feeBps = 0 }) {
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

// ── the bundle ──────────────────────────────────────────────────────────────

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
 * A v1 bundle, in the order it executes.
 *
 * The legs are walked in sequence for the same reason v2's are — the caller
 * shows a running total — but BE CLEAR THAT V1'S PER-WALLET RATE DOES NOT MOVE.
 * The opening tick is all there is before the launch, so this model has no
 * impact term and wallet 20 is quoted the same price as wallet 1. It will not
 * get it. Every v1 figure here is a ceiling.
 */
function shareV1({ launchConfig, devBuyWei, devBuyEth, buys = [] }) {
  const supplyTokens = Number(launchConfig?.supply || 0) / 1e18;
  const legs = [];
  let cumulativeBps = 0;

  const dev = legWei({ amountWei: devBuyWei, amountEth: devBuyEth });
  const devCap = dev > 0n ? capCheck({ amountInWei: dev, launchConfig }) : null;
  if (devCap) cumulativeBps += devCap.estBps;

  let bundleTokens = 0;
  let bundleWei = 0n;
  for (const buy of buys) {
    const wei = legWei(buy);
    const cap = capCheck({ amountInWei: wei, launchConfig });
    cumulativeBps += cap.estBps;
    bundleTokens += cap.estTokens;
    bundleWei += wei;
    legs.push({
      key: buy.key,
      amountEth: formatWei(wei),
      estTokens: cap.estTokens,
      estBps: cap.estBps,
      cumulativeBps,
      exceedsWallet: cap.exceedsWallet,
      exceedsTx: cap.exceedsTx,
    });
  }

  const devLeg = devCap
    ? {
        key: 'dev',
        amountEth: formatWei(dev),
        estTokens: devCap.estTokens,
        estBps: devCap.estBps,
        cumulativeBps: devCap.estBps,
        // Never flagged, whatever its size. The dev buy happens inside the
        // launch transaction, before the restriction window applies to
        // anything, so the caps are not its caps — marking it would train the
        // operator to ignore the one marker that means a reverted buy.
        exceedsWallet: false,
        exceedsTx: false,
      }
    : null;

  const bundleBps = supplyTokens ? (bundleTokens / supplyTokens) * 10000 : 0;
  return {
    protocol: 'v1',
    // The caller MUST render this differently when it is false. v1 has no pool
    // to quote against until the launch has already happened.
    exact: false,
    dev: devLeg,
    buys: legs,
    bundle: { eth: formatWei(bundleWei), tokens: bundleTokens, bps: bundleBps },
    total: {
      eth: formatWei(bundleWei + dev),
      tokens: bundleTokens + (devLeg ? devLeg.estTokens : 0),
      bps: bundleBps + (devLeg ? devLeg.estBps : 0),
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
 * A v2 bundle, walked through the curve in the order it executes.
 *
 * ORDER IS THE POINT. The dev buy goes first because it is inside the launch
 * transaction itself, then each wallet buys a curve the ones before it have
 * already moved, so wallet 20 pays more than wallet 1 for the same ETH. Quoting
 * them independently overstates the tail.
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

  const legs = [];
  let bundleTokens = 0n;
  let bundleWei = 0n;
  let cumulative = devOut ? devOut.tokensOut : 0n;
  for (const buy of buys) {
    const wei = legWei(buy);
    const r = step(buy.key, wei);
    bundleTokens += r.tokensOut;
    bundleWei += wei;
    cumulative += r.tokensOut;
    legs.push({
      key: buy.key,
      amountEth: formatWei(wei),
      estTokens: Number(r.tokensOut) / 1e18,
      estTokensRaw: r.tokensOut.toString(),
      estBps: bpsOf(r.tokensOut, supply),
      cumulativeBps: bpsOf(cumulative, supply),
      exceedsWallet: false, // v2 has no restriction window and no caps
      exceedsTx: false,
    });
  }

  const devLeg = devOut
    ? {
        key: 'dev',
        amountEth: formatWei(dev),
        estTokens: Number(devOut.tokensOut) / 1e18,
        estTokensRaw: devOut.tokensOut.toString(),
        estBps: bpsOf(devOut.tokensOut, supply),
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
  v2Buy,
  shareV1,
  shareV2,
  bundleShare,
};
