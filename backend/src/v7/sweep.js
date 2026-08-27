'use strict';

/**
 * Collecting the ETH back out of a finished V7 run.
 *
 * After the exit has sold every position, the proceeds sit in the bundle wallets and are
 * no use there. This gathers them.
 *
 * IT GOES THROUGH RELAY, AND THAT IS THE ENTIRE POINT OF THE MODULE. A direct sweep would
 * undo the whole run: every bundle wallet bought in public, and if all of them then send
 * ETH straight to one address, anyone reading the chain sees the buyers funnelling into a
 * single wallet — the link the Relay hop avoided on the way IN, drawn anyway on the way
 * OUT, retroactively, for the entire run. There is deliberately no direct path here; the
 * test asserts every wallet goes through Relay.
 *
 * That costs a Relay fee per wallet — the honest price of the property — which is why the
 * dust floor exists: below some amount the fee to move a balance exceeds what is being
 * moved.
 *
 * DESTINATION IS THE CALLER'S. 'main' tops the main wallet up for another run; 'treasury'
 * parks the ETH in the wallet that never trades (and then the main wallet is swept too,
 * since it is no longer the destination). ETH ONLY — tokens are the exit's job. One
 * wallet's failure does not stop the others.
 *
 * This is venue-independent (it moves ETH, not tokens), so it is a near-verbatim clone of
 * v6/sweep.js — v7 owns its own copy per the isolation rule.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v7roles = require('./roles');
const defaultRelay = require('./relay');

const DEPOSIT_GAS = 50_000n; // a Relay deposit is a plain value send
const RELAY_FEE_PCT = 3; // held back for Relay's sender-side fee
const FEE_BUMP_PCT = 25;
const DEFAULT_MIN_SWEEP_ETH = '0.002'; // below this the fee+gas eat the balance

const DESTINATIONS = ['main', 'treasury'];

function wire(deps = {}) {
  return {
    ksFor: deps.keystoreForFn || keystoreFor,
    activity: deps.activityForFn || activityFor,
    rpc: deps.rpc || provider,
    relay: deps.relay || defaultRelay,
    getFeesFn: deps.getFeesFn || getFees,
  };
}

/** Who is emptied, into what. main is a source only when it is not the destination. */
function resolveParties(ks, destination) {
  if (!DESTINATIONS.includes(destination)) {
    throw new Error(`destination must be one of ${DESTINATIONS.join(' or ')}`);
  }
  const to = destination === 'main' ? v7roles.main(ks) : v7roles.treasury(ks);
  const sources = [...v7roles.bundle(ks)];
  if (destination === 'treasury') {
    const main = ks.walletWithRole(v7roles.ROLES.main);
    if (main) sources.push(main);
  }
  return { to, sources };
}

async function plan(userId, { destination = 'main', minSweepEth } = {}, deps = {}) {
  const w = wire(deps);
  const ks = w.ksFor(userId);
  const { to, sources } = resolveParties(ks, destination);

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const gas = gasCost(fees, DEPOSIT_GAS);
  const minWei = parseEther(String(minSweepEth ?? DEFAULT_MIN_SWEEP_ETH));

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

  return { to, wallets, skipped, minWei, gas };
}

/** What a sweep would move. Reads only. */
async function preview(userId, input = {}, deps = {}) {
  const { to, wallets, skipped, minWei } = await plan(userId, input, deps);
  const total = wallets.reduce((sum, x) => sum + x.amountWei, 0n);

  return {
    destination: { walletId: to.id, address: to.address, role: to.role },
    route: 'relay',
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

/** Sweep, one Relay order per wallet. @param {boolean} input.confirm required. */
async function run(userId, input = {}, deps = {}) {
  const w = wire(deps);

  if (input.confirm !== true) {
    throw new Error("sweeping moves every v7 wallet's balance — requires { confirm: true }");
  }

  const { to, wallets, skipped } = await plan(userId, input, deps);
  if (!wallets.length) {
    throw new Error(
      'nothing to sweep — every v7 wallet is empty or holds less than the floor. Sell any remaining ' +
        'positions in the exit step first.'
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
    'v7',
    `[v7] swept ${totals.sent}/${totals.wallets} wallet(s) to the ${to.role === v7roles.ROLES.main ? 'main' : 'treasury'} wallet through Relay` +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      (moved > 0n ? ` — ${formatEther(moved)} ETH` : ''),
    { destination: to.address, route: 'relay', totals, wallets: results, skipped }
  );

  return {
    action: 'v7-sweep',
    route: 'relay',
    destination: { walletId: to.id, address: getAddress(to.address), role: to.role },
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = {
  preview,
  run,
  DESTINATIONS,
  DEFAULT_MIN_SWEEP_ETH,
  RELAY_FEE_PCT,
  _private: { plan, resolveParties },
};
