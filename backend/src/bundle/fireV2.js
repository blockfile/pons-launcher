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

const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const v2factory = require('../evm/v2/factory');
const { waitForReceipt } = require('../evm/receipt');

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
      })),
    };
  }

  if (!plan.launch?.raw) throw new Error('plan has no signed launch');
  const unsigned = plan.buys.filter((b) => !b.raw);
  if (unsigned.length) {
    // Signing here would put key derivation back in the critical path, which is
    // the whole thing this rebuild removed.
    throw new Error(`${unsigned.length} buy(s) are unsigned — re-run preflight`);
  }

  // Open the sockets before the clock matters. A cold TLS handshake in the
  // middle of the burst costs more than everything else here put together.
  await warm();

  const t0 = Date.now();
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
  };

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
    if (r.status !== 'sent') continue;
    const receipt = await awaitReceipt(rpc, r.hash);
    r.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
    r.blockNumber = receipt?.blockNumber ?? null;
  }

  const sameBlock = results.filter(
    (r) => r.blockNumber != null && r.blockNumber === launch.blockNumber
  ).length;

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
  };
}

module.exports = { fireV2 };
