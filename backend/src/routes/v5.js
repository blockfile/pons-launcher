'use strict';

/**
 * v5 — the letscash.fun (CashCat) bundler tab.
 *
 * SEPARATE FROM the other route files BY DESIGN, exactly as routes/v4.js is: a
 * tab owns its own routes so one strategy's endpoints can never resolve
 * another's wallets. v5 reaches for the SHARED spine (keystore, funding, Relay,
 * deploy, activity) but its money paths and roles are its own.
 *
 * Scaffolding phase: config + wallet reads + wallet creation. The launch, the
 * bundle fan-out, the V4-swap buy/sell and the sweep arrive in later phases,
 * each behind its own fund-safety review.
 */

const express = require('express');
const { formatEther } = require('ethers');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const v5roles = require('../v5/roles');
const factoryModule = require('../evm/v5/factory');
const { prepareLaunch, fireLaunch, reconcileLaunch } = require('../v5/launch');

const router = express.Router();

// One launch at a time per account, on TWO levels.
//
// (1) `launching` — the in-process handler guard. v5dev is a singleton, so two
// OVERLAPPING handlers would read the same pending nonce and sign two different
// launches against it. Refused, not raced.
//
// (2) `pendingLaunches` — the in-FLIGHT guard, and the one that actually stops a
// double-SPEND. When a launch is broadcast but its receipt never arrives before
// the timeout, fireLaunch returns status 'pending' and the handler returns — but
// tx A is still live in the mempool at nonce N. Without this guard a retry (a
// double-click, a second tab, an automated retry) would find the handler lock
// free, read the 'pending' nonce as N+1 (tx A occupies N), sign launch B, and
// broadcast it — and if BOTH mine, two launch fees + two atomic first-buys are
// spent for two different tokens. So a 'pending' outcome PARKS the wallet here
// and every further launch is refused until POST /v5/launch/resolve re-checks the
// hash against the chain and clears it. In-memory is sufficient (one process per
// deployment); a process restart clears it, which fails OPEN — see the resolve
// route, which is also how an operator recovers after a restart. v5 keeps its own
// guards rather than sharing v1/v2's, per the tab-isolation rule.
const launching = new Set();
const pendingLaunches = new Map(); // userId -> { hash, nonce, walletId, address, symbol, token, poolId, at }

function withLaunchLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (launching.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch is already in progress for this account — wait for it to finish' });
    }
    const pending = pendingLaunches.get(id);
    if (pending) {
      return res.status(409).json({
        error:
          'a previous v5 launch was broadcast but never confirmed — resolve it before launching again, ' +
          'or a second launch would sign at the next nonce and spend a second fee + first buy alongside it',
        pending,
        resolve: 'POST /api/v5/launch/resolve to re-check it against the chain and clear it',
      });
    }
    launching.add(id);
    try {
      await handler(req, res, next);
    } finally {
      launching.delete(id);
    }
  };
}

// The activity detail persisted for a launch outcome. HONEST about what actually
// happened: token/poolId are the real ones ONLY when the launch confirmed — a
// reverted/pending launch persists null, because its predicted address points at
// a pool that does not exist (yet/ever), and a later Sell/Bundle must not trade
// it. hookResolved travels so a null hook on a confirmed record is never mistaken
// for "ETH pool / config default", and any mismatch/warning the launch itself
// raised is carried so the suspicion stays attached to the pool identity.
function launchActivityDetail(result, plan) {
  const confirmed = result.launch.status === 'confirmed';
  return {
    token: confirmed ? result.token || null : null,
    poolId: confirmed ? result.poolId || null : null,
    hook: result.hook || null, // receipt hook or null — fireLaunch never uses the config default
    hookResolved: Boolean(result.hook),
    quote: plan.quote,
    configId: plan.configId,
    firstBuyEth: plan.launch.firstBuyEth,
    firstBuyOut: result.firstBuyOut || null,
    launchHash: result.launch.hash,
    blockNumber: result.launch.blockNumber,
    status: result.launch.status,
    ...(result.mismatch ? { mismatch: result.mismatch } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

// BigInt -> string everywhere, so a stray wei value cannot turn a good plan into
// "Do not know how to serialize a BigInt". (Same shape as routes/launch.js's
// jsonSafe, kept local so v5's routes are self-contained.)
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

// A plan safe to return over HTTP: the SIGNED launch tx is stripped. Anyone
// holding a raw signed launch could broadcast it, so it never leaves the server —
// exactly as routes/launch.js's publicPlan does for the pons paths.
function publicPlan(plan) {
  return jsonSafe({ ...plan, launch: { ...plan.launch, raw: undefined } });
}

// GET /api/v5/config — the letscash contract map + chain, for the console.
router.get('/v5/config', requireApiKey, (req, res) => {
  res.json({
    chainId: config.chainId,
    explorerUrl: config.explorerUrl,
    letscash: config.letscash,
    roles: v5roles.ROLES,
  });
});

// GET /api/v5/launch/configs — the LIVE launch menu read off the factory: the
// enabled flag + fee, and every config (id, tax tier, quote asset, supply, mode)
// the form's picker offers. Read-only; a heavier call than /v5/config (it walks
// the on-chain config range), so the console fetches it when the Launch step opens.
router.get('/v5/launch/configs', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await factoryModule.getConfigs({ runner: provider })));
  } catch (err) {
    next(err);
  }
});

// GET /api/v5/wallets — the v5dev launcher + v5bundle wallets, with balances.
router.get('/v5/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const withBal = async (w) =>
      w
        ? {
            walletId: w.id,
            address: w.address,
            role: w.role,
            label: w.label,
            balanceEth: formatEther(await provider.getBalance(w.address)),
          }
        : null;
    const bundle = v5roles.bundle(ks);
    res.json({
      dev: await withBal(v5roles.dev(ks)),
      bundle: await Promise.all(bundle.map(withBal)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/wallets/generate — fresh wallets in one of v5's two roles. v5dev
// is a singleton (the keystore refuses a second); v5bundle is plural and, unlike
// v1/v2's bundle, is NOT capped at 31 (that cap is a pons-factory exemption-list
// limit, and letscash has no exemption list).
router.post('/v5/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, label, role = v5roles.ROLES.bundle } = req.body || {};
    if (!v5roles.isV5Role(role)) throw new Error(`role must be ${v5roles.ROLES.dev} or ${v5roles.ROLES.bundle}`);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be 1-100');
    const made = keystoreFor(req.user.id).generate(n, { label, role });
    activityFor(req.user.id).record('v5', `[v5] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(made);
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/launch/preflight — build and SIGN the launch, broadcast nothing.
// The rehearsal: it proves the launcher wallet, the fee + first-buy funds, the
// mined vanity salt, and — via a static simulate — that the launch will not
// revert, before any money moves. Returns the public plan (signed `raw` stripped)
// plus the simulate preview.
router.post('/v5/launch/preflight', requireApiKey, async (req, res, next) => {
  try {
    const plan = await prepareLaunch(req.body || {}, { keystore: keystoreFor(req.user.id) });
    res.json({ plan: publicPlan(plan), simulate: jsonSafe(plan.simulate) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/launch — prepare, then fire. This is a MONEY PATH: it signs and
// broadcasts the real launch and SPENDS the first buy, so it demands an explicit
// { confirm: true }. DRY_RUN still returns a full plan and a simulated result
// without touching the chain.
router.post('/v5/launch', requireApiKey, withLaunchLock(async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error(
        'refusing to launch without { confirm: true } — this signs and broadcasts the launch and spends the first buy'
      );
    }
    const ks = keystoreFor(req.user.id);
    const plan = await prepareLaunch(req.body || {}, { keystore: ks });
    const result = await fireLaunch(plan, {});

    // If the receipt never arrived, PARK the wallet: tx A is still live at nonce N,
    // so a fresh launch now would sign at N+1 and double-spend. The guard is held
    // until POST /v5/launch/resolve confirms A's fate. (Set BEFORE the record, so a
    // record hiccup cannot leave the wallet unguarded.)
    if (result.launch.status === 'pending') {
      pendingLaunches.set(req.user.id, {
        hash: result.launch.hash,
        nonce: plan.launch.nonce,
        walletId: plan.launch.walletId,
        address: plan.launch.address,
        symbol: plan.params.symbol,
        token: plan.token,
        poolId: plan.poolId,
        quote: plan.quote,
        configId: plan.configId,
        firstBuyEth: plan.launch.firstBuyEth,
        at: new Date().toISOString(),
      });
    }

    // Persist the launched token / pool / hook so the later Sell and Bundle steps
    // can find this launch. The RECEIPT's hook is authoritative (per-pool), and
    // token/poolId are persisted as real ONLY when the launch confirmed — see
    // launchActivityDetail. activityFor.record never throws (it is observing work
    // already on chain), so a log hiccup can never fail a launch that confirmed.
    activityFor(req.user.id).record(
      'v5',
      `[v5] launched ${plan.params.symbol} ${result.token || plan.token} (${result.launch.status})`,
      launchActivityDetail(result, plan)
    );

    res.json({ ...jsonSafe(result), plan: publicPlan(plan) });
  } catch (err) {
    next(err);
  }
}));

// POST /api/v5/launch/resolve — reconcile a launch that was broadcast but whose
// receipt never arrived (the /v5/launch response carried status 'pending'). It
// re-fetches the receipt NOW: on a definitive outcome it records the honest result
// and CLEARS the in-flight guard so launching can resume; while the tx is still
// unmined it keeps the guard (a fresh launch would double-spend). This is also the
// recovery path after a process restart drops the in-memory guard — an operator
// who knows a launch was in flight can pass its { hash } explicitly.
router.post('/v5/launch/resolve', requireApiKey, async (req, res, next) => {
  try {
    const id = req.user.id;
    const parked = pendingLaunches.get(id);
    const hash = parked?.hash || req.body?.hash;
    if (!hash) {
      return res.json({ pending: null, message: 'no v5 launch is awaiting reconciliation' });
    }
    const seed = parked || { hash, token: req.body?.token || null, poolId: req.body?.poolId || null };
    const result = await reconcileLaunch(seed, {});

    if (result.launch.status === 'pending') {
      // Still not mined — keep the guard; do not record (nothing definitive yet).
      return res.json({ resolved: false, ...jsonSafe(result) });
    }

    // Definitive (confirmed or reverted): record the honest outcome and release.
    activityFor(id).record(
      'v5',
      `[v5] launch ${hash} reconciled: ${parked?.symbol ? parked.symbol + ' ' : ''}${result.launch.status}`,
      launchActivityDetail(result, {
        quote: seed.quote ?? null,
        configId: seed.configId ?? null,
        launch: { firstBuyEth: seed.firstBuyEth ?? null },
      })
    );
    pendingLaunches.delete(id);
    res.json({ resolved: true, ...jsonSafe(result) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Exposed for the fund-safety tests (the double-launch guard + the honest
// persistence detail), mirroring routes/launch.js.
module.exports.withLaunchLock = withLaunchLock;
module.exports.pendingLaunches = pendingLaunches;
module.exports.launchActivityDetail = launchActivityDetail;
