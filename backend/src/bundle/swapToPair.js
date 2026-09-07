'use strict';

/**
 * PRE-LAUNCH: every bundle wallet buys its OWN pair token with its OWN ETH.
 *
 * THE PROBLEM. A PAIRED v2 launch (NVDA / SPCX / AMD / any approved pair token)
 * denominates the dev buy and every bundle buy in that token, not ETH. The bundle
 * buys are SIGNED BEFORE THE TOKEN EXISTS and broadcast atomically with the launch,
 * so there is no room to swap inside them: a wallet that does not already hold the
 * pair token is dropped by prepareV2's preflight —
 *
 *     0xE6da…4D89: holds 0.0 NVDA, needs 0.029125 NVDA — skipped
 *
 * — and a launch whose every buyer was skipped pays its fee, does the dev buy, and
 * produces a bundle of zero. Until now the only fix was funding 31 wallets with the
 * pair token by hand.
 *
 * WHY THIS IS NOT THE MACHINERY efe1840 REVERTED. That commit removed an ETH→SPCX
 * zap for two specific reasons, and neither applies here:
 *
 *   1. IT WAS FIRE-TIME. The zap tried to swap inside the ~3s snipe window, against
 *      an aggregator that indexes a new curve ~3.6s after launch. This runs BEFORE
 *      the launch is armed. It is not time-critical, it never touches the launch
 *      transaction, and the launch path is byte-for-byte unchanged. It is a funding
 *      step that happens to buy a token instead of sending ETH.
 *   2. IT TRADED A DEAD POOL through a bespoke EthToSpcxSwap.sol against the
 *      pons-managed SPCX pool, whose liquidity was usually zero, so it filled ~0.
 *      This routes through the VERIFIED Uniswap WETH→USDG→pairToken path that V3's
 *      route buys use in production. Measured live on 2026-09-07 at the 3 ETH size:
 *      NVDA 0.01% impact (0.05% tier), SPCX 0.01% (0.05% tier), MSFT 0.03%,
 *      QQQ 0.01%. The pools are deep now.
 *
 *      They are NOT all deep, which is why the impact guard below is not optional:
 *      the same sweep measured MSTR at 78.9%, SHOP at 92.2%, TTWO at 92.9% and UPS
 *      at 34.7% for 3 ETH. Those are real, currently-approved pair tokens.
 *
 * WHY IT IMPORTS evm/v3/swaproute.js RATHER THAN COPYING IT. The project mandates
 * per-tab module ownership (every tab owns its own modules; duplication is the
 * rule). That rule governs STRATEGY under src/<tab>/ — how a tab decides to trade.
 * swaproute.js is not strategy: it lives under evm/, it holds four VERIFIED
 * addresses plus the hop layout of a 2-hop path, and it READS AND BUILDS ONLY (it
 * never signs). A copy of it is a second declaration of where the money goes, and
 * the two would drift the first time a router or a fee tier moves — a divergent
 * copy sends value into the wrong pool silently. It also carries the one piece of
 * knowledge this module cannot survive losing: THE QUOTER SATURATES INSTEAD OF
 * REVERTING on an oversized input, so a slippage floor is structurally blind to a
 * pool-draining trade and only assessImpact can catch it. Duplicating a hazard note
 * is how it gets dropped. So: imported, read-only, nothing under src/v3 touched.
 *
 * SIZING — quoteEthToPair is exact-INPUT and the wallet needs an exact OUTPUT.
 * Sized by quoting a probe for the near-spot rate, scaling, then re-quoting until
 * the quote clears the requirement (price impact makes the linear scale a slight
 * under-estimate, so it converges from below). Then OVERSHOOT_BPS on top.
 *
 * THE MARGIN, AND WHY THE FLOOR IS THE REQUIREMENT ITSELF. The input is sized 3%
 * above what the requirement quotes at, and minOut is set to the requirement (never
 * 0 — this is a public AMM, not the curve). Those two are the same number seen from
 * both ends: the swap is expected to deliver ~103% of what is needed, and it is
 * FLOORED at 100%, so any fill within 3% of the quote succeeds and always leaves
 * the wallet able to make its buy, while a worse fill reverts and the wallet keeps
 * its ETH. 3% is V3's own live route slippage (DEFAULT_ROUTE_SLIPPAGE_BPS) and is
 * two orders of magnitude above the impact measured on the pairs worth launching
 * against, so it is covering block-to-block drift between quote and mine, not
 * depth. Sizing it *below* the requirement would be the real hazard: a wallet left
 * one wei short is a wallet the preflight skips, which is the bug this whole module
 * exists to remove.
 *
 * THE GAS RESERVE. A wallet that swaps every last wei into NVDA is a wallet that
 * cannot then broadcast its own buy, so the swap is refused unless the balance also
 * covers, on top of the swap input:
 *
 *   - the swap's own gas, at today's fees;
 *   - the approve AND the buy prepareV2 will pre-sign for it (a paired buy is two
 *     transactions: approve at nonce n, curve.buy at n+1), at DOUBLE today's fees —
 *     those are broadcast later, at launch time, at whatever the base fee is then,
 *     and a wallet holding the pair token but not the gas to spend it is stranded
 *     in exactly the way this module is meant to prevent;
 *   - config.gasBufferEth, because prepareV2's preflight itself demands
 *     `nativeBalance >= approve+buy gas + buffer` and skips the wallet otherwise.
 *
 * Fees are read at prepareV2's OWN 25% bump (FEE_BUMP_PCT), so the reserve is sized
 * on the same basis the launch will check it against — the reverted module got this
 * right and the note is worth keeping: reserve at a lower basis and the wallet
 * swaps, then fails the launch's under-funded check, with the pair token stranded.
 *
 * ISOLATION. Wallets are processed one at a time, each awaited to its receipt: they
 * do not compete on the pool, they do not burst the RPC, and one wallet's failure
 * is one wallet's failure. Every wallet appears in the result with what it ended up
 * holding, whether it swapped, was skipped, or failed — there is no silent half-done
 * state. NOTHING is sent for a wallet that cannot cover the whole plan; it is
 * refused rather than half-spent.
 *
 * ORDERING. This must run BEFORE the launch is armed. prepareV2 reads each wallet's
 * pending nonce when it signs, so a swap broadcast after arming would consume the
 * nonce the pre-signed approve is holding. The route shares the launch lock.
 */

const { getAddress, parseEther, parseUnits, formatUnits, formatEther, ZeroAddress } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { rpcMessage } = require('../evm/errors');
const { readTokenBalance } = require('../evm/erc20');
const { waitForReceipt } = require('../evm/receipt');
const { resolvePairTokens } = require('../evm/v2/pairTokens');
const swaproute = require('../evm/v3/swaproute');
const keystore = require('../wallets/keystore');
const { DEFAULT_VARIANT, bundleWalletsFor } = require('../wallets/variants');

// The bump prepareV2 signs the launch and its buys at. The reserve held back here
// must be sized at the SAME basis or the wallet passes this check and fails that one.
const FEE_BUMP_PCT = 25;

// Gas figures, matching the paths that will actually spend them:
//   SWAP_GAS    — V3's live route uses this for the identical 2-hop exactInput.
//   APPROVE_GAS — prepareV2's own figure for the approve it pre-signs.
//   the buy     — config.buyGasLimit, which is the limit prepareV2 signs with.
const SWAP_GAS = 450_000n;
const APPROVE_GAS = 100_000n;

// The approve and the buy are broadcast LATER, at launch time, at fees nobody can
// read yet. Reserved at double today's, so a base fee that doubles between funding
// and launch does not strand a wallet holding pair tokens it cannot spend.
const LATER_LEG_FEE_MULT = 2n;

// See "THE MARGIN" above. Identical to V3's DEFAULT_ROUTE_SLIPPAGE_BPS.
const OVERSHOOT_BPS = 300;

// Sizing: 0.001 ETH is the near-spot probe swaproute itself uses for impact, and
// four rounds is far more than the two a monotonic pool needs to converge.
const SIZING_PROBE = 10n ** 15n;
const SIZING_ROUNDS = 4;

// A bundle is at most 31 wallets (the factory's exemption list). 100 bounds the
// work without ever binding a real request.
const MAX_TARGETS = 100;

const BPS = 10_000n;

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * The ETH input whose quote clears `need` of the pair token.
 *
 * quoteEthToPair is exact-INPUT, so this inverts it: take the near-spot rate from a
 * tiny probe, scale linearly to a first guess, then re-quote and scale again. Price
 * impact makes every linear guess an UNDER-estimate, so the sequence approaches the
 * answer from below and stops the moment a quote clears the requirement; the 0.1%
 * nudge keeps a pool whose impact exactly cancels the correction from stalling.
 *
 * It does NOT throw when it cannot reach the target. A pool too shallow to deliver
 * the amount at all is a pool whose impact is enormous, and the caller's impact
 * guard gives a far better account of that than "could not size" does — so this
 * reports `converged: false` with its best (under-)estimate and lets the guard
 * speak first. Assessing impact at an under-estimate only ever UNDER-states it,
 * which is safe here: the under-estimate for a pool that would not converge is
 * already far past the cap.
 *
 * Exported for tests.
 *
 * @returns {Promise<{ethIn: bigint, quotedOut: bigint, rounds: number, converged: boolean}>}
 */
async function sizeEthForPair({ pairToken, need, usdgFee, probeOut: seededProbe }, deps = {}) {
  const rpc = deps.provider || provider;
  const route = deps.route || swaproute;
  const quote = async (amountInWei) =>
    BigInt((await route.quoteEthToPair({ pairToken, amountInWei, usdgFee }, { provider: rpc })).amountOut);

  const want = BigInt(need);
  if (want <= 0n) throw new Error('sizeEthForPair: need must be positive');

  // The near-spot rate is a property of the POOL, not of the wallet, so a caller
  // sizing 31 wallets reads it once and passes it in rather than asking the quoter
  // the identical question 31 times. It only seeds the first guess — every guess is
  // then verified against a real quote at the real size — so a slightly stale seed
  // costs an extra round at worst and can never over-size a swap.
  const probeOut = seededProbe !== undefined ? BigInt(seededProbe) : await quote(SIZING_PROBE);
  if (probeOut <= 0n) {
    throw new Error(`the route quotes no output for ${formatEther(SIZING_PROBE)} ETH — the pool cannot be sized against`);
  }

  let ethIn = ceilDiv(want * SIZING_PROBE, probeOut);
  let quotedOut = await quote(ethIn);
  let rounds = 1;
  while (quotedOut < want && rounds <= SIZING_ROUNDS) {
    // Scale by the shortfall, plus 0.1% so the correction always overshoots the
    // impact it just measured rather than converging asymptotically.
    ethIn = ceilDiv(ethIn * want * 1001n, quotedOut * 1000n);
    quotedOut = await quote(ethIn);
    rounds += 1;
  }
  return { ethIn, quotedOut, rounds, converged: quotedOut >= want };
}

/** The pair token, confirmed APPROVED RIGHT NOW, with the decimals the launch will use. */
async function resolveApprovedPair(pairToken, deps = {}) {
  if (!pairToken) throw new Error('pairToken is required');
  let pair;
  try {
    pair = getAddress(pairToken);
  } catch (_err) {
    throw new Error(`"${pairToken}" is not an address`);
  }
  if (pair === ZeroAddress) {
    throw new Error('a native-ETH launch needs no pair token — its bundle buys are already denominated in ETH');
  }
  // pairTokens.js is the live confirmation, not the seed list: it puts every
  // candidate through approvedPairTokens, so a pair the factory has since
  // un-approved (RIVN was) fails here rather than at launch. Refreshed rather
  // than read from the 5-minute cache, because this one spends money on the answer.
  const resolve = deps.resolvePairTokens || resolvePairTokens;
  const approved = await resolve({ refresh: true, provider: deps.provider });
  const found = approved.find((t) => !t.native && getAddress(t.address) === pair);
  if (!found) {
    throw new Error(
      `${pair} is not an approved pair token right now — the factory would reject a launch against it. ` +
        `Approved: ${approved.filter((t) => !t.native).map((t) => t.symbol).join(', ') || '(none)'}`
    );
  }
  // The FACTORY's economics decimals, not the ERC-20's: the launch reverts
  // PairTokenDecimalsMismatch if they disagree, so that is the number prepareV2
  // parses buy amounts with and therefore the number this must parse them with.
  return { address: pair, symbol: found.symbol, decimals: Number(found.decimals) };
}

/**
 * Make every named bundle wallet hold `amountPair` of the launch's pair token,
 * bought with its own ETH.
 *
 * @param {object} input
 * @param {string} [input.variant]   launcher variant (default v1)
 * @param {string} input.pairToken   the launch's pair token; must be approved NOW
 * @param {Array<{walletId: string, amountPair: string|number}>} input.targets
 *   `amountPair` is what the wallet must END UP holding — the operator's per-wallet
 *   Buy amount, so it is the same number the preflight will demand of it.
 * @param {boolean} [input.dryRun]   price and check everything, send nothing
 * @param {object} [deps] injected for tests; production uses the real modules
 */
async function swapBundleToPair(input, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore || keystore;
  const route = deps.route || swaproute;
  const feesFn = deps.getFees || getFees;
  const balanceFn = deps.readTokenBalance || readTokenBalance;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const buyGas = BigInt(deps.buyGasLimit ?? config.buyGasLimit);
  const bufferEth = String(deps.gasBufferEth ?? config.gasBufferEth);
  const maxImpactBps = Number(deps.maxImpactBps ?? config.v3Route.maxImpactBps);

  const variant = input.variant || DEFAULT_VARIANT;
  // A dry run in a DRY_RUN deployment is not optional: nothing may ever be sent there.
  const dryRun = Boolean(input.dryRun) || Boolean(deps.dryRun ?? config.dryRun);

  const targets = Array.isArray(input.targets) ? input.targets : null;
  if (!targets || targets.length === 0) throw new Error('targets[] is required');
  if (targets.length > MAX_TARGETS) {
    throw new Error(`targets[] is capped at ${MAX_TARGETS} (got ${targets.length})`);
  }

  const pair = await resolveApprovedPair(input.pairToken, { ...deps, provider: rpc });

  // WHICH WALLETS — resolved before anything is priced, so a target that is not
  // this launcher's bundle wallet refuses the whole request instead of being
  // discovered halfway through a run that has already spent ETH.
  const bundle = bundleWalletsFor(ks, variant);
  const byId = new Map(bundle.map((w) => [w.id, w]));
  const seen = new Set();
  const plan = targets.map((t) => {
    const wallet = byId.get(t.walletId);
    if (!wallet) throw new Error(`${t.walletId} is not a ${variant} bundle wallet`);
    // Two amounts for one wallet is a confused request, and guessing which one was
    // meant would spend ETH on the guess.
    if (seen.has(t.walletId)) throw new Error(`${wallet.address} is named twice in targets[]`);
    seen.add(t.walletId);
    let need;
    try {
      need = parseUnits(String(t.amountPair ?? '0'), pair.decimals);
    } catch (_err) {
      throw new Error(`${wallet.address}: "${t.amountPair}" is not a valid ${pair.symbol} amount`);
    }
    if (need <= 0n) throw new Error(`${wallet.address}: amountPair must be positive`);
    return { wallet, need };
  });

  // ONE route discovery for the whole run: the fee tier is a property of the pair,
  // not of the wallet. A pair with no funded USDG pool (USDG itself, for one) fails
  // here — before a single wallet is touched — rather than 31 times over.
  let usdgFee;
  try {
    usdgFee = await route.discoverPairFee(pair.address, { provider: rpc });
  } catch (err) {
    throw new Error(
      `no ETH→${pair.symbol} route: ${err.message}. The bundle cannot buy this pair token with its own ETH; ` +
        'fund the wallets with it directly.'
    );
  }

  // The near-spot rate, read ONCE for the whole run — see sizeEthForPair.
  const probeOut = BigInt(
    (await route.quoteEthToPair({ pairToken: pair.address, amountInWei: SIZING_PROBE, usdgFee }, { provider: rpc }))
      .amountOut
  );
  if (probeOut <= 0n) {
    throw new Error(
      `the ETH→${pair.symbol} route quotes nothing for ${formatEther(SIZING_PROBE)} ETH — the pool is empty. ` +
        'Nothing was sent.'
    );
  }

  const fees = await feesFn(FEE_BUMP_PCT);
  // The swap pays gas now, at these fees. The approve and the buy pay it later, at
  // launch-time fees nobody can read yet — reserved at double. The buffer is
  // prepareV2's own, so a wallet that passes here also passes its preflight.
  const gasReserve =
    gasCost(fees, SWAP_GAS) +
    gasCost(fees, APPROVE_GAS + buyGas) * LATER_LEG_FEE_MULT +
    parseEther(bufferEth);

  const results = [];
  let totalEth = 0n;

  for (const { wallet, need } of plan) {
    const address = getAddress(wallet.address);
    const row = {
      walletId: wallet.id,
      address,
      needPair: formatUnits(need, pair.decimals),
      heldPair: null,
      holdingPair: null,
      swapEth: null,
      receivedPair: null,
      impactBps: null,
      hash: null,
      status: 'failed',
      reason: null,
    };
    results.push(row);

    try {
      const held = BigInt(await balanceFn(pair.address, address));
      row.heldPair = formatUnits(held, pair.decimals);
      row.holdingPair = row.heldPair;

      // ALREADY FUNDED — including a wallet a previous run swapped for. Swapping
      // again would spend ETH to buy a token it already has, and the second buy
      // would sit unused.
      if (held >= need) {
        row.status = 'skipped-already-funded';
        row.reason = `already holds ${row.heldPair} ${pair.symbol}, needs ${row.needPair}`;
        continue;
      }
      // TOP UP THE SHORTFALL, not the whole requirement: a wallet part-funded by
      // hand should not be made to buy what it is already holding.
      const short = need - held;

      const sized = await sizeEthForPair(
        { pairToken: pair.address, need: short, usdgFee, probeOut },
        { provider: rpc, route }
      );
      // The margin. See "THE MARGIN" in the header.
      const ethIn = (sized.ethIn * (BPS + BigInt(OVERSHOOT_BPS))) / BPS;

      // ── can the wallet cover the swap AND everything it still has to pay for? ──
      const balance = BigInt(await rpc.getBalance(address));
      if (balance < ethIn + gasReserve) {
        row.status = 'skipped-short';
        row.reason =
          `holds ${formatEther(balance)} ETH but needs ${formatEther(ethIn + gasReserve)} — ` +
          `${formatEther(ethIn)} to buy ${formatUnits(short, pair.decimals)} ${pair.symbol} plus ` +
          `${formatEther(gasReserve)} reserved for the swap, the launch's approve + buy, and the gas buffer. ` +
          'Nothing was sent; fund it and run this again.';
        continue;
      }

      // ── the impact guard. The quoter SATURATES rather than reverting on an
      // oversized input, so the minOut floor below is structurally blind to a
      // trade that drains a thin pool — it would simply "expect" the drained
      // output and permit it. This is the only thing that can refuse it. ──
      const impact = await route.assessBuyImpact(
        { pairToken: pair.address, amountInWei: ethIn, usdgFee },
        { provider: rpc }
      );
      row.impactBps = impact.impactBps;
      if (impact.impactBps > maxImpactBps) {
        row.status = 'skipped-impact';
        row.reason =
          `${formatEther(ethIn)} ETH would move the ${pair.symbol} pool ${(impact.impactBps / 100).toFixed(2)}% ` +
          `(max ${maxImpactBps / 100}%) — most of the ETH would be lost to price impact. Nothing was sent; ` +
          'reduce this wallet\'s buy amount.';
        continue;
      }

      // Impact was within the cap, so the pool is genuinely deep — a sizing loop
      // that still could not reach the requirement here means the quote is behaving
      // in a way this module does not model. Refuse rather than send a swap whose
      // floor is above what anything quoted.
      if (!sized.converged) {
        row.status = 'failed';
        row.reason =
          `could not size an ETH input that buys ${formatUnits(short, pair.decimals)} ${pair.symbol} ` +
          `after ${sized.rounds} quotes — nothing was sent`;
        continue;
      }

      const fullOut = BigInt(impact.fullOut);
      if (fullOut < short) {
        // The price moved between sizing and this quote by more than the margin.
        // Refuse rather than send a swap whose floor it already cannot clear.
        row.status = 'failed';
        row.reason =
          `the ${pair.symbol} quote moved between sizing and execution (${formatUnits(fullOut, pair.decimals)} < ` +
          `${formatUnits(short, pair.decimals)}) — nothing was sent, try again`;
        continue;
      }

      // A REAL FLOOR, never 0: this is a public AMM. The requirement itself is the
      // floor, so a fill that would leave the wallet unable to make its buy reverts
      // and the ETH stays put.
      const percentFloor = (fullOut * (BPS - BigInt(OVERSHOOT_BPS))) / BPS;
      const minOut = percentFloor > short ? percentFloor : short;

      row.swapEth = formatEther(ethIn);

      if (dryRun) {
        row.status = 'would-swap';
        row.reason = `would spend ${row.swapEth} ETH for ${formatUnits(short, pair.decimals)} ${pair.symbol}`;
        totalEth += ethIn;
        continue;
      }

      const tx = route.buildSwapEthToPair({
        pairToken: pair.address,
        amountInWei: ethIn,
        minOut,
        recipient: address,
        usdgFee,
      });

      let hash;
      try {
        const nonce = await rpc.getTransactionCount(address, 'pending');
        const sent = await ks
          .signer(wallet.id, rpc)
          .sendTransaction({ to: tx.to, data: tx.data, value: tx.value, nonce, gasLimit: SWAP_GAS, ...fees });
        hash = sent.hash;
      } catch (err) {
        throw new Error(`the swap failed to broadcast: ${rpcMessage(err)}`);
      }
      row.hash = hash;

      const receipt = await awaitReceipt(rpc, hash);
      if (!receipt || Number(receipt.status) !== 1) {
        // A reverted swap kept the ETH — the floor did its job. Only gas is gone.
        row.status = 'failed';
        row.reason = 'the swap reverted — the ETH was not spent (the minOut floor held); try again';
        continue;
      }

      totalEth += ethIn;
      const after = BigInt(await balanceFn(pair.address, address));
      row.holdingPair = formatUnits(after, pair.decimals);
      row.receivedPair = formatUnits(after > held ? after - held : 0n, pair.decimals);
      if (after >= need) {
        row.status = 'swapped';
        row.reason = null;
      } else {
        // Confirmed, floor cleared, and still short — only reachable if the balance
        // read lags the swap's block. Reported as its own state rather than as a
        // success, because the launch preflight will skip this wallet.
        row.status = 'swapped-short';
        row.reason =
          `the swap confirmed but the wallet reads ${row.holdingPair} ${pair.symbol} against ${row.needPair} — ` +
          're-read the balance before arming';
      }
    } catch (err) {
      row.status = 'failed';
      row.reason = err.message;
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    variant,
    dryRun,
    pairToken: pair.address,
    pairSymbol: pair.symbol,
    pairDecimals: pair.decimals,
    usdgFee,
    count: results.length,
    swapped: count('swapped'),
    wouldSwap: count('would-swap'),
    swappedShort: count('swapped-short'),
    skippedAlreadyFunded: count('skipped-already-funded'),
    skippedShort: count('skipped-short'),
    skippedImpact: count('skipped-impact'),
    failed: count('failed'),
    totalEth: formatEther(totalEth),
    results,
  };
}

module.exports = {
  swapBundleToPair,
  sizeEthForPair,
  resolveApprovedPair,
  _private: { SWAP_GAS, APPROVE_GAS, OVERSHOOT_BPS, FEE_BUMP_PCT, LATER_LEG_FEE_MULT, MAX_TARGETS },
};
