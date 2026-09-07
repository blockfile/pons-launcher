'use strict';

// Broadcasts a pons v2 launch and the bundle behind it.
//
//   NATIVE: warm the pool → broadcast the launch → immediately blast every
//   pre-signed buy → collect receipts
//
//   PAIRED (ERC-20 quote asset): warm the pool → check the salt pin →
//   broadcast EVERY approve → ISSUE the launch → blast the buys, and only the
//   buys, WITHOUT waiting for the launch to be acknowledged → collect receipts,
//   the launch's included
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
// WHY THE PAIRED LAUNCH IS NO LONGER AWAITED BEFORE THE BUYS. Moving the
// approves in front bought back a quarter second and left exactly one full RPC
// round trip in the critical path: the `await` on the launch's own broadcast.
// That await buys nothing — no buy reads anything out of the launch's answer,
// because the curve address came from the salt — and it costs the same ~250ms,
// which is 2-3 blocks and, when the launch lands late in a second, the whole
// tax tier. So on the paired path the launch's send is ISSUED and the buys
// follow it immediately; the launch's answer is collected at the end, before
// this function returns, where it is still reported but no longer paid for.
//
// The risk that accepts is an OVERTAKE: one buy's request reaching the
// sequencer before the launch's. It is bounded, and it is asymmetric, and the
// asymmetry is the whole argument:
//
//   PAIRED — the buy carries `value: 0` (evm/v2/curve.js). It calls an address
//   with no contract, which SUCCEEDS on the EVM, moves nothing, and leaves the
//   wallet holding all of its pair tokens. Cost: that wallet's gas and its
//   nonce, and it does not get to buy. Nothing is stranded, no funds are lost.
//
//   NATIVE — the identical buy carries its ETH as value, and paying ETH into a
//   codeless address ALSO succeeds and the ETH IS GONE PERMANENTLY (1.798 ETH,
//   2026-08-13). So the native path is untouched, deliberately: its launch is
//   awaited before a single buy is issued, and nothing on it is reordered. The
//   switch that turns this on (config.v2PairedAsyncLaunch) is not even read on
//   that path — see the note at the branch.
//
// Overtakes are not left to be inferred. Every buy's receipt is compared with
// the launch's by block number and then by transaction index; each buy reports
// which side of the launch it was sequenced on and how many blocks after it
// landed, and the count is raised to the top of the result.
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

// A transaction's position inside its block. ethers v6 calls it `index`; a raw
// JSON-RPC receipt calls it `transactionIndex`. Both are read, and a receipt
// carrying neither reports null rather than 0 — 0 is the strongest possible
// claim about ordering and the one most likely to be wrong.
function txIndexOf(receipt) {
  const i = receipt?.index ?? receipt?.transactionIndex;
  return typeof i === 'number' && Number.isFinite(i) ? i : null;
}

/**
 * WHICH SIDE OF THE LAUNCH A BUY WAS SEQUENCED ON.
 *
 * 'ahead' is the overtake — the buy reached the sequencer first, so it executed
 * against an address that had no contract yet. On the paired path that is a
 * wasted nonce and nothing worse; on the native path it is ETH gone. Either way
 * it is a fact in a receipt, not something to infer from a missing balance.
 *
 * Same block is decided on transaction index, because the block number alone
 * cannot tell a bundle that won its slot from one that jumped the launch.
 */
function sideOfLaunch(buy, launchBlock, launchIndex) {
  if (buy.blockNumber == null || launchBlock == null) return null;
  if (buy.blockNumber !== launchBlock) return buy.blockNumber < launchBlock ? 'ahead' : 'behind';
  if (buy.txIndex == null || launchIndex == null) return 'unknown';
  return buy.txIndex < launchIndex ? 'ahead' : 'behind';
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
      // Which ordering a live run of this plan would take — a paired plan (its
      // buys carry approves) does not wait for the launch's acknowledgement, a
      // native one always does. Reported here so a dry run says which.
      launchAsync: plan.buys.some((b) => b.approve) && config.v2PairedAsyncLaunch,
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

  // ── the launch ────────────────────────────────────────────────────────────
  // THE SWITCH, and the reason it is one.
  //
  // PAIRED: the launch's send is issued and NOT awaited. It was the last full
  // RPC round trip in the critical path (~250ms, 2-3 blocks) and it bought
  // nothing — no buy reads the launch's answer, because prepareV2 got the curve
  // address from the salt. A buy that overtakes the launch here carries value 0,
  // calls a codeless address, moves nothing, and costs its wallet gas and a
  // nonce. No funds are lost, which is why this trade is worth making.
  //
  // NATIVE: awaited, always, and the flag is never consulted. `paired &&` is
  // what makes that unconditional — no environment variable can switch it on.
  // An overtaking native buy pays its ETH into a codeless address, the call
  // SUCCEEDS, and the ETH is unrecoverable: 1.798 ETH on 2026-08-13.
  const asyncLaunch = paired && (deps.asyncPairedLaunch ?? config.v2PairedAsyncLaunch);

  let launchResp = null;
  // Settles into a tagged outcome and NEVER rejects, so a launch that fails
  // while the buys are still going out cannot surface as an unhandled rejection.
  // It is collected — and reported, with the buys that were already sent —
  // below, after the burst.
  let launchSettled = null;
  let launchAckMs = null;

  if (asyncLaunch) {
    launchSettled = rpc.broadcastTransaction(plan.launch.raw).then(
      (resp) => ({ ok: true, resp }),
      (err) => ({ ok: false, err })
    );

    // THE LEAD, and why it is not a sleep. Ordering is decided at the sequencer
    // by arrival, and the only lever left here is how far ahead of the buys the
    // launch's request is handed to the network. Issuing it first already puts
    // it first in the provider's send queue, but by tens of microseconds — the
    // same order as the jitter between two sockets, so on its own it is a weak
    // guarantee. One event-loop turn lets the JSON-RPC drain carrying the launch
    // fire and write before a buy is even serialised, for ~1ms: about 1% of a
    // block and 0.1% of the one-second tax step this whole change exists to win.
    // config caps it at 5ms so it can never grow back into the latency it
    // replaced; 0 issues the buys in the same turn, still strictly after it.
    const lead = deps.launchLeadMs ?? config.v2PairedLaunchLeadMs;
    if (lead > 0) await new Promise((r) => setTimeout(r, lead));
  } else if (approvesSent) {
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
  // The launch is on the wire. On the awaited path this is also the moment its
  // acknowledgement came back; on the async path that lands later and is
  // reported separately as launchAckMs, so the round trip stays measurable.
  const sentMs = Date.now() - t0;

  // Straight into the buys, AND NOTHING BUT THE BUYS. The launch is in flight —
  // on the paired path not even acknowledged yet — and it does not need to be,
  // because the curve address does not depend on anything the launch tells us,
  // nor on anything its RPC answer tells us. On the paired path the approve
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

  // THE ROUND TRIP THAT LEFT THE CRITICAL PATH, COLLECTED. It was taken out of
  // FRONT of the buys, not out of the result: nothing returns from this function
  // until the launch's own broadcast has answered for itself.
  if (launchSettled) {
    const settled = await launchSettled;
    launchAckMs = Date.now() - t0;
    if (!settled.ok) {
      // The one case this change creates that the awaited ordering could not:
      // buys already on the wire behind a launch that never reached the node.
      // Say all of it — what went out, what it cost, and what is NOT true.
      const sent = results.filter((r) => r.status === 'sent');
      const pairLabel = plan.pairSymbol || 'pair';
      throw new Error(
        `the launch FAILED TO BROADCAST: ${rpcMessage(settled.err)}. ${sent.length} bundle buy(s) had ` +
          'ALREADY BEEN SENT — on this ERC-20-quoted path the buys are not held for the launch\'s ' +
          'acknowledgement, which is what wins the block. Those buys carry no ETH (value 0): each called ' +
          'an address with no contract, moved nothing and cost gas only, so NOTHING IS STRANDED and every ' +
          `wallet still holds its ${pairLabel} balance in full. The ${approvesSent} approve(s) that went ` +
          'out ahead of them granted an allowance on a curve that was never created — also harmless. But ' +
          'every one of those wallets HAS MOVED ON A NONCE, so this plan is spent: RE-RUN PREFLIGHT before ' +
          'launching again. Buys already sent: ' +
          (sent.length ? sent.map((r) => `${r.address} ${r.hash}`).join(', ') : 'none')
      );
    }
    launchResp = settled.resp;
  }

  // Only now, with everything on the wire, do we wait for anything.
  const launchReceipt = await awaitReceipt(rpc, launchResp.hash);
  const launch = {
    hash: launchResp.hash,
    status: !launchReceipt ? 'pending' : launchReceipt.status === 1 ? 'confirmed' : 'reverted',
    blockNumber: launchReceipt?.blockNumber ?? null,
    // The launch's own slot in its block — the yardstick every buy below is
    // measured against, so an overtake is read rather than guessed.
    txIndex: txIndexOf(launchReceipt),
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
    r.txIndex = txIndexOf(receipt);
  }

  // ── WHERE EACH BUY LANDED RELATIVE TO THE LAUNCH ──────────────────────────
  // The point of not waiting for the launch's acknowledgement is to land in the
  // launch's own block or the one after it; the risk it takes is landing in
  // FRONT of the launch. Both are read off the receipts here, per wallet, so the
  // operator sees them instead of inferring them from a balance that never
  // arrives. Measured on every path — the native one has no overtakes to find,
  // and if it ever does that is exactly when this has to be visible.
  for (const r of results) {
    r.blocksAfterLaunch =
      r.blockNumber != null && launch.blockNumber != null
        ? r.blockNumber - launch.blockNumber
        : null;
    r.vsLaunch = sideOfLaunch(r, launch.blockNumber, launch.txIndex);
  }
  const ahead = results.filter((r) => r.vsLaunch === 'ahead');

  const sameBlock = results.filter(
    (r) => r.blockNumber != null && r.blockNumber === launch.blockNumber
  ).length;
  // The number this change is judged on: buys in the launch block or the next
  // one (+0/+1). Two blocks is ~0.2s, so unless the launch landed right at the
  // end of a second that is the launch's OWN second — the tier a non-exempt
  // sniper pays 99% in.
  const withinOneBlock = results.filter(
    (r) => r.blocksAfterLaunch === 0 || r.blocksAfterLaunch === 1
  ).length;

  // An overtake is not a rounding detail, so it gets its own line at the top of
  // the result — and a different one per path, because the two cost completely
  // different things and reading the native text on a paired launch would send
  // the operator hunting for money that never moved.
  let overtake = null;
  if (ahead.length) {
    const who = ahead.map((r) => r.address).join(', ');
    if (paired) {
      for (const r of ahead) r.boughtNothing = true;
      overtake =
        `${ahead.length} buy(s) were sequenced AHEAD of the launch (${who}). On this ` +
        `${plan.pairSymbol || 'pair'}-quoted path the buy carries no ETH, so it called an address with ` +
        'no contract, moved nothing and cost gas only — NOTHING IS STRANDED and those wallets still hold ' +
        'their pair balance. But they did NOT buy, and their nonce is spent: do not count them in the ' +
        'bundle, and re-run preflight before trying to buy with them again.';
    } else {
      for (const r of ahead) r.strandSuspected = true;
      overtake =
        `${ahead.length} buy(s) were sequenced AHEAD of the launch (${who}). On the NATIVE path that buy ` +
        'sent its ETH to an address with no contract: the call SUCCEEDED, no tokens were received, and ' +
        'THE ETH IS UNRECOVERABLE. Check these wallets now. The native launch is awaited precisely so ' +
        'this cannot happen, so treat it as a bug in the ordering as well as a loss.';
    }
  }

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
      if (paired) {
        // Not a strand, and saying so matters as much as raising it: the ERC-20
        // buy carries value 0, so there is no money sitting at a codeless
        // address. What IS true is that these wallets bought nothing and spent
        // their nonces.
        for (const r of exposed) r.boughtNothing = true;
        strand =
          `the launch is ${launch.status} but ${exposed.length} buy(s) were broadcast. On this ` +
          `${plan.pairSymbol || 'pair'}-quoted path they carry no ETH, so they cost gas only and STRANDED ` +
          'NOTHING — every wallet still holds its pair balance — but they bought nothing either and their ' +
          'nonces are spent. Re-run preflight before treating this launch as done.';
      } else {
        for (const r of exposed) r.strandSuspected = true;
        strand =
          `the launch is ${launch.status} but ${exposed.length} buy(s) were broadcast — they may have paid ` +
          `into a curve that was never created and stranded. Check these wallets' token balances before ` +
          `treating this launch as done; a "confirmed" buy here does NOT mean it received tokens.`;
      }
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
    // Buys in the launch block or the one after it — the +0/+1 target.
    withinOneBlock,
    // Buys the sequencer put IN FRONT of the launch. On the paired path each is
    // a wallet that burned gas and bought nothing; on the native path each is
    // ETH gone. Zero is the expected value on both.
    overtook: ahead.length,
    confirmed: results.filter((r) => r.status === 'confirmed').length,
    sentMs,
    burstMs,
    // How long the pre-launch approve phase took (0 on the native path, which
    // has none). burstMs - sentMs is the number that decides the launch: the
    // post-launch burst, which is now buys only.
    approveMs,
    // Whether the launch's acknowledgement was taken out of the critical path
    // (paired only — always false for native), and when it finally came back.
    // launchAckMs - sentMs is the round trip this change stopped paying for.
    launchAsync: asyncLaunch,
    ...(launchAckMs != null ? { launchAckMs } : {}),
    ...(mismatch ? { mismatch } : {}),
    ...(strand ? { strand } : {}),
    ...(overtake ? { overtake } : {}),
  };
}

module.exports = { fireV2, recheckLaunch, assertSaltPin, RECHECK_MS };
