'use strict';

/**
 * The end of a V3 run: sell everything, out of every wallet V3 owns.
 *
 * INCLUDING v3main, WHICH IS THE WHOLE REASON THIS IS NOT bundle/prepareSell.
 * That module empties BUNDLE wallets — the set a launcher fans supply out to.
 * V3's seller is also a holder: it makes the big buy, sells a slice per cycle,
 * and finishes holding whatever the cycles did not need. An exit that swept
 * only the bundle wallets would leave the largest remaining position sitting in
 * the one wallet the operator is most likely to assume was already empty.
 *
 * The other half of the reason is the isolation rule — V3 does not edit v1's or
 * v2's money paths, and teaching prepareSell about a third wallet set would be
 * exactly that.
 *
 * THREE PROPERTIES CARRIED OVER FROM prepareSell DELIBERATELY, because each was
 * learned the expensive way there:
 *
 *   1. NO SLIPPAGE FLOOR. minQuoteOut is 0 for every wallet. The point of this
 *      button is that nothing is left holding tokens. A floor turns a
 *      guaranteed exit into a maybe-exit.
 *   2. THE APPROVAL IS FOR EXACTLY THE BALANCE, per wallet, so no wallet is
 *      left with a standing allowance to a curve it no longer trades with.
 *   3. A WALLET TOO SHORT OF GAS IS SKIPPED, NOT ATTEMPTED. An approval that is
 *      broadcast and cannot be mined leaves the sell behind it at n+1 stuck for
 *      good.
 *
 * One wallet's revert does not stop the others. This is the opposite of the
 * engine's halt-on-failure rule, and the difference is that the exit's wallets
 * are independent: nothing downstream depends on wallet 3 having sold, so
 * stopping would strand the wallets after it for no gain.
 */

const { formatEther, formatUnits, getAddress } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v3roles = require('./roles');
const defaultTrade = require('./trade');

// What a wallet must be able to pay before its approval is signed. Same two
// transactions trade.sell builds.
const EXIT_GAS = defaultTrade.APPROVE_GAS + defaultTrade.SELL_GAS;
const FEE_BUMP_PCT = defaultTrade.FEE_BUMP_PCT;

function wire(deps = {}) {
  return {
    ks: (deps.keystoreForFn || keystoreFor),
    activity: (deps.activityForFn || activityFor),
    rpc: deps.rpc || provider,
    trade: deps.trade || defaultTrade,
    getFeesFn: deps.getFeesFn || getFees,
    decimals: deps.decimals ?? 18,
  };
}

/** Every wallet V3 owns that could be holding this token: the bundle, and main. */
function holders(ks) {
  const main = ks.walletWithRole(v3roles.ROLES.main);
  return [...(main ? [main] : []), ...v3roles.bundle(ks)];
}

async function readPositions(userId, { token, curve }, deps = {}) {
  const w = wire(deps);
  const ks = w.ks(userId);
  const state = await w.trade.readCurve(curve, deps);

  const wallets = [];
  for (const wallet of holders(ks)) {
    const balance = await w.trade.tokenBalance(token, wallet.address, deps);
    wallets.push({ wallet, balance });
  }
  return { state, wallets };
}

/** What the exit would sell, per wallet. Reads only. */
async function preview(userId, { token, curve }, deps = {}) {
  const w = wire(deps);
  const { state, wallets } = await readPositions(userId, { token, curve }, deps);

  const held = wallets.filter((x) => x.balance > 0n);
  const total = held.reduce((sum, x) => sum + x.balance, 0n);

  return {
    token: getAddress(token),
    curve: getAddress(curve),
    graduated: state.graduated,
    readyToGraduate: state.readyToGraduate,
    minQuoteOut: '0',
    wallets: held.map((x) => ({
      walletId: x.wallet.id,
      address: x.wallet.address,
      role: x.wallet.role,
      tokens: formatUnits(x.balance, w.decimals),
      tokensRaw: x.balance.toString(),
    })),
    walletCount: held.length,
    totalTokens: formatUnits(total, w.decimals),
    totalTokensRaw: total.toString(),
  };
}

/**
 * Sell every V3 wallet's whole balance.
 *
 * @param {object} input
 * @param {boolean} input.confirm required — this is irreversible, touches every
 *   wallet, and has no slippage floor. Same two locks the v1 sell takes.
 */
async function run(userId, { token, curve, confirm }, deps = {}) {
  const w = wire(deps);

  if (confirm !== true) {
    throw new Error(
      'the v3 exit is irreversible and has no slippage floor — requires { confirm: true }'
    );
  }

  const { state, wallets } = await readPositions(userId, { token, curve }, deps);
  if (state.graduated) {
    throw new Error(
      `the curve at ${curve} has graduated — a graduated token trades in a Uniswap v4 pool and ` +
        'cannot be sold here. Sell it manually, or on ponsfamily.com.'
    );
  }

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const reserve = gasCost(fees, EXIT_GAS);

  const skipped = [];
  const sellable = [];
  for (const { wallet, balance } of wallets) {
    if (balance <= 0n) {
      skipped.push({ walletId: wallet.id, address: wallet.address, reason: 'holds none of this token' });
      continue;
    }
    const native = BigInt(await w.rpc.getBalance(wallet.address));
    if (native < reserve) {
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        reason:
          `native balance ${formatEther(native)} ETH does not cover the approval and the sell ` +
          `(${formatEther(reserve)} ETH of gas)`,
      });
      continue;
    }
    sellable.push({ wallet, balance });
  }

  if (!sellable.length) {
    throw new Error('no v3 wallet holds a sellable balance of this token — nothing to sell');
  }

  const results = [];
  for (const { wallet, balance } of sellable) {
    try {
      const out = await w.trade.sell(
        { wallet, curveAddress: curve, token, tokensIn: balance },
        { ...deps, keystore: w.ks(userId), rpc: w.rpc, fees }
      );
      results.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        tokens: formatUnits(balance, w.decimals),
        status: out.status,
        approveHash: out.approveHash,
        sellHash: out.sellHash,
        ethReceived: formatEther(out.ethReceived ?? 0n),
        ethReceivedRaw: (out.ethReceived ?? 0n).toString(),
      });
    } catch (err) {
      // One wallet's failure is not the run's — see the header.
      results.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        tokens: formatUnits(balance, w.decimals),
        status: 'failed',
        error: err?.shortMessage || err?.message || String(err),
        ethReceived: '0.0',
        ethReceivedRaw: '0',
      });
    }
  }

  const sold = results.filter((r) => r.status === 'confirmed').length;
  const failed = results.length - sold;
  const received = results.reduce((sum, r) => sum + BigInt(r.ethReceivedRaw), 0n);
  const totals = {
    wallets: results.length,
    sold,
    failed,
    ethReceived: formatEther(received),
    ethReceivedRaw: received.toString(),
  };

  w.activity(userId).record(
    'v3',
    `[v3] exit: sold from ${sold}/${results.length} wallet(s)` +
      (failed ? `, ${failed} failed` : '') +
      (received > 0n ? ` — ${formatEther(received)} ETH` : ''),
    { token, curve, totals, wallets: results, skipped }
  );

  return {
    action: 'v3-exit',
    token: getAddress(token),
    curve: getAddress(curve),
    minQuoteOut: '0',
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = { preview, run, EXIT_GAS, _private: { holders, readPositions } };
