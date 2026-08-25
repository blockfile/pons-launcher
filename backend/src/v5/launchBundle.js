'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — the COMBINED "Launch + bundle" money path (uniform with the pons v1
// Launcher tab, where launch and bundle are ONE armed action, not two steps).
//
// The pons v1 Launcher fires the launch and every bundle wallet's buy behind a
// single "Launch + bundle" button. v5 was originally split into a Launch step and
// a separate Bundle step; this orchestrator restores the v1 shape for letscash by
// composing the two already-fund-safe paths in the right order:
//
//   1. prepareLaunch + fireLaunch  — the launch, with the launcher's ATOMIC first
//      buy inside the launch tx (the guaranteed-first entry). Signs at preflight,
//      broadcasts at fire, and reads the REAL token / pool / hook back out of the
//      mined receipt. If it reverts or never confirms there is nothing to bundle.
//   2. prepareBundleBuys + fireBundleBuys — the instant the launch confirms, every
//      bundle wallet BUYS the token from the just-created pool with its own ETH.
//
// WHY THIS ORDER, AND WHY IT CANNOT STRAND:
//   The pool does not exist until the launch tx executes, so the bundle buys are
//   signed AGAINST THE REAL, CONFIRMED POOL (its receipt hook is authoritative),
//   never a predicted one — there is no wrong-pool risk the way a pre-signed bundle
//   would carry. Each buy is an independent ETH swap on its own wallet, so a buy
//   that fails strands nothing but its own wallet's ETH (which stays put). And the
//   launch's own guarantees are untouched: a reverted launch created no token and
//   refunds the fee, a lost/pending launch is PARKED by the route exactly as the
//   standalone launch is.
//
// WHY THE LAUNCH IS NEVER DISCARDED FOR A BUNDLE PROBLEM:
//   Once the launch confirms, that success is banked. If the bundle cannot run —
//   the receipt hook was unreadable, the launch was USDG-quoted (per-wallet buys
//   are ETH-only for now), or prepareBundleBuys throws — this returns the confirmed
//   launch with a `bundleSkipped` reason rather than throwing the launch away. The
//   operator then fires the bundle manually from the Bundle step. NEVER let a
//   second-phase failure erase a first-phase success that already spent the fee.
//
// letscash gives bundle wallets NO tax exemption (unlike pons, which declares them
// exempt in the launch), so each bundle buy pays the pool's flat base tax. That is
// visible in the live pool-fee readout; it changes the cost, not the flow.
//
// Everything chain-touching is injectable so the compose logic is exercised fully
// offline (see launchBundle.test.js) — the underlying paths have their own tests.
// ─────────────────────────────────────────────────────────────────────────────

const { getAddress, ZeroAddress } = require('ethers');
const { keystoreFor } = require('../wallets/keystore');
const launchModule = require('./launch');
const buyModule = require('./buy');

/**
 * Fire the launch, then — only if it confirms — fire the per-wallet bundle buys.
 *
 * @param {object} input  the launch input (params, configId, firstBuy/firstBuyEth,
 *                        quote, salt, …) PLUS the bundle: `buys` [{walletId|address,
 *                        amountEth}], optional `slippageBps`, `buyGas`. `confirm`
 *                        is a route-level gate and is ignored here.
 * @param {object} [deps] injectable: { keystore, prepareLaunch, fireLaunch,
 *                        prepareBundleBuys, fireBundleBuys, fireLaunchDeps, fireBuysDeps }.
 * @returns {Promise<{launch, launchPlan, bundle, buyPlan, bundleSkipped}>}
 *   `launch` is fireLaunch's result (confirmed/reverted/pending/dropped). `bundle`
 *   is fireBundleBuys' result, or null when no bundle ran. `bundleSkipped` explains
 *   a null bundle that followed a CONFIRMED launch (so the caller can tell "nothing
 *   to bundle" from "bundle deliberately skipped, fire it manually").
 */
async function launchThenBundle(input = {}, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const prepareLaunchFn = deps.prepareLaunch || launchModule.prepareLaunch;
  const fireLaunchFn = deps.fireLaunch || launchModule.fireLaunch;
  const prepareBuysFn = deps.prepareBundleBuys || buyModule.prepareBundleBuys;
  const fireBuysFn = deps.fireBundleBuys || buyModule.fireBundleBuys;

  // Keep the bundle fields OUT of the launch input: prepareLaunch reads none of
  // them, and passing slippageBps would make it emit a spurious first-buy-floor
  // warning meant for the bundle. `confirm` is the route's gate, not a launch field.
  const { buys: rawBuys, slippageBps, buyGas, confirm, ...launchInput } = input || {};

  // Drop zero / blank buys up front — an all-zero bundle is just a launch. An
  // 'all − gas' entry carries NO amountEth (its size is resolved from the live
  // balance in prepareBundleBuys), so it must be kept, not read as zero — else
  // every all-gas wallet is silently dropped and never buys.
  const buys = (Array.isArray(rawBuys) ? rawBuys : []).filter(
    (b) =>
      b &&
      (String(b.mode || '').toLowerCase() === 'all' ||
        Number(String(b.amountEth ?? b.amount ?? '0').trim() || '0') > 0)
  );

  // ── 1. LAUNCH ──────────────────────────────────────────────────────────────
  const launchPlan = await prepareLaunchFn(launchInput, { keystore: ks });
  const launchResult = await fireLaunchFn(launchPlan, deps.fireLaunchDeps || {});

  const none = { launch: launchResult, launchPlan, bundle: null, buyPlan: null, bundleSkipped: null };

  // A launch that did not confirm (reverted / pending / dropped / dry-run simulated)
  // created no tradeable pool — there is nothing to bundle into. Return launch-only;
  // the route parks a 'pending' launch exactly as the standalone path does.
  if (launchResult.launch?.status !== 'confirmed') return none;

  // Launch-only by choice: no wallet asked to buy.
  if (!buys.length) return none;

  // ── 2. BUNDLE (post-confirm) ─────────────────────────────────────────────────
  // The launch fee + first buy are BANKED now. So NOTHING below may throw past
  // this function: every path — a guard skip, a prepare failure, a fire failure,
  // even a malformed receipt field — must return the CONFIRMED launch with a
  // `bundleSkipped` reason, never discard it (the whole point of this file; see
  // the header). The one try/catch around the entire section is that guarantee,
  // held by construction rather than by the callee's internals happening not to
  // throw. A partial fire (some buys broadcast, then a throw) still reports the
  // launch — the operator finishes from the Bundle tools.
  try {
    // The receipt hook is what pins the exact pool. Without it a buy cannot safely
    // target the pool (config.letscash.hook is only a default, and letscash pools
    // live under several hooks) — skip rather than risk a decoy pool.
    if (!launchResult.hook || launchResult.hookResolved === false) {
      return {
        ...none,
        bundleSkipped:
          'the launch confirmed but its pool hook could not be read from the receipt — fire the bundle ' +
          'buys manually from the Bundle tools once the pool is confirmed on the explorer.',
      };
    }
    // Per-wallet buys are ETH-only for now (a USDG buy needs Permit2, like the
    // sell's input side). A USDG-quoted launch cannot be bundle-bought this way yet.
    const nativeQuote = !launchResult.quote || getAddress(launchResult.quote) === ZeroAddress;
    if (!nativeQuote) {
      return {
        ...none,
        bundleSkipped:
          'this launch is USDG-quoted and per-wallet bundle buys are ETH-only for now — use the untaxed ' +
          'fan-out, or buy manually, from the Bundle tools.',
      };
    }

    // Sign the buys against the REAL launched pool (token + receipt hook), then fire.
    // Hand the buy path the AUTHORITATIVE pool from the launch receipt's Initialize
    // event (exact poolId + full key with the config's real fee/tickSpacing), so it
    // targets the pool this launch actually created instead of re-deriving it from
    // hardcoded values (wrong for a non-default tickSpacing) or probing a pool the
    // RPC hasn't caught up on. Falls back to on-chain resolution if, exceptionally,
    // the receipt carried no Initialize event.
    const pool = launchResult.pool;
    const buyPlan = await prepareBuysFn(
      {
        token: launchResult.token,
        hook: launchResult.hook,
        quote: 'eth',
        buys,
        ...(pool && pool.poolId
          ? {
              poolId: pool.poolId,
              poolKey: {
                currency0: pool.currency0,
                currency1: pool.currency1,
                fee: pool.fee,
                tickSpacing: pool.tickSpacing,
                hooks: pool.hooks,
              },
            }
          : {}),
        ...(slippageBps != null ? { slippageBps } : {}),
        ...(buyGas != null ? { buyGas } : {}),
      },
      { keystore: ks }
    );
    const bundle = await fireBuysFn(buyPlan, deps.fireBuysDeps || {});
    return { launch: launchResult, launchPlan, bundle, buyPlan, bundleSkipped: null };
  } catch (err) {
    // The launch already succeeded and spent the fee — hand it back with the reason
    // the bundle did not complete, never a thrown error that would erase it. The
    // launcher's atomic first buy already gave IT the tokens, so the recovery is to
    // distribute them with the untaxed fan-out in the Bundle tools (a bigger first
    // buy = more to fan out).
    return {
      ...none,
      bundleSkipped:
        `the launch confirmed but the per-wallet buys could not run: ${err.message} ` +
        '— distribute to the wallets with the untaxed fan-out in the Bundle tools instead.',
    };
  }
}

module.exports = { launchThenBundle };
