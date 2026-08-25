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
const { formatEther, getAddress } = require('ethers');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const v5roles = require('../v5/roles');
const factoryModule = require('../evm/v5/factory');
// The seasoned-wallet pool is the SHARED v4 seasoning store (aged, pre-funded
// wallets). v5 claims from it into its own v5bundle role, exactly as v3 does — see
// the claim route below. v5 owns its routes; the pool + keystore are shared spine.
const seasoned = require('../v4/seasoned');
const { storeFor } = require('../v4/store');
const { prepareLaunch, fireLaunch, reconcileLaunch, approveQuoteForLaunch, quoteAllowanceStatus } = require('../v5/launch');
const { prepareBundle, fireBundle } = require('../v5/bundle');
const { prepareSell, fireSell } = require('../v5/sell');
const { prepareBundleBuys, fireBundleBuys } = require('../v5/buy');
const { launchThenBundle } = require('../v5/launchBundle');
const { poolFeeStatus } = require('../evm/v5/swap');
const { launcherStatus, withdrawFromLauncher, cancelStuckLauncherTx } = require('../v5/launcher');

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
const resolving = new Set(); // userIds mid-reconcile, so two /resolve calls can't double-record

function withLaunchLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (launching.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch is already in progress for this account — wait for it to finish' });
    }
    // A bundle fan-out spends the SAME v5dev wallet at sequential nonces, so a
    // launch must not start while one is mid-flight (their nonces would collide).
    if (bundling.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 bundle fan-out is in progress on this launcher — wait for it before launching' });
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
    // A launcher withdraw/cancel signs the same v5dev wallet; don't let a launch
    // start mid-withdraw and collide on its nonce (symmetric with the launcher
    // routes' own launching/bundling/selling checks).
    if (launcherBusy.has(id)) {
      return res.status(409).json({ error: 'a v5 launcher action (withdraw/cancel) is in progress — wait for it to finish' });
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
    // The first buy in the config's own quote units (USDG for a USDG launch); null
    // on the reconcile path, which has no full plan.
    firstBuyAmount: plan.launch.firstBuyAmount ?? null,
    firstBuyQuote: plan.firstBuyQuote ?? null,
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

// The bundle plan's secret is every transfer's SIGNED raw — strip them all, the
// same way publicPlan strips the launch's. The rest (who gets how much) is safe.
function publicBundlePlan(plan) {
  return jsonSafe({ ...plan, transfers: (plan.transfers || []).map((t) => ({ ...t, raw: undefined })) });
}

// The buy plan's secret is every wallet's signed buy — strip them.
function publicBuyPlan(plan) {
  return jsonSafe({ ...plan, buys: (plan.buys || []).map((b) => ({ ...b, raw: undefined })) });
}

// The sell plan's secrets are every wallet's signed approvals + sell. Strip them.
function publicSellPlan(plan) {
  return jsonSafe({
    ...plan,
    wallets: (plan.wallets || []).map((w) => ({
      ...w,
      approvals: (w.approvals || []).map((a) => ({ ...a, raw: undefined })),
      sell: { ...w.sell, raw: undefined },
    })),
  });
}

// One bundle fan-out at a time per account: the transfers are signed at the
// launcher's sequential nonces, so two overlapping runs would sign against the
// same nonces and collide (or, if the first has landed, re-split a smaller
// balance). Refused, not raced — the same discipline as the launch lock.
const bundling = new Set();
function withBundleLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (bundling.has(id)) {
      return res.status(409).json({ error: 'a v5 bundle fan-out is already in progress for this account' });
    }
    // The launcher wallet is shared with the launch path. Don't fan out while a
    // launch is running or parked-unconfirmed on it — the on-chain settled-nonce
    // gate in prepareBundle is the real guard, but refusing here is cheaper and
    // gives a clearer message.
    if (launching.has(id) || pendingLaunches.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch is in progress or unresolved on this launcher — settle it before bundling' });
    }
    if (launcherBusy.has(id)) {
      return res.status(409).json({ error: 'a v5 launcher action (withdraw/cancel) is in progress — wait for it to finish' });
    }
    bundling.add(id);
    try {
      await handler(req, res, next);
    } finally {
      bundling.delete(id);
    }
  };
}

// One exit at a time per account. A sell spends the BUNDLE wallets (not v5dev), so
// it does not collide with a launch's nonces — but it must not run while a bundle
// is still landing tokens INTO those wallets, or it would exit a half-settled
// balance. Refuse a concurrent sell, and a sell while a bundle is mid-flight.
const selling = new Set();
// Per-wallet BUYS (the v1-style bundle) spend the SAME bundle wallets as the sell,
// so buy and sell are mutually exclusive per account.
const buying = new Set();
function withSellLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (selling.has(id)) {
      return res.status(409).json({ error: 'a v5 sell is already in progress for this account' });
    }
    if (buying.has(id)) {
      return res.status(409).json({ error: 'a v5 bundle buy is in progress on these wallets — let it finish before selling' });
    }
    if (bundling.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 bundle is still landing into the bundle wallets — let it settle before selling' });
    }
    selling.add(id);
    try {
      await handler(req, res, next);
    } finally {
      selling.delete(id);
    }
  };
}
function withBuyLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (buying.has(id)) {
      return res.status(409).json({ error: 'a v5 bundle buy is already in progress for this account' });
    }
    if (selling.has(id)) {
      return res.status(409).json({ error: 'a v5 sell is in progress on these wallets — let it finish before buying' });
    }
    if (bundling.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 bundle is still landing into the bundle wallets — let it settle before buying' });
    }
    buying.add(id);
    try {
      await handler(req, res, next);
    } finally {
      buying.delete(id);
    }
  };
}

// F3 — PIN the bundle's token to one this account actually launched. `token` is
// caller-supplied; without this an arbitrary (or fat-fingered) address could be
// fanned out. The launched tokens are the confirmed-launch rows in this user's own
// v5 activity. A token that is not among them is refused unless the caller sets
// `allowUnlistedToken: true` (the escape hatch for a token launched before the
// activity log existed / was trimmed — used knowingly, never by default).
function assertOwnLaunchedToken(userId, token, allowUnlisted) {
  if (allowUnlisted === true) return;
  const want = String(token || '').toLowerCase();
  const launched = new Set(
    activityFor(userId)
      .list({ kind: 'v5', limit: 500 })
      // activity.record spreads the detail at the TOP LEVEL of the entry (not under
      // e.detail), so the launched token is e.token, not e.detail.token.
      .map((e) => e.token)
      .filter(Boolean)
      .map((t) => String(t).toLowerCase())
  );
  if (!launched.has(want)) {
    throw new Error(
      `token ${token} is not among this account's launched letscash tokens — bundle a token you launched ` +
        'here, or pass { allowUnlistedToken: true } if you are certain this is yours'
    );
  }
}

// The AUTHORITATIVE per-pool hook for a launched token, from this user's own v5
// activity (the launch persisted the receipt hook). The sell path pins this so it
// targets the exact launched pool instead of probing candidate hooks — see the
// decoy-pool guard in v5/sell.js. Newest matching record wins; null if none.
function launchedTokenHook(userId, token) {
  const want = String(token || '').toLowerCase();
  const entry = activityFor(userId)
    .list({ kind: 'v5', limit: 500 })
    // detail is spread at the top level of the entry (see activity.record), so the
    // fields are e.token / e.hook, not e.detail.*.
    .find((e) => e.token && String(e.token).toLowerCase() === want && e.hook);
  return entry ? entry.hook : null;
}

// The token's QUOTE asset, from the same launch record. A USDG-quoted token trades
// in a (USDG, token) pool, so the sell must resolve against USDG — but the sell
// input defaults to ETH, and the console never sends a quote, so without this a
// USDG token would resolve a non-existent ETH pool and be unsellable. Returns
// 'usdg' | 'eth' | null (no record). The launch persisted detail.quote as the
// quote ADDRESS (0x0 for ETH, the USDG address for USDG).
function launchedTokenQuote(userId, token) {
  const want = String(token || '').toLowerCase();
  const usdg = String(config.letscash.usdg).toLowerCase();
  const entry = activityFor(userId)
    .list({ kind: 'v5', limit: 500 })
    .find((e) => e.token && String(e.token).toLowerCase() === want && e.quote);
  if (!entry) return null;
  const q = String(entry.quote).toLowerCase();
  return q === usdg ? 'usdg' : 'eth';
}

function sameAddress(a, b) {
  try {
    return getAddress(String(a)) === getAddress(String(b));
  } catch {
    return false;
  }
}
function normQuote(q) {
  const s = String(q || '').toLowerCase();
  return s === 'usdg' || s === String(config.letscash.usdg).toLowerCase() ? 'usdg' : 'eth';
}

// Resolve the {hook, quote} a sell must target, with the RECEIPT record as the
// authority. For a token this account launched, the persisted receipt hook + quote
// WIN — a client-supplied hook/quote is accepted only if it MATCHES (it can never
// override the decoy-pool guard's authoritative pool). For an unlisted token
// (allowUnlistedToken), there is nothing to pin against, so the operator must
// supply the exact identity — and a hook without a quote is refused, because
// assuming ETH could route a USDG token's exit into a seeded (ETH,token) decoy.
function resolveSellPool(userId, body = {}) {
  const recordedHook = launchedTokenHook(userId, body.token);
  const recordedQuote = launchedTokenQuote(userId, body.token); // 'usdg' | 'eth' | null
  if (recordedHook) {
    if (body.hook && !sameAddress(body.hook, recordedHook)) {
      throw new Error(
        "the supplied hook does not match this token's launch record — refusing (the receipt hook is " +
          'authoritative for the decoy-pool guard)'
      );
    }
    if (body.quote && normQuote(body.quote) !== (recordedQuote || 'eth')) {
      throw new Error("the supplied quote does not match this token's launch record");
    }
    return { hook: recordedHook, quote: recordedQuote || 'eth' };
  }
  if (body.hook && !body.quote) {
    throw new Error('for an unlisted token, pass an explicit quote ("eth" or "usdg") alongside the hook');
  }
  return { hook: body.hook, quote: body.quote || 'eth' };
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

// POST /api/v5/wallets/import — import existing wallets by private key into a v5
// role. A bundler wants aged/existing wallets, not only fresh ones (fresh wallets
// are a fingerprint). NOT capped at 31 — that limit is the pons factory's
// exemption list, which letscash does not have. Keys are never logged (only the
// derived addresses), mirroring the shared import.
router.post('/v5/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, label, role = v5roles.ROLES.bundle } = req.body || {};
    if (!v5roles.isV5Role(role)) throw new Error(`role must be ${v5roles.ROLES.dev} or ${v5roles.ROLES.bundle}`);
    const keys = (Array.isArray(privateKeys) ? privateKeys : String(privateKeys || '').split(/[\s,]+/)).filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');
    // v5dev is a singleton — the keystore refuses a second, so importing >1 into it
    // (or a second when one exists) fails loudly there.
    const added = keystoreFor(req.user.id).importKeys(keys, { label, role });
    activityFor(req.user.id).record('v5', `[v5] imported ${added.length} ${role} wallet(s)`, {
      role,
      addresses: added.map((w) => w.address),
    });
    res.json(added);
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/wallets/claim-seasoned — pull N finished-seasoning wallets from the
// shared v4 pool into v5's bundle role, most-aged first. They arrive pre-aged and
// pre-funded — organic-looking bundle wallets, the whole point of seasoning.
// Mirrors /v3/wallets/claim-seasoned; refused while a v5 money path is active or a
// launch is parked, since claiming re-roles wallets a prepare step may resolve.
router.post('/v5/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    const id = req.user.id;
    if (launching.has(id) || bundling.has(id) || selling.has(id) || buying.has(id) || launcherBusy.has(id) || pendingLaunches.has(id)) {
      throw new Error('a v5 launch/bundle/sell/launcher action is in progress or unresolved — settle it before claiming wallets');
    }
    const ks = keystoreFor(id);
    const store = storeFor(id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    if (take.length === 0) {
      return res.json(jsonSafe({ claimed: [], available: pool.length, shortfall: want }));
    }
    const out = seasoned.claim(ks, store, take.map((w) => w.id), {
      toRole: v5roles.ROLES.bundle,
      toTab: 'v5',
      now: Date.now(),
    });
    activityFor(id).record('v5', `[v5] claimed ${out.claimed.length} seasoned wallet(s) into the bundle`, {
      count: out.claimed.length,
    });
    res.json(jsonSafe({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) }));
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

// GET /api/v5/launch/quote-allowance — the launcher's USDG balance + its allowance
// to the factory, so the console can tell whether a USDG first buy is fundable and
// approved before a launch is attempted. ?quote overrides USDG (default).
router.get('/v5/launch/quote-allowance', requireApiKey, async (req, res, next) => {
  try {
    const out = await quoteAllowanceStatus({ quote: req.query?.quote }, { keystore: keystoreFor(req.user.id) });
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/launch/approve — approve the factory to pull the launcher's USDG for
// a first buy (a one-time setup, separate from the launch so the allowance exists
// on-chain before preflight simulates). Broadcasts one approval from the launcher.
// { amount } bounds it (whole USDG units); omit for MAX.
router.post('/v5/launch/approve', requireApiKey, withLauncherLock(async (req, res, next) => {
  try {
    // The approve signs the singleton v5dev wallet, so it must be mutually excluded
    // from every other v5dev spender. withLauncherLock holds launcherBusy (which the
    // launch + bundle locks honour); this also refuses while a launch/bundle handler
    // is mid-flight or a launch is parked, closing the TOCTOU where two preparers
    // read the same settled nonce.
    if (launching.has(req.user.id) || bundling.has(req.user.id) || pendingLaunches.has(req.user.id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch or bundle is in progress or unresolved on the launcher — settle it before approving' });
    }
    const out = await approveQuoteForLaunch(req.body || {}, { keystore: keystoreFor(req.user.id) });
    activityFor(req.user.id).record('v5', `[v5] approved factory to pull ${out.amount} USDG (${out.status})`, {
      kind: 'approve-quote',
      quote: out.quote,
      spender: out.spender,
      amount: out.amount,
      hash: out.hash,
      status: out.status,
    });
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
}));

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
// receipt never arrived (the /v5/launch response carried status 'pending', OR its
// broadcast response was lost). It re-fetches the receipt NOW: on a DEFINITIVE
// outcome (confirmed / reverted / dropped) it records the honest result and CLEARS
// the in-flight guard so launching can resume; while the tx is still in the mempool
// it keeps the guard (a fresh launch would double-spend). A 'dropped' outcome — the
// tx is gone from the mempool and never mined, so its nonce is free — is what saves
// an evicted launch from parking the wallet forever. This is also the recovery path
// after a process restart drops the in-memory guard: an operator who knows a launch
// was in flight can pass its { hash, address, nonce } explicitly.
router.post('/v5/launch/resolve', requireApiKey, async (req, res, next) => {
  const id = req.user.id;
  // Serialise reconciles per account, so two concurrent /resolve calls cannot both
  // read the same marker and double-record before either clears it.
  if (resolving.has(id)) {
    return res.status(409).json({ error: 'a v5 launch reconcile is already in progress for this account' });
  }
  resolving.add(id);
  try {
    const parked = pendingLaunches.get(id);
    const hash = parked?.hash || req.body?.hash;
    if (!hash) {
      return res.json({ pending: null, message: 'no v5 launch is awaiting reconciliation' });
    }
    // For an operator-supplied hash (post-restart recovery), address+nonce let
    // reconcile detect a dropped tx; without them it can still confirm/revert.
    const seed = parked || {
      hash,
      token: req.body?.token || null,
      poolId: req.body?.poolId || null,
      address: req.body?.address || null,
      nonce: req.body?.nonce != null ? Number(req.body.nonce) : null,
    };
    const result = await reconcileLaunch(seed, {});

    if (result.launch.status === 'pending') {
      // Still in the mempool — keep the guard; do not record (nothing definitive).
      return res.json({
        resolved: false,
        ...jsonSafe(result),
        hint:
          'still unconfirmed. If it is genuinely stuck (neither mining nor dropping), replace it via ' +
          'POST /v5/launcher/cancel to un-brick the launcher, then resolve again.',
      });
    }

    // Definitive (confirmed / reverted / dropped): record the honest outcome and release.
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
  } finally {
    resolving.delete(id);
  }
});

// POST /api/v5/launch-bundle/preflight — the money-risk REHEARSAL for the combined
// Launch + bundle. It prepares (simulates + signs, broadcasts nothing) the LAUNCH,
// which is the only part that can revert and burn a fee. The per-wallet bundle buys
// cannot be quoted until the pool exists (the launch creates it), so they are echoed
// back for review only; their real quote + floor is built at FIRE time against the
// confirmed pool. Returns the launch plan (its signed launch stripped).
router.post('/v5/launch-bundle/preflight', requireApiKey, async (req, res, next) => {
  try {
    const { buys, slippageBps, buyGas, confirm, ...launchInput } = req.body || {};
    const plan = await prepareLaunch(launchInput, { keystore: keystoreFor(req.user.id) });
    // Count 'all − gas' wallets too — they carry no amountEth, so an amount>0
    // filter would undercount an all-gas bundle to zero (mirrors launchThenBundle).
    const intended = (Array.isArray(buys) ? buys : []).filter(
      (b) =>
        b &&
        (String(b.mode || '').toLowerCase() === 'all' ||
          Number(String(b.amountEth ?? b.amount ?? '0').trim() || '0') > 0)
    );
    res.json({
      plan: publicPlan(plan),
      simulate: jsonSafe(plan.simulate),
      bundle: {
        walletCount: intended.length,
        note:
          'the bundle buys fire the instant the launch confirms, against the real pool; their per-wallet ' +
          'quote (and the flat tax they pay) is built then, so nothing is signed for them at preflight.',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/launch-bundle — the COMBINED "Launch + bundle", uniform with the pons
// v1 Launcher tab: fire the launch (with the launcher's atomic first buy inside it),
// and the instant it confirms, fire every bundle wallet's buy against the real pool.
// A MONEY PATH → { confirm: true }. It spends BOTH the launcher (launch + first buy)
// AND the bundle wallets (their buys), so it holds the launch lock AND the buy lock,
// and refuses to start while a sell or a standalone bundle buy is touching the same
// bundle wallets. A launch that confirms is NEVER discarded for a bundle problem —
// see v5/launchBundle.js: the response then carries `bundleSkipped` and the operator
// fires the bundle from the Bundle step.
router.post('/v5/launch-bundle', requireApiKey, withLaunchLock(async (req, res, next) => {
  const id = req.user.id;
  // The bundle portion spends the bundle wallets — refuse a concurrent sell/buy on
  // them, and HOLD `buying` for the whole op so one cannot start mid-flight. (The
  // launch lock, held by withLaunchLock, already excludes another launch/fan-out.)
  if (selling.has(id) || buying.has(id)) {
    return res.status(409).json({
      error:
        'a v5 sell or bundle buy is in progress on the bundle wallets — let it finish before a combined launch + bundle',
    });
  }
  buying.add(id);
  try {
    if (req.body?.confirm !== true) {
      throw new Error(
        'refusing to launch + bundle without { confirm: true } — this signs and broadcasts the launch, ' +
          'spends the first buy, and buys from every funded bundle wallet'
      );
    }
    const ks = keystoreFor(id);
    const { launch: result, launchPlan: plan, bundle, buyPlan, bundleSkipped } = await launchThenBundle(
      req.body || {},
      { keystore: ks }
    );

    // Park a launch whose receipt never arrived — identical to the standalone
    // /v5/launch, so a retry cannot sign a second launch at the next nonce.
    if (result.launch.status === 'pending') {
      pendingLaunches.set(id, {
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

    // Record the launch first (this is what pins the token/pool/hook for a later
    // manual bundle/sell, including the `bundleSkipped` recovery path).
    activityFor(id).record(
      'v5',
      `[v5] launched ${plan.params.symbol} ${result.token || plan.token} (${result.launch.status})`,
      launchActivityDetail(result, plan)
    );

    // Record the bundle buys, when any fired.
    if (bundle && buyPlan) {
      activityFor(id).record(
        'v5',
        `[v5] bundle buy ${buyPlan.symbol}: ${bundle.bought}/${buyPlan.walletCount} wallet(s) bought` +
          (bundle.failed ? `, ${bundle.failed} failed` : '') +
          (bundle.pending ? `, ${bundle.pending} pending` : ''),
        {
          kind: 'bundle-buy',
          token: buyPlan.token,
          symbol: buyPlan.symbol,
          walletCount: buyPlan.walletCount,
          totalEth: buyPlan.totalEth,
          bought: bundle.bought,
          failed: bundle.failed,
          pending: bundle.pending,
        }
      );
    }

    res.json({
      ...jsonSafe(result),
      plan: publicPlan(plan),
      bundle: bundle ? jsonSafe(bundle) : null,
      buyPlan: buyPlan ? publicBuyPlan(buyPlan) : null,
      bundleSkipped: bundleSkipped || null,
    });
  } catch (err) {
    next(err);
  } finally {
    buying.delete(id);
  }
}));

// POST /api/v5/bundle/preflight — build and SIGN the untaxed token fan-out from
// the launcher to the bundle wallets, broadcast nothing. Returns the public plan
// (each transfer's signed raw stripped) so the operator can read who gets how much
// before anything moves.
router.post('/v5/bundle/preflight', requireApiKey, async (req, res, next) => {
  try {
    assertOwnLaunchedToken(req.user.id, req.body?.token, req.body?.allowUnlistedToken);
    const plan = await prepareBundle(req.body || {}, { keystore: keystoreFor(req.user.id) });
    res.json({ plan: publicBundlePlan(plan) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/bundle — prepare, then fire the fan-out. A MONEY PATH (it moves the
// launched supply), so it demands { confirm: true }. DRY_RUN returns a simulated
// result without broadcasting. One fan-out at a time per account.
router.post('/v5/bundle', requireApiKey, withBundleLock(async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error('refusing to fan out without { confirm: true } — this moves the launched supply');
    }
    assertOwnLaunchedToken(req.user.id, req.body?.token, req.body?.allowUnlistedToken);
    const ks = keystoreFor(req.user.id);
    const plan = await prepareBundle(req.body || {}, { keystore: ks });
    const result = await fireBundle(plan, {});

    activityFor(req.user.id).record(
      'v5',
      `[v5] bundled ${plan.symbol}: ${result.sent}/${plan.count} transfer(s) confirmed` +
        (result.failed ? `, ${result.failed} failed` : '') +
        (result.pending ? `, ${result.pending} pending` : ''),
      {
        kind: 'bundle',
        token: plan.token,
        symbol: plan.symbol,
        count: plan.count,
        totalOut: plan.totalOut,
        sent: result.sent,
        failed: result.failed,
        pending: result.pending,
      }
    );

    res.json({ ...jsonSafe(result), plan: publicBundlePlan(plan) });
  } catch (err) {
    next(err);
  }
}));

// POST /api/v5/sell/preflight — build and SIGN the whole exit (per wallet: two
// Permit2 approvals + the V4 sell), broadcast nothing. Returns the public plan
// (every signed raw stripped) plus the per-wallet token counts and best-effort ETH
// estimates. Worth running: it is where the estimate comes from, and it verifies
// the pool exists before any approval is signed.
router.post('/v5/sell/preflight', requireApiKey, async (req, res, next) => {
  try {
    assertOwnLaunchedToken(req.user.id, req.body?.token, req.body?.allowUnlistedToken);
    // The launch's recorded receipt hook + quote are authoritative (decoy-pool
    // guard); a client hook/quote is honoured only if it matches. See resolveSellPool.
    const { hook, quote } = resolveSellPool(req.user.id, req.body || {});
    const plan = await prepareSell({ ...(req.body || {}), hook, quote }, { keystore: keystoreFor(req.user.id) });
    res.json(publicSellPlan(plan));
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/sell — prepare, then fire the exit. Irreversible and touches every
// holding wallet, so it demands { confirm: true }. DRY_RUN returns a simulated
// result without broadcasting. One exit at a time per account.
router.post('/v5/sell', requireApiKey, withSellLock(async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error('refusing to sell without { confirm: true } — this exits every holding wallet, irreversibly');
    }
    assertOwnLaunchedToken(req.user.id, req.body?.token, req.body?.allowUnlistedToken);
    const { hook, quote } = resolveSellPool(req.user.id, req.body || {});
    const ks = keystoreFor(req.user.id);
    const plan = await prepareSell({ ...(req.body || {}), hook, quote }, { keystore: ks });
    const result = await fireSell(plan, {});

    activityFor(req.user.id).record(
      'v5',
      `[v5] sold ${plan.symbol}: ${result.sold}/${plan.walletCount} wallet(s) exited` +
        (result.failed ? `, ${result.failed} failed` : '') +
        (result.pending ? `, ${result.pending} pending` : ''),
      {
        kind: 'sell',
        token: plan.token,
        symbol: plan.symbol,
        walletCount: plan.walletCount,
        totalTokens: plan.totalTokens,
        sold: result.sold,
        failed: result.failed,
        pending: result.pending,
      }
    );

    res.json({ ...jsonSafe(result), plan: publicSellPlan(plan) });
  } catch (err) {
    next(err);
  }
}));

// GET /api/v5/pool-fee — the live tax a normal wallet pays on this token's pool
// right now, its base rate, and (only for the rare pool with an anti-snipe premium)
// when the premium finishes decaying to base. In practice letscash launches are
// FLAT, so hasDecay is almost always false and current == base. Read-only; the hook
// is pinned from the launch record. ?token=… (and optional ?hook/?quote overrides).
router.get('/v5/pool-fee', requireApiKey, async (req, res, next) => {
  try {
    const body = { token: req.query?.token, hook: req.query?.hook, quote: req.query?.quote };
    const { hook } = resolveSellPool(req.user.id, body);
    const out = await poolFeeStatus({ token: body.token, quote: 'eth', hook }, { provider });
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/bundle-buy/preflight — the V1-style bundle: build and SIGN a buy for
// every bundle wallet that has a buy amount (each buys the token from the pool with
// its own ETH), broadcast nothing. Returns the plan raw-stripped, with the per-wallet
// expected tokens the CURRENT tax gives — run it after the anti-snipe tax has decayed.
router.post('/v5/bundle-buy/preflight', requireApiKey, async (req, res, next) => {
  try {
    assertOwnLaunchedToken(req.user.id, req.body?.token, req.body?.allowUnlistedToken);
    const { hook, quote } = resolveSellPool(req.user.id, req.body || {});
    const plan = await prepareBundleBuys({ ...(req.body || {}), hook, quote }, { keystore: keystoreFor(req.user.id) });
    res.json(publicBuyPlan(plan));
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/bundle-buy — prepare, then fire the per-wallet buys. A MONEY PATH →
// { confirm:true }. Broadcasts each wallet's buy. One buy run at a time, and never
// alongside a sell (both spend the same bundle wallets).
router.post('/v5/bundle-buy', requireApiKey, withBuyLock(async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error('refusing to buy without { confirm: true } — this spends each bundle wallet\'s ETH');
    }
    assertOwnLaunchedToken(req.user.id, req.body?.token, req.body?.allowUnlistedToken);
    const { hook, quote } = resolveSellPool(req.user.id, req.body || {});
    const ks = keystoreFor(req.user.id);
    const plan = await prepareBundleBuys({ ...(req.body || {}), hook, quote }, { keystore: ks });
    const result = await fireBundleBuys(plan, {});

    activityFor(req.user.id).record(
      'v5',
      `[v5] bundle buy ${plan.symbol}: ${result.bought}/${plan.walletCount} wallet(s) bought` +
        (result.failed ? `, ${result.failed} failed` : '') +
        (result.pending ? `, ${result.pending} pending` : ''),
      {
        kind: 'bundle-buy',
        token: plan.token,
        symbol: plan.symbol,
        walletCount: plan.walletCount,
        totalEth: plan.totalEth,
        bought: result.bought,
        failed: result.failed,
        pending: result.pending,
      }
    );

    res.json({ ...jsonSafe(result), plan: publicBuyPlan(plan) });
  } catch (err) {
    next(err);
  }
}));

// ── launcher rescue: get value OUT of v5dev, and un-stick it ───────────────────
// The launcher is a one-way value sink (fund/bundle spend into the bundle wallets,
// sweep pulls into it) and a stuck launcher tx bricks new launches. These are the
// console paths to withdraw surplus and to replace a stuck nonce.

// serialise launcher withdraw/cancel per account (both sign from the singleton v5dev).
const launcherBusy = new Set();
function withLauncherLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (launcherBusy.has(id)) {
      return res.status(409).json({ error: 'a v5 launcher action is already in progress for this account' });
    }
    launcherBusy.add(id);
    try {
      await handler(req, res, next);
    } finally {
      launcherBusy.delete(id);
    }
  };
}

// GET /api/v5/launcher/status — the launcher's ETH + USDG (and, with ?token=, a
// token) balances, and whether it has a stuck/unconfirmed tx. Read-only.
router.get('/v5/launcher/status', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await launcherStatus({ token: req.query?.token }, { keystore: keystoreFor(req.user.id) })));
  } catch (err) {
    next(err);
  }
});

// POST /api/v5/launcher/withdraw — send ETH or an ERC-20 (asset: 'eth'|'usdg'|
// <address>) from the launcher to an external address. A MONEY PATH → { confirm:true }.
// Refused while a launch/bundle/sell is active or a launch is parked (all spend the
// same wallet), and while the launcher has an unconfirmed tx (cancel that first).
router.post('/v5/launcher/withdraw', requireApiKey, withLauncherLock(async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error('refusing to withdraw without { confirm: true } — this moves funds out of the launcher');
    }
    const id = req.user.id;
    if (launching.has(id) || bundling.has(id) || selling.has(id) || pendingLaunches.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch/bundle/sell is active or unresolved — settle it before withdrawing from the launcher' });
    }
    const out = await withdrawFromLauncher(req.body || {}, { keystore: keystoreFor(id) });
    activityFor(id).record('v5', `[v5] withdrew ${out.amount} ${out.asset} from launcher → ${out.to} (${out.status})`, {
      kind: 'launcher-withdraw',
      asset: out.asset,
      token: out.token || null,
      to: out.to,
      amount: out.amount,
      hash: out.hash,
      status: out.status,
    });
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
}));

// POST /api/v5/launcher/cancel — replace a stuck launcher tx (0-value self-transfer
// at the stuck nonce with a bumped fee). { confirm:true }. Intentionally NOT blocked
// by pendingLaunches — un-sticking a parked/stuck launch is its whole purpose. After
// it lands, run /v5/launch/resolve so the parked marker clears (the old tx drops).
router.post('/v5/launcher/cancel', requireApiKey, withLauncherLock(async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error('refusing to cancel without { confirm: true } — this replaces the launcher\'s stuck transaction');
    }
    const id = req.user.id;
    if (launching.has(id) || bundling.has(id) || selling.has(id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch/bundle/sell handler is running — let it finish before cancelling' });
    }
    const out = await cancelStuckLauncherTx(req.body || {}, { keystore: keystoreFor(id) });
    activityFor(id).record(
      'v5',
      out.nothingStuck
        ? '[v5] launcher cancel: nothing to cancel'
        : `[v5] cancelled launcher tx at nonce ${out.nonce} (${out.status})`,
      { kind: 'launcher-cancel', nonce: out.nonce ?? null, hash: out.hash || null, status: out.status || 'none' }
    );
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
}));

module.exports = router;
// Exposed for the fund-safety tests (the double-launch guard + the honest
// persistence detail), mirroring routes/launch.js.
module.exports.withLaunchLock = withLaunchLock;
module.exports.pendingLaunches = pendingLaunches;
module.exports.launchActivityDetail = launchActivityDetail;
module.exports.publicPlan = publicPlan;
module.exports.withBundleLock = withBundleLock;
module.exports.bundling = bundling;
module.exports.publicBundlePlan = publicBundlePlan;
module.exports.assertOwnLaunchedToken = assertOwnLaunchedToken;
module.exports.withSellLock = withSellLock;
module.exports.selling = selling;
module.exports.publicSellPlan = publicSellPlan;
module.exports.withBuyLock = withBuyLock;
module.exports.buying = buying;
module.exports.publicBuyPlan = publicBuyPlan;
module.exports.launchedTokenHook = launchedTokenHook;
module.exports.launchedTokenQuote = launchedTokenQuote;
module.exports.resolveSellPool = resolveSellPool;
