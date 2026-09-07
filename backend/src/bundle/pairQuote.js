'use strict';

/**
 * READ-ONLY PRICING FOR A PAIRED LAUNCH'S CONSOLE.
 *
 * Nothing in this module signs, sends, takes the launch lock or touches a nonce.
 * It exists so the operator can answer two questions the console could not answer
 * before, both of which are questions about a PRICE and neither of which is a
 * spend:
 *
 *   1. THE CONVERTER. The Buy column is denominated in the launch's quote asset —
 *      NVDA / SPCX / AMD on a paired launch — because that is the number prepareV2
 *      parses and then demands the wallet hold. The operator, though, thinks in
 *      ETH ("I have 0.5 ETH for this bundle") and had no way to see what that is
 *      in NVDA, or what an NVDA total costs in ETH. `convertPair` answers both
 *      directions. It does NOT change what is written anywhere: the Buy column
 *      stays the pair token, and the console writes only what is in its own
 *      pair-token field.
 *
 *   2. "USE THE ETH THE WALLETS ALREADY HOLD." By the time a paired launch is
 *      being sized the bundle wallets are usually already funded with ETH, so the
 *      natural question is the inverse of the auto-fill's: not "pick a pair-token
 *      total and work out the ETH" but "spend what is already there, keep back
 *      the gas, and let the resulting pair-token amount BE the Buy amount".
 *      `planFromBalance` answers that, per wallet.
 *
 * WHY THIS IS A NEW ENDPOINT AND NOT THE swap-to-pair DRY RUN. The dry run is the
 * console's pricing instrument for a plan it already has, and it stays that: it is
 * still what prices the Fund column and the pair-funding cost. But it is an
 * exact-OUTPUT question — "here are the amounts each wallet must end up holding,
 * what does that cost?" — and both questions above run the other way. There is no
 * amount to hand it: the converter has an ETH figure and no wallets, and the
 * balance planner has an ETH balance per wallet and is trying to DISCOVER the
 * amount. Handing it a placeholder plan to read a rate off would be a second,
 * worse source of the same number. So this module asks the same quoter the dry run
 * asks, through the same evm/v3/swaproute route, and reuses swapToPair's own
 * sizing loop, its own gas reserve and its own margin constant rather than
 * restating any of them.
 *
 * TWO CURRENCIES, AND NOT ONE SUM ACROSS THEM. Every figure this module returns is
 * labelled with its unit in its own field name — `...Eth` is wei-derived ETH,
 * `...Pair` is the pair token at the FACTORY's economics decimals (the decimals
 * prepareV2 parses buy amounts with, which is what makes the comparison legal).
 * Nothing here adds a figure in one unit to a figure in the other. The only bridge
 * between them is a quote, and a quote is stamped with the moment it was taken.
 *
 * THE APPROVAL CHECK USES THE CACHE, NOT A REFRESH. swapBundleToPair resolves the
 * pair with `refresh: true` because it is about to SPEND on the answer and an
 * approval that has been flipped off must fail before any ETH moves. These two
 * calls spend nothing and are driven from debounced fields, so a refresh would
 * mean a whole-chain log scan per keystroke. The five-minute cache is the right
 * trade here: the worst case is a converter reading for a pair that was
 * un-approved in the last five minutes, and the path that spends re-checks live.
 */

const { getAddress, parseEther, parseUnits, formatUnits, formatEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { readTokenBalances } = require('../evm/erc20');
const { resolvePairTokens } = require('../evm/v2/pairTokens');
const swaproute = require('../evm/v3/swaproute');
const keystore = require('../wallets/keystore');
const { DEFAULT_VARIANT, bundleWalletsFor } = require('../wallets/variants');
const {
  resolveApprovedPair,
  sizeEthForPair,
  gasReserveWei,
  OVERSHOOT_BPS,
  FEE_BUMP_PCT,
} = require('./swapToPair');
// The gas the console's own sell path signs with. Imported rather than restated
// so "gas for N sells" here is the same figure /api/gas reports and the same one
// prepareSell actually uses.
const { APPROVE_GAS: SELL_APPROVE_GAS, SELL_GAS } = require('./prepareSell');

const BPS = 10_000n;

// How many exits each wallet keeps gas for, when the caller does not say. This is
// the console's standing promise — WalletsPanel's SELL_RESERVE — and is
// deliberately generous: a wallet holding a position it cannot exit is worse than
// one funded slightly high.
const DEFAULT_SELLS = 10;
const MAX_SELLS = 50;

// A bundle is at most 31 wallets. This only bounds the quoting work.
const MAX_PLAN_WALLETS = 100;

// Nothing on this chain is worth quoting above this, and an absurd input is the
// one way a read-only endpoint can be made expensive.
const MAX_ETH_IN = parseEther('100000');

/**
 * The pair token, confirmed approved, resolved through the FIVE-MINUTE CACHE.
 * See "THE APPROVAL CHECK USES THE CACHE" in the header for why this differs from
 * swapBundleToPair's refresh.
 */
function approvedPair(pairToken, deps = {}) {
  const resolve = deps.resolvePairTokens || resolvePairTokens;
  return resolveApprovedPair(pairToken, {
    provider: deps.provider,
    resolvePairTokens: (opts) => resolve({ ...opts, refresh: false }),
  });
}

/** A positive decimal amount, or null when the field was not asked about. */
function optionalAmount(value, units, label) {
  if (value === undefined || value === null || value === '') return null;
  let parsed;
  try {
    parsed = parseUnits(String(value), units);
  } catch (_err) {
    throw new Error(`"${value}" is not a valid ${label} amount`);
  }
  if (parsed <= 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

/**
 * A LIVE RATE, BOTH WAYS. Whichever of `ethIn` / `pairIn` is given is answered;
 * both may be given and both are answered from the same routed fee tier.
 *
 * ETH -> PAIR is a plain exact-input quote: it is literally the swap the console
 * would make, so what it reports is what that ETH buys.
 *
 * PAIR -> ETH is NOT the reverse quote, and the difference matters. Quoting
 * pairToken -> ETH would price SELLING that much of the pair token, which is a
 * different (and smaller, by two pool fees and two lots of impact) number than
 * what it costs to BUY it. An operator funding a bundle off the second figure
 * would under-fund every wallet. So this inverts the buy the way the funding path
 * does — swapToPair's own sizeEthForPair — and then adds swapToPair's own
 * OVERSHOOT_BPS, because that is what the swap will actually put in.
 *
 * `converged` is false when the sizing loop could not reach the target: the pool
 * is too thin for that size, and the ETH figure is a floor, not an answer.
 *
 * @returns {Promise<object>} every amount as a decimal string, every field named
 *   with its own unit, plus `quotedAt` — a rate is a quote and it moves.
 */
async function convertPair(input, deps = {}) {
  const rpc = deps.provider || provider;
  const route = deps.route || swaproute;
  const pair = await approvedPair(input.pairToken, { ...deps, provider: rpc });

  const ethIn = optionalAmount(input.ethIn, 18, 'ETH');
  const pairIn = optionalAmount(input.pairIn, pair.decimals, pair.symbol);
  if (ethIn === null && pairIn === null) throw new Error('ethIn or pairIn is required');
  if (ethIn !== null && ethIn > MAX_ETH_IN) {
    throw new Error(`ethIn is capped at ${formatEther(MAX_ETH_IN)} ETH`);
  }

  const usdgFee = await route.discoverPairFee(pair.address, { provider: rpc });
  const out = {
    pairToken: pair.address,
    pairSymbol: pair.symbol,
    pairDecimals: pair.decimals,
    usdgFee,
    // The margin the funding swap adds on top of what it sizes. Returned so the
    // console can say WHY the ETH figure is what it is instead of restating 3%.
    overshootBps: OVERSHOOT_BPS,
    quotedAt: new Date().toISOString(),
  };

  if (ethIn !== null) {
    const { amountOut } = await route.quoteEthToPair(
      { pairToken: pair.address, amountInWei: ethIn, usdgFee },
      { provider: rpc }
    );
    out.ethIn = formatEther(ethIn);
    out.pairOut = formatUnits(BigInt(amountOut), pair.decimals);
  }

  if (pairIn !== null) {
    const sized = await sizeEthForPair(
      { pairToken: pair.address, need: pairIn, usdgFee },
      { provider: rpc, route }
    );
    const withMargin = (sized.ethIn * (BPS + BigInt(OVERSHOOT_BPS))) / BPS;
    out.pairIn = formatUnits(pairIn, pair.decimals);
    out.ethCost = formatEther(withMargin);
    out.ethCostConverged = sized.converged;
  }

  return out;
}

/**
 * Round a raw amount DOWN to `places` decimals, as the string the console writes
 * into the Buy column.
 *
 * Down, never nearest. The Buy amount becomes a requirement the wallet must be
 * able to satisfy, so a value rounded UP is a wallet asked for more than its ETH
 * can buy — which is the "holds 0.0X, needs 0.0Y — skipped" state this whole
 * feature exists to prevent.
 */
function floorUnits(raw, decimals, places) {
  const p = Math.max(0, Math.min(Number(places), Number(decimals)));
  const drop = 10n ** BigInt(Number(decimals) - p);
  return formatUnits((BigInt(raw) / drop) * drop, decimals);
}

/**
 * WHAT THE ETH EACH BUNDLE WALLET ALREADY HOLDS WOULD BUY.
 *
 * Per wallet: read its real ETH balance, hold back everything it still has to pay
 * gas for, quote what the remainder buys, and report a CONSERVATIVE pair-token
 * amount for the Buy column. Sends nothing and writes nothing — the console
 * writes the fields, and only after showing these figures.
 *
 * ── THE GAS RESERVE, TERM BY TERM ──────────────────────────────────────────
 * All at getFees(FEE_BUMP_PCT = 25), the same basis prepareV2 checks against.
 *
 *   gasReserveWei(fees)  — swapToPair's OWN reserve, imported rather than
 *                          restated, so a wallet this planner sizes is never a
 *                          wallet that run then refuses for lacking it:
 *                            swap gas (450k)
 *                          + (approve 100k + config.buyGasLimit) x 2, because the
 *                            launch's approve and buy are broadcast LATER at fees
 *                            nobody can read yet
 *                          + config.gasBufferEth, prepareV2's own preflight buffer
 *   sellReserveWei       — (approve 100k + sell 600k) x `sells`, at the same fees.
 *                          This is the term swapToPair does NOT hold back, because
 *                          it is the console's promise rather than the launch's:
 *                          step 6 sells from these very wallets, and a wallet that
 *                          cannot afford its own exit is holding a position it
 *                          cannot get out of. It is the same figure /api/gas
 *                          reports as sellGasEth, times the same SELL_RESERVE the
 *                          auto-fill already reserves.
 *
 * ── THE TWO MARGINS, AND WHY BOTH ARE OVERSHOOT_BPS ────────────────────────
 *   spendable = balance - reserve                        (ETH free to become pair)
 *   swapIn    = spendable * BPS / (BPS + OVERSHOOT_BPS)   (ETH the swap may size to)
 *   quoted    = the live quote for swapIn                 (pair token)
 *   buy       = held + floor(quoted * (BPS - OVERSHOOT_BPS) / BPS)
 *
 * The FIRST margin is not a safety cushion, it is arithmetic: swapBundleToPair
 * sizes an input against the requirement and then adds OVERSHOOT_BPS on top, so
 * the input it actually broadcasts is 103% of what it sized. Planning the swap at
 * the whole spendable balance would therefore produce a run that needs 103% of it
 * and refuses the wallet as short. `swapIn` is the largest figure whose +3% still
 * fits inside what the wallet can spend.
 *
 * The SECOND margin is the conservative choice the Buy column is written from.
 * `quoted` is the OPTIMISTIC figure — what the pool would pay at this instant.
 * Writing it would leave the wallet needing every wei of its spendable balance and
 * the pool to have not moved; the first tick against it makes the Buy amount one
 * the wallet cannot satisfy. So the Buy column gets `quoted` less the same 3%,
 * floored to the pair's decimals. What that buys:
 *   - the funding swap re-sizes its own input from this smaller requirement and so
 *     spends LESS than swapIn, never more — swapIn is a true ceiling;
 *   - about 3% of room for the price to move between this quote and the run;
 *   - and the run's minOut is floored at the requirement itself, so the wallet
 *     either ends up holding at least this amount or the swap reverts with its ETH
 *     intact. There is no outcome where it holds less than its Buy amount.
 *
 * `held` is added because swapBundleToPair tops up the SHORTFALL rather than
 * buying the whole requirement again — a wallet already holding some of the pair
 * token would otherwise leave that much ETH unspent for no reason. The guarantee
 * is unchanged: it ends up holding `held` plus at least what it buys.
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────
 * Every wallet appears in the result with a status and, when it is not usable, a
 * reason naming it. A wallet whose balance cannot cover the reserve is skipped and
 * NAMED; it is never given a zero Buy amount, which would read as a decision.
 */
async function planFromBalance(input, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore || keystore;
  const route = deps.route || swaproute;
  const feesFn = deps.getFees || getFees;
  const balancesFn = deps.readTokenBalances || readTokenBalances;
  const buyGasLimit = deps.buyGasLimit ?? config.buyGasLimit;
  const gasBufferEth = deps.gasBufferEth ?? config.gasBufferEth;
  const maxImpactBps = Number(deps.maxImpactBps ?? config.v3Route.maxImpactBps);

  const variant = input.variant || DEFAULT_VARIANT;
  const sells = Math.max(0, Math.min(MAX_SELLS, Math.round(Number(input.sells ?? DEFAULT_SELLS)) || 0));

  const pair = await approvedPair(input.pairToken, { ...deps, provider: rpc });

  const bundle = bundleWalletsFor(ks, variant);
  if (!bundle.length) throw new Error(`there are no ${variant} bundle wallets to plan against`);
  if (bundle.length > MAX_PLAN_WALLETS) {
    throw new Error(`this plan is capped at ${MAX_PLAN_WALLETS} wallets (got ${bundle.length})`);
  }

  // ONE route discovery for the whole plan: the fee tier is a property of the
  // pair, not of the wallet — the same reason swapBundleToPair does it once.
  let usdgFee;
  try {
    usdgFee = await route.discoverPairFee(pair.address, { provider: rpc });
  } catch (err) {
    throw new Error(
      `no ETH to ${pair.symbol} route: ${err.message}. These wallets cannot buy this pair token with their own ETH.`
    );
  }

  const fees = await feesFn(FEE_BUMP_PCT);
  const gasReserve = gasReserveWei(fees, { buyGasLimit, gasBufferEth });
  const sellReserve = gasCost(fees, SELL_APPROVE_GAS + SELL_GAS) * BigInt(sells);
  const reserve = gasReserve + sellReserve;

  const addresses = bundle.map((w) => getAddress(w.address));
  // One batched read for what they already hold, rather than 31 sequential ones.
  const held = await balancesFn(pair.address, addresses, { provider: rpc });

  // The Buy column is written at six places on a native launch and at the pair
  // token's own decimals when those are fewer — a 2-decimal quote asset cannot
  // parse "0.123456" and the priced plan would be refused for it. Same rule the
  // auto-fill split uses.
  const places = Math.min(6, Number(pair.decimals) || 6);

  const results = [];
  let totalSwapWei = 0n;
  let totalBuyRaw = 0n;

  for (let i = 0; i < bundle.length; i += 1) {
    const wallet = bundle[i];
    const address = addresses[i];
    const heldRaw = held[i] == null ? 0n : BigInt(held[i]);
    const row = {
      walletId: wallet.id,
      address,
      balanceEth: null,
      reserveEth: formatEther(reserve),
      spendableEth: null,
      swapEth: null,
      heldPair: held[i] == null ? null : formatUnits(heldRaw, pair.decimals),
      quotedPair: null,
      buyPair: null,
      impactBps: null,
      status: 'failed',
      reason: null,
    };
    results.push(row);

    try {
      const balance = BigInt(await rpc.getBalance(address));
      row.balanceEth = formatEther(balance);

      if (balance <= reserve) {
        row.status = 'skipped-no-eth';
        row.spendableEth = '0.0';
        row.reason =
          `holds ${formatEther(balance)} ETH, all of which is reserved: ${formatEther(gasReserve)} for the ` +
          `swap and the launch's approve + buy, ${formatEther(sellReserve)} for ${sells} sells. ` +
          'Fund it first, or it buys nothing.';
        continue;
      }

      const spendable = balance - reserve;
      row.spendableEth = formatEther(spendable);
      // See "THE TWO MARGINS": the funding swap broadcasts 103% of what it sizes.
      const swapIn = (spendable * BPS) / (BPS + BigInt(OVERSHOOT_BPS));
      if (swapIn <= 0n) {
        row.status = 'skipped-no-eth';
        row.reason = `holds ${formatEther(balance)} ETH — nothing is left over once gas is reserved`;
        continue;
      }
      row.swapEth = formatEther(swapIn);

      // The impact guard, for the same reason swapBundleToPair has one: the quoter
      // SATURATES rather than reverting on an oversized input, so a slippage floor
      // is structurally blind to a trade that drains a thin pool. assessBuyImpact
      // returns the full quote alongside the impact, so this is the quote too —
      // one call, not two.
      const impact = await route.assessBuyImpact(
        { pairToken: pair.address, amountInWei: swapIn, usdgFee },
        { provider: rpc }
      );
      row.impactBps = impact.impactBps;
      if (impact.impactBps > maxImpactBps) {
        row.status = 'skipped-impact';
        row.reason =
          `${formatEther(swapIn)} ETH would move the ${pair.symbol} pool ` +
          `${(impact.impactBps / 100).toFixed(2)}% (max ${maxImpactBps / 100}%) — most of it would be lost to ` +
          'price impact. Buy less from this wallet, or leave it out.';
        continue;
      }

      const quoted = BigInt(impact.fullOut);
      if (quoted <= 0n) {
        row.status = 'failed';
        row.reason = `the ${pair.symbol} pool quotes nothing for ${formatEther(swapIn)} ETH`;
        continue;
      }
      row.quotedPair = formatUnits(quoted, pair.decimals);

      // THE CONSERVATIVE FIGURE. See "THE TWO MARGINS" above for why it is the
      // quote less OVERSHOOT_BPS and not the quote itself.
      const conservative = (quoted * (BPS - BigInt(OVERSHOOT_BPS))) / BPS;
      const buyStr = floorUnits(heldRaw + conservative, pair.decimals, places);
      const buyRaw = parseUnits(buyStr, pair.decimals);
      if (buyRaw <= heldRaw) {
        row.status = 'skipped-dust';
        row.reason =
          `${formatEther(spendable)} ETH buys ${formatUnits(conservative, pair.decimals)} ${pair.symbol}, ` +
          `which rounds to nothing at ${places} decimal place${places === 1 ? '' : 's'} — too little to name as a buy`;
        continue;
      }

      row.buyPair = buyStr;
      row.status = 'ok';
      totalSwapWei += swapIn;
      totalBuyRaw += buyRaw;
    } catch (err) {
      row.status = 'failed';
      row.reason = err.message;
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    variant,
    pairToken: pair.address,
    pairSymbol: pair.symbol,
    pairDecimals: pair.decimals,
    usdgFee,
    sells,
    overshootBps: OVERSHOOT_BPS,
    // Per wallet, in ETH, and split so the console can say what each half is for.
    gasReserveEth: formatEther(gasReserve),
    sellReserveEth: formatEther(sellReserve),
    reserveEth: formatEther(reserve),
    count: results.length,
    usable: count('ok'),
    skippedNoEth: count('skipped-no-eth'),
    skippedImpact: count('skipped-impact'),
    skippedDust: count('skipped-dust'),
    failed: count('failed'),
    // A CEILING on what the funding run will spend, not a forecast: it re-sizes
    // its own input from the smaller Buy amounts below and so spends less.
    totalSwapEth: formatEther(totalSwapWei),
    // What the Buy column would add up to, in the pair token. Never added to the
    // ETH figure above — they are different assets and this module never sums
    // across them.
    totalBuyPair: formatUnits(totalBuyRaw, pair.decimals),
    quotedAt: new Date().toISOString(),
    results,
  };
}

module.exports = {
  convertPair,
  planFromBalance,
  approvedPair,
  floorUnits,
  _private: { DEFAULT_SELLS, MAX_SELLS, MAX_PLAN_WALLETS, MAX_ETH_IN, BPS },
};
