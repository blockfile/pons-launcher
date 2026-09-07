'use strict';

// Broadcasts a pons v2 launch and the bundle behind it.
//
//   NATIVE: warm the pool → broadcast the launch → immediately blast every
//   pre-signed buy → collect receipts
//
//   PAIRED (ERC-20 quote asset): warm the pool → check the salt pin →
//   broadcast EVERY approve → broadcast the launch → blast the buys, and only
//   the buys → collect receipts
//
// WHY THE APPROVES MOVED IN FRONT OF THE LAUNCH. The opening snipe tax is
// startBps >> ((elapsed * 14) / window) and it steps on whole wall-clock
// SECONDS: 99.00% at 0s, 6.18% at 1s, 0.19% at 2s, nothing at 3s. Being exempt
// grants no ordering power — only speed puts a bundle in the 99% tier. On the
// paired NVDA launch of record the bundle wallets already held tx indexes 5, 6,
// 8, 10, 11, 12 and 13 in the sniper's own block while he held 17: they were
// sequenced AHEAD of him and spent the slot on `approve` instead of `buy`.
// Every `await broadcastTransaction` is a full round trip (~250ms measured,
// 2-3 blocks at 0.101s), so an approve between the launch and the buy pushed
// every buy a wall-clock quarter-second late for nothing. The approve does not
// need the curve to exist — it is an allowance on the PAIR token naming an
// address — so it can go out before the launch, and now does.
//
// The native path is untouched, deliberately. There the buy carries its ETH as
// value, and a buy that lands before the launch pays into a codeless address,
// SUCCEEDS on the EVM and keeps the money (1.798 ETH, 2026-08-13). Nothing on
// that path is reordered.
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

const SALT_HEX = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * THE SALT PIN — the one check that has to hold before an approve goes out
 * ahead of its launch.
 *
 * A bundle approve names the PREDICTED CURVE as its spender, and that address
 * exists only as a function of the launch salt. prepareV2 mints exactly one
 * salt per call and uses it for the prediction, the factory's own simulation,
 * the launch transaction, the approves and the buys — and /v2/launch prepares
 * and fires in the same request, so nothing can slip between them. That is the
 * design. This is the proof, and it is checked BEFORE the first broadcast:
 *
 *   1. the plan names a real 32-byte salt and a real curve;
 *   2. the SIGNED LAUNCH BYTES decode to that same salt (read out of the
 *      transaction itself, not from a field sitting next to it);
 *   3. every approve records that same salt, and names that same curve.
 *
 * If any of those disagree the approves would grant an allowance on a curve the
 * launch never creates, and every buy behind them would be lost. So this throws
 * and nothing is broadcast. It never repairs, re-derives or guesses a salt.
 *
 * @param {object} plan from prepareV2()
 * @param {{saltFromLaunch: (raw: string) => string}} io the decoder
 */
function assertSaltPin(plan, { saltFromLaunch }) {
  const salt = plan.salt;
  if (typeof salt !== 'string' || !SALT_HEX.test(salt)) {
    throw new Error(
      'the plan carries no 32-byte salt, so the curve its approves name cannot be tied to the launch ' +
        'about to be sent. Nothing was broadcast — re-run preflight.'
    );
  }
  const curve = plan.curve;
  if (typeof curve !== 'string' || !ADDRESS_HEX.test(curve) || /^0x0+$/.test(curve)) {
    throw new Error(
      `the plan's curve address (${String(curve)}) is not usable, so the approves cannot be checked ` +
        'against it. Nothing was broadcast — re-run preflight.'
    );
  }

  let launchSalt;
  try {
    launchSalt = saltFromLaunch(plan.launch.raw);
  } catch (err) {
    throw new Error(
      'the signed launch cannot be read back as a pons v2 launch, so the salt its approves were built ' +
        `against cannot be verified: ${err.message}. Nothing was broadcast — re-run preflight.`
    );
  }
  if (launchSalt.toLowerCase() !== salt.toLowerCase()) {
    throw new Error(
      `SALT MISMATCH — nothing was broadcast. The bundle's approves were built against salt ${salt} ` +
        `(curve ${curve}), but the launch about to be sent carries salt ${launchSalt}. That launch ` +
        'creates a DIFFERENT curve: every approve and every buy would name one that never exists. ' +
        'Re-run preflight.'
    );
  }

  for (const b of plan.buys) {
    if (!b.approve) continue;
    if (typeof b.approve.salt !== 'string' || b.approve.salt.toLowerCase() !== salt.toLowerCase()) {
      throw new Error(
        `SALT MISMATCH — nothing was broadcast. ${b.address}'s approve was built against salt ` +
          `${String(b.approve.salt)}, not this launch's ${salt}. Re-run preflight.`
      );
    }
    if (String(b.approve.spender).toLowerCase() !== curve.toLowerCase()) {
      throw new Error(
        `nothing was broadcast: ${b.address}'s approve names spender ${b.approve.spender}, not the ` +
          `curve ${curve} this plan predicted from salt ${salt}. Re-run preflight.`
      );
    }
  }
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

  // Is this the ERC-20 pair path? Exactly one thing decides it: whether the
  // bundle's buys carry pre-signed approvals. A native buy signs none.
  const paired = plan.buys.some((b) => b.approve);

  // THE SALT PIN. Offline, free, and first — a plan that cannot prove its
  // approves and its launch share one salt must not reach the network at all,
  // not even to warm a socket. It is what makes broadcasting an approve ahead
  // of its launch safe. On the native path there is nothing to pin (no approve
  // is broadcast) and this does not run, so that path cannot be refused by a
  // check it never had.
  if (paired) {
    assertSaltPin(plan, { saltFromLaunch: deps.saltFromLaunch || v2factory.saltFromLaunchTx });
  }

  // Open the sockets before the clock matters. A cold TLS handshake in the
  // middle of the burst costs more than everything else here put together
  // (~131ms measured — 1.3 blocks).
  //
  // THE COUNT IS NOT OPTIONAL. warmPool(count, rpc) does
  // Array.from({length: count}), and Array.from({length: undefined}) is an
  // EMPTY array — so the bare `await warm()` this line used to be opened ZERO
  // sockets while the comment above claimed otherwise. Every socket the burst
  // needs is counted here: one broadcast per buy, a second per buy on the
  // paired path (approve then buy), the dev approve if there is one, and the
  // launch itself.
  const warmCount = plan.buys.length * (paired ? 2 : 1) + (plan.launch.approve ? 1 : 0) + 1;
  try {
    await warm(warmCount, rpc);
  } catch (err) {
    // A warm-up is an optimisation. Never let it stop a launch.
    console.warn(`[pons-launcher] connection warm-up failed: ${err.message}`);
  }

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

  // ── every approve, BEFORE the launch ──────────────────────────────────────
  // The dev's approve(forwarder) sits at the nonce just below the launch, and
  // each bundle wallet's approve(curve) sits at the nonce just below its buy.
  // The sequencer runs a wallet's nonces in order, so both allowances are in
  // place by the time the transaction above them executes; no receipt is
  // awaited for any of them.
  //
  // ALL OF THEM GO OUT AT ONCE, in a single concurrent round trip, for two
  // reasons. It is the shortest possible pre-launch phase, so it telegraphs the
  // least: an approve naming the predicted curve is a public signal, and the
  // window between the first one and the launch is the only warning a watcher
  // gets. And it leaves the post-launch burst holding buys and nothing else —
  // which is the entire point of the change.
  //
  // An approve costs gas and moves no funds, so a wallet whose approve is on
  // the wire when something later aborts has lost nothing but its nonce.
  const approveOutcome = new Array(plan.buys.length).fill(null);
  let devApprove = null;
  let approvesSent = 0;
  let approveMs = 0;
  if (paired || plan.launch.approve) {
    const pending = [];
    if (plan.launch.approve) pending.push({ dev: true, raw: plan.launch.approve.raw });
    plan.buys.forEach((b, i) => {
      if (b.approve) pending.push({ index: i, raw: b.approve.raw });
    });

    const settled = await Promise.allSettled(pending.map((p) => rpc.broadcastTransaction(p.raw)));
    let devError = null;
    settled.forEach((r, k) => {
      const p = pending[k];
      if (p.dev) {
        if (r.status === 'fulfilled') {
          devApprove = { hash: r.value.hash, status: 'sent', nonce: plan.launch.approve.nonce };
        } else {
          devError = r.reason;
        }
        return;
      }
      const { approve } = plan.buys[p.index];
      approveOutcome[p.index] =
        r.status === 'fulfilled'
          ? { nonce: approve.nonce, hash: r.value.hash, status: 'sent' }
          : { nonce: approve.nonce, hash: null, status: 'failed', error: rpcMessage(r.reason) };
      if (r.status === 'fulfilled') approvesSent += 1;
    });
    approveMs = Date.now() - t0;

    if (devError) {
      // A dev approve that will not broadcast leaves the launch at n+1 queued
      // behind a gap it can never fill. Abort loudly rather than send the launch
      // (and the whole bundle) into a hole.
      throw new Error(
        `the dev approve for the ${plan.pairSymbol || 'pair'} launch failed to broadcast, so the ` +
          `launch was NOT sent: ${rpcMessage(devError)}` +
          (approvesSent
            ? `. ${approvesSent} bundle approve(s) had already gone out — they cost gas only and ` +
              'strand nothing, but those wallets have moved on a nonce, so re-run preflight'
            : '')
      );
    }
  }

  let launchResp;
  if (approvesSent) {
    try {
      launchResp = await rpc.broadcastTransaction(plan.launch.raw);
    } catch (err) {
      throw new Error(
        `the launch failed to broadcast after ${approvesSent} bundle approve(s) were already sent: ` +
          `${rpcMessage(err)}. Those wallets granted an allowance on a curve that was never created ` +
          '— gas only, nothing is stranded — but they have moved on a nonce, so re-run preflight ' +
          'before trying again.'
      );
    }
  } else {
    launchResp = await rpc.broadcastTransaction(plan.launch.raw);
  }
  const sentMs = Date.now() - t0;

  // Straight into the buys, AND NOTHING BUT THE BUYS. The launch is in flight,
  // not confirmed — and it does not need to be, because the curve address does
  // not depend on anything the launch tells us. On the paired path the approve
  // that used to sit here, costing every wallet a full round trip after the
  // launch, has already been broadcast above; this loop only reports what
  // happened to it.
  const results = await Promise.all(
    plan.buys.map(async (b, i) => {
      const entry = {
        walletId: b.walletId,
        address: b.address,
        amountEth: b.amountEth,
        nonce: b.nonce,
        exempt: b.exempt,
      };
      // ERC-20 pair: approve(curve) at nonce n went out before the launch, the
      // buy at n+1 goes out now. If the approve would not even broadcast, the
      // buy would sit behind a nonce gap forever, so it is NOT sent.
      if (b.approve) {
        const sent = approveOutcome[i];
        entry.approve = { nonce: sent.nonce, hash: sent.hash, status: sent.status };
        if (sent.status !== 'sent') {
          entry.status = 'failed';
          entry.error = sent.error;
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
    // How long the pre-launch approve phase took (0 on the native path, which
    // has none). burstMs - sentMs is the number that decides the launch: the
    // post-launch burst, which is now buys only.
    approveMs,
    ...(mismatch ? { mismatch } : {}),
    ...(strand ? { strand } : {}),
  };
}

module.exports = { fireV2, recheckLaunch, assertSaltPin, RECHECK_MS };
