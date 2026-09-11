'use strict';

/**
 * Sweeping ETH out of V4's FUNDER wallets, to one super-main.
 *
 * After a run, ETH sits scattered across the funders — each campaign's leftover. This moves
 * it to ONE super-main the operator names, by the route the operator picks per sweep.
 *
 * FUNDERS ONLY — AN AGED SEED IS NEVER SWEPT. Two locks, so neither has to be trusted alone:
 *
 *   1. the sources are the v4master wallets that are not flagged super-main — this module
 *      never reads the seed role;
 *   2. any wallet the V4 store has on record as a seed (claimed by a seasoning campaign,
 *      withdrawn from the pool, or handed off to V1/V3) is excluded whatever its role says
 *      now, so a seed re-roled into v4master by hand is still never a funder.
 *
 * A run naming anything that is not a funder — a seed, a super-main, another tab's wallet —
 * is refused whole before a single balance is read. A seed's value is that it looks unrelated
 * to everything else the operator holds, and no sweep is worth that.
 *
 * A funder a live campaign still needs is never swept: one that a running, paused or halted
 * campaign SPENDS from (its drips are still aging seeds), or one a live campaign still OWES a
 * transfer (a split that has not finished paying it). The same two tests the delete guard in
 * routes/v4.js applies. They are checked when the sweep is planned AND again immediately
 * before each funder's send, so a campaign started on a funder while a sweep is under way
 * stops that funder being swept. Such a funder is named in `skipped`, never silently dropped.
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
 *           publicly links every funder swept to the super-main — and so to each other. No
 *           seed gets a direct on-chain edge (every funder → seed transfer went through
 *           Relay), but each funder's seeds end up one Relay hop from the super-main, and
 *           Relay's own order history can connect that hop.
 *
 * Both honour DRY_RUN — nothing is signed, and rows come back `simulated`.
 *
 * V4 owns its own copy of every piece of this, per the isolation rule — the gas estimate
 * below included, which is deliberately not imported from wallets/funding.js.
 */

const { formatEther, getAddress, keccak256, parseEther } = require('ethers');
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

// The cap on the RECEIPT wait at the end of a direct sweep; a send not seen by then is
// reported pending, not failed. The balance reads and the sends before it are one at a time
// — deliberately: N concurrent broadcasts is the pattern that tripped this provider's rate
// limiter and failed a whole sweep (see disperserAddresses in config.js) — so a very large
// sweep on a slow RPC can still outlast nginx's ~60 s. That is safe: the backend finishes,
// the activity log records it, and a re-run re-reads every balance.
const DIRECT_RECEIPT_TIMEOUT_MS = 30_000;

// Relay's rate-limit refusal as it is worded — HTTP 429 "Could not process request. Please
// try again later.", or relay.js's own "Relay returned 429". The status itself is also
// watched (see sendRelay), so a differently worded 429 still stops the sweep.
const RELAY_RATE_LIMIT_RE = /try again later|could not process|rate.?limit|too many|\b429\b/i;
const RATE_LIMITED = 'Relay is rate-limiting — run the sweep again in a minute';

// A campaign in any of these still spends from its funder, or still pays the wallets it owes.
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
 * Every wallet id the V4 store has on record as a SEED, whatever its keystore role says now:
 * claimed by a seasoning campaign (splits claim nothing — see store.claimedSeedIds),
 * withdrawn from the pool, or handed off to V1/V3.
 */
function recordedSeedIds(store) {
  const ids = new Set(store.claimedSeedIds());
  for (const id of store.withdrawnSeedIds()) ids.add(id);
  for (const g of store.graduated()) ids.add(g.id);
  return ids;
}

/**
 * THE ONE PLACE THAT DECIDES WHAT MAY BE SWEPT: every v4master that is not a super-main and
 * has never been a seed. It reads the master role only, so a seed cannot appear in its answer.
 */
function funders(ks, store) {
  const supers = store.superMainIds();
  const seeds = recordedSeedIds(store);
  return v4roles.masters(ks).filter((w) => !supers.has(w.id) && !seeds.has(w.id));
}

/**
 * Why a live campaign still needs this funder, or null. Read fresh on every call — it is
 * re-checked immediately before each send.
 */
function busyReason(store, walletId) {
  for (const c of store.campaigns()) {
    if (!LIVE_CAMPAIGN.has(c.status)) continue;
    const name = c.name || c.id;
    if (c.masterWalletId === walletId) {
      return `funding campaign "${name}" (${c.status}) — sweeping it would starve the campaign`;
    }
    if ((c.transfers || []).some((t) => t.walletId === walletId && t.status === 'pending')) {
      return `still owed a transfer by campaign "${name}" (${c.status}) — sweep it once that campaign has paid it`;
    }
  }
  return null;
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
 * same plain transfer to the same address — from a funder that holds ETH, so the estimate
 * can run. Never throws: a failed estimate is the floor.
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

/** A ticked funder a campaign claimed after the sweep was planned: named, and left alone. */
function heldBack({ wallet, balance }, reason) {
  return {
    walletId: wallet.id,
    address: wallet.address,
    balanceEth: formatEther(balance),
    reason: `${reason} (it was free when this sweep began, and was left alone)`,
  };
}

async function plan(userId, { destinationId, route: asked, minSweepEth } = {}, deps = {}) {
  const w = wire(deps);
  const route = asked ?? 'relay';
  assertRoute(route);
  const ks = w.ksFor(userId);
  const store = w.storeForFn(userId);
  const to = resolveDestination(ks, store, destinationId);

  const sources = [];
  const skipped = [];
  for (const wallet of funders(ks, store)) {
    if (wallet.id === to.id) continue; // a super-main is never a funder — asserted, not trusted
    const busy = busyReason(store, wallet.id);
    if (busy) {
      skipped.push({ walletId: wallet.id, address: wallet.address, balanceEth: null, reason: busy });
      continue;
    }
    sources.push(wallet);
  }

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const minWei = parseEther(String(minSweepEth ?? DEFAULT_MIN_SWEEP_ETH));

  // Every balance first, so the direct route's gas estimate can come from a funder that
  // holds ETH: an estimate from an empty one fails and falls to the floor, which a
  // destination with code (an EIP-7702 delegation, say) could need more than.
  const funded = [];
  for (const wallet of sources) {
    const balance = BigInt(await w.rpc.getBalance(wallet.address));
    if (balance <= 0n) {
      skipped.push({ walletId: wallet.id, address: wallet.address, balanceEth: formatEther(balance), reason: 'nothing to sweep' });
      continue;
    }
    funded.push({ wallet, balance });
  }

  let gasLimit = DEPOSIT_GAS;
  if (route === 'direct') {
    gasLimit = funded.length ? await directGasLimit(w.rpc, funded[0].wallet.address, to.address) : DIRECT_GAS_FLOOR;
  }
  const gas = gasCost(fees, gasLimit);

  const wallets = [];
  for (const { wallet, balance } of funded) {
    const skip = (reason) =>
      skipped.push({ walletId: wallet.id, address: wallet.address, balanceEth: formatEther(balance), reason });
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

  return { to, route, wallets, skipped, minWei, fees, gasLimit, store };
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
 * and nonce. Stops at the first rate-limit refusal.
 */
async function sendRelay(w, ks, deps, { store, to, wallets }) {
  const results = [];
  const held = [];
  let limited = false;
  const baseFetch = deps.fetch || globalThis.fetch;
  for (const x of wallets) {
    const entry = rowOf(x);
    if (limited) {
      results.push({ ...entry, status: 'not-attempted', error: RATE_LIMITED });
      continue;
    }
    const busy = busyReason(store, x.wallet.id);
    if (busy) {
      held.push(heldBack(x, busy));
      continue;
    }
    // Relay's refusal is recognised by its HTTP status as well as its wording: the quote
    // fetch relay.js makes is observed on its way back (relay.js itself is not modified —
    // it passes deps.fetch straight through to its request).
    let saw429 = false;
    const fetch = async (...args) => {
      const res = await baseFetch(...args);
      if (res && res.status === 429) saw429 = true;
      return res;
    };
    try {
      const sent = await w.relay.transfer(
        { fromWallet: x.wallet, toAddress: to.address, amountWei: x.amountWei },
        { ...deps, fetch, keystore: ks, rpc: w.rpc }
      );
      results.push({ ...entry, status: sent.simulated ? 'simulated' : 'sent', hash: sent.hash, requestId: sent.requestId });
    } catch (err) {
      const error = errText(err);
      results.push({ ...entry, status: 'failed', error });
      if (saw429 || RELAY_RATE_LIMIT_RE.test(error)) limited = true;
    }
  }
  return { results, held };
}

/**
 * A plain send per funder, one at a time; then every receipt is awaited together.
 *
 * Each send is SIGNED HERE and broadcast separately, so its hash is known before the node is
 * asked. ethers' sendTransaction reads the block number alongside the broadcast and throws if
 * THAT read fails — even when the node took the transaction — which would report a send that
 * happened as a failure with no hash to look up. So a throw after signing asks the node
 * whether it has the transaction before calling it failed.
 */
async function sendDirect(w, ks, { store, to, wallets, fees, gasLimit }) {
  const held = [];
  const toAddr = getAddress(to.address);
  const broadcast = [];
  for (const x of wallets) {
    const busy = busyReason(store, x.wallet.id);
    if (busy) {
      held.push(heldBack(x, busy));
      continue;
    }
    const entry = rowOf(x);
    if (w.dryRun) {
      broadcast.push({ entry, simulated: true });
      continue;
    }
    let hash = null;
    try {
      const signer = ks.signer(x.wallet.id, w.rpc);
      const raw = await signer.signTransaction(
        await signer.populateTransaction({ to: toAddr, value: x.amountWei, gasLimit, ...fees })
      );
      hash = keccak256(raw);
      await w.rpc.broadcastTransaction(raw);
      broadcast.push({ entry, hash });
    } catch (err) {
      const known = hash ? await w.rpc.getTransaction(hash).catch(() => null) : null;
      broadcast.push(known ? { entry, hash } : { entry, hash, error: errText(err) });
    }
  }

  const results = await Promise.all(
    broadcast.map(async ({ entry, hash, error, simulated }) => {
      if (simulated) return { ...entry, status: 'simulated', hash: null };
      if (error) return { ...entry, status: 'failed', hash, error };
      const receipt = await w.waitFn(w.rpc, hash, { timeoutMs: DIRECT_RECEIPT_TIMEOUT_MS }).catch(() => null);
      return { ...entry, status: statusOf(receipt), hash };
    })
  );
  return { results, held };
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
    throw new Error('nothing to sweep — every ticked funder is empty, under the floor, or needed by a campaign');
  }

  const sent =
    route === 'direct'
      ? await sendDirect(w, ks, { ...planned, wallets })
      : await sendRelay(w, ks, deps, { ...planned, wallets });
  const results = sent.results;
  skipped.push(...sent.held);

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

  // The sends have happened by now. A log that cannot be written must not turn that into an
  // error: the operator would lose the hashes of a sweep that ran.
  let logWarning = null;
  try {
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
  } catch (err) {
    logWarning = `the sweep ran, but the activity log could not be written (${errText(err)}) — keep this result`;
  }

  return {
    action: 'v4-sweep-funders',
    route,
    dryRun: w.dryRun,
    destination: { walletId: to.id, address: getAddress(to.address) },
    wallets: results,
    skipped,
    totals,
    logWarning,
  };
}

module.exports = {
  preview,
  run,
  ROUTES,
  DEFAULT_MIN_SWEEP_ETH,
  RELAY_FEE_PCT,
  DIRECT_GAS_FLOOR,
  _private: {
    plan,
    funders,
    recordedSeedIds,
    busyReason,
    resolveDestination,
    assertFunderIds,
    directGasLimit,
    RELAY_RATE_LIMIT_RE,
  },
};
