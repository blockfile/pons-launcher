'use strict';

// Broadcasts a pons v2 launch, then buys the curve it creates.
//
// The shape is forced by the protocol. v1 could fire pre-signed buys the instant
// the launch went out, because the token address was known in advance. v2's
// curve address only exists once the launch is mined, so the sequence is:
//
//   warm the pool → broadcast the launch → await the receipt → read the curve
//   from TokenLaunched → sign every buy → fire them all at once
//
// That costs a receipt round trip, which is the price of not buying a stranger's
// token. Everyone else has to observe the launch before they can react to it, so
// knowing it was coming is still an advantage — just a smaller one.
//
// There is no launch-block wait here: v2 has no LaunchBlockBuyBlocked rule and
// no restriction window. The curve is open the moment it exists.

const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const v2factory = require('../evm/v2/factory');
const { buildBuyTx } = require('../evm/v2/curve');
const { toSignable } = require('./prepareV2');
const { waitForReceipt } = require('../evm/receipt');
const keystore = require('../wallets/keystore');

/**
 * @param {object} plan from prepareV2()
 * @param {object} [deps] injectable for tests
 */
async function fireV2(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const ks = deps.keystore || keystore;
  const dryRun = deps.dryRun ?? config.dryRun;
  const parseLaunch = deps.parseLaunch || v2factory.parseLaunch;
  // NOT launchResp.wait(): that polls at ethers' 4s default, which would leave
  // the bundle forty blocks behind a curve anyone else can already buy.
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const buildBuy = deps.buildBuyTx || buildBuyTx;

  if (dryRun) {
    return {
      simulated: true,
      protocol: 'v2',
      token: null,
      curve: null,
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

  // 1. Open a socket per buy while nothing is racing. The buys go out in one
  //    burst later and a cold pool would make each pay its own TLS handshake.
  const warm = deps.warmPool || warmPool;
  if (plan.buys.length) {
    try {
      await warm(plan.buys.length, rpc);
    } catch (err) {
      console.warn(`[pons-launcher] connection warm-up failed: ${err.message}`);
    }
  }

  // 2. The launch.
  const launchResp = await rpc.broadcastTransaction(plan.launch.raw);
  const launchReceipt = await awaitReceipt(rpc, launchResp.hash);

  const launched = launchReceipt ? parseLaunch(launchReceipt) : null;
  const launchOk = launchReceipt && launchReceipt.status === 1;

  const result = {
    simulated: false,
    protocol: 'v2',
    token: launched ? launched.token : null,
    curve: launched ? launched.curve : null,
    launch: {
      address: plan.launch.address,
      hash: launchResp.hash,
      block: launchReceipt ? launchReceipt.blockNumber : null,
      status: launchOk ? 'confirmed' : 'reverted',
    },
    buys: [],
  };

  // A launch that reverted, or one whose event we could not read, leaves
  // nothing to buy. Never guess at a curve address.
  if (!launchOk || !launched) {
    result.buys = plan.buys.map((b) => ({
      walletId: b.walletId,
      address: b.address,
      amountEth: b.amountEth,
      hash: null,
      status: 'skipped',
      error: launchOk ? 'no TokenLaunched event in the receipt' : 'launch reverted',
    }));
    return result;
  }

  // 3. Sign every buy now that the curve is known. Signing is local and takes
  //    microseconds; it is the receipt above that costs time, not this.
  const nativeQuote = plan.pairToken === '0x0000000000000000000000000000000000000000';
  const signed = [];
  for (const b of plan.buys) {
    try {
      const tx = await buildBuy({
        curveAddress: launched.curve,
        amountIn: BigInt(b.amountIn),
        recipient: b.address,
        minTokensOut: 0n,
        nativeQuote,
      });
      const signer = ks.signer(b.walletId, rpc);
      const raw = await signer.signTransaction(
        toSignable(tx, {
          nonce: b.nonce,
          gasLimit: BigInt(plan.buyGas),
          fees: plan.fees,
          chainId: BigInt(plan.chainId),
        })
      );
      signed.push({ ...b, raw });
    } catch (err) {
      signed.push({ ...b, raw: null, signError: rpcMessage(err) });
    }
  }

  // 4. Every buy at once, over the already-warm sockets.
  const burstAt = Date.now();
  const sentMs = new Array(signed.length).fill(null);
  const broadcasts = await Promise.allSettled(
    signed.map((b, i) => {
      if (!b.raw) return Promise.reject(new Error(b.signError || 'could not sign'));
      return rpc.broadcastTransaction(b.raw).then(
        (r) => {
          sentMs[i] = Date.now() - burstAt;
          return r;
        },
        (err) => {
          sentMs[i] = Date.now() - burstAt;
          throw err;
        }
      );
    })
  );

  const buys = signed.map((b, i) => {
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

  // 5. Collect outcomes.
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

  result.buys = buys;
  result.burstMs = sentMs.filter((m) => m !== null).reduce((a, b) => Math.max(a, b), 0);
  // How far behind the launch the bundle landed, in RPC blocks. v2 has no
  // restriction window, so being in the launch block is a win here rather than
  // the revert it would have been in v1.
  result.sameBlock = launchReceipt
    ? buys.filter((b) => b.block === launchReceipt.blockNumber).length
    : 0;
  return result;
}

module.exports = { fireV2 };
