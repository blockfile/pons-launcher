'use strict';

/**
 * Every /api/v3/* endpoint — the Relay chain's whole surface.
 *
 * SEPARATE FROM routes/wallets.js AND routes/launch.js BY DESIGN, and mounted
 * beside them rather than inside them. V3 is a strategy of its own; the rule for
 * this feature is that v1 and v2 are not touched, and a router that can be
 * unmounted in one line is the strongest form of that promise.
 *
 * WHERE THE REFUSALS LIVE. The engine validates the SHAPE of a run — intervals,
 * jitter, positive amounts, no duplicate wallets. Everything that requires
 * reading the chain is validated here, before the engine is ever started:
 *
 *   · the token is a pons v2 launch the factory has a record of
 *   · a wallet this account holds or has held launched it
 *   · the curve has not graduated and is not about to
 *   · v3main exists and can cover the big buy
 *   · every target is genuinely a v3 bundle wallet
 *
 * The ownership check is the one that matters most, and it is the same gate
 * prepareSell enforces for the same reason: a run signs approvals, and an
 * approval to a hostile ERC-20 is the whole dusting attack. "A wallet of ours"
 * is the live keystore plus the deleted-wallet archive, so rotating a dev wallet
 * does not orphan the tokens it launched.
 */

const express = require('express');
const { formatEther, formatUnits, getAddress, parseEther } = require('ethers');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey, requireAuthConfigured } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const { erc20 } = require('../evm/erc20');
const { getFees, gasCost } = require('../evm/fees');
const config = require('../config');
const holdings = require('../evm/v2/holdings');
const { ethPriceUsd } = require('../ethPrice');
const v3roles = require('../v3/roles');
const trade = require('../v3/trade');
const relay = require('../v3/relay');
const swaproute = require('../evm/v3/swaproute');
const sizing = require('../v3/sizing');
const engine = require('../v3/engine');
const exit = require('../v3/exit');
const gather = require('../v3/gather');
const sweep = require('../v3/sweep');
const { storeFor } = require('../v4/store');
const seasoned = require('../v4/seasoned');

const router = express.Router();

/**
 * BigInts out of the response.
 *
 * Copied rather than imported from routes/launch.js: importing a route module
 * to borrow a seven-line helper pulls its whole router in as a side effect, and
 * this file is meant to be detachable in one line.
 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** An ETH string to wei, refusing anything that is not a number. */
function parseAmount(value, what) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^\d*\.?\d+$/.test(raw)) {
    throw new Error(`${what} must be a number of ETH`);
  }
  return parseEther(raw);
}

/**
 * Turn a request body into what the engine takes, refusing everything that
 * cannot be checked without reading the chain first.
 */
async function resolveRun(body = {}, ks, deps = {}) {
  const describe = deps.describeToken || ((t) => holdings.describeToken(t));
  const readCurve = (deps.trade || trade).readCurve;
  const routeSwap = deps.swaproute || swaproute;
  const rpc = deps.rpc || provider;
  const getFeesFn = deps.getFeesFn || getFees;

  if (!body.token) throw new Error('token is required');
  const token = getAddress(body.token);

  // ── is this a token we may touch ──────────────────────────────────────────
  const record = await describe(token);
  if (!record.exists) {
    throw new Error(`${token} is not a pons v2 launch — the factory has no record of it`);
  }
  const ours = holdings.ownerSet(ks.ownedAddresses());
  if (!ours.has(getAddress(record.deployer).toLowerCase())) {
    throw new Error(
      `${token} was not launched by a wallet this account holds or has held — the factory says ` +
        `${record.deployer} launched it. Refusing to approve a contract we did not create.`
    );
  }

  // ── is the curve still a curve ────────────────────────────────────────────
  const curve = await readCurve(record.curve, deps);
  if (curve.graduated) {
    throw new Error(`${token} has graduated to a Uniswap v4 pool — V3 cannot trade it`);
  }
  if (curve.readyToGraduate) {
    // Refused rather than warned: a run that graduates halfway leaves the rest
    // of the position somewhere this code cannot sell, and the operator would
    // discover that at the exit rather than at the start.
    throw new Error(
      `${token} is ready to graduate — a run started now would strand the remaining position in ` +
        'a pool V3 cannot sell into'
    );
  }
  // A TOKEN-quoted curve (e.g. AMZN) is traded via the ETH<->pairToken route (swaproute): the big
  // buy swaps ETH to the pair token then buys the curve with it, each sell swaps the proceeds back
  // to ETH so Relay can move them. It is allowed only if the curve exposes a pairToken AND a funded
  // swap route exists AND the big buy won't over-impact the (usually thin) pool — the last two are
  // checked below once the big buy is sized. A native curve skips all of this.
  if (!curve.isNativeQuote && !curve.pairToken) {
    throw new Error(
      `${token} is token-quoted but its curve exposes no pairToken — V3 has nothing to route ETH ` +
        `through, so it cannot trade this curve.`
    );
  }

  // ── the wallets ───────────────────────────────────────────────────────────
  const main = v3roles.main(ks); // throws naming v3main
  const bundle = v3roles.bundle(ks);
  if (!bundle.length) {
    throw new Error('no v3 bundle wallet — generate some on the V3 tab first');
  }

  // No per-wallet amount. The position is divided across however many wallets
  // are in the run, one cycle each, sized as it goes — so all a target needs to
  // be is a wallet we own. Omitting `targets` means every bundle wallet, which
  // is what the console sends.
  const requested =
    Array.isArray(body.targets) && body.targets.length
      ? body.targets
      : bundle.map((w) => ({ walletId: w.id }));

  const known = new Map(bundle.map((w) => [w.id, w]));
  const targets = requested.map((t) => {
    const wallet = known.get(t.walletId);
    if (!wallet) throw new Error(`wallet ${t.walletId} is not a v3 bundle wallet`);
    return { walletId: wallet.id, address: wallet.address };
  });

  // ── can the main wallet start ─────────────────────────────────────────────
  const bigBuyWei = parseAmount(body.bigBuyEth, 'the big buy');
  if (bigBuyWei <= 0n) throw new Error('the big buy must be positive');

  const fees = await getFeesFn(trade.FEE_BUMP_PCT);
  const bigBuyGas = gasCost(fees, BigInt(config.buyGasLimit));
  const balance = BigInt(await rpc.getBalance(main.address));
  if (balance < bigBuyWei + bigBuyGas) {
    throw new Error(
      `the v3 main wallet has ${formatEther(balance)} ETH but the big buy needs ` +
        `${formatEther(bigBuyWei + bigBuyGas)} (buy + gas) — fund it first`
    );
  }

  // ── token-quoted curve: confirm the route exists and the big buy fits the pool ─────────────
  // The QuoterV2 SATURATES (never reverts) on an oversized input, so this impact preflight is the
  // ONLY thing that catches a big buy that would drain the thin USDG/pairToken pool for near
  // nothing. assessBuyImpact discovers the fee tier (throwing "no route" if the pool is unfunded)
  // and measures the price impact — refuse at START, matching the guard buyViaRoute enforces live.
  if (!curve.isNativeQuote) {
    let impact;
    try {
      impact = await routeSwap.assessBuyImpact(
        { pairToken: curve.pairToken, amountInWei: bigBuyWei },
        { provider: rpc }
      );
    } catch (err) {
      throw new Error(
        `${token} is quoted in ${curve.pairToken}, but V3 cannot route ETH to it: ${err.message}`
      );
    }
    if (impact.impactBps > config.v3Route.maxImpactBps) {
      throw new Error(
        `this ${formatEther(bigBuyWei)} ETH big buy would move the ${curve.pairToken} pool ` +
          `${(impact.impactBps / 100).toFixed(1)}% (max ${config.v3Route.maxImpactBps / 100}%) — the pool is too ` +
          `thin for this size and most of the ETH would be lost to price impact. Use a smaller big buy.`
      );
    }
  }

  return {
    token,
    curve: getAddress(record.curve),
    symbol: body.symbol || null,
    bigBuyWei,
    targets,
    main,
    curveState: curve,
    intervalMs: body.intervalMs,
    jitterPct: body.jitterPct,
    variancePct: body.variancePct,
  };
}

/** A wei amount as dollars, or null when no price is available. */
function usd(wei, price) {
  if (!price) return null;
  return (Number(formatEther(wei)) * price).toFixed(2);
}

/**
 * A dry preview. Everything resolveRun checks, plus what the run would look
 * like: how big the position will be after the big buy, what an average slice
 * works out to, and what the opening tax would cost. Broadcasts nothing.
 *
 * THE POSITION IS NOT THE BIG BUY. Buying and then selling the same tokens back
 * pays the fee and the creator tax twice AND the operator's own price impact
 * twice, so what is actually available to distribute is meaningfully less than
 * what goes in. Estimating it here — rather than dividing the big buy by the
 * wallet count — is the difference between the panel's average slice being
 * roughly right and being confidently wrong.
 */
/**
 * Can this run fund every wallet? Replays the whole chain against the curve,
 * sized against the SAME gas the engine reserves (engine.gasFigures). Used by
 * both the plan (to warn) and start (to refuse) so the two never disagree.
 */
async function feasibilityOf(run, deps = {}) {
  const s = deps.sizing || sizing;
  const getFeesFn = deps.getFeesFn || getFees;
  const routeSwap = deps.swaproute || swaproute;
  const rpc = deps.rpc || provider;
  const curve = run.curveState;
  const isRoute = curve.isNativeQuote === false;
  const shape = {
    quoteReserve: curve.quoteReserve,
    tokenReserve: curve.tokenReserve,
    feeBps: curve.feeBps,
    creatorTaxBps: curve.creatorTaxBps,
  };
  const walletCount = run.targets.length;
  if (walletCount === 0) return { feasible: false, sustainedWallets: 0, reason: 'no-wallets', atCycle: 1 };
  const fees = await getFeesFn(engine.FEE_BUMP_PCT);
  // Same route-aware basis the engine's gasFor uses, so the plan blesses exactly the runs the
  // engine can sustain — a token curve's sell/buy carry extra swap+approve legs.
  const gas = engine.gasFigures(fees, { route: isRoute });

  // simulateChain replays the chain in the curve's QUOTE asset. For a native curve that is ETH and
  // the gas figures are already ETH. For a token curve the curve is priced in the pair token, so
  // the big buy AND the ETH gas floors it is checked against are converted to the pair token — via
  // one spot reference quote (1 ETH -> pairToken), which keeps the whole sim in one currency
  // without a tiny per-figure quote rounding to zero. (Price impact on the buy is caught separately
  // by the start-time impact preflight; this sim is about slice depletion, not impact.)
  let toQuote = (weiEth) => weiEth;
  if (isRoute) {
    const perEth = (
      await routeSwap.quoteEthToPair({ pairToken: curve.pairToken, amountInWei: 10n ** 18n }, { provider: rpc })
    ).amountOut;
    toQuote = (weiEth) => (weiEth > 0n ? (BigInt(weiEth) * perEth) / 10n ** 18n : 0n);
  }
  const tokensBought = s.quoteBuyOut({ quoteIn: toQuote(run.bigBuyWei), ...shape });
  return s.simulateChain({
    tokensBought,
    ...shape,
    walletCount,
    mainGas: toQuote(gas.mainGas),
    buyGas: toQuote(gas.buyGas),
    buffer: toQuote(gas.buffer),
    relayFeePct: engine.RELAY_FEE_PCT,
  });
}

// Basis points, kept local rather than read off `sizing` so a test that injects
// a sizing double cannot change what the cap arithmetic means.
const CAP_BPS = 10_000n;

/**
 * Spot market cap of a pons v2 curve, before and after the big buy, in the
 * curve's OWN QUOTE ASSET.
 *
 * A pons v2 curve is constant product with a VIRTUAL ("phantom") quote reserve,
 * so the marginal price of one token is just quoteReserve / tokenReserve — a
 * price is not a trade, so no fee applies to it. Market cap is that price times
 * the token's whole supply:
 *
 *   now:   q0 / t0 · supply
 *   after: q1 / t1 · supply,   q1 = q0 + net,  t1 = t0 − tokensBought
 *
 * where `net` is the part of the big buy that actually reaches the reserve —
 * quoteIn less the curve fee and the creator tax, taken off the input exactly
 * as sizing.quoteBuyOut takes it, so q1 and t1 describe the same post-buy curve
 * the position estimate above was drawn from rather than one a rounding apart.
 *
 * BOTH SIDES ARE BASE UNITS, so the token's decimals cancel: supply/tokenReserve
 * is a pure ratio and the result comes out in quote base units (wei on a native
 * curve) whatever the token's decimals are. Decimals are only ever used to print
 * the supply for a human.
 *
 * Pure BigInt arithmetic and no I/O — this is the part that can be pinned to a
 * known launch by a test rather than by watching a chain. Returns null rather
 * than throwing on a curve shape the formula has no answer for (an empty
 * reserve, a buy that takes the whole token side, a fee of 100%).
 *
 * @returns {{ nowQuote: bigint, afterQuote: bigint } | null}
 */
function marketCapQuote({
  quoteReserve,
  tokenReserve,
  feeBps = 0,
  creatorTaxBps = 0,
  quoteIn,
  tokensBought,
  totalSupply,
}) {
  const q0 = BigInt(quoteReserve);
  const t0 = BigInt(tokenReserve);
  const supply = BigInt(totalSupply);
  if (q0 <= 0n || t0 <= 0n || supply <= 0n) return null;

  const takenBps = BigInt(feeBps) + BigInt(creatorTaxBps);
  if (takenBps >= CAP_BPS) return null;

  const net = (BigInt(quoteIn) * (CAP_BPS - takenBps)) / CAP_BPS;
  const q1 = q0 + net;
  const t1 = t0 - BigInt(tokensBought);
  if (t1 <= 0n) return null;

  return { nowQuote: (q0 * supply) / t0, afterQuote: (q1 * supply) / t1 };
}

/**
 * The plan's `mc` block: what the token is capped at right now, and what the big
 * buy would leave it capped at — in ETH, and in dollars when a rate is available.
 *
 * ADVISORY, AND NEVER ALLOWED TO FAIL A PLAN. It needs one chain read the rest
 * of the plan does not — the token's own totalSupply() — and, on a token-quoted
 * curve, one quote to price the pair token. A token that does not implement the
 * getter, or a quoter that will not answer, must cost the operator a display
 * figure and nothing else: a preview that refused to describe a run because a
 * headline number was unavailable would be strictly worse than one that
 * describes it without the number. So the whole body sits inside one catch and
 * the caller gets null.
 *
 * TOKEN-QUOTED CURVES (e.g. AMZN) come out of the formula above in pair-token
 * units and are converted by one reference quote, probed at 0.001 ETH and scaled
 * to a per-ETH rate, then divided into the figure. Quoting a cap-sized amount
 * directly would be nonsense: the QuoterV2 SATURATES rather than reverting on an
 * oversized input, so a market-cap-sized quote reports what a pool that size
 * could pay, not what the token is worth. The probe size is the point — see the
 * note at the conversion itself.
 *
 * feasibilityOf's own rate is deliberately NOT changed to match. It feeds
 * simulateChain, whose feasible/sustainedWallets verdict gates Start; this one
 * only prints a headline. A display fix does not get to move a money decision.
 */
async function marketCapOf({ token, curve, tokensBought, curveQuoteIn, price }, deps = {}) {
  try {
    const rpc = deps.rpc || provider;
    const erc20Fn = deps.erc20 || erc20;
    const routeSwap = deps.swaproute || swaproute;
    const erc = erc20Fn(token, rpc);

    // The one read that decides whether there is an `mc` at all.
    const totalSupply = BigInt(await erc.totalSupply());
    // Display only — the arithmetic is decimals-free (see marketCapQuote). A
    // token that does not expose decimals() is printed as the 18 everything on
    // this chain uses.
    const decimals = await erc
      .decimals()
      .then((d) => Number(d))
      .catch(() => 18);
    const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18;

    const caps = marketCapQuote({
      quoteReserve: curve.quoteReserve,
      tokenReserve: curve.tokenReserve,
      feeBps: curve.feeBps,
      creatorTaxBps: curve.creatorTaxBps,
      quoteIn: curveQuoteIn,
      tokensBought,
      totalSupply,
    });
    if (!caps) return null;

    let nowWei = caps.nowQuote;
    let afterWei = caps.afterQuote;
    const pairQuoted = curve.isNativeQuote === false;
    if (pairQuoted) {
      // PROBED AT 0.001 ETH AND SCALED, NOT QUOTED AT 1 ETH. This rate is a
      // PRICE, so it wants the near-spot rate — the same size swaproute's
      // IMPACT_PROBE uses for exactly that reason. Quoting a whole ETH against
      // the thin USDG/pairToken pool this path targets moves it: an impacted
      // quote pays out fewer pair tokens, perEth lands under spot, and since
      // the cap divides BY perEth the headline would come out HIGH by
      // 1/(1-impact) — one-way, never conservative. And the size is wrong on
      // its face: resolveRun refuses the run unless the big buy's own impact is
      // under v3Route.maxImpactBps, so the trade that was allowed is often a
      // small fraction of the ETH being quoted here, and nothing measures THIS
      // quote's impact. The probe is unguarded for the same reason it needs no
      // guard: at 0.001 ETH the impact is negligible on any pool funded enough
      // to have routed the plan this far.
      const probe = 10n ** 15n;
      const out = BigInt(
        (
          await routeSwap.quoteEthToPair(
            { pairToken: curve.pairToken, amountInWei: probe },
            { provider: rpc }
          )
        ).amountOut
      );
      if (out <= 0n) return null;
      // Scale to a per-ETH rate first, then divide — multiply-before-divide, so
      // the pair-token figure never rounds through a truncated intermediate.
      const perEth = out * (10n ** 18n / probe);
      nowWei = (nowWei * 10n ** 18n) / perEth;
      afterWei = (afterWei * 10n ** 18n) / perEth;
    }

    return {
      nowEth: formatEther(nowWei),
      nowUsd: usd(nowWei, price),
      afterEth: formatEther(afterWei),
      afterUsd: usd(afterWei, price),
      supply: formatUnits(totalSupply, places),
      pairQuoted,
    };
  } catch (_err) {
    return null;
  }
}

async function buildPlan(body, ks, deps = {}) {
  const run = await resolveRun(body, ks, deps);
  const t = deps.trade || trade;
  const s = deps.sizing || sizing;
  const priceFn = deps.ethPriceUsd || ethPriceUsd;

  const curve = run.curveState;
  const shape = {
    quoteReserve: curve.quoteReserve,
    tokenReserve: curve.tokenReserve,
    feeBps: curve.feeBps,
    creatorTaxBps: curve.creatorTaxBps,
  };

  // Round-trip the big buy through the curve to estimate the position, IN ETH. A token-quoted
  // curve (e.g. AMZN) is priced in its pair token, not ETH, and the run crosses the swap pool on
  // BOTH sides — ETH -> pairToken to buy, pairToken -> ETH on every sell — so the estimate must
  // cross it too, or the headline position and bleed are in the wrong currency. A native curve
  // skips both conversions (and never touches the swap module).
  const rpc = deps.rpc || provider;
  const routeSwap = deps.swaproute || swaproute;
  const isRoute = curve.isNativeQuote === false;
  const curveQuoteIn = isRoute
    ? (await routeSwap.quoteEthToPair({ pairToken: curve.pairToken, amountInWei: run.bigBuyWei }, { provider: rpc })).amountOut
    : run.bigBuyWei;
  const tokensBought = s.quoteBuyOut({ quoteIn: curveQuoteIn, ...shape });
  const positionQuote = s.quoteSellOut({ tokensIn: tokensBought, ...shape });
  const positionWei = isRoute
    ? (await routeSwap.quotePairToEth({ pairToken: curve.pairToken, amountIn: positionQuote }, { provider: rpc })).amountOut
    : positionQuote;
  const walletCount = run.targets.length;
  const meanWei = walletCount > 0 ? positionWei / BigInt(walletCount) : 0n;

  // Feasibility: replay the WHOLE chain against the curve (engine gas basis), so
  // a run that would collapse mid-way ("slices too small") is caught HERE rather
  // than a wallet or two into a live run. The headline meanWei above is a naive
  // average that hides the sequential price impact; this does not.
  const feasibility = await feasibilityOf(run, deps);

  const variancePct = Number(body.variancePct ?? sizing.DEFAULT_VARIANCE_PCT);
  const lowWei = (meanWei * BigInt(Math.round(10_000 - variancePct * 100))) / 10_000n;
  const highWei = (meanWei * BigInt(Math.round(10_000 + variancePct * 100))) / 10_000n;

  // Advisory only, and never allowed to fail the plan — a dollar figure is a
  // convenience beside the ETH figures, which are the ones the curve fixes.
  const price = await priceFn()
    .then((p) => p.usd)
    .catch(() => null);

  // Where the big buy leaves the token's market cap. Advisory, like the dollar
  // figures — null when it cannot be computed, never a reason to refuse a plan.
  const mc = await marketCapOf(
    { token: run.token, curve, tokensBought, curveQuoteIn, price },
    deps
  );

  // Per the FIRST bundle wallet: the tax is a function of the recipient and the
  // clock, and every wallet in this run is in the same position.
  const snipeTax = await t.snipeTax(run.curve, run.targets[0].address, deps);

  const bleedPct =
    run.bigBuyWei > 0n
      ? Number(((run.bigBuyWei - positionWei) * 10_000n) / run.bigBuyWei) / 100
      : 0;

  const warnings = [
    'there is no slippage floor on any trade in this run — every sell and every buy takes ' +
      'whatever price it gets',
    `buying the position and selling it back costs about ${bleedPct.toFixed(1)}% to fees and to ` +
      "your own price impact, so the wallets share roughly " +
      `${formatEther(positionWei)} ETH rather than the full ${formatEther(run.bigBuyWei)}`,
  ];
  if (bleedPct > 20) {
    warnings.push(
      `that ${bleedPct.toFixed(1)}% is high, and it is price impact rather than fees: this big buy ` +
        'is large relative to the curve. A smaller big buy loses far less on the round trip.'
    );
  }
  if (isRoute) {
    warnings.push(
      `this curve is quoted in ${curve.pairToken}, not ETH — every buy swaps ETH to that token and ` +
        'every sell swaps back, through a pool that is usually thin. The position is capped at what the ' +
        'pool can absorb (a big buy over the impact cap is refused at start), and each cycle pays two ' +
        'extra swap legs of gas and fees on top of the curve. Keep the big buy small.'
    );
  }
  if (!feasibility.feasible) {
    warnings.push(
      `this position can fund about ${feasibility.sustainedWallets} of ${walletCount} wallets before a ` +
        'cycle raises less than the gas the next one needs — the run would halt partway. Reduce the ' +
        'wallet count (or increase the big buy, or pick a deeper-liquidity curve) so every wallet is served.'
    );
  }
  if (snipeTax.bps > 0) {
    warnings.push(
      `the opening snipe tax is still live at ${snipeTax.bps} bps and V3's wallets are NOT exempt — ` +
        'they were not known when the launch declared its exemption list, so every buy in this run ' +
        `pays it. The window is ${snipeTax.windowSeconds}s from the launch; wait it out to avoid the tax.`
    );
  }

  return {
    token: run.token,
    curve: run.curve,
    graduated: curve.graduated,
    readyToGraduate: curve.readyToGraduate,
    feeBps: curve.feeBps,
    creatorTaxBps: curve.creatorTaxBps,
    bigBuyEth: formatEther(run.bigBuyWei),
    bigBuyUsd: usd(run.bigBuyWei, price),
    ethUsd: price,
    mainWallet: { walletId: run.main.id, address: run.main.address },
    walletCount,
    // Whether the position can actually fund every wallet, and how many it can
    // fund if not — the panel greys out Start and says which when this is false.
    feasible: feasibility.feasible,
    sustainedWallets: feasibility.sustainedWallets,
    targets: run.targets.map((x, i) => ({ index: i + 1, walletId: x.walletId, address: x.address })),
    // What the run has to hand out, after the round trip.
    position: {
      tokens: formatUnits(tokensBought, 18),
      tokensRaw: tokensBought.toString(),
      eth: formatEther(positionWei),
      usd: usd(positionWei, price),
      bleedPct: Number(bleedPct.toFixed(2)),
    },
    // What one cycle looks like on average, and the band it varies within.
    slice: {
      meanEth: formatEther(meanWei),
      meanUsd: usd(meanWei, price),
      lowEth: formatEther(lowWei),
      lowUsd: usd(lowWei, price),
      highEth: formatEther(highWei),
      highUsd: usd(highWei, price),
    },
    // Market cap now and after the big buy. Null when the token's supply could
    // not be read — the panel simply shows nothing rather than a wrong figure.
    mc,
    snipeTax,
    intervalMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS),
    jitterPct: Number(body.jitterPct ?? engine.DEFAULT_JITTER_PCT),
    variancePct,
    estimatedRunMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS) * walletCount,
    minQuoteOut: '0',
    warnings,
  };
}

// ── wallets ─────────────────────────────────────────────────────────────────

// GET /api/v3/wallets — V3's three groups, with balances. Never key material.
router.get('/v3/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const groups = v3roles.all(ks);
    const withBalance = async (w) =>
      w ? { ...w, balanceEth: formatEther(await provider.getBalance(w.address)) } : null;

    res.json(
      jsonSafe({
        treasury: await withBalance(groups.treasury),
        main: await withBalance(groups.main),
        bundle: await Promise.all(groups.bundle.map(withBalance)),
        roles: v3roles.ROLES,
        running: engine.isRunning(req.user.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/wallets/generate — fresh wallets in one of V3's three roles.
router.post('/v3/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, role, label } = req.body || {};
    if (!v3roles.isV3Role(role)) {
      throw new Error(`role must be one of ${Object.values(v3roles.ROLES).join(', ')}`);
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be between 1 and 100');

    const made = keystoreFor(req.user.id).generate(n, { role, label });
    activityFor(req.user.id).record('v3', `[v3] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/wallets/import — an existing key into one of V3's roles.
router.post('/v3/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, role, label } = req.body || {};
    if (!v3roles.isV3Role(role)) {
      throw new Error(`role must be one of ${Object.values(v3roles.ROLES).join(', ')}`);
    }
    const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys].filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');

    const made = keystoreFor(req.user.id).importKeys(keys, { role, label });
    activityFor(req.user.id).record('v3', `[v3] imported ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v3/wallets/:id — refused mid-run: the engine resolves wallets by
// id every cycle, and deleting one under a running job fails that cycle and
// halts the whole thing.
router.delete('/v3/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v3 run is in progress — stop it before deleting a wallet');
    }
    const ks = keystoreFor(req.user.id);
    const wallet = ks.list().find((w) => w.id === req.params.id);
    if (!wallet) throw new Error(`no wallet ${req.params.id}`);
    if (!v3roles.isV3Role(wallet.role)) {
      throw new Error(`${req.params.id} is not a v3 wallet — delete it from its own tab`);
    }
    ks.remove(req.params.id);
    activityFor(req.user.id).record('v3', `[v3] deleted ${wallet.role} wallet ${wallet.address}`, {
      role: wallet.role,
      address: wallet.address,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/fund — treasury → main, through Relay.
router.post('/v3/fund', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const from = v3roles.treasury(ks);
    const to = v3roles.main(ks);
    const amountWei = parseAmount(req.body?.amountEth, 'the funding amount');

    const out = await relay.transfer({ fromWallet: from, toAddress: to.address, amountWei }, { keystore: ks });

    // Broadcasting the deposit is not delivery. Wait for the order to actually
    // fill, so a deposit that never settles is surfaced with everything needed to
    // recover it — not returned as a bare success hash the way a stranded 0.1
    // orphaned deposit was.
    let fill = { filled: null, status: null };
    if (out.hash && out.requestId) {
      fill = await relay.confirmFill(out.requestId);
    }
    const result = { ...out, filled: fill.filled, relayStatus: fill.status };
    if (fill.filled === false) {
      result.warning =
        `Deposit broadcast but Relay has not filled it (status: ${fill.status}). ` +
        `The ${formatEther(amountWei)} ETH is at deposit address ${out.depositAddress} and is ` +
        `refundable to the treasury ${from.address}. Keep requestId ${out.requestId} for a Relay ticket.`;
    }

    activityFor(req.user.id).record(
      'v3',
      `[v3] funded the main wallet with ${formatEther(amountWei)} ETH through Relay` +
        (fill.filled === false ? ` — NOT filled (${fill.status})` : ''),
      { from: from.address, to: to.address, requestId: out.requestId, hash: out.hash, filled: fill.filled }
    );
    res.json(jsonSafe(result));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/wallets/backup — V3 keys for an offline backup. V3's wallets only
// (v3dev/v3main/v3bundle), never another tab's — the same scoping V4's backup
// uses. Same two locks as the whole-keystore export: an API key, and a configured
// credential so a keyless deployment fails closed rather than serving keys.
//
// TWO OPTIONAL NARROWINGS, mirroring V4's /v4/wallets/backup shape. With NEITHER
// present the response is exactly what it was before they existed — every V3
// wallet — so the "Download backup" button is unchanged:
//   walletIds — an explicit set of ids (the bundle table's "export selected"). An
//               id naming a wallet that is not one of ours is simply absent from
//               the v3-only floor below, so a stray or hostile id can only ever
//               export FEWER wallets, never a wallet this tab does not own.
//   role      — one of V3's own three roles (a per-panel export). walletIds wins.
router.post('/v3/wallets/backup', requireApiKey, requireAuthConfigured, (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.confirm !== true) throw new Error('backup requires { confirm: true }');
    const ks = keystoreFor(req.user.id);
    // Every V3 wallet is the floor this never exports past — the filters below
    // only ever NARROW it, never widen it to another tab's keys.
    const all = ks.exportAll().filter((w) => v3roles.isV3Role(w.role));

    const requestedIds = Array.isArray(body.walletIds) ? new Set(body.walletIds.map(String)) : null;
    const role = typeof body.role === 'string' && body.role ? body.role : null;
    if (role && !v3roles.isV3Role(role)) {
      throw new Error(`role must be one of ${Object.values(v3roles.ROLES).join(', ')}`);
    }
    const wallets = requestedIds
      ? all.filter((w) => requestedIds.has(w.id))
      : role
        ? all.filter((w) => w.role === role)
        : all;

    console.warn(`[pons-launcher] V3 KEYSTORE BACKUP EXPORTED — ${wallets.length} private keys`);
    activityFor(req.user.id).record('export', `[v3] downloaded a backup of ${wallets.length} v3 private key(s)`, {
      count: wallets.length,
    });
    res.json({
      exportedAt: new Date().toISOString(),
      chainId: config.chainId,
      count: wallets.length,
      // Only on a filtered export, so the full-backup file is byte-for-byte what
      // it was, and a subset file still says what it is when it is opened months
      // later by someone who no longer remembers which button produced it.
      ...(requestedIds || role
        ? {
            note: requestedIds
              ? `Selected export — ${wallets.length} of ${all.length} V3 wallet(s), the ones chosen on the tab. ` +
                'The rest are NOT in this file.'
              : `Per-panel export — the ${wallets.length} ${role} wallet(s) only. Other V3 wallets are NOT in this file.`,
          }
        : {}),
      warning:
        'These private keys control real funds. Anyone holding this file can spend every wallet in it. ' +
        'Store it offline. There are no mnemonics: the keystore holds private keys only.',
      wallets,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/wallets/claim-seasoned — pull N finished-seasoning wallets into
// V3's bundle role. Refused mid-run: the engine resolves wallets by id per cycle.
router.post('/v3/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v3 run is in progress — stop it before claiming wallets');
    }
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    if (take.length === 0) {
      return res.json(jsonSafe({ claimed: [], available: pool.length, shortfall: want }));
    }
    const out = seasoned.claim(ks, store, take.map((w) => w.id), {
      toRole: v3roles.ROLES.bundle,
      toTab: 'v3',
      now: Date.now(),
    });
    activityFor(req.user.id).record('v3', `[v3] claimed ${out.claimed.length} seasoned wallet(s) into the bundle`, {
      count: out.claimed.length,
    });
    res.json(jsonSafe({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) }));
  } catch (err) {
    next(err);
  }
});

// ── the chain ───────────────────────────────────────────────────────────────

// GET /api/v3/chain — the current job, or an idle shape. The panel polls this.
router.get('/v3/chain', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.status(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/chain/plan — everything start would check, plus what cycle one
// would sell and what the opening tax would cost. Broadcasts nothing.
router.post('/v3/chain/plan', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await buildPlan(req.body || {}, keystoreFor(req.user.id))));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/chain/start — irreversible, moves the whole position, no
// slippage floor. Takes confirm the same way the v1 sell does.
router.post('/v3/chain/start', requireApiKey, async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error(
        'starting a v3 run sells and re-buys the whole position with no slippage floor — ' +
          'requires { confirm: true }'
      );
    }
    const run = await resolveRun(req.body || {}, keystoreFor(req.user.id));
    // Refuse a run the position cannot finish — the same feasibility the plan
    // shows. { force: true } overrides it for an operator who means to run a
    // partial chain anyway.
    const feasibility = await feasibilityOf(run);
    if (!feasibility.feasible && req.body?.force !== true) {
      throw new Error(
        `this position can fund about ${feasibility.sustainedWallets} of ${run.targets.length} wallets before a ` +
          "cycle raises less than the next one's gas — the run would halt partway. Reduce the wallet count " +
          '(or increase the big buy, or pick a deeper-liquidity curve), or pass { force: true } to run it anyway.'
      );
    }
    res.json(
      jsonSafe(
        await engine.start(req.user.id, {
          token: run.token,
          curve: run.curve,
          symbol: run.symbol,
          bigBuyWei: run.bigBuyWei,
          targets: run.targets,
          intervalMs: run.intervalMs,
          jitterPct: run.jitterPct,
          variancePct: run.variancePct,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v3/chain/stop', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.stop(req.user.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/v3/chain/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.resume(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// ── the exit ────────────────────────────────────────────────────────────────

router.get('/v3/exit/preview', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const record = await holdings.describeToken(req.query.token);
    if (!record.exists) throw new Error(`${req.query.token} is not a pons v2 launch`);
    res.json(
      jsonSafe(await exit.preview(req.user.id, { token: record.token, curve: record.curve }))
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v3/exit', requireApiKey, async (req, res, next) => {
  try {
    const record = await holdings.describeToken(req.body?.token);
    if (!record.exists) throw new Error(`${req.body?.token} is not a pons v2 launch`);
    // The same ownership gate the start takes. An exit approves every wallet's
    // balance to the curve, so it is the same risk and takes the same check.
    const ks = keystoreFor(req.user.id);
    const ours = holdings.ownerSet(ks.ownedAddresses());
    if (!ours.has(getAddress(record.deployer).toLowerCase())) {
      throw new Error(`${record.token} was not launched by a wallet this account holds or has held`);
    }
    res.json(
      jsonSafe(
        await exit.run(req.user.id, {
          token: record.token,
          curve: record.curve,
          confirm: req.body?.confirm,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

// ── gathering a token back to main ────────────────────────────────────────────
// Two end-of-run utilities that sit beside the exit. Both read the chain and
// move the exact balance they find — see v3/gather.js.

// A DIRECT ERC-20 transfer of one token from every bundle wallet into main. This
// links those wallets to main on-chain by design (the panel warns about it); a
// plain transfer grants no allowance, so there is no ownership gate to enforce.
router.post('/v3/tokens/return-to-main', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await gather.returnToMain(req.user.id, { token: req.body?.token })));
  } catch (err) {
    next(err);
  }
});

// Sell the main wallet's whole balance of a token back to ETH. Floor-free
// (confirm required) and behind the exit's ownership gate — gather.sellMain
// enforces both, so the handler only passes the body through.
router.post('/v3/tokens/sell-main', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(
        await gather.sellMain(req.user.id, {
          token: req.body?.token,
          confirm: req.body?.confirm,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

// A DIRECT native-ETH sweep to main (or treasury) — no Relay. For dust the relayed
// sweep below cannot move: Relay's fee + minimum eat a ~$1 balance, a direct send
// only pays 21k gas. Links the wallets on-chain (the panel warns); confirm required.
router.post('/v3/tokens/sweep-direct', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v3 run is in progress — sweeping now would take the ETH a pending cycle is about to use');
    }
  } catch (err) {
    return next(err);
  }
  gather
    .sweepEthToMain(req.user.id, { destination: req.body?.destination, confirm: req.body?.confirm })
    .then((out) => res.json(jsonSafe(out)))
    .catch(next);
});

// ── the sweep ───────────────────────────────────────────────────────────────
// Collecting the ETH back out once the exit has sold everything. Always through
// Relay — see the header of v3/sweep.js for why a direct sweep would undo the
// whole run after the fact.

router.get('/v3/sweep/preview', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(
        await sweep.preview(req.user.id, {
          destination: req.query.destination || 'main',
          minSweepEth: req.query.minSweepEth,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v3/sweep', requireApiKey, async (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error(
        'a v3 run is in progress — sweeping now would take the ETH a pending cycle is about to ' +
          'buy with. Stop the run first.'
      );
    }
    res.json(
      jsonSafe(
        await sweep.run(req.user.id, {
          destination: req.body?.destination || 'main',
          minSweepEth: req.body?.minSweepEth,
          confirm: req.body?.confirm,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._private = { jsonSafe, parseAmount, resolveRun, buildPlan, marketCapQuote };
