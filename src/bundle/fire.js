'use strict';

// Broadcasts a prepared bundle: the launch first, then every pre-signed buy as
// fast as the RPC will take them.
//
// The buys go out WITHOUT waiting for the launch receipt. On a FIFO sequencer
// that is what puts them in the same or the very next block. A buy that somehow
// lands before the pool exists simply reverts — that wallet loses gas, not its
// funds — so firing optimistically is strictly better than waiting.

const config = require('../config');
const { provider } = require('../evm/provider');

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

  // 1. The launch. Awaiting the broadcast (not the receipt) guarantees the
  //    sequencer has it before any buy is offered.
  const launchResp = await rpc.broadcastTransaction(plan.launch.raw);

  // 2. Every buy, immediately and concurrently.
  const broadcasts = await Promise.allSettled(
    plan.buys.map((b) => rpc.broadcastTransaction(b.raw))
  );

  const buys = plan.buys.map((b, i) => {
    const r = broadcasts[i];
    return r.status === 'fulfilled'
      ? { walletId: b.walletId, address: b.address, amountEth: b.amountEth, hash: r.value.hash, status: 'sent' }
      : {
          walletId: b.walletId,
          address: b.address,
          amountEth: b.amountEth,
          hash: null,
          status: 'rejected',
          error: r.reason?.shortMessage || r.reason?.message || String(r.reason),
        };
  });

  // 3. Now that everything is in flight, collect outcomes.
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
        b.error = err.shortMessage || err.message;
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
    // How many buys made it into the launch block itself — the number worth
    // watching, since those beat every sniper.
    sameBlock: launchReceipt
      ? buys.filter((b) => b.block === launchReceipt.blockNumber).length
      : 0,
  };
}

module.exports = { fire };
