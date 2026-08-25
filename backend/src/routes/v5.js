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
const { prepareLaunch, fireLaunch, reconcileLaunch, approveQuoteForLaunch, quoteAllowanceStatus } = require('../v5/launch');
const { prepareBundle, fireBundle } = require('../v5/bundle');
const { prepareSell, fireSell } = require('../v5/sell');
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
function withSellLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (selling.has(id)) {
      return res.status(409).json({ error: 'a v5 sell is already in progress for this account' });
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
router.post('/v5/launch/approve', requireApiKey, async (req, res, next) => {
  try {
    // Don't stack an approval onto a launcher that is mid-launch or parked — it
    // would sign behind the in-flight tx. (approveQuoteForLaunch also refuses on
    // an on-chain in-flight nonce; this is the cheaper, clearer first line.)
    if (launching.has(req.user.id) || pendingLaunches.has(req.user.id)) {
      return res
        .status(409)
        .json({ error: 'a v5 launch is in progress or unresolved on the launcher — settle it before approving' });
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
    // Pin the launch's recorded hook (or an explicit override) so the sell targets
    // the exact pool, never a probed/decoy one. prepareSell refuses without it.
    const hook = req.body?.hook || launchedTokenHook(req.user.id, req.body?.token);
    // Derive the quote from the launch record too, so a USDG-launched token sells
    // into its (USDG,token) pool without the console having to know its quote.
    const quote = req.body?.quote || launchedTokenQuote(req.user.id, req.body?.token) || 'eth';
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
    const hook = req.body?.hook || launchedTokenHook(req.user.id, req.body?.token);
    const quote = req.body?.quote || launchedTokenQuote(req.user.id, req.body?.token) || 'eth';
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
module.exports.withBundleLock = withBundleLock;
module.exports.bundling = bundling;
module.exports.publicBundlePlan = publicBundlePlan;
module.exports.assertOwnLaunchedToken = assertOwnLaunchedToken;
module.exports.withSellLock = withSellLock;
module.exports.selling = selling;
module.exports.publicSellPlan = publicSellPlan;
module.exports.launchedTokenHook = launchedTokenHook;
module.exports.launchedTokenQuote = launchedTokenQuote;
