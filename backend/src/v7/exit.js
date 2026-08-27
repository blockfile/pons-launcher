'use strict';

/**
 * The end of a V7 run: sell everything, out of every wallet V7 owns.
 *
 * INCLUDING v7main, which is the whole reason this is not v5/sell.js. That module empties
 * BUNDLE wallets. V7's seller is also a holder: it makes the big buy, sells a slice per
 * cycle, and finishes holding whatever the cycles did not need — an exit that swept only
 * the bundle wallets would leave the largest remaining position in the one wallet the
 * operator is most likely to assume was already empty.
 *
 * Three properties carried over from v3/v5/v6's sells, each learned the expensive way:
 *   1. NO SLIPPAGE FLOOR (minOut 0) — the point of the button is that nothing is left
 *      holding tokens; a floor turns a guaranteed exit into a maybe-exit.
 *   2. Each wallet is sold for EXACTLY its balance (bounded approval).
 *   3. A wallet too short of gas is SKIPPED, not attempted — a broadcast approval that
 *      cannot be mined strands the sell queued behind it.
 * One wallet's revert does not stop the others (they are independent).
 *
 * Venue = a flap bonding curve (v7/trade.js), reached through the fixed flap launcher, so
 * the curve is resolved+verified once (provenance + native binding + state), and each sell
 * is the 2-tx flow (a plain approve + swapExactInput) — not v6's 3-tx Permit2 sell.
 */

const { formatEther, formatUnits, getAddress } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v7roles = require('./roles');
const defaultTrade = require('./trade');

// What a wallet must pay before its approval is signed — the two txs trade.sell builds
// (a plain approve + the swapExactInput). One tx lighter than v6's Permit2 sell.
const EXIT_GAS = defaultTrade.ERC20_APPROVE_GAS + defaultTrade.SELL_GAS;
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

/** Every wallet V7 owns that could hold this token: the bundle, and main. */
function holders(ks) {
  const main = ks.walletWithRole(v7roles.ROLES.main);
  return [...(main ? [main] : []), ...v7roles.bundle(ks)];
}

async function readPositions(userId, { token }, deps = {}) {
  const w = wire(deps);
  const ks = w.ks(userId);
  // Resolve + verify the curve ONCE — the provenance dusting guard (throws if the token is
  // not a genuine flap launch, is not native-quoted, or has graduated off the curve).
  const pool = await w.trade.readCurve({ token, quote: 'eth' }, deps);

  // Balances read CONCURRENTLY — one round trip for the whole set, not one per wallet,
  // which is what keeps the exit preview fast once a run has claimed dozens of wallets.
  const list = holders(ks);
  const balances = await Promise.all(list.map((wallet) => w.trade.tokenBalance(token, wallet.address, deps)));
  const wallets = list.map((wallet, i) => ({ wallet, balance: balances[i] }));
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
    venue: pool.venue,
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
 * Sell every V7 wallet's whole balance.
 *
 * @param {boolean} input.confirm required — irreversible, touches every wallet, no floor.
 */
async function run(userId, { token, confirm }, deps = {}) {
  const w = wire(deps);

  if (confirm !== true) {
    throw new Error('the v7 exit is irreversible and has no slippage floor — requires { confirm: true }');
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
        reason: `native ${formatEther(native)} ETH does not cover the approval + the sell (${formatEther(reserve)} ETH gas)`,
      });
      continue;
    }
    sellable.push({ wallet, balance });
  }

  if (!sellable.length) {
    throw new Error('no v7 wallet holds a sellable balance of this token — nothing to sell');
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
    'v7',
    `[v7] exit: sold from ${sold}/${results.length} wallet(s)` +
      (failed ? `, ${failed} failed` : '') +
      (received > 0n ? ` — ${formatEther(received)} ETH` : ''),
    { token, venue: pool.venue, totals, wallets: results, skipped }
  );

  return {
    action: 'v7-exit',
    token: getAddress(token),
    venue: pool.venue,
    minQuoteOut: '0',
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = { preview, run, EXIT_GAS, _private: { holders, readPositions } };
