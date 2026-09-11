'use strict';

/**
 * Sweeping ETH out of V4's FUNDER wallets, to one super-main.
 *
 * After a run, ETH sits scattered across the funders — each campaign's leftover. This moves
 * it to ONE super-main the operator names, by the route the operator picks per sweep.
 *
 * FUNDERS ONLY — AN AGED SEED IS NEVER SWEPT. The sources are the v4master wallets that are
 * not flagged super-main, and nothing else. This module never reads the seed role, and a run
 * naming anything that is not a funder — a seed, a super-main, another tab's wallet — is
 * refused whole before a single balance is read. A seed's value is that it looks unrelated
 * to everything else the operator holds, no sweep is worth that, so there is no path here
 * that can reach one. (Seeds handed to V1/V3 are re-roled out of v4seed by the claim, so
 * they are unreachable by construction too.)
 *
 * A funder that is the source of a live campaign — running, paused or halted — is never
 * swept: its ETH is earmarked for drips that are still aging seeds. It is named in
 * `skipped` rather than silently left out.
 *
 * TWO ROUTES:
 *
 *   relay   (default) one Relay order per funder. The funder pays a deposit address and a
 *           solver pays the super-main, so the two share no on-chain edge — the same
 *           property the split that funded the funder had. Costs a Relay fee + gas; 3% is
 *           held back for the fee, so small balances fall under the dust floor. Stops at
 *           the FIRST rate-limit refusal: Relay's /quote budget on this chain is ~5 per
 *           window per IP and every request sent while blocked re-arms the block, so the
 *           funders after it are reported not-attempted and keep their ETH for a re-run.
 *
 *   direct  a plain send of the balance minus its own gas. Recovers almost everything, and
 *           draws a public funder → super-main link for every funder swept. It links no
 *           seed: every funder → seed transfer went through Relay.
 *
 * Both honour DRY_RUN — nothing is signed, and rows come back `simulated`.
 *
 * V4 owns its own copy of every piece of this, per the isolation rule — the gas estimate
 * below included, which is deliberately not imported from wallets/funding.js.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v4roles = require('./roles');
const { storeFor } = require('./store');
const defaultRelay = require('./relay');

const ROUTES = ['relay', 'direct'];

const DEPOSIT_GAS = 50_000n; // a Relay deposit is a plain value send
const RELAY_FEE_PCT = 3; // held back for Relay's sender-side fee
const FEE_BUMP_PCT = 25;
const DEFAULT_MIN_SWEEP_ETH = '0.002'; // below this the Relay fee+gas eat the balance

// A plain send costs 21,195 gas on this chain, not the textbook 21,000 — hard-coding 21,000
// had the node reject every send with "intrinsic gas too low". So the chain is asked, with
// headroom, and this is only the floor for when the estimate fails.
const DIRECT_GAS_FLOOR = 30_000n;
const DIRECT_GAS_HEADROOM_PCT = 20;

// How long a direct sweep waits for its receipts: under nginx's ~60 s read timeout, so the
// console still gets its answer. A send not seen by then is reported pending, not failed.
const DIRECT_RECEIPT_TIMEOUT_MS = 30_000;

// Relay's rate-limit refusal — HTTP 429 "Could not process request. Please try again later."
// Matched on the message because v4/relay.js, the campaigns' money path, is deliberately not
// changed to carry a status code.
const RELAY_RATE_LIMIT_RE = /try again later|could not process|rate.?limit|too many|\b429\b/i;

// A campaign in any of these still spends from its funder.
const LIVE_CAMPAIGN = new Set(['running', 'paused', 'halted']);

function wire(deps = {}) {
  return {
    ksFor: deps.keystoreForFn || keystoreFor,
    storeForFn: deps.storeForFn || storeFor,
    activity: deps.activityForFn || activityFor,
    rpc: deps.rpc || provider,
    relay: deps.relay || defaultRelay,
    getFeesFn: deps.getFeesFn || getFees,
    waitFn: deps.waitForReceiptFn || waitForReceipt,
    dryRun: Boolean(deps.dryRun ?? config.dryRun),
  };
}

/**
 * THE ONE PLACE THAT DECIDES WHAT MAY BE SWEPT: every v4master that is not a super-main.
 * It reads the master role only, so a seed cannot appear in its answer.
 */
function funders(ks, store) {
  const supers = store.superMainIds();
  return v4roles.masters(ks).filter((w) => !supers.has(w.id));
}

function assertRoute(route) {
  if (!ROUTES.includes(route)) throw new Error(`route must be "relay" or "direct", not "${route}"`);
}

/** The destination: a flagged super-main, and nothing else. */
function resolveDestination(ks, store, destinationId) {
  const supers = store.superMainIds();
  if (supers.size === 0) {
    throw new Error('no super-main is flagged — flag one in step 1 first, then sweep the funders to it');
  }
  const to = v4roles.masters(ks).find((w) => w.id === destinationId && supers.has(w.id));
  if (!to) throw new Error('the destination must be one of your super-mains');
  return to;
}

/**
 * Refuse any id that is not a funder, before a single balance is read. This is the gate that
 * keeps a hand-written request from pointing the sweep at a seed.
 */
function assertFunderIds(ks, store, walletIds) {
  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    throw new Error('walletIds[] is required — the funders to sweep, as ticked in the preview');
  }
  const ok = new Set(funders(ks, store).map((w) => w.id));
  for (const id of walletIds) {
    if (!ok.has(id)) {
      throw new Error(`wallet ${id} is not a funder — only funders are swept; seeds and super-mains never are`);
    }
  }
  return new Set(walletIds);
}

/**
 * The gas limit a direct send is signed with. Estimated once per sweep — every send is the
 * same plain transfer to the same address. Never throws: a failed estimate is the floor.
 */
async function directGasLimit(rpc, from, to) {
  try {
    const est = BigInt(await rpc.estimateGas({ from, to, value: 1n }));
    const withHeadroom = (est * BigInt(100 + DIRECT_GAS_HEADROOM_PCT)) / 100n;
    return withHeadroom > DIRECT_GAS_FLOOR ? withHeadroom : DIRECT_GAS_FLOOR;
  } catch (_err) {
    return DIRECT_GAS_FLOOR;
  }
}

function statusOf(receipt) {
  if (!receipt) return 'pending';
  return Number(receipt.status) === 1 ? 'confirmed' : 'reverted';
}

function errText(err) {
  return err?.shortMessage || err?.message || String(err);
}

function rowOf({ wallet, balance, amountWei }) {
  return {
    walletId: wallet.id,
    address: wallet.address,
    balanceEth: formatEther(balance),
    sendEth: formatEther(amountWei),
    sendWeiRaw: amountWei.toString(),
  };
}

async function plan(userId, { destinationId, route = 'relay', minSweepEth } = {}, deps = {}) {
  const w = wire(deps);
  assertRoute(route);
  const ks = w.ksFor(userId);
  const store = w.storeForFn(userId);
  const to = resolveDestination(ks, store, destinationId);

  const busy = new Set(
    store
      .campaigns()
      .filter((c) => LIVE_CAMPAIGN.has(c.status))
      .map((c) => c.masterWalletId)
  );
  const sources = [];
  const skipped = [];
  for (const wallet of funders(ks, store)) {
    if (wallet.id === to.id) continue; // a super-main is never a funder — asserted, not trusted
    if (busy.has(wallet.id)) {
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        balanceEth: null,
        reason: 'running a campaign — sweeping it would starve the campaign',
      });
      continue;
    }
    sources.push(wallet);
  }

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const minWei = parseEther(String(minSweepEth ?? DEFAULT_MIN_SWEEP_ETH));
  let gasLimit = DEPOSIT_GAS;
  if (route === 'direct') {
    gasLimit = sources.length ? await directGasLimit(w.rpc, sources[0].address, to.address) : DIRECT_GAS_FLOOR;
  }
  const gas = gasCost(fees, gasLimit);

  const wallets = [];
  for (const wallet of sources) {
    const balance = BigInt(await w.rpc.getBalance(wallet.address));
    const skip = (reason) =>
      skipped.push({ walletId: wallet.id, address: wallet.address, balanceEth: formatEther(balance), reason });
    if (balance <= 0n) {
      skip('nothing to sweep');
      continue;
    }
    if (route === 'direct') {
      // Everything but the send's own gas ceiling. The node checks value + gasLimit ×
      // maxFeePerGas against the balance, so at these fees this is the most that fits.
      const amountWei = balance - gas;
      if (amountWei <= 0n) {
        skip(`${formatEther(balance)} ETH does not cover the send's own gas (${formatEther(gas)} ETH)`);
        continue;
      }
      wallets.push({ wallet, balance, amountWei });
    } else {
      const afterGas = balance - gas;
      const amountWei = afterGas > 0n ? (afterGas * BigInt(100 - RELAY_FEE_PCT)) / 100n : 0n;
      if (amountWei < minWei) {
        skip(
          `too small for a Relay order — ${formatEther(balance)} ETH would send ${formatEther(amountWei)}, ` +
            `under the ${formatEther(minWei)} floor`
        );
        continue;
      }
      wallets.push({ wallet, balance, amountWei });
    }
  }

  return { to, route, wallets, skipped, minWei, fees, gasLimit };
}

/** What a sweep would move. Reads only. */
async function preview(userId, input = {}, deps = {}) {
  const { to, route, wallets, skipped, minWei } = await plan(userId, input, deps);
  const total = wallets.reduce((sum, x) => sum + x.amountWei, 0n);
  return {
    destination: { walletId: to.id, address: to.address },
    route,
    minSweepEth: formatEther(minWei),
    wallets: wallets.map(rowOf),
    skipped,
    walletCount: wallets.length,
    totalEth: formatEther(total),
    totalEthRaw: total.toString(),
  };
}

/**
 * One Relay order per funder, in turn — each is quoted against the sender's live balance
 * and nonce. Stops at the first rate-limit refusal (see RELAY_RATE_LIMIT_RE).
 */
async function sendRelay(w, ks, deps, to, wallets) {
  const results = [];
  let limited = false;
  for (const x of wallets) {
    const entry = rowOf(x);
    if (limited) {
      results.push({ ...entry, status: 'not-attempted', error: 'Relay is rate-limiting — run the sweep again in a minute' });
      continue;
    }
    try {
      const sent = await w.relay.transfer(
        { fromWallet: x.wallet, toAddress: to.address, amountWei: x.amountWei },
        { ...deps, keystore: ks, rpc: w.rpc }
      );
      results.push({ ...entry, status: sent.simulated ? 'simulated' : 'sent', hash: sent.hash, requestId: sent.requestId });
    } catch (err) {
      const error = errText(err);
      results.push({ ...entry, status: 'failed', error });
      if (RELAY_RATE_LIMIT_RE.test(error)) limited = true;
    }
  }
  return results;
}

/**
 * A plain send per funder. Every send is broadcast before any receipt is awaited — the
 * wallets are independent (each signs its own nonce), so waiting on them one at a time
 * would only add latency to a request nginx cuts off at ~60 s.
 */
async function sendDirect(w, ks, to, wallets, { fees, gasLimit }) {
  if (w.dryRun) return wallets.map((x) => ({ ...rowOf(x), status: 'simulated', hash: null }));

  const toAddr = getAddress(to.address);
  const broadcast = [];
  for (const x of wallets) {
    const entry = rowOf(x);
    try {
      const tx = await ks
        .signer(x.wallet.id, w.rpc)
        .sendTransaction({ to: toAddr, value: x.amountWei, gasLimit, ...fees });
      broadcast.push({ entry, hash: tx.hash });
    } catch (err) {
      broadcast.push({ entry, error: errText(err) });
    }
  }
  return Promise.all(
    broadcast.map(async ({ entry, hash, error }) => {
      if (!hash) return { ...entry, status: 'failed', hash: null, error };
      const receipt = await w.waitFn(w.rpc, hash, { timeoutMs: DIRECT_RECEIPT_TIMEOUT_MS }).catch(() => null);
      return { ...entry, status: statusOf(receipt), hash };
    })
  );
}

/**
 * Sweep the ticked funders to the super-main.
 *
 * @param {string[]} input.walletIds the funders to sweep — every one must be a funder.
 * @param {'relay'|'direct'} [input.route='relay']
 * @param {boolean} input.confirm required.
 */
async function run(userId, input = {}, deps = {}) {
  const w = wire(deps);
  if (input.confirm !== true) {
    throw new Error("sweeping moves each ticked funder's whole balance — requires { confirm: true }");
  }
  const route = input.route ?? 'relay';
  assertRoute(route);
  const ks = w.ksFor(userId);
  const store = w.storeForFn(userId);
  const ticked = assertFunderIds(ks, store, input.walletIds);

  const planned = await plan(userId, { ...input, route }, deps);
  const { to } = planned;
  const wallets = planned.wallets.filter((x) => ticked.has(x.wallet.id));
  // A ticked funder the fresh plan skipped — it started a campaign, or its balance fell
  // under the floor, since the preview — is named with the plan's reason.
  const skipped = planned.skipped.filter((s) => ticked.has(s.walletId));
  if (!wallets.length) {
    throw new Error('nothing to sweep — every ticked funder is empty, under the floor, or running a campaign');
  }

  const results =
    route === 'direct' ? await sendDirect(w, ks, to, wallets, planned) : await sendRelay(w, ks, deps, to, wallets);

  const MOVED = ['sent', 'confirmed', 'simulated'];
  const count = (...statuses) => results.filter((r) => statuses.includes(r.status)).length;
  const movedWei = results
    .filter((r) => MOVED.includes(r.status))
    .reduce((sum, r) => sum + BigInt(r.sendWeiRaw), 0n);
  const totals = {
    wallets: results.length,
    moved: count(...MOVED),
    failed: count('failed', 'reverted'),
    pending: count('pending'),
    notAttempted: count('not-attempted'),
    eth: formatEther(movedWei),
    ethRaw: movedWei.toString(),
  };

  const how = route === 'direct' ? 'directly — links these funders to the super-main on-chain' : 'through Relay';
  w.activity(userId).record(
    'v4',
    `[v4] swept ${totals.moved}/${totals.wallets} funder(s) to the super-main ${to.address} ${how}` +
      (w.dryRun ? ' (dry run — nothing signed)' : '') +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      (totals.pending ? `, ${totals.pending} pending` : '') +
      (totals.notAttempted ? `, ${totals.notAttempted} not attempted (Relay rate limit)` : '') +
      (movedWei > 0n ? ` — ${formatEther(movedWei)} ETH` : ''),
    { destination: to.address, route, dryRun: w.dryRun, totals, wallets: results, skipped }
  );

  return {
    action: 'v4-sweep-funders',
    route,
    dryRun: w.dryRun,
    destination: { walletId: to.id, address: getAddress(to.address) },
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = {
  preview,
  run,
  ROUTES,
  DEFAULT_MIN_SWEEP_ETH,
  RELAY_FEE_PCT,
  DIRECT_GAS_FLOOR,
  _private: { plan, funders, resolveDestination, assertFunderIds, directGasLimit, RELAY_RATE_LIMIT_RE },
};
