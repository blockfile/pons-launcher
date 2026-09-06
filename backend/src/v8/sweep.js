'use strict';

/**
 * Collecting the ETH back out of the v8bundle wallets, into v8main.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RELAY OR DIRECT? — THE DECISION, AND WHY.
 *
 * The sweep goes through RELAY. It is the more expensive answer and it is the right one.
 *
 * The case for a direct send is real: Relay charges roughly 3% on the sender's side and
 * cannot move dust at all, so a direct sweep returns more ETH from every wallet and
 * returns SOME ETH from wallets Relay would refuse outright.
 *
 * It is refused anyway, because a direct sweep would retroactively destroy the only thing
 * this tab produces. The entire purpose of V8 is that no on-chain transaction connects the
 * main wallet to the bundle wallets: the fan-out pays a Relay deposit address and a solver
 * pays each bundle wallet, so there is no edge to follow. If every one of those wallets
 * then sends its balance straight back to one address, the funnel appears anyway — the
 * link that was carefully avoided on the way IN gets drawn on the way OUT, and it is worse
 * than never having bothered, because it groups every wallet in the run at once and dates
 * them. There is deliberately NO direct path in this file, not even behind a flag; the
 * test beside it asserts every wallet goes through Relay.
 *
 * The 3% is the honest price of that property. THE DUST FLOOR IS WHERE THE HONESTY LIVES:
 * below some balance the Relay fee plus the wallet's own gas exceeds what is being moved,
 * and such a wallet is SKIPPED AND NAMED in `skipped[]` — never silently dropped, and
 * never quietly rerouted to a direct send to "save" it. The operator sees exactly which
 * wallets still hold dust and can decide what to do about them by hand, which is a
 * decision with a privacy cost attached and therefore theirs to make, not this module's.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE MONEY RULES. Each wallet's real balance is read from the chain, its own gas for the
 * deposit is reserved out of it, and the Relay fee is held back on top — so the amount
 * asked for is one the wallet can actually pay for. A wallet that cannot cover its own
 * send is skipped, not attempted. Every wallet is isolated: one failure is recorded
 * against that wallet and the rest of the sweep continues.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v8roles = require('./roles');
const relayTransfer = require('./relayTransfer');

const FEE_BUMP_PCT = 25;

// Held back from every balance for Relay's sender-side fee. The order is EXACT_OUTPUT, so
// the deposit Relay quotes is the requested amount PLUS its fee; asking for the whole
// spendable balance would quote a deposit larger than the wallet holds and fail the
// affordability check in relayOnce. Asking for (balance − gas) × 97% leaves room for it.
const RELAY_FEE_PCT = 3;

// Below this, moving the balance costs more than the balance is worth. Overridable per
// request, because what counts as dust depends on what the operator paid for the gas.
const DEFAULT_MIN_SWEEP_ETH = '0.002';

function wire(deps = {}) {
  return {
    ksFor: deps.keystoreForFn || keystoreFor,
    activity: deps.activityForFn || activityFor,
    rpc: deps.rpc || provider,
    relay: deps.relay || relayTransfer,
    getFeesFn: deps.getFeesFn || getFees,
  };
}

/**
 * Read every v8bundle wallet's live balance and work out what each can actually send.
 *
 * Reads only — nothing here signs. Returns the wallets worth sweeping and, separately,
 * the ones that are not, each with the reason spelled out.
 */
async function plan(userId, { minSweepEth } = {}, deps = {}) {
  const w = wire(deps);
  const ks = w.ksFor(userId);
  const to = v8roles.main(ks); // throws when there is nowhere to sweep TO
  const sources = v8roles.bundle(ks);

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const gas = gasCost(fees, relayTransfer.DEPOSIT_GAS);
  const minWei = parseEther(String(minSweepEth ?? DEFAULT_MIN_SWEEP_ETH));

  const wallets = [];
  const skipped = [];

  for (const wallet of sources) {
    const balance = BigInt(await w.rpc.getBalance(wallet.address));
    if (balance <= 0n) {
      skipped.push({
        walletId: wallet.id,
        address: getAddress(wallet.address),
        balanceEth: '0.0',
        reason: 'nothing to sweep',
      });
      continue;
    }

    // The wallet pays for its own deposit transaction, so its gas comes out first. What is
    // left over is what a Relay order may be written against.
    const afterGas = balance - gas;
    const amountWei = afterGas > 0n ? (afterGas * BigInt(100 - RELAY_FEE_PCT)) / 100n : 0n;

    if (amountWei < minWei) {
      skipped.push({
        walletId: wallet.id,
        address: getAddress(wallet.address),
        balanceEth: formatEther(balance),
        reason:
          amountWei <= 0n
            ? `cannot cover its own gas — ${formatEther(balance)} ETH, and the deposit costs about ${formatEther(gas)}`
            : `too small for a Relay order — ${formatEther(balance)} ETH would send ${formatEther(amountWei)}, ` +
              `under the ${formatEther(minWei)} floor`,
      });
      continue;
    }

    wallets.push({ wallet, balance, amountWei });
  }

  return { to, wallets, skipped, minWei, gas };
}

/** What a sweep would move, without moving it. */
async function preview(userId, input = {}, deps = {}) {
  const { to, wallets, skipped, minWei } = await plan(userId, input, deps);
  const total = wallets.reduce((sum, x) => sum + x.amountWei, 0n);
  return {
    action: 'v8-sweep-preview',
    route: 'relay',
    destination: { walletId: to.id, address: getAddress(to.address) },
    minSweepEth: formatEther(minWei),
    wallets: wallets.map((x) => ({
      walletId: x.wallet.id,
      address: getAddress(x.wallet.address),
      balanceEth: formatEther(x.balance),
      sendEth: formatEther(x.amountWei),
    })),
    skipped,
    walletCount: wallets.length,
    totalEth: formatEther(total),
  };
}

/**
 * Sweep every v8bundle wallet back into v8main, one Relay order per wallet.
 *
 * @param {boolean} input.confirm required — this empties every bundle wallet.
 */
async function run(userId, input = {}, deps = {}) {
  const w = wire(deps);

  if (input.confirm !== true) {
    throw new Error("sweeping moves every v8 bundle wallet's balance back to main — requires { confirm: true }");
  }

  const { to, wallets, skipped } = await plan(userId, input, deps);
  const ks = w.ksFor(userId);
  const results = [];

  // Sequential, one wallet at a time: each order is quoted against that wallet's live
  // balance and nonce, and the serial cadence is also what keeps the run inside Relay's
  // per-IP quote budget.
  for (const { wallet, balance, amountWei } of wallets) {
    const entry = {
      walletId: wallet.id,
      address: getAddress(wallet.address),
      balanceEth: formatEther(balance),
      sendEth: formatEther(amountWei),
      sendWeiRaw: amountWei.toString(),
      requestId: null,
      depositAddress: null,
      hash: null,
      error: null,
    };
    try {
      const sent = await w.relay.relayOnce(
        { fromWallet: wallet, toAddress: to.address, amountWei },
        { ...deps, keystore: ks, rpc: w.rpc }
      );
      results.push({
        ...entry,
        status: 'sent',
        hash: sent.hash,
        requestId: sent.requestId,
        depositAddress: sent.depositAddress,
        ...(sent.simulated ? { simulated: true } : {}),
      });
    } catch (err) {
      // Isolated per wallet — a failed order leaves that wallet's ETH where it is and the
      // sweep moves on to the next.
      results.push({ ...entry, status: 'failed', error: err?.shortMessage || err?.message || String(err) });
    }
  }

  const ok = results.filter((r) => r.status === 'sent');
  const moved = ok.reduce((sum, r) => sum + BigInt(r.sendWeiRaw), 0n);
  const totals = {
    wallets: results.length,
    sent: ok.length,
    failed: results.length - ok.length,
    skipped: skipped.length,
    eth: formatEther(moved),
  };

  w.activity(userId).record(
    'sweep',
    `[v8] swept ${totals.sent}/${totals.wallets} wallet(s) back to main through Relay` +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      (skipped.length ? `, ${skipped.length} skipped as dust` : '') +
      (moved > 0n ? ` — ${formatEther(moved)} ETH` : ''),
    { destination: getAddress(to.address), route: 'relay', totals, wallets: results, skipped }
  );

  return {
    action: 'v8-sweep',
    route: 'relay',
    destination: { walletId: to.id, address: getAddress(to.address) },
    results,
    skipped,
    totals,
  };
}

module.exports = {
  preview,
  run,
  DEFAULT_MIN_SWEEP_ETH,
  RELAY_FEE_PCT,
  FEE_BUMP_PCT,
  _private: { plan },
};
