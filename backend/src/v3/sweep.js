'use strict';

/**
 * Collecting the ETH back out of a finished run.
 *
 * After the exit has sold every position, the proceeds are sitting in twenty
 * separate bundle wallets and are no use there. This gathers them.
 *
 * IT GOES THROUGH RELAY, AND THAT IS THE ENTIRE POINT OF THE MODULE.
 *
 * A direct sweep is the obvious implementation and it would undo the whole run.
 * Every bundle wallet bought the token in public; if all twenty then send ETH
 * straight to one address, anyone reading the chain sees twenty buyers
 * funnelling into a single wallet, and the link the Relay hop was used to avoid
 * on the way IN is drawn anyway on the way OUT — retroactively, for the entire
 * run, after the fact and beyond undoing. There is deliberately no direct path
 * in this file. The test beside it asserts that every wallet goes through the
 * relay helper.
 *
 * That costs a Relay fee per wallet, which is the honest price of the property.
 * It is also why the dust floor exists: below some amount the fee to move a
 * balance exceeds what is being moved, and the only sensible thing is to leave
 * it and say so.
 *
 * DESTINATION IS THE CALLER'S. 'main' tops the main wallet up for another run;
 * 'treasury' parks the ETH in the wallet that never trades — and in that case
 * the main wallet is swept too, since it is no longer the destination.
 *
 * ETH ONLY. Tokens are the exit's job (see exit.js); a wallet still holding a
 * position should be sold, not swept.
 *
 * One wallet's failure does not stop the others — the same rule the exit
 * follows, and for the same reason: these wallets are independent, and halting
 * would strand the ones after it for no gain.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v3roles = require('./roles');
const defaultRelay = require('./relay');

// A Relay deposit is a plain value send with no calldata.
const DEPOSIT_GAS = 50_000n;

// Held back for Relay's own fee: an EXACT_OUTPUT order charges the sender, and
// how much is not known until the quote comes back — which is after the amount
// has to be chosen.
const RELAY_FEE_PCT = 3;

// Same headroom the rest of V3 puts on a fee ceiling.
const FEE_BUMP_PCT = 25;

// Below this a sweep is not worth making: the Relay fee and the gas together
// are a large share of the balance, and the operator ends up paying to move
// almost nothing. Overridable per sweep.
const DEFAULT_MIN_SWEEP_ETH = '0.002';

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

/**
 * Who is being emptied, and into what.
 *
 * The main wallet is a source only when it is not the destination — sweeping a
 * wallet into itself is a Relay order that pays a fee to achieve nothing.
 */
function resolveParties(ks, destination) {
  if (!DESTINATIONS.includes(destination)) {
    throw new Error(`destination must be one of ${DESTINATIONS.join(' or ')}`);
  }
  const to = destination === 'main' ? v3roles.main(ks) : v3roles.treasury(ks);
  const sources = [...v3roles.bundle(ks)];
  if (destination === 'treasury') {
    const main = ks.walletWithRole(v3roles.ROLES.main);
    if (main) sources.push(main);
  }
  return { to, sources };
}

/**
 * What each wallet could send, after gas and the fee allowance.
 *
 * @returns {Promise<{to, wallets, skipped, minWei}>}
 */
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
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        role: wallet.role,
        balanceEth: '0.0',
        reason: 'nothing to sweep',
      });
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
        reason:
          `too small to be worth a Relay order — ${formatEther(balance)} ETH would send ` +
          `${formatEther(amountWei > 0n ? amountWei : 0n)}, under the ${formatEther(minWei)} floor`,
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

/**
 * Sweep, one Relay order per wallet.
 *
 * @param {boolean} input.confirm required — this moves every wallet's balance.
 */
async function run(userId, input = {}, deps = {}) {
  const w = wire(deps);

  if (input.confirm !== true) {
    throw new Error('sweeping moves every v3 wallet\'s balance — requires { confirm: true }');
  }

  const { to, wallets, skipped } = await plan(userId, input, deps);
  if (!wallets.length) {
    throw new Error(
      'nothing to sweep — every v3 wallet is empty or holds less than the floor. Sell any ' +
        'remaining positions in step 5 first.'
    );
  }

  const ks = w.ksFor(userId);
  const results = [];

  // Sequential, not parallel. Each order is quoted against the sender's live
  // balance and nonce, and firing twenty at once would have them racing each
  // other's state for no gain — this runs after everything else is done.
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
      const sent = await w.relay.transfer(
        { fromWallet: wallet, toAddress: to.address, amountWei },
        { ...deps, keystore: ks, rpc: w.rpc }
      );
      results.push({ ...entry, status: 'sent', hash: sent.hash, requestId: sent.requestId });
    } catch (err) {
      results.push({
        ...entry,
        status: 'failed',
        error: err?.shortMessage || err?.message || String(err),
      });
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
    'v3',
    `[v3] swept ${totals.sent}/${totals.wallets} wallet(s) to the ${to.role === v3roles.ROLES.main ? 'main' : 'treasury'} wallet through Relay` +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      (moved > 0n ? ` — ${formatEther(moved)} ETH` : ''),
    { destination: to.address, route: 'relay', totals, wallets: results, skipped }
  );

  return {
    action: 'v3-sweep',
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
