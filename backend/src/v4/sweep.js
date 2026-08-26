'use strict';

/**
 * Gathering ETH back out of V4's wallets, to a super-main.
 *
 * After a run, ETH sits scattered across the funding wallets (a campaign's leftover) and
 * the seed wallets (their small funded balances). This gathers a CHOSEN set of them —
 * funding wallets, seeds, and/or withdrawn seeds — to a super-main the operator names.
 *
 * IT GOES THROUGH RELAY, NEVER DIRECT, AND THAT IS THE WHOLE POINT. V4 exists so a seed
 * wallet has NO on-chain link to the operator's other wallets — Relay broke that link
 * when the seed was funded. A direct seed → super-main sweep would draw the link back,
 * on-chain, retroactively: anyone reading the chain would see the seasoned wallet
 * funnelling into the super-main, and the wallet's whole value — that it looks unrelated —
 * is gone. So every hop here is a Relay order; there is deliberately no direct path, and
 * the test asserts it.
 *
 * That costs a Relay fee + gas per wallet, which is why the dust floor exists: a seed
 * holding 0.0005 ETH cannot be moved for less than it holds, so it is skipped and named
 * rather than sent at a loss. In practice this recovers the FUNDING wallets' leftovers;
 * most seed balances are dust and are skipped.
 *
 * The DESTINATION is a funding wallet the caller names (the console offers the super-mains).
 * It is excluded from the sources so it never sweeps into itself. One wallet's failure
 * does not stop the others.
 *
 * Venue-independent (it moves ETH, not tokens), so it is a near-clone of v3/v6 sweep —
 * V4 owns its own copy per the isolation rule.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v4roles = require('./roles');
const { storeFor } = require('./store');
const defaultRelay = require('./relay');

const DEPOSIT_GAS = 50_000n; // a Relay deposit is a plain value send
const RELAY_FEE_PCT = 3; // held back for Relay's sender-side fee
const FEE_BUMP_PCT = 25;
const DEFAULT_MIN_SWEEP_ETH = '0.002'; // below this the fee+gas eat the balance

// The wallet groups a gather can pull from. 'funding' is the masters (minus the
// destination); 'seeds' is every seed; 'withdrawn' is the seeds set aside from the pool.
const CATEGORIES = ['funding', 'seeds', 'withdrawn'];

function wire(deps = {}) {
  return {
    ksFor: deps.keystoreForFn || keystoreFor,
    storeForFn: deps.storeForFn || storeFor,
    activity: deps.activityForFn || activityFor,
    rpc: deps.rpc || provider,
    relay: deps.relay || defaultRelay,
    getFeesFn: deps.getFeesFn || getFees,
  };
}

/**
 * Which wallets a gather empties, for the chosen categories, deduped and never
 * including the destination. Pure over its inputs.
 */
function resolveSources(ks, store, { categories, destinationId, busyMasterIds = new Set() }) {
  const want = new Set(categories);
  const seen = new Map(); // id -> wallet, so a seed that is both 'seeds' and 'withdrawn' is one entry
  const add = (wallet) => {
    if (wallet && wallet.id !== destinationId && !seen.has(wallet.id)) seen.set(wallet.id, wallet);
  };

  // A funder that is the source of a LIVE campaign is holding ETH earmarked for its
  // remaining drips — sweeping it would starve the campaign, so it is never a source.
  if (want.has('funding')) for (const w of v4roles.masters(ks)) if (!busyMasterIds.has(w.id)) add(w);
  if (want.has('seeds')) for (const w of v4roles.seeds(ks)) add(w);
  if (want.has('withdrawn')) {
    const wd = store.withdrawnSeedIds();
    for (const w of v4roles.seeds(ks)) if (wd.has(w.id)) add(w);
  }
  return [...seen.values()];
}

async function plan(userId, { destinationId, categories = ['funding'], minSweepEth } = {}, deps = {}) {
  const w = wire(deps);
  const ks = w.ksFor(userId);
  const store = w.storeForFn(userId);

  const cats = (Array.isArray(categories) ? categories : [categories]).filter((c) => CATEGORIES.includes(c));
  if (!cats.length) throw new Error(`categories must include one of ${CATEGORIES.join(', ')}`);

  // The destination is a funding wallet (the console offers the super-mains). It must
  // exist and be a v4master — never a seed, and never another tab's wallet.
  const to = v4roles.masters(ks).find((x) => x.id === destinationId);
  if (!to) throw new Error('the destination must be one of your funding wallets (a super-main)');

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const gas = gasCost(fees, DEPOSIT_GAS);
  const minWei = parseEther(String(minSweepEth ?? DEFAULT_MIN_SWEEP_ETH));

  // Funders sourcing a still-live campaign are held back (see resolveSources).
  const activeStatuses = new Set(['running', 'paused', 'halted']);
  const busyMasterIds = new Set(
    store.campaigns().filter((c) => activeStatuses.has(c.status)).map((c) => c.masterWalletId)
  );
  const sources = resolveSources(ks, store, { categories: cats, destinationId, busyMasterIds });

  const wallets = [];
  const skipped = [];
  for (const wallet of sources) {
    const balance = BigInt(await w.rpc.getBalance(wallet.address));
    if (balance <= 0n) {
      skipped.push({ walletId: wallet.id, address: wallet.address, role: wallet.role, balanceEth: '0.0', reason: 'nothing to sweep' });
      continue;
    }
    const afterGas = balance - gas;
    const amountWei = afterGas > 0n ? (afterGas * BigInt(100 - RELAY_FEE_PCT)) / 100n : 0n;
    if (amountWei < minWei) {
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        balanceEth: formatEther(balance),
        reason: `too small for a Relay order — ${formatEther(balance)} ETH would send ${formatEther(amountWei > 0n ? amountWei : 0n)}, under the ${formatEther(minWei)} floor`,
      });
      continue;
    }
    wallets.push({ wallet, balance, amountWei });
  }

  return { to, wallets, skipped, minWei, gas, categories: cats };
}

/** What a gather would move. Reads only. */
async function preview(userId, input = {}, deps = {}) {
  const { to, wallets, skipped, minWei, categories } = await plan(userId, input, deps);
  const total = wallets.reduce((sum, x) => sum + x.amountWei, 0n);

  return {
    destination: { walletId: to.id, address: to.address, role: to.role },
    route: 'relay',
    categories,
    minSweepEth: formatEther(minWei),
    wallets: wallets.map((x) => ({
      walletId: x.wallet.id,
      address: x.wallet.address,
      role: x.wallet.role,
      balanceEth: formatEther(x.balance),
      sendEth: formatEther(x.amountWei),
    })),
    skipped,
    walletCount: wallets.length,
    totalEth: formatEther(total),
    totalEthRaw: total.toString(),
  };
}

/** Gather, one Relay order per wallet. @param {boolean} input.confirm required. */
async function run(userId, input = {}, deps = {}) {
  const w = wire(deps);

  if (input.confirm !== true) {
    throw new Error("gathering moves every chosen wallet's balance through Relay — requires { confirm: true }");
  }

  const { to, wallets, skipped, categories } = await plan(userId, input, deps);
  if (!wallets.length) {
    throw new Error(
      'nothing to gather — every chosen wallet is empty or holds less than the dust floor. Seed balances are ' +
        'usually below it; the funding wallets are where the recoverable ETH is.'
    );
  }

  const ks = w.ksFor(userId);
  const results = [];

  // Sequential: each order is quoted against the sender's live balance and nonce.
  for (const { wallet, balance, amountWei } of wallets) {
    const entry = {
      walletId: wallet.id,
      address: wallet.address,
      role: wallet.role,
      balanceEth: formatEther(balance),
      sendEth: formatEther(amountWei),
      sendWeiRaw: amountWei.toString(),
    };
    try {
      const sent = await w.relay.transfer({ fromWallet: wallet, toAddress: to.address, amountWei }, { ...deps, keystore: ks, rpc: w.rpc });
      results.push({ ...entry, status: 'sent', hash: sent.hash, requestId: sent.requestId });
    } catch (err) {
      results.push({ ...entry, status: 'failed', error: err?.shortMessage || err?.message || String(err) });
    }
  }

  const ok = results.filter((r) => r.status === 'sent');
  const moved = ok.reduce((sum, r) => sum + BigInt(r.sendWeiRaw), 0n);
  const totals = {
    wallets: results.length,
    sent: ok.length,
    failed: results.length - ok.length,
    eth: formatEther(moved),
    ethRaw: moved.toString(),
  };

  w.activity(userId).record(
    'v4',
    `[v4] gathered ${totals.sent}/${totals.wallets} wallet(s) to the super-main ${to.address} through Relay` +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      (moved > 0n ? ` — ${formatEther(moved)} ETH` : ''),
    { destination: to.address, route: 'relay', categories, totals, wallets: results, skipped }
  );

  return {
    action: 'v4-gather',
    route: 'relay',
    destination: { walletId: to.id, address: getAddress(to.address), role: to.role },
    categories,
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = {
  preview,
  run,
  CATEGORIES,
  DEFAULT_MIN_SWEEP_ETH,
  RELAY_FEE_PCT,
  _private: { plan, resolveSources },
};
