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
// over an already-warm connection pool. That is the earliest legal moment, and
// it is still inside the restriction window where every other address is capped
// at maxWalletBps. Pre-signed transactions do not expire, so the wait is free.

const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { evmBlockNumber } = require('../evm/blocknumber');
const { rpcMessage } = require('../evm/errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until the chain's own block.number moves past `launchBlock`.
 *
 * Returns how long it waited, or null when the wait was skipped or the block
 * number could not be read — a bundle that fires late is worth far more than a
 * bundle that does not fire at all, so this never throws.
 */
async function waitForNextBlock(launchBlock, { rpc, readBlock, pause, pollMs, waitMs }) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    let now;
    try {
      now = await readBlock(rpc);
    } catch (err) {
      console.warn(`[pons-launcher] could not read block.number: ${rpcMessage(err)}`);
      return null;
    }
    if (now > launchBlock) return Date.now() - started;
    await pause(pollMs);
  }
  console.warn(
    `[pons-launcher] block.number did not pass ${launchBlock} within ${waitMs}ms — firing anyway`
  );
  return Date.now() - started;
}

/**
 * @param {object} plan from prepare()
 * @param {object} [deps] injectable for tests
 * @returns {Promise<object>} launch + per-wallet results
 */
async function fire(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;

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
  const warm = deps.warmPool || warmPool;
  if (plan.buys.length) {
    try {
      await warm(plan.buys.length, rpc);
    } catch (err) {
      // A warm-up is an optimisation. Never let it stop a launch.
      console.warn(`[pons-launcher] connection warm-up failed: ${err.message}`);
    }
  }

  // 2. The launch. Read block.number first: the launch will execute in this
  //    block, and that is the block the buys must NOT land in.
  const readBlock = deps.evmBlockNumber || evmBlockNumber;
  const pause = deps.sleep || sleep;
  const shouldWait = deps.waitForLaunchBlock ?? config.waitForLaunchBlock;

  let launchBlock = null;
  if (shouldWait && plan.buys.length) {
    try {
      launchBlock = await readBlock(rpc);
    } catch (err) {
      console.warn(`[pons-launcher] could not read block.number before launching: ${rpcMessage(err)}`);
    }
  }

  const launchResp = await rpc.broadcastTransaction(plan.launch.raw);

  // 3. Hold the buys until the block ticks over. Every buy fired inside the
  //    launch block reverts with LaunchBlockBuyBlocked, so this wait is what
  //    makes the difference between a bundle that fills and one that burns gas.
  let waitedMs = null;
  if (launchBlock !== null) {
    waitedMs = await waitForNextBlock(launchBlock, {
      rpc,
      readBlock,
      pause,
      pollMs: config.launchBlockPollMs,
      waitMs: config.launchBlockWaitMs,
    });
  }

  // 4. Every buy at once, over sockets that are already open.
  //
  // Each buy records when the RPC accepted it, measured from the instant the
  // burst began. On a real launch the bundle spread across three RPC blocks —
  // wider than the polling error — and without this there is no way to tell
  // whether that spread is ours (the burst) or the sequencer's (inclusion).
  const burstAt = Date.now();
  const sentMs = new Array(plan.buys.length).fill(null);
  const broadcasts = await Promise.allSettled(
    plan.buys.map((b, i) =>
      rpc.broadcastTransaction(b.raw).then(
        (r) => {
          sentMs[i] = Date.now() - burstAt;
          return r;
        },
        (err) => {
          sentMs[i] = Date.now() - burstAt;
          throw err;
        }
      )
    )
  );

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
        }
      : {
          walletId: b.walletId,
          address: b.address,
          amountEth: b.amountEth,
          hash: null,
          status: 'rejected',
          sentMs: sentMs[i],
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
  };
}

module.exports = { fire };
