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

module.exports = { fireV2, recheckLaunch, RECHECK_MS };
