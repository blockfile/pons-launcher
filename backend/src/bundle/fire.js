'use strict';

// Broadcasts a prepared bundle: the launch, then every pre-signed buy the
// instant they are allowed to land.
//
// Firing the buys immediately after the launch does NOT work, and the reason is
// worth stating plainly because it is the opposite of the intuition:
//
//   PonsLauncherToken._update reverts LaunchBlockBuyBlocked for every
//   pool-to-user buy in the launch block, except the factory's own atomic
//   initial buy. And `block.number` on this chain advances about every 16
//   SECONDS, so "the launch block" is a ~16 second span of wall clock.
//
// A bundle broadcast 20ms behind the launch therefore lands inside the launch
// block and every buy reverts — observed on chain, where the pool's
// TransferHelper masked the reason as the useless string "TF".
//
// So the buys wait for block.number to tick past the launch, then fire at once
// over an already-warm connection pool. That is the earliest legal moment —
// the ban is `block.number == launchBlock`, a strict equality, so launchBlock+1
// is legal and still inside the restriction window where every other address is
// capped at maxWalletBps. Pre-signed transactions do not expire, so the wait is
// free. See blockwait.js for the verified source that proves it.
//
// TIMING. Two launches were lost to competitors by about one RPC block — ~100ms
// — between block.number ticking and our first buy reaching the wire. Every
// stage below is timed against a monotonic clock and reported in `timing` on
// the result, so the next launch can say where those milliseconds went instead
// of guessing: how late we noticed the tick, how long we then took to
// broadcast, and whether the connection pool was still warm when it mattered.

const config = require('../config');
const { provider, warmPool, poolStats } = require('../evm/provider');
const { evmBlockNumber } = require('../evm/blocknumber');
const { rpcMessage } = require('../evm/errors');
const { monotonic, ms, summary } = require('../evm/timing');
const { waitForNextBlock, MAX_IN_FLIGHT } = require('./blockwait');

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

/**
 * Milliseconds from the moment the tick was observed to `pick` of `offsets`,
 * where the offsets are measured from the start of the burst.
 *
 * null when there was no observed tick to measure from — a skipped wait, an
 * unreadable block number, or a wait that timed out — because in those cases
 * the number would be an invitation to compare against a baseline that does not
 * exist.
 */
function sinceTick(wait, burstAt, offsets, pick) {
  const known = offsets.filter((v) => v !== null);
  if (!wait || wait.observedTickMs === null || !known.length) return null;
  return ms(burstAt + pick(...known) - wait.observedTickMs);
}

/**
 * @param {object} plan from prepare()
 * @param {object} [deps] injectable for tests
 * @returns {Promise<object>} launch + per-wallet results
 */
async function fire(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;

  // One monotonic origin for the whole launch. Every *Ms below is milliseconds
  // since this instant, so any two of them can be subtracted directly.
  const now = deps.now || monotonic;
  const origin = now();
  const at = () => now() - origin;
  const sockets = deps.poolStats || poolStats;

  if (dryRun) {
    return {
      simulated: true,
      token: plan.token,
      launch: { address: plan.launch.address, hash: null, status: 'simulated' },
      buys: plan.buys.map((b) => ({
        walletId: b.walletId,
        address: b.address,
        amountEth: b.amountEth,
        hash: null,
        status: 'simulated',
      })),
    };
  }

  // 1. Open one connection per buy first. A cold pool makes every buy pay its
  //    own TLS handshake during the burst; warming costs a few milliseconds
  //    here, before the launch, where nothing is racing yet. A launch cannot be
  //    front-run — the pool does not exist until it lands — so spending time
  //    ahead of it is free, and it buys a much tighter bundle behind it.
  //    One per buy is no longer enough. The wait below keeps up to
  //    MAX_IN_FLIGHT reads of block.number open at any instant, and at the tick
  //    those reads are still holding their sockets — so a pool warmed to
  //    exactly buys.length leaves the last few buys of the burst opening fresh
  //    connections at precisely the moment being optimised. Warm the headroom.
  const warm = deps.warmPool || warmPool;
  const warmCount = plan.buys.length + MAX_IN_FLIGHT;
  const warmStartedMs = at();
  if (plan.buys.length) {
    try {
      await warm(warmCount, rpc);
    } catch (err) {
      // A warm-up is an optimisation. Never let it stop a launch.
      console.warn(`[pons-launcher] connection warm-up failed: ${err.message}`);
    }
  }
  const warmDoneMs = at();
  // Proof, not assumption: how many idle sockets the warm-up actually left in
  // the pool. Compared against the count taken just before the burst below.
  const socketsAfterWarm = sockets();

  // 2. The launch. Read block.number first: the launch will execute in this
  //    block, and that is the block the buys must NOT land in.
  const readBlock = deps.evmBlockNumber || evmBlockNumber;
  const pause = deps.sleep || sleep;
  const shouldWait = deps.waitForLaunchBlock ?? config.waitForLaunchBlock;

  let launchBlock = null;
  // This read is also the earliest observation that still saw the launch block,
  // so it bounds how early the tick could have happened when the wait is short.
  let staleSince = null;
  if (shouldWait && plan.buys.length) {
    const issuedMs = at();
    try {
      launchBlock = await readBlock(rpc);
      const returnedMs = at();
      staleSince = { issuedMs, returnedMs, rttMs: returnedMs - issuedMs };
    } catch (err) {
      console.warn(`[pons-launcher] could not read block.number before launching: ${rpcMessage(err)}`);
    }
  }

  const launchIssuedMs = at();
  const launchResp = await rpc.broadcastTransaction(plan.launch.raw);
  const launchAckMs = at();

  // 3. Hold the buys until the block ticks over. Every buy fired inside the
  //    launch block reverts with LaunchBlockBuyBlocked, so this wait is what
  //    makes the difference between a bundle that fills and one that burns gas.
  let wait = null;
  if (launchBlock !== null) {
    wait = await waitForNextBlock(launchBlock, {
      rpc,
      readBlock,
      pause,
      now,
      originMs: origin,
      staleSince,
      pollMs: deps.pollMs ?? config.launchBlockPollMs,
      waitMs: deps.waitMs ?? config.launchBlockWaitMs,
    });
  }
  const waitedMs = wait ? wait.waitedMs : null;

  // 4. Every buy at once, over sockets that are already open.
  //
  // Each buy records when the RPC accepted it, measured from the instant the
  // burst began. On a real launch the bundle spread across three RPC blocks —
  // wider than the polling error — and without this there is no way to tell
  // whether that spread is ours (the burst) or the sequencer's (inclusion).
  //
  // `issuedMs` is new alongside it: the gap between issuing a broadcast and it
  // being accepted is a round trip, but the gap between the burst starting and
  // a broadcast being ISSUED is ours — event-loop time, or ethers serialising
  // behind a socket that has to be re-opened. Only the second kind is fixable
  // from here, so the two are measured apart.
  const socketsBeforeBurst = sockets();
  const burstAt = at();
  const sentMs = new Array(plan.buys.length).fill(null);
  const issuedMs = new Array(plan.buys.length).fill(null);
  const broadcasts = await Promise.allSettled(
    plan.buys.map((b, i) => {
      issuedMs[i] = ms(at() - burstAt);
      return rpc.broadcastTransaction(b.raw).then(
        (r) => {
          sentMs[i] = ms(at() - burstAt);
          return r;
        },
        (err) => {
          sentMs[i] = ms(at() - burstAt);
          throw err;
        }
      );
    })
  );
  const burstDoneMs = at();

  const buys = plan.buys.map((b, i) => {
    const r = broadcasts[i];
    return r.status === 'fulfilled'
      ? {
          walletId: b.walletId,
          address: b.address,
          amountEth: b.amountEth,
          hash: r.value.hash,
          status: 'sent',
          sentMs: sentMs[i],
          issuedMs: issuedMs[i],
        }
      : {
          walletId: b.walletId,
          address: b.address,
          amountEth: b.amountEth,
          hash: null,
          status: 'rejected',
          sentMs: sentMs[i],
          issuedMs: issuedMs[i],
          error: rpcMessage(r.reason),
        };
  });

  // 5. Now that everything is in flight, collect outcomes.
  const launchReceipt = await launchResp.wait();
  await Promise.allSettled(
    buys.map(async (b) => {
      if (!b.hash) return;
      try {
        const receipt = await rpc.waitForTransaction(b.hash);
        b.status = receipt && receipt.status === 1 ? 'confirmed' : 'reverted';
        b.block = receipt ? receipt.blockNumber : null;
      } catch (err) {
        b.status = 'unknown';
        b.error = rpcMessage(err);
      }
    })
  );

  return {
    simulated: false,
    token: plan.token,
    launch: {
      address: plan.launch.address,
      hash: launchResp.hash,
      block: launchReceipt ? launchReceipt.blockNumber : null,
      status: launchReceipt && launchReceipt.status === 1 ? 'confirmed' : 'reverted',
    },
    buys,
    // How long the bundle was held for block.number to tick past the launch.
    // null means the wait was skipped or block.number could not be read.
    waitedMs,
    launchBlockNumber: launchBlock === null ? null : launchBlock.toString(),
    // How long the whole burst took to be accepted, end to end. If this is a
    // few milliseconds and the buys still land in different blocks, the spread
    // is the sequencer's and no client change will close it.
    burstMs: sentMs.filter((m) => m !== null).reduce((a, b) => Math.max(a, b), 0),
    // How many buys landed in the same RPC block as each other — a measure of
    // how tightly the bundle held together, NOT of beating anyone: landing in
    // the launch block is a revert, not a win.
    sameBlock: launchReceipt
      ? buys.filter((b) => b.block === launchReceipt.blockNumber).length
      : 0,

    // Where the milliseconds went. Everything above is unchanged; this is
    // additive, and it exists because losing a launch by ~100ms twice is not
    // something that can be fixed from a burstMs alone.
    //
    // The headline number is `tickToWireMs`: from the instant we learned
    // block.number had ticked to the instant the first buy left this process.
    // That is the only part of the gap this code controls. `wait.detectionLagMs`
    // is the part BEFORE it — how long the tick had already been true while we
    // were still between polls — and the two together are our lateness.
    timing: {
      startedAt: new Date(deps.epochNow ? deps.epochNow() : Date.now()).toISOString(),
      warm: { startedMs: ms(warmStartedMs), doneMs: ms(warmDoneMs), tookMs: ms(warmDoneMs - warmStartedMs) },
      launchBlockRead: staleSince
        ? { issuedMs: ms(staleSince.issuedMs), returnedMs: ms(staleSince.returnedMs), rttMs: ms(staleSince.rttMs) }
        : null,
      launchBroadcast: {
        issuedMs: ms(launchIssuedMs),
        ackMs: ms(launchAckMs),
        rttMs: ms(launchAckMs - launchIssuedMs),
      },
      wait,
      burst: {
        startedMs: ms(burstAt),
        doneMs: ms(burstDoneMs),
        // Issuing is ours; acking is the network's. Split so the next change
        // can be aimed at whichever one is actually costing the block.
        issued: summary(issuedMs.filter((v) => v !== null)),
        acked: summary(sentMs.filter((v) => v !== null)),
      },
      // Tick observed → first buy on the wire. This is the recoverable part.
      tickToWireMs: sinceTick(wait, burstAt, issuedMs, Math.min),
      // Tick observed → last buy acknowledged, i.e. the whole tail.
      tickToLastAckMs: sinceTick(wait, burstAt, sentMs, Math.max),
      // warmPool's claim, checked. If `beforeBurst.free` has collapsed relative
      // to `afterWarm.free`, the pool went cold during the wait and the burst
      // paid handshakes it was supposed to have avoided.
      sockets: { afterWarm: socketsAfterWarm, beforeBurst: socketsBeforeBurst },
    },
  };
}

module.exports = { fire };
