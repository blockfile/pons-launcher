'use strict';

/**
 * The end of a V6 run: sell everything, out of every wallet V6 owns.
 *
 * INCLUDING v6main, which is the whole reason this is not v5/sell.js. That module
 * empties BUNDLE wallets. V6's seller is also a holder: it makes the big buy, sells
 * a slice per cycle, and finishes holding whatever the cycles did not need — an exit
 * that swept only the bundle wallets would leave the largest remaining position in
 * the one wallet the operator is most likely to assume was already empty.
 *
 * Three properties carried over from v3/v5's sells, each learned the expensive way:
 *   1. NO SLIPPAGE FLOOR (minOut 0) — the point of the button is that nothing is
 *      left holding tokens; a floor turns a guaranteed exit into a maybe-exit.
 *   2. Each wallet is sold for EXACTLY its balance (bounded Permit2 approval).
 *   3. A wallet too short of gas is SKIPPED, not attempted — a broadcast approval
 *      that cannot be mined strands the sell queued behind it.
 * One wallet's revert does not stop the others (they are independent).
 *
 * Venue = a letscash Uniswap-V4 pool (v6/trade.js), so the pool is resolved+verified
 * once (per-pool hook), and each sell is the 3-tx Permit2 flow — not v3's two-tx
 * curve sell.
 */

const { formatEther, formatUnits, getAddress } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v6roles = require('./roles');
const defaultTrade = require('./trade');

// What a wallet must pay before its first approval is signed — the three txs
// trade.sell builds (two Permit2 approvals + the execute).
const EXIT_GAS = defaultTrade.ERC20_APPROVE_GAS + defaultTrade.PERMIT2_APPROVE_GAS + defaultTrade.SELL_GAS;
const FEE_BUMP_PCT = defaultTrade.FEE_BUMP_PCT;

function wire(deps = {}) {
  return {
    ks: deps.keystoreForFn || keystoreFor,
    activity: deps.activityForFn || activityFor,
    rpc: deps.rpc || provider,
    trade: deps.trade || defaultTrade,
    getFeesFn: deps.getFeesFn || getFees,
    decimals: deps.decimals ?? 18,
  };
}

/** Every wallet V6 owns that could hold this token: the bundle, and main. */
function holders(ks) {
  const main = ks.walletWithRole(v6roles.ROLES.main);
  return [...(main ? [main] : []), ...v6roles.bundle(ks)];
}

async function readPositions(userId, { token }, deps = {}) {
  const w = wire(deps);
  const ks = w.ks(userId);
  // Resolve + verify the pool ONCE — the provenance dusting guard (throws if the token
  // is not a genuine letscash launch, or has no live pool for the quote).
  const pool = await w.trade.readPool({ token, quote: 'eth' }, deps);

  const wallets = [];
  for (const wallet of holders(ks)) {
    const balance = await w.trade.tokenBalance(token, wallet.address, deps);
    wallets.push({ wallet, balance });
  }
  return { pool, wallets };
}

/** What the exit would sell, per wallet. Reads only. */
async function preview(userId, { token }, deps = {}) {
  const w = wire(deps);
  const { pool, wallets } = await readPositions(userId, { token }, deps);

  const held = wallets.filter((x) => x.balance > 0n);
  const total = held.reduce((sum, x) => sum + x.balance, 0n);

  return {
    token: getAddress(token),
    poolId: pool.poolId,
    hook: pool.hook,
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
 * Sell every V6 wallet's whole balance.
 *
 * @param {boolean} input.confirm required — irreversible, touches every wallet, no floor.
 */
async function run(userId, { token, confirm }, deps = {}) {
  const w = wire(deps);

  if (confirm !== true) {
    throw new Error('the v6 exit is irreversible and has no slippage floor — requires { confirm: true }');
  }

  const { pool, wallets } = await readPositions(userId, { token }, deps);

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
        reason: `native ${formatEther(native)} ETH does not cover the two approvals + the sell (${formatEther(reserve)} ETH gas)`,
      });
      continue;
    }
    sellable.push({ wallet, balance });
  }

  if (!sellable.length) {
    throw new Error('no v6 wallet holds a sellable balance of this token — nothing to sell');
  }

  const results = [];
  for (const { wallet, balance } of sellable) {
    try {
      const out = await w.trade.sell(
        { wallet, token, quote: 'eth', pool, tokensIn: balance },
        { ...deps, keystore: w.ks(userId), rpc: w.rpc, fees }
      );
      results.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        tokens: formatUnits(balance, w.decimals),
        status: out.status,
        sellHash: out.sellHash,
        ethReceived: formatEther(out.ethReceived ?? 0n),
        ethReceivedRaw: (out.ethReceived ?? 0n).toString(),
      });
    } catch (err) {
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
    'v6',
    `[v6] exit: sold from ${sold}/${results.length} wallet(s)` +
      (failed ? `, ${failed} failed` : '') +
      (received > 0n ? ` — ${formatEther(received)} ETH` : ''),
    { token, poolId: pool.poolId, totals, wallets: results, skipped }
  );

  return {
    action: 'v6-exit',
    token: getAddress(token),
    poolId: pool.poolId,
    minQuoteOut: '0',
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = { preview, run, EXIT_GAS, _private: { holders, readPositions } };
