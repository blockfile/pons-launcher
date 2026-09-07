'use strict';

/**
 * THE WAY BACK: a bundle wallet sells the pair token it is holding for its own ETH.
 *
 * THE PROBLEM. swapToPair.js is a one-way door. It makes every bundle wallet buy
 * the launch's quote asset (NVDA / SPCX / AMD …) with its own ETH so the pre-signed
 * paired buys are not dropped by preflight — and then there is no path back. The
 * operator changes the paired asset, abandons the launch, sizes the bundle wrong or
 * simply wants the ETH back, and the pair token sits in 31 wallets that this console
 * has no way to empty. Nothing else in the v1/v2 path sells a pair token: the launch
 * spends it, the exit sells the LAUNCHED token, and a wallet whose launch never
 * happened is holding an asset the console can only look at.
 *
 * This is not hypothetical. The same class of stranding cost real money on the V3
 * tab — a run bonded mid-flight and left a wallet holding 1.75 SPCX the app refused
 * to touch, fixed in 7082041 by letting the exit recover a stranded pair token. That
 * fix is in the V3 engine and reaches only V3's own wallets. This is the same exit
 * ramp for the wallets swapToPair funded, built before it is needed again.
 *
 * IT IS THE MIRROR OF swapToPair, AND DELIBERATELY SO — same module layout, same
 * per-wallet isolation, same refusal-over-half-spend rule, same status vocabulary
 * (`swapped` / `skipped-*` / `failed`), same read-only evm/v3/swaproute for the route
 * itself. Two things are genuinely different, and both are below in full:
 *
 *   1. IT NEEDS AN APPROVE. Native ETH rides into the router as msg.value; an ERC-20
 *      must be pulled by transferFrom, so every wallet broadcasts TWO transactions —
 *      approve(pairToken -> router) at nonce n, then the swap at n+1. swapToPair
 *      broadcasts one.
 *   2. IT PAYS ETH IN RATHER THAN OUT, so the reserve is a different figure. See
 *      exitGasWei.
 *
 * THE IMPACT GUARD, AND WHY THE SELL SIDE IS THE DANGEROUS ONE. The QuoterV2
 * SATURATES instead of reverting on an oversized input (evm/v3/swaproute.js says so
 * at length): it returns approximately the whole pool rather than an error, so a
 * slippage floor sized from that quote is structurally BLIND to a pool-draining
 * trade — it "expects" the drained output and permits it. Only the probe-vs-full
 * comparison in assessSellImpact can refuse it. That matters more here than it did
 * on the buy side, because the recovery case is "sell the ENTIRE balance" and the
 * entire balance of a wallet funded for a big launch is exactly the size that empties
 * a thin pool. A live sweep on 2026-09-07 measured currently-approved pairs at 78.9%
 * (MSTR), 92.2% (SHOP) and 92.9% (TTWO) impact for 3 ETH. A wallet holding the SHOP
 * side of that trade, sold blind, gets back a rounding error. So: refused past
 * config.v3Route.maxImpactBps, per wallet, before anything is signed.
 *
 * A REAL FLOOR, NEVER 0. This is a public AMM, not the curve: an unfloored swap is a
 * sandwich to zero. minOut is the live quote less OVERSHOOT_BPS — swapToPair's own
 * constant, imported rather than restated, because it is the same 3% covering the
 * same block-to-block drift between quote and mine. A fill worse than that reverts,
 * and a reverted swap leaves the wallet holding its pair token, which is the state it
 * was already in. The floor can only cost gas; its absence can cost the position.
 *
 * WHY THERE IS NO EXIT-STYLE WIDE FLOOR HERE. V3's exit deliberately widens its floor
 * because it MUST liquidate — it is unwinding a live position and a failed sell is a
 * position left on a curve. This is not that. Nothing is racing, nothing is half-done,
 * and a wallet that keeps its pair token for another minute has lost nothing. So the
 * floor stays tight, and a wallet whose fill would be bad is a wallet that keeps its
 * tokens rather than one that dumps them.
 *
 * THE GAS. See exitGasWei. It is derived beside swapToPair's reserve, not copied from
 * it, and the two constants it is built from are imported from that module so a change
 * to either moves both directions at once.
 *
 * ORDERING. Like swapToPair, this must not run against an ARMED launch: prepareV2
 * reads each wallet's pending nonce when it signs, and this consumes two nonces per
 * wallet. The route shares the launch lock for exactly that reason. (Selling the pair
 * token out from under an armed launch would also drop the wallet at preflight, which
 * is the same stranding read from the other end.)
 *
 * ISOLATION. One wallet at a time, each awaited to its receipt: they do not compete on
 * the pool, they do not burst the RPC, and one wallet's failure is one wallet's
 * failure. Every target appears in the result with what it held, what it sold, what it
 * got back and why it was skipped if it was. Nothing is sent for a wallet that cannot
 * cover the whole plan.
 */

const { getAddress, parseUnits, formatUnits, formatEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { rpcMessage } = require('../evm/errors');
const { readTokenBalance } = require('../evm/erc20');
const { waitForReceipt } = require('../evm/receipt');
const swaproute = require('../evm/v3/swaproute');
const keystore = require('../wallets/keystore');
const { DEFAULT_VARIANT, bundleWalletsFor } = require('../wallets/variants');
// EVERY shared figure comes from swapToPair rather than being restated here: the
// approval resolution (which is what makes "approved RIGHT NOW" one rule and not
// two), the margin, the fee basis, and the two gas limits the reserve is built
// from. That module was refactored so there is ONE implementation of the reserve
// arithmetic; a second copy in the opposite direction would be the drift it was
// refactored to prevent.
const {
  resolveApprovedPair,
  OVERSHOOT_BPS,
  FEE_BUMP_PCT,
  SWAP_GAS,
  APPROVE_GAS,
} = require('./swapToPair');

const BPS = 10_000n;

// A bundle is at most 31 wallets. 100 bounds the work without ever binding a real
// request — the same bound swapToPair sets, for the same reason. This is a limit on
// WORK, not a money figure: the reserve arithmetic is the thing that must have a
// single implementation, and it is imported above.
const MAX_TARGETS = 100;

/**
 * WHAT A WALLET MUST HOLD IN ETH TO SELL ITS PAIR TOKEN.
 *
 * DERIVED BESIDE swapToPair's gasReserveWei, NOT COPIED FROM IT — and it is a
 * different number on purpose. That reserve holds back three things:
 *
 *   swap gas + (approve + buy) x 2 + config.gasBufferEth
 *
 * of which the last two exist entirely because the wallet is about to be part of a
 * LAUNCH: the approve and curve.buy prepareV2 pre-signs are broadcast later, at
 * launch-time fees nobody can read yet (hence the doubling), and the buffer is the
 * one prepareV2's own preflight demands on top.
 *
 * THIS DIRECTION IS THE WALLET LEAVING THAT LAUNCH. There is no pre-signed approve
 * and buy to hold gas back for — if there were, this run would be racing an armed
 * launch, which the launch lock prevents — and there is no preflight left to satisfy.
 * What remains is exactly the two transactions this module itself broadcasts, now, at
 * today's fees:
 *
 *   approve(pairToken -> SwapRouter02)   APPROVE_GAS
 *   exactInput + unwrapWETH9 multicall   SWAP_GAS
 *
 * Same two constants, same gasCost helper, same FEE_BUMP_PCT basis as the other
 * direction — imported, so a change to either figure moves both. The difference is
 * the absent terms, and that is the whole of it.
 *
 * It is used TWICE and means one thing both times: a wallet holding less ETH than
 * this cannot sell at all (skipped-short), and a balance whose whole quoted proceeds
 * would not cover this is dust that costs more to sell than it returns (skipped-dust).
 *
 * @param {object} fees getFees(FEE_BUMP_PCT)
 * @returns {bigint} wei
 */
function exitGasWei(fees) {
  return gasCost(fees, APPROVE_GAS + SWAP_GAS);
}

/** What a confirmed receipt actually paid in gas, for measuring the ETH that arrived. */
function spentOn(receipt) {
  if (!receipt) return 0n;
  const used = receipt.gasUsed;
  const price = receipt.effectiveGasPrice ?? receipt.gasPrice;
  if (used == null || price == null) return 0n;
  return BigInt(used) * BigInt(price);
}

/**
 * Sell the pair token held by each named bundle wallet, back to native ETH.
 *
 * @param {object} input
 * @param {string} [input.variant]   launcher variant (default v1)
 * @param {string} input.pairToken   the pair token to sell; must be approved NOW
 * @param {Array<{walletId: string, amountPair?: string|number}>} input.targets
 *   `amountPair` is OPTIONAL. OMITTED means sell the wallet's ENTIRE balance — the
 *   recovery case, and the easy one: no amount to get wrong, nothing left behind.
 *   GIVEN means sell exactly that much and leave the rest; a wallet holding less
 *   than that is refused rather than part-sold, because a partial fill of a named
 *   amount is a decision nobody made.
 * @param {boolean} [input.dryRun]   price and check everything, send nothing
 * @param {object} [deps] injected for tests; production uses the real modules
 */
async function swapBundleFromPair(input, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore || keystore;
  const route = deps.route || swaproute;
  const feesFn = deps.getFees || getFees;
  const balanceFn = deps.readTokenBalance || readTokenBalance;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const maxImpactBps = Number(deps.maxImpactBps ?? config.v3Route.maxImpactBps);

  const variant = input.variant || DEFAULT_VARIANT;
  // A dry run in a DRY_RUN deployment is not optional: nothing may ever be sent there.
  const dryRun = Boolean(input.dryRun) || Boolean(deps.dryRun ?? config.dryRun);

  const targets = Array.isArray(input.targets) ? input.targets : null;
  if (!targets || targets.length === 0) throw new Error('targets[] is required');
  if (targets.length > MAX_TARGETS) {
    throw new Error(`targets[] is capped at ${MAX_TARGETS} (got ${targets.length})`);
  }

  // Not an address, the native asset, or a token the factory does not approve RIGHT
  // NOW — all three refuse the whole run before anything is read per wallet. The
  // approval check is the same live one the funding direction makes (never the seed
  // list): a token this launcher would not launch against is not one its wallets
  // should be trading through this endpoint either, and the console's own listing
  // uses the same resolution, so the two agree on what a pair token is.
  const pair = await resolveApprovedPair(input.pairToken, { ...deps, provider: rpc });
  const asPair = (raw) => formatUnits(raw, pair.decimals);

  // WHICH WALLETS — resolved before anything is priced, so a target that is not this
  // launcher's bundle wallet refuses the whole request rather than being discovered
  // halfway through a run that has already sold from other wallets.
  const bundle = bundleWalletsFor(ks, variant);
  const byId = new Map(bundle.map((w) => [w.id, w]));
  const seen = new Set();
  const plan = targets.map((t) => {
    const wallet = byId.get(t.walletId);
    if (!wallet) throw new Error(`${t.walletId} is not a ${variant} bundle wallet`);
    // Two amounts for one wallet is a confused request, and guessing which one was
    // meant would sell on the guess.
    if (seen.has(t.walletId)) throw new Error(`${wallet.address} is named twice in targets[]`);
    seen.add(t.walletId);

    // ABSENT is not zero. An omitted amount is "sell everything", which is the
    // recovery case; a zero or an unparseable one is a mistake and is refused rather
    // than silently promoted to "everything".
    const given = t.amountPair;
    if (given === undefined || given === null || String(given).trim() === '') {
      return { wallet, want: null };
    }
    let want;
    try {
      want = parseUnits(String(given), pair.decimals);
    } catch (_err) {
      throw new Error(`${wallet.address}: "${given}" is not a valid ${pair.symbol} amount`);
    }
    if (want <= 0n) {
      throw new Error(
        `${wallet.address}: amountPair must be positive — omit it entirely to sell the whole balance`
      );
    }
    return { wallet, want };
  });

  // ONE route discovery for the whole run: the fee tier is a property of the pair,
  // not of the wallet. A pair with no funded USDG pool fails here — before a single
  // wallet is touched — rather than 31 times over.
  let usdgFee;
  try {
    usdgFee = await route.discoverPairFee(pair.address, { provider: rpc });
  } catch (err) {
    throw new Error(
      `no ${pair.symbol}->ETH route: ${err.message}. These wallets cannot sell this pair token back to ETH ` +
        'through the router; move it out by hand.'
    );
  }

  const fees = await feesFn(FEE_BUMP_PCT);
  const exitGas = exitGasWei(fees);

  const results = [];
  let totalPairSoldRaw = 0n;
  let totalQuotedWei = 0n;
  let totalReceivedWei = 0n;

  for (const { wallet, want } of plan) {
    const address = getAddress(wallet.address);
    const row = {
      walletId: wallet.id,
      address,
      // null = "the whole balance", which is a different request from an amount and
      // is reported as one rather than as a number the caller never gave.
      askedPair: want === null ? null : asPair(want),
      heldPair: null,
      sellPair: null,
      soldPair: null,
      holdingPair: null,
      quotedEth: null,
      minEth: null,
      receivedEth: null,
      impactBps: null,
      approveHash: null,
      hash: null,
      status: 'failed',
      reason: null,
    };
    results.push(row);

    try {
      const held = BigInt(await balanceFn(pair.address, address));
      row.heldPair = asPair(held);
      row.holdingPair = row.heldPair;

      // NOTHING TO SELL. Named, never silently dropped: the console shows this
      // control precisely because some wallets hold the token, and a wallet that
      // does not is an answer, not an omission.
      if (held <= 0n) {
        row.status = 'skipped-empty';
        row.reason = `holds no ${pair.symbol} — there is nothing to sell`;
        continue;
      }

      // A NAMED AMOUNT IS EXACT. Selling what it happens to hold instead would be a
      // silent re-write of the request, and the operator asked for a number.
      if (want !== null && held < want) {
        row.status = 'skipped-short-pair';
        row.reason =
          `holds ${row.heldPair} ${pair.symbol} but was asked to sell ${row.askedPair} — nothing was sold. ` +
          'Ask for less, or omit the amount to sell the whole balance.';
        continue;
      }

      const sell = want === null ? held : want;
      row.sellPair = asPair(sell);

      // ── THE IMPACT GUARD, and the quote the floor is built from — ONE call. ──
      // The quoter SATURATES rather than reverting on an oversized input, so the
      // minOut floor below is structurally blind to a trade that drains the pool: it
      // would simply "expect" the drained output and permit it. This is the only
      // thing that can refuse it, and on this side of the trade the size being
      // refused is the wallet's whole balance.
      const impact = await route.assessSellImpact(
        { pairToken: pair.address, amountIn: sell, usdgFee },
        { provider: rpc }
      );
      row.impactBps = impact.impactBps;
      const quoted = BigInt(impact.fullOut);
      row.quotedEth = formatEther(quoted);

      if (quoted <= 0n) {
        row.status = 'failed';
        row.reason =
          `the ${pair.symbol}->ETH route quotes nothing for ${row.sellPair} ${pair.symbol} — refusing a ` +
          'floorless swap. Nothing was sold.';
        continue;
      }

      // DUST — worth less than the two transactions it takes to sell it. Measured
      // against the very figure the gas check below uses, so "dust" here means one
      // definite thing: selling it would cost more than it returns.
      if (quoted <= exitGas) {
        row.status = 'skipped-dust';
        row.reason =
          `${row.sellPair} ${pair.symbol} is worth ${row.quotedEth} ETH, less than the ` +
          `${formatEther(exitGas)} ETH of gas the approve + swap would cost — selling it loses money. ` +
          'Nothing was sold.';
        continue;
      }

      // ── can the wallet pay for its own exit? ──
      // This direction PAYS ETH IN, so the only thing it must cover is the approve
      // and the swap themselves. Read once and reused below as the "before" for the
      // received-ETH measurement.
      const before = BigInt(await rpc.getBalance(address));
      if (before < exitGas) {
        row.status = 'skipped-short';
        row.reason =
          `holds ${formatEther(before)} ETH but needs ${formatEther(exitGas)} ETH for the approve and the ` +
          `swap at today's fees. Nothing was sold; send it a little ETH and run this again.`;
        continue;
      }

      if (impact.impactBps > maxImpactBps) {
        row.status = 'skipped-impact';
        row.reason =
          `selling ${row.sellPair} ${pair.symbol} would move the pool ${(impact.impactBps / 100).toFixed(2)}% ` +
          `(max ${maxImpactBps / 100}%) — most of the value would be lost to price impact. Nothing was sold; ` +
          'sell a smaller amount, or leave this wallet holding it.';
        continue;
      }

      // A REAL FLOOR, NEVER 0. The live quote less the same 3% swapToPair sizes its
      // own margin with. A worse fill reverts and the wallet keeps its pair token.
      const minOut = (quoted * (BPS - BigInt(OVERSHOOT_BPS))) / BPS;
      if (minOut <= 0n) {
        row.status = 'failed';
        row.reason = 'the quote is too small to floor — refusing a floorless swap. Nothing was sold.';
        continue;
      }
      row.minEth = formatEther(minOut);

      if (dryRun) {
        row.status = 'would-swap';
        row.reason = `would sell ${row.sellPair} ${pair.symbol} for ≈ ${row.quotedEth} ETH`;
        totalPairSoldRaw += sell;
        totalQuotedWei += quoted;
        continue;
      }

      // BOUNDED at exactly what is being sold, never an infinite approval: the router
      // consumes the whole allowance in the swap that follows it, so a wallet is left
      // with no standing permission for anything to pull its pair token later. The
      // same shape V3's own recovery uses. (A previous attempt whose swap reverted can
      // leave a stale allowance; re-approving over it is legal on every pair token the
      // factory approves, and if it were not, the approve would revert and the wallet
      // would still be holding everything it holds now.)
      const approveTx = route.buildApproveToRouter({ pairToken: pair.address, amount: sell });
      const swapTx = route.buildSwapPairToEth({
        pairToken: pair.address,
        amountIn: sell,
        minOut,
        recipient: address,
        usdgFee,
      });

      let approveHash;
      let hash;
      try {
        // Sequential nonces from ONE read: the swap cannot mine before the approve
        // it depends on, because n+1 cannot be included before n. Re-reading the
        // pending nonce between the two is what collides on a lagging node.
        const nonce = await rpc.getTransactionCount(address, 'pending');
        const signer = ks.signer(wallet.id, rpc);
        approveHash = (
          await signer.sendTransaction({
            to: approveTx.to,
            data: approveTx.data,
            value: 0n,
            nonce,
            gasLimit: APPROVE_GAS,
            ...fees,
          })
        ).hash;
        row.approveHash = approveHash;
        hash = (
          await signer.sendTransaction({
            to: swapTx.to,
            data: swapTx.data,
            value: 0n,
            nonce: nonce + 1,
            gasLimit: SWAP_GAS,
            ...fees,
          })
        ).hash;
      } catch (err) {
        // NO PAIR TOKEN HAS MOVED, whichever of the two threw: only the swap can move
        // it, and the swap is what failed. If the approve did land, all that is left
        // behind is an allowance to the router for exactly this amount, which the next
        // attempt overwrites and then consumes. The wallet's holding is untouched, and
        // `approveHash` is on the row either way so the operator can see what did go
        // out.
        throw new Error(
          `the ${pair.symbol}->ETH swap failed to broadcast: ${rpcMessage(err)}. No ${pair.symbol} was sold.`
        );
      }
      row.hash = hash;

      const receipt = await awaitReceipt(rpc, hash);
      if (!receipt || Number(receipt.status) !== 1) {
        // A reverted swap moved no tokens — the floor did its job, or the allowance
        // did not land. Either way the wallet still holds its pair token and only gas
        // is gone, which is the same state it was in before this ran.
        row.status = 'failed';
        row.reason =
          `the swap reverted — the ${pair.symbol} is still in the wallet (the minOut floor held) and only ` +
          'gas was spent. Try again.';
        continue;
      }

      // WHAT ACTUALLY ARRIVED. The balance delta, gross of the gas both legs paid,
      // so the figure is the swap's own output rather than the output less fees.
      const approveReceipt = await awaitReceipt(rpc, approveHash).catch(() => null);
      const after = BigInt(await rpc.getBalance(address));
      let received = after - before + spentOn(receipt) + spentOn(approveReceipt);
      // The swap enforced amountOutMinimum = minOut, so a CONFIRMED swap paid at
      // least that. A measured delta below it is a balance read lagging the swap's
      // block, not a smaller fill — reporting the lagging figure would understate
      // the recovery.
      if (received < minOut) received = minOut;
      row.receivedEth = formatEther(received);

      const heldAfter = BigInt(await balanceFn(pair.address, address));
      row.holdingPair = asPair(heldAfter);
      const sold = held > heldAfter ? held - heldAfter : 0n;
      row.soldPair = asPair(sold);

      row.status = 'swapped';
      totalPairSoldRaw += sold > 0n ? sold : sell;
      totalReceivedWei += received;
      totalQuotedWei += quoted;
      if (heldAfter >= held) {
        // Confirmed, floor cleared, and the token still reads as held — only
        // reachable when the balance read lags the swap's block. Reported rather
        // than left to look like a wallet that sold nothing, and NOT reported as a
        // failure: the receipt is the authority and it says the swap filled.
        row.reason =
          `the swap confirmed and paid at least ${row.minEth} ETH, but the wallet still reads ` +
          `${row.holdingPair} ${pair.symbol} — the balance read lags the swap's block. Re-read before ` +
          'selling from this wallet again.';
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
    skippedEmpty: count('skipped-empty'),
    skippedShortPair: count('skipped-short-pair'),
    skippedShort: count('skipped-short'),
    skippedImpact: count('skipped-impact'),
    skippedDust: count('skipped-dust'),
    failed: count('failed'),
    // TWO CURRENCIES, EACH NAMED, NEVER SUMMED ACROSS. `totalPairSold` is the pair
    // token at the factory's economics decimals; the two ETH figures are wei-derived.
    totalPairSold: asPair(totalPairSoldRaw),
    // What the pool QUOTED for everything this run would sell or did sell — the
    // figure the console prices a dry run with, and a quote, so it moves.
    totalQuotedEth: formatEther(totalQuotedWei),
    // What actually ARRIVED. Always 0 on a dry run, because nothing was sent.
    totalEthOut: formatEther(totalReceivedWei),
    // The margin every minOut is floored by. Returned so the console can say WHY a
    // swap would revert instead of restating 3% in its own copy of the number.
    overshootBps: OVERSHOOT_BPS,
    // The ETH a wallet must hold to sell at all — the same figure both the
    // skipped-short refusal and the dust test are measured against. Reported so the
    // console can state the refusal with the number that decides it rather than a
    // second guess at it. Reporting only: nothing here reads it back.
    gasReserveEth: formatEther(exitGas),
    results,
  };
}

module.exports = {
  swapBundleFromPair,
  exitGasWei,
  _private: { MAX_TARGETS, OVERSHOOT_BPS, FEE_BUMP_PCT, SWAP_GAS, APPROVE_GAS },
};
