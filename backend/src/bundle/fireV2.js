'use strict';

// Broadcasts a pons v2 launch and the bundle behind it.
//
//   warm the pool → broadcast the launch → immediately blast every pre-signed
//   buy → collect receipts
//
// Nothing is signed here and nothing is read from a receipt before the buys go
// out. prepareV2 already knows the curve address, because the live factory
// takes a salt and the deployer predicts what it produces. The earlier version
// of this file had to wait for the launch receipt to learn where to buy; that
// round trip is gone.
//
// There is no launch-block wait. v2 has no equivalent of v1's
// LaunchBlockBuyBlocked, and the bundle wallets are declared snipe-tax exempt
// inside the launch itself — they are the only addresses that can buy at the
// untaxed price during the opening window, so there is nothing to race.

const { Transaction } = require('ethers');
const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const v2factory = require('../evm/v2/factory');
const { waitForReceipt } = require('../evm/receipt');
const zeroexSwap = require('../evm/v2/zeroexSwap');

// A last, HARD-CAPPED re-check that the launch still simulates, run at fire time
// to catch chain state that drifted between preflight and now. It is one
// eth_call, capped at RECHECK_MS: if the node does not answer in time it
// PROCEEDS — the prepare-time estimate already validated this launch, and the
// bundle must never wait on a slow RPC. It aborts ONLY on a definitive revert
// (revert data present); a transient or network error also proceeds.
//
// Crucially it runs BEFORE the launch is broadcast, never between the launch and
// the buys, so it cannot delay the bundle relative to the launch or to a sniper
// — both are gated on the launch landing, which shifts with it.
const RECHECK_MS = 250;

// Is a failed estimate a DEFINITIVE revert (abort the bundle) or a transient
// error (proceed — the bundle must not wait on a flaky node)? Two independent
// signals mean revert, and the check errs toward catching a revert:
//
//   1. ethers classifies an execution revert as CALL_EXCEPTION — including a
//      BARE revert()/require() that carries no data at all. Checking only for
//      revert-data bytes (as this once did) let those through as "transient".
//   2. Revert data can surface in any of several slots depending on the node
//      and the ethers path. This reads the SAME slots explainRevert reads, so
//      the gate can never wave through a revert the decoder would have named.
//
// A network/timeout/rate-limit error is neither CALL_EXCEPTION nor carries
// revert data, so it proceeds — the fire-time check is defense in depth behind
// prepareV2's hard estimate, not the sole guard.
function isDefiniteRevert(err) {
  if (err && err.code === 'CALL_EXCEPTION') return true;
  const data =
    err?.data ||
    err?.info?.error?.data ||
    err?.error?.data ||
    err?.revert?.data ||
    (typeof err?.value === 'string' && err.value.startsWith('0x') ? err.value : null);
  return typeof data === 'string' && data.startsWith('0x') && data.length >= 10;
}

async function recheckLaunch(rpc, tx, explain, { timeoutMs = RECHECK_MS } = {}) {
  // A provider that cannot estimate simply skips the extra check — the bundle is
  // never held up for a capability the node does not offer.
  if (typeof rpc.estimateGas !== 'function') return { ok: true, skipped: true };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: true, timedOut: true }), timeoutMs);
  });
  const check = rpc
    .estimateGas(tx)
    .then(() => ({ ok: true }))
    .catch((err) => (isDefiniteRevert(err) ? { ok: false, reason: explain(err) } : { ok: true, transient: true }));
  const result = await Promise.race([check, timeout]);
  clearTimeout(timer);
  return result;
}

/**
 * @param {object} plan from prepareV2()
 * @param {object} [deps] injectable for tests
 */
async function fireV2(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;
  const parseLaunch = deps.parseLaunch || v2factory.parseLaunch;
  // NOT tx.wait(): that polls at ethers' 4s default, which on a chain making
  // ten blocks a second reports a landed bundle up to forty blocks late.
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const warm = deps.warmPool || warmPool;

  if (dryRun) {
    return {
      simulated: true,
      protocol: 'v2',
      mode: plan.mode,
      token: plan.token,
      curve: plan.curve,
      launch: { address: plan.launch.address, hash: null, status: 'simulated' },
      buys: plan.buys.map((b) => ({
        walletId: b.walletId,
        address: b.address,
        amountEth: b.amountEth,
        status: 'simulated',
        hash: null,
        // Present only on the ERC-20 pair path — a native buy signs no approval.
        ...(b.approve ? { approve: { hash: null, status: 'simulated' } } : {}),
      })),
    };
  }

  // ETH-zap is a wholly separate live flow: the buys are NOT pre-signed (they
  // cannot be — the zap route calls a curve that does not exist until the launch
  // lands), so the "everything is signed" checks below do not apply. Branch here,
  // after the dry-run short-circuit, so the pre-signed native and pair paths that
  // follow are byte-for-byte unchanged.
  if (plan.bundleFunding === 'ethZap') {
    return fireZap(plan, deps);
  }

  if (!plan.launch?.raw) throw new Error('plan has no signed launch');
  // An ERC-20 dev buy carries a pre-signed approve for the forwarder; if it is
  // missing the launchAndBuy would revert on the allowance.
  if (plan.launch.approve && !plan.launch.approve.raw) {
    throw new Error('the dev approve is unsigned — re-run preflight');
  }
  // A buy is unsigned if its own raw is missing, or — on the ERC-20 path — if the
  // approve it depends on is missing. Either way its sell/buy would be stranded.
  const unsigned = plan.buys.filter((b) => !b.raw || (b.approve && !b.approve.raw));
  if (unsigned.length) {
    // Signing here would put key derivation back in the critical path, which is
    // the whole thing this rebuild removed.
    throw new Error(`${unsigned.length} buy(s) are unsigned — re-run preflight`);
  }

  // Open the sockets before the clock matters. A cold TLS handshake in the
  // middle of the burst costs more than everything else here put together.
  await warm();

  // The bounded re-check. Uses the now-warm socket, runs before the launch goes
  // out, and aborts only on a definitive revert — so a launch that turned
  // un-launchable since preflight (config disabled, fee changed, salt taken)
  // never fires its bundle at a curve that will not exist.
  //
  // SKIPPED for an ERC-20 dev buy. Its launch tx is a forwarder launchAndBuy that
  // pulls the pair token via transferFrom, and the dev's approve has not been
  // broadcast yet — so an estimate would revert on the missing allowance every
  // time and abort a perfectly good launch. prepareV2 already validated this
  // launch against the plain launchToken (which needs no allowance) at
  // prepare time, so the fail-safe is not lost; only this redundant fire-time
  // pass is.
  if (!deps.skipRecheck && !plan.launch.needsApprove) {
    let tx = null;
    try {
      const p = Transaction.from(plan.launch.raw);
      tx = { to: p.to, data: p.data, value: p.value, from: p.from };
    } catch (_err) {
      // Unparseable raw — skip the re-check rather than block; prepareV2 already
      // estimated this exact transaction moments ago.
    }
    if (tx) {
      const rc = await recheckLaunch(rpc, tx, deps.explainRevert || v2factory.explainRevert, {
        timeoutMs: deps.recheckMs ?? RECHECK_MS,
      });
      if (!rc.ok) {
        throw new Error(
          `the launch reverts as of now, so nothing was broadcast: ${rc.reason}. ` +
            'State changed since preflight — re-run preflight before launching.'
        );
      }
    }
  }

  const t0 = Date.now();
  // On the ERC-20 dev-buy path the dev's approve(forwarder) is broadcast first,
  // at the nonce just below the launch. The sequencer runs a wallet's nonces in
  // order, so the allowance is in place by the time launchAndBuy executes — the
  // same trick the buy pairs below use. No receipt is awaited between them.
  let devApprove = null;
  if (plan.launch.approve) {
    try {
      const resp = await rpc.broadcastTransaction(plan.launch.approve.raw);
      devApprove = { hash: resp.hash, status: 'sent', nonce: plan.launch.approve.nonce };
    } catch (err) {
      // A dev approve that will not broadcast leaves the launch at n+1 queued
      // behind a gap it can never fill. Abort loudly rather than send the launch
      // (and the whole bundle) into a hole.
      throw new Error(
        `the dev approve for the ${plan.pairSymbol || 'pair'} launch failed to broadcast, so ` +
          `nothing else was sent: ${rpcMessage(err)}`
      );
    }
  }
  const launchResp = await rpc.broadcastTransaction(plan.launch.raw);
  const sentMs = Date.now() - t0;

  // Straight into the buys. The launch is in flight, not confirmed — and it
  // does not need to be, because the curve address does not depend on anything
  // the launch tells us.
  const results = await Promise.all(
    plan.buys.map(async (b) => {
      const entry = {
        walletId: b.walletId,
        address: b.address,
        amountEth: b.amountEth,
        nonce: b.nonce,
        exempt: b.exempt,
      };
      // ERC-20 pair: approve(curve) at nonce n, buy at n+1 — both broadcast
      // without waiting for the approve's receipt, exactly as the sell path does.
      // If the approve will not even broadcast, the buy at n+1 would sit behind a
      // nonce gap forever, so it is NOT sent.
      if (b.approve) {
        entry.approve = { nonce: b.approve.nonce, hash: null, status: 'pending' };
        try {
          const resp = await rpc.broadcastTransaction(b.approve.raw);
          entry.approve.hash = resp.hash;
          entry.approve.status = 'sent';
        } catch (err) {
          entry.approve.status = 'failed';
          entry.status = 'failed';
          entry.error = rpcMessage(err);
          return entry;
        }
      }
      try {
        const resp = await rpc.broadcastTransaction(b.raw);
        entry.hash = resp.hash;
        entry.status = 'sent';
      } catch (err) {
        entry.status = 'failed';
        entry.error = rpcMessage(err);
      }
      return entry;
    })
  );
  const burstMs = Date.now() - t0;

  // Only now, with everything on the wire, do we wait for anything.
  const launchReceipt = await awaitReceipt(rpc, launchResp.hash);
  const launch = {
    hash: launchResp.hash,
    status: !launchReceipt ? 'pending' : launchReceipt.status === 1 ? 'confirmed' : 'reverted',
    blockNumber: launchReceipt?.blockNumber ?? null,
    // The dev's forwarder approve, on the ERC-20 dev-buy path only.
    ...(devApprove ? { approve: devApprove } : {}),
  };
  if (devApprove && devApprove.hash) {
    const ar = await awaitReceipt(rpc, devApprove.hash);
    launch.approve.status = !ar ? 'pending' : ar.status === 1 ? 'confirmed' : 'reverted';
  }

  // The launch's own event is the authority. If it disagrees with what the buys
  // were signed against, every buy went somewhere else, and that has to be said
  // loudly rather than inferred from a confusing balance later.
  let mismatch = null;
  if (launchReceipt && launchReceipt.status === 1) {
    const actual = parseLaunch(launchReceipt);
    if (actual) {
      launch.token = actual.token;
      launch.curve = actual.curve;
      if (actual.curve.toLowerCase() !== String(plan.curve).toLowerCase()) {
        mismatch = `launch created curve ${actual.curve}, but the buys were signed against ${plan.curve}`;
      }
    }
  }

  for (const r of results) {
    // Resolve the approve's receipt too, for an honest per-wallet status on the
    // ERC-20 path. It does not gate the buy (the sequencer already ran it first),
    // it is only reported.
    if (r.approve && r.approve.hash) {
      const ar = await awaitReceipt(rpc, r.approve.hash);
      r.approve.status = !ar ? 'pending' : ar.status === 1 ? 'confirmed' : 'reverted';
    }
    if (r.status !== 'sent') continue;
    const receipt = await awaitReceipt(rpc, r.hash);
    r.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
    r.blockNumber = receipt?.blockNumber ?? null;
  }

  const sameBlock = results.filter(
    (r) => r.blockNumber != null && r.blockNumber === launch.blockNumber
  ).length;

  // A buy can report "confirmed" while having STRANDED. Paying native value into
  // the predicted curve address before — or without — the launch that deploys a
  // contract there SUCCEEDS on the EVM and keeps the ETH; the buy's receipt says
  // status 1. The only reliable tell from here is that the LAUNCH did not
  // confirm while buys went out. Never let "confirmed" imply success in that
  // case: flag every sent buy and raise it to the top of the result, because it
  // is the one outcome the operator must act on and the least visible.
  let strand = null;
  if (launch.status !== 'confirmed') {
    const exposed = results.filter((r) => r.status === 'confirmed' || r.status === 'sent' || r.status === 'pending');
    if (exposed.length) {
      for (const r of exposed) r.strandSuspected = true;
      strand =
        `the launch is ${launch.status} but ${exposed.length} buy(s) were broadcast — they may have paid ` +
        `into a curve that was never created and stranded. Check these wallets' token balances before ` +
        `treating this launch as done; a "confirmed" buy here does NOT mean it received tokens.`;
    }
  }

  return {
    protocol: 'v2',
    mode: plan.mode,
    token: plan.token,
    curve: plan.curve,
    launch,
    buys: results,
    sameBlock,
    confirmed: results.filter((r) => r.status === 'confirmed').length,
    sentMs,
    burstMs,
    ...(mismatch ? { mismatch } : {}),
    ...(strand ? { strand } : {}),
  };
}

/**
 * The ETH-zap fire path.
 *
 *   warm → re-check the plain launch → broadcast the launch → WAIT for it to
 *   confirm → fetch one zap quote per wallet (taker = that wallet) concurrently →
 *   sign each at fire time → broadcast → collect receipts.
 *
 * TWO things make this fundamentally different from the pre-signed path above,
 * and both are inherent to the zap, not choices:
 *
 *   1. The buys wait for the launch. A pre-signed buy is broadcast the instant
 *      the launch is (the curve address is already known); a zap buy cannot be,
 *      because the swap route calls the token's curve and that curve does not
 *      exist until the launch is mined. So there IS a gap here — the bundle is no
 *      longer guaranteed first. The snipe-tax exemption still makes the bundle's
 *      buys untaxed; a non-exempt buyer in the gap pays the decaying opening tax.
 *   2. The buys are signed here. prepareV2 signed nothing for them, so this needs
 *      the keystore. Each wallet's nonce is read AFTER the launch is mined, so the
 *      dev buyer's post-launch nonce is already its launch nonce + 1 with no
 *      special handling.
 *
 * A wallet whose quote fails is skipped with the reason recorded — never an abort
 * of the whole bundle.
 *
 * @param {object} plan from prepareV2() in ethZap mode
 * @param {object} [deps] injectable for tests: { provider, keystore, getZapBuyTx,
 *   waitForZapRoute, waitForReceipt, parseLaunch, warmPool, sleep, explainRevert,
 *   skipRecheck, recheckMs }
 */

// A throttled quote is the endpoint being busy, NOT a missing route — fireZap has
// already waited for the route to exist. These are the shapes the pons zap returns
// under concurrent load (HTTP 409 "No price right now.", an occasional "No route",
// or a 429): retry them with backoff instead of skipping the wallet.
function isThrottleError(message) {
  return /no price right now|no route for that pair|\b429\b|\b409\b|too many|rate.?limit|throttl/i.test(
    String(message || '')
  );
}

// Run `worker` over `items` with at most `limit` in flight at once, preserving
// input order in the results. The zap endpoint throttles concurrent quotes, so
// the buys go through a small pool rather than all at once — this both keeps the
// quotes served and spreads the sends across blocks (less self-competition).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fireZap(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore;
  const getZap = deps.getZapBuyTx || zeroexSwap.getZapBuyTx;
  const waitRoute = deps.waitForZapRoute || zeroexSwap.waitForZapRoute;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const parseLaunch = deps.parseLaunch || v2factory.parseLaunch;
  const warm = deps.warmPool || warmPool;

  if (!ks || typeof ks.signer !== 'function') {
    throw new Error('ETH-zap fire needs a keystore to sign each buy at fire time');
  }
  if (!plan.launch?.raw) throw new Error('plan has no signed launch');

  await warm();

  // The launch is a plain launchToken (no dev buy, no allowance to wait on), so
  // the bounded pre-launch re-check runs exactly as on the native path.
  if (!deps.skipRecheck) {
    let tx = null;
    try {
      const p = Transaction.from(plan.launch.raw);
      tx = { to: p.to, data: p.data, value: p.value, from: p.from };
    } catch (_err) {
      // Unparseable raw — skip the re-check; prepareV2 already estimated this.
    }
    if (tx) {
      const rc = await recheckLaunch(rpc, tx, deps.explainRevert || v2factory.explainRevert, {
        timeoutMs: deps.recheckMs ?? RECHECK_MS,
      });
      if (!rc.ok) {
        throw new Error(
          `the launch reverts as of now, so nothing was broadcast: ${rc.reason}. ` +
            'State changed since preflight — re-run preflight before launching.'
        );
      }
    }
  }

  const t0 = Date.now();
  const launchResp = await rpc.broadcastTransaction(plan.launch.raw);
  const sentMs = Date.now() - t0;

  // The buys CANNOT go out yet: the zap route calls the token's curve, which does
  // not exist until the launch is mined. Wait for the receipt before quoting.
  const launchReceipt = await awaitReceipt(rpc, launchResp.hash);
  const launch = {
    hash: launchResp.hash,
    status: !launchReceipt ? 'pending' : launchReceipt.status === 1 ? 'confirmed' : 'reverted',
    blockNumber: launchReceipt?.blockNumber ?? null,
  };

  const skipAll = (reason) =>
    plan.buys.map((b) => ({
      walletId: b.walletId,
      address: b.address,
      amountEth: b.amountEth,
      exempt: b.exempt,
      ...(b.isDev ? { isDev: true } : {}),
      status: 'skipped',
      reason,
    }));

  // No curve, no buys — and nothing was sent, so nothing can strand.
  if (!launchReceipt || launchReceipt.status !== 1) {
    return {
      protocol: 'v2',
      mode: 'ethZap',
      token: plan.token,
      curve: plan.curve,
      launch,
      buys: skipAll(`launch ${launch.status} — no zap buys attempted (the curve was never created)`),
      confirmed: 0,
      skipped: plan.buys.length,
      sentMs,
      burstMs: Date.now() - t0,
    };
  }

  // The launch event is the authority on where the token is. If it disagrees with
  // the plan, buying would buy the WRONG token — abort the buys and say so.
  let mismatch = null;
  const actual = parseLaunch(launchReceipt);
  if (actual) {
    launch.token = actual.token;
    launch.curve = actual.curve;
    if (actual.curve.toLowerCase() !== String(plan.curve).toLowerCase()) {
      mismatch = `launch created curve ${actual.curve}, but the plan predicted ${plan.curve} — refusing to zap-buy the wrong token`;
    }
  }
  if (mismatch) {
    return {
      protocol: 'v2',
      mode: 'ethZap',
      token: (actual && actual.token) || plan.token,
      curve: plan.curve,
      launch,
      buys: skipAll('curve mismatch — see `mismatch`'),
      confirmed: 0,
      skipped: plan.buys.length,
      sentMs,
      burstMs: Date.now() - t0,
      mismatch,
    };
  }

  const buyToken = (actual && actual.token) || plan.token;
  const slippageBps = Number(plan.slippageBps ?? config.zapSlippageBps);
  const gasLimit = BigInt(plan.zapBuyGas || config.zapBuyGasLimit);
  const chainId = BigInt(plan.chainId || config.chainId);
  // The fees prepareV2 baked (strings), carried with the plan's +25% headroom.
  const fees = plan.fees || {};

  // The curve exists now, but the zap AGGREGATOR does not index a brand-new curve
  // for a beat or two after the launch confirms — so a quote fetched immediately
  // answers "No route for that pair" and every buy is lost, exactly as a live
  // launch showed. Wait for the route to appear (usually a few seconds), THEN
  // quote-and-blast. If it never appears within the budget, no buy could have
  // succeeded anyway — skip them all with the reason rather than firing blind.
  const routeTimeoutMs = Number(plan.zapRouteTimeoutMs ?? config.zapRouteTimeoutMs);
  let routeWaitedMs = null;
  try {
    const r = await waitRoute({ buyToken, slippageBps }, { timeoutMs: routeTimeoutMs });
    routeWaitedMs = r?.waitedMs ?? null;
  } catch (err) {
    return {
      protocol: 'v2',
      mode: 'ethZap',
      token: buyToken,
      curve: (actual && actual.curve) || plan.curve,
      launch,
      buys: skipAll(`zap route never appeared: ${err.message}`),
      confirmed: 0,
      skipped: plan.buys.length,
      sentMs,
      burstMs: Date.now() - t0,
    };
  }

  // Quote-and-send each wallet through a small concurrency pool. The zap endpoint
  // throttles concurrent quotes (blasting all of them at once returns HTTP 409
  // "No price right now." for most), so a bounded number are in flight at a time;
  // a throttled quote is retried with backoff, not skipped, because the route is
  // known to exist. Running them pooled also spreads the sends across blocks,
  // which reduces the self-competition that reverts buys on the fresh curve.
  // A wallet that still cannot be quoted, or whose broadcast fails, affects ONLY
  // itself.
  const sendConcurrency = Number(plan.zapSendConcurrency ?? config.zapSendConcurrency);
  const maxAttempts = Math.max(1, Number(plan.zapQuoteMaxAttempts ?? config.zapQuoteMaxAttempts));
  const backoffMs = Number(plan.zapQuoteBackoffMs ?? config.zapQuoteBackoffMs);

  const buyOne = async (b) => {
    const entry = {
      walletId: b.walletId,
      address: b.address,
      amountEth: b.amountEth,
      exempt: b.exempt,
      ...(b.isDev ? { isDev: true } : {}),
    };

    // Fetch the firm per-taker quote, retrying a throttled response with backoff.
    let zapTx = null;
    let lastErr = 'no route';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        zapTx = await getZap({ buyToken, sellAmountWei: b.amountIn, taker: b.address, slippageBps });
        break;
      } catch (err) {
        lastErr = err.message;
        const retryable = isThrottleError(err.message);
        if (!retryable || attempt === maxAttempts - 1) break;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
    if (!zapTx) {
      entry.status = 'skipped';
      entry.reason = `zap quote failed: ${lastErr}`;
      return entry;
    }

    try {
      const signer = ks.signer(b.walletId, rpc);
      // Read AFTER the launch is mined, so the dev buyer's nonce is already its
      // launch nonce + 1 — no special-casing.
      const nonce = await rpc.getTransactionCount(b.address, 'pending');
      const signable = {
        to: zapTx.to,
        data: zapTx.data,
        value: BigInt(zapTx.value),
        nonce,
        gasLimit,
        chainId,
        ...fees,
      };
      const raw = await signer.signTransaction(signable);
      const resp = await rpc.broadcastTransaction(raw);
      entry.hash = resp.hash;
      entry.nonce = nonce;
      entry.status = 'sent';
      entry.zapTo = zapTx.to;
      entry.zapValue = BigInt(zapTx.value).toString();
    } catch (err) {
      entry.status = 'failed';
      entry.error = rpcMessage(err);
    }
    return entry;
  };

  const results = await mapWithConcurrency(plan.buys, sendConcurrency, buyOne);

  for (const r of results) {
    if (r.status !== 'sent') continue;
    const receipt = await awaitReceipt(rpc, r.hash);
    r.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
    r.blockNumber = receipt?.blockNumber ?? null;
  }
  const burstMs = Date.now() - t0;

  return {
    protocol: 'v2',
    mode: 'ethZap',
    token: buyToken,
    curve: plan.curve,
    launch,
    buys: results,
    confirmed: results.filter((r) => r.status === 'confirmed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    sentMs,
    routeWaitedMs,
    burstMs,
  };
}

module.exports = { fireV2, fireZap, recheckLaunch, RECHECK_MS };
