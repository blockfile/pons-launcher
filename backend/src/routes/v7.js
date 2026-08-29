'use strict';

/**
 * Every /api/v7/* endpoint — the flap.sh bonding-curve relay chain's whole surface.
 *
 * Mounted beside the others and detachable in one line (the isolation rule). This is
 * routes/v6.js ported to flap: the engine validates the SHAPE of a run (intervals, jitter,
 * positive amounts, no duplicate wallets); everything that needs the chain is validated
 * HERE first.
 *
 * WHERE THE DUSTING GUARD LIVES. A run signs a token approval, and an approval to a hostile
 * ERC-20 is the dusting attack. V7's guard is trade.readCurve(), one eth_getCode plus two
 * eth_calls, no getLogs: (1) the token must be an EIP-1167 clone of a flap tokenMaster (a
 * decoy ERC-20 has its own bytecode and is rejected); (2) its quoteToken() must be WNATIVE,
 * so every value hop stays native; (3) its state() must be BondingCurve(0) — a graduated
 * token trades on a V2 pair V7 does not touch, and is refused.
 *
 * THE FLAP-SPECIFIC GUARD v6 NEVER HAD: GRADUATION. A big buy sized large enough to push the
 * token's tokens-sold to its dexSupplyThresh would saturate the curve and could graduate the
 * token mid-run, stranding the whole position on the V2 venue. chain/start HARD-REFUSES such
 * a big buy (no force bypass), the same way v6 hard-refused a sells-revert honeypot.
 */

const express = require('express');
const { formatEther, formatUnits, getAddress, parseEther } = require('ethers');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey, requireAuthConfigured } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const config = require('../config');
const { ethPriceUsd } = require('../ethPrice');
const v7roles = require('../v7/roles');
const trade = require('../v7/trade');
const relay = require('../v7/relay');
const sizing = require('../v7/sizing');
const engine = require('../v7/engine');
const exit = require('../v7/exit');
const sweep = require('../v7/sweep');
const { storeFor } = require('../v4/store');
const seasoned = require('../v4/seasoned');

const router = express.Router();

// A hard ceiling on how long the pre-flight (resolve + feasibility) may run before a chain
// route answers. A degraded / rate-limited RPC can make the curve read and the live quotes
// retry for minutes — long past the 60s gateway — during which the operator sees only
// "working…", then the modal gives up, WHILE the handler keeps running and eventually starts
// the run anyway (the big buy fires minutes later, out of nowhere). Bounding it FAIL-CLOSED:
// if validation cannot finish in time the route throws and NOTHING is started, so the
// operator gets a clear "try again" instead of a phantom run. Env-overridable; under the 60s
// gateway. (Same fix as routes/v6.js.)
const PREFLIGHT_TIMEOUT_MS = Number(process.env.V7_PREFLIGHT_TIMEOUT_MS) || 45_000;

/**
 * Race a pre-flight promise against a deadline. On expiry it REJECTS (the caller throws and
 * starts nothing); the losing promise keeps running to completion in the background but its
 * result is discarded, so no run is ever scheduled off a timed-out validation.
 */
function withDeadline(promise, ms, label) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${Math.round(ms / 1000)}s — the RPC is slow right now, so nothing was ` +
              `started. Try again in a moment.`
          )
        ),
      ms
    );
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

/** BigInts out of the response — local copy so this file stays detachable. */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** An ETH string to wei, refusing anything that is not a number. */
function parseAmount(value, what) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^\d*\.?\d+$/.test(raw)) throw new Error(`${what} must be a number of ETH`);
  return parseEther(raw);
}

/** A wei amount as dollars, or null when no price is available. */
function usd(wei, price) {
  if (!price) return null;
  return (Number(formatEther(wei)) * price).toFixed(2);
}

/** The 4-byte custom-error selector from a reverted eth_call, or null. */
function revertSelector(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data || err?.value?.data;
  return typeof data === 'string' && data.length >= 10 ? data.slice(0, 10) : null;
}

/**
 * Narrow a full V7-wallet list to what a backup request asked for.
 *
 * Absent or empty filter → the whole list unchanged, so the plain "Download
 * backup" and every older caller stay byte-identical. Optionally NARROWED so a
 * single panel can back up only its own wallets (role) or the operator can
 * export a hand-picked selection (walletIds); the two may combine (role AND
 * ids). The list handed in is already gated to V7's own roles, so no filter can
 * ever widen it to another tab's keys — an unknown role or an id V7 does not own
 * simply matches nothing rather than reaching for it.
 */
function selectBackupWallets(wallets, body = {}) {
  const ids =
    Array.isArray(body.walletIds) && body.walletIds.length ? new Set(body.walletIds.map(String)) : null;
  const role = typeof body.role === 'string' && v7roles.isV7Role(body.role) ? body.role : null;
  let out = wallets;
  if (role) out = out.filter((w) => w.role === role);
  if (ids) out = out.filter((w) => ids.has(String(w.id)));
  return out;
}

/** The big-buy graduation cap: maxHeadroomFrac of the tokens left before graduation. */
function graduationCap(pool) {
  const headroom = pool.headroomTokens ?? 0n;
  return (headroom * BigInt(Math.round(config.flap.maxHeadroomFrac * 100))) / 100n;
}

/** How far along the curve the token is, 0..100 (informational). */
function pctSold(pool) {
  const thresh = pool.dexSupplyThresh ?? 0n;
  if (thresh <= 0n) return 0;
  return Number((pool.circulatingSupply * 10_000n) / thresh) / 100;
}

/**
 * Turn a request body into what the engine takes, refusing everything that cannot be
 * checked without reading the chain first. readCurve is the load-bearing gate.
 */
async function resolveRun(body = {}, ks, deps = {}) {
  const t = deps.trade || trade;
  const rpc = deps.rpc || provider;
  const getFeesFn = deps.getFeesFn || getFees;

  if (!body.token) throw new Error('token is required');
  const token = getAddress(body.token);

  // The dusting guard + the curve the run trades: resolve + VERIFY a live, native-quoted,
  // state-0 flap curve. Throws if the token is not a genuine flap launch, is not
  // native-quoted, or has graduated — so no approval is ever signed for a token that does
  // not really trade on the flap curve.
  const pool = await t.readCurve({ token, quote: 'eth' }, deps);

  const main = v7roles.main(ks); // throws naming v7main
  const bundle = v7roles.bundle(ks);
  if (!bundle.length) throw new Error('no v7 bundle wallet — generate some on the V7 tab first');

  // No per-wallet amount: the position is divided across however many wallets are in the
  // run, one cycle each, sized as it goes. Omitting `targets` means every bundle wallet,
  // which is what the console sends.
  const requested =
    Array.isArray(body.targets) && body.targets.length ? body.targets : bundle.map((w) => ({ walletId: w.id }));
  const known = new Map(bundle.map((w) => [w.id, w]));
  const targets = requested.map((tt) => {
    const wallet = known.get(tt.walletId);
    if (!wallet) throw new Error(`wallet ${tt.walletId} is not a v7 bundle wallet`);
    return { walletId: wallet.id, address: wallet.address };
  });

  const bigBuyWei = parseAmount(body.bigBuyEth, 'the big buy');
  if (bigBuyWei <= 0n) throw new Error('the big buy must be positive');

  const fees = await getFeesFn(trade.FEE_BUMP_PCT);
  const bigBuyGas = gasCost(fees, trade.BUY_GAS);
  const balance = BigInt(await rpc.getBalance(main.address));
  if (balance < bigBuyWei + bigBuyGas) {
    throw new Error(
      `the v7 main wallet has ${formatEther(balance)} ETH but the big buy needs ` +
        `${formatEther(bigBuyWei + bigBuyGas)} (buy + gas) — fund it first`
    );
  }

  const buySlippageBps = body.buySlippageBps != null ? Number(body.buySlippageBps) : trade.DEFAULT_BUY_SLIPPAGE_BPS;

  return {
    token,
    pool,
    symbol: body.symbol || null,
    bigBuyWei,
    targets,
    main,
    intervalMs: body.intervalMs,
    jitterPct: body.jitterPct,
    variancePct: body.variancePct,
    buySlippageBps,
  };
}

/**
 * Can this run fund every wallet — and is the big buy safe against graduation? V7 QUOTES the
 * round trip live (buy the big buy, sell the position back) and checks the per-wallet average
 * clears the per-cycle cost, using the SAME gas the engine reserves. The flap quoter prices
 * sells, so a sell-quote revert is a genuine anomaly (not the letscash quirk) — provenance
 * already proved a genuine clone whose state-0 sells are structurally guaranteed, so it is a
 * SOFT estimate+warn, never a hard block. The graduation check is the flap-specific hard gate:
 * if the big buy would take more than maxHeadroomFrac of the tokens left before graduation, the
 * run is refused (chain/start enforces it). An estimate — the big buy moves the price the quotes
 * do not see, so the real tail raises less; the engine's per-cycle running mean self-corrects.
 */
async function feasibilityOf(run, deps = {}) {
  const t = deps.trade || trade;
  const s = deps.sizing || sizing;
  const getFeesFn = deps.getFeesFn || getFees;
  const walletCount = run.targets.length;
  const tokensBought = await t.quoteBuyOut({ token: run.token, pool: run.pool, amountWei: run.bigBuyWei }, deps);

  let positionWei = 0n;
  let pricingEstimated = false;
  let sellError = null;
  if (tokensBought > 0n) {
    try {
      positionWei = await t.quoteSellOut({ token: run.token, pool: run.pool, tokensIn: tokensBought }, deps);
    } catch (err) {
      // The flap quoter prices sells, so a revert here is a genuine anomaly (an exotic
      // on-curve tax config), not a honeypot signal — provenance already proved a genuine
      // clone whose state-0 sells are structurally guaranteed. Soft-estimate + warn, allow.
      sellError = revertSelector(err);
      pricingEstimated = true;
      positionWei = run.bigBuyWei;
    }
  }

  // GRADUATION GUARD — the big buy must not saturate the curve / graduate the token.
  const cap = graduationCap(run.pool);
  const graduationRisk = (run.pool.headroomTokens ?? 0n) > 0n && tokensBought >= cap && cap > 0n;

  const base = {
    positionWei,
    tokensBought,
    pricingEstimated,
    sellError,
    graduationRisk,
    headroomTokens: run.pool.headroomTokens ?? 0n,
    graduationCap: cap,
  };

  if (!walletCount) return { feasible: false, perWalletWei: 0n, reason: 'no-wallets', ...base };

  const fees = await getFeesFn(engine.FEE_BUMP_PCT);
  const gas = engine.gasFigures(fees);
  const est = s.estimateFeasibility({
    positionValueWei: positionWei,
    walletCount,
    mainGas: gas.mainGas,
    buyGas: gas.buyGas,
    buffer: gas.buffer,
    relayFeePct: engine.RELAY_FEE_PCT,
  });
  return { ...est, ...base };
}

/**
 * A dry preview. Everything resolveRun checks, plus what the run would look like — the
 * position after the big buy, an average slice, and how close the token is to graduation.
 * Broadcasts nothing.
 */
async function buildPlan(body, ks, deps = {}) {
  const run = await resolveRun(body, ks, deps);
  const priceFn = deps.ethPriceUsd || ethPriceUsd;

  const feas = await feasibilityOf(run, deps);
  const { positionWei, tokensBought } = feas;
  const walletCount = run.targets.length;
  const meanWei = walletCount > 0 ? positionWei / BigInt(walletCount) : 0n;

  const variancePct = Number(body.variancePct ?? sizing.DEFAULT_VARIANCE_PCT);
  const lowWei = (meanWei * BigInt(Math.round(10_000 - variancePct * 100))) / 10_000n;
  const highWei = (meanWei * BigInt(Math.round(10_000 + variancePct * 100))) / 10_000n;

  const price = await priceFn().then((p) => p.usd).catch(() => null);

  const bleedPct = run.bigBuyWei > 0n ? Number(((run.bigBuyWei - positionWei) * 10_000n) / run.bigBuyWei) / 100 : 0;
  const soldPct = pctSold(run.pool);
  const headroom = run.pool.headroomTokens ?? 0n;

  const warnings = [];
  if (feas.graduationRisk) {
    // The big buy would take too large a share of the tokens left before graduation.
    warnings.push(
      `THIS BIG BUY WOULD GRADUATE OR SATURATE THE CURVE, so this run CANNOT be started on it. It would buy ` +
        `~${formatUnits(feas.tokensBought, 18)} tokens, and only ${formatUnits(headroom, 18)} remain before ` +
        `graduation (${soldPct}% sold). A mid-run graduation moves the token to a V2 pair V7 does not trade, ` +
        `stranding the whole position. Reduce the big buy, or pick a token further from graduation.`
    );
  } else {
    if (headroom > 0n) {
      warnings.push(
        `this token is ${soldPct}% of the way to graduation — ${formatUnits(headroom, 18)} tokens of headroom ` +
          `left, of which this big buy takes ~${formatUnits(feas.tokensBought, 18)}. V7 refuses a big buy past ` +
          `${Math.round(config.flap.maxHeadroomFrac * 100)}% of the headroom. As the run's cycles re-buy less than ` +
          `they sell (fees), circulating supply drifts DOWN, away from graduation.`
      );
    }
    if (feas.pricingEstimated) {
      warnings.push(
        `the flap quoter could not price the sell${feas.sellError ? ` (custom error ${feas.sellError})` : ''}, so ` +
          `the position value here is a ROUGH ESTIMATE (about the ETH put in). This is unusual — provenance proved a ` +
          `genuine flap clone whose state-0 sells are structurally guaranteed, so the sells should still work, and ` +
          `the engine sizes each cycle from the real balance. Confirm the first cycle sell lands.`
      );
    }
    warnings.push(
      `the sells in this run have NO slippage floor — every sell exits at whatever price it gets. The buys carry a ` +
        `${run.buySlippageBps}bps floor` +
        (run.buySlippageBps === 0 ? ' (0 = strictly-guaranteed buy, allowed on the predictable flap curve).' : '.')
    );
    if (!feas.pricingEstimated) {
      warnings.push(
        `buying the position and selling it back costs about ${bleedPct.toFixed(1)}% to the 1% curve fee, any ` +
          `on-curve token tax, and your own price impact, so the wallets share roughly ${formatEther(positionWei)} ETH ` +
          `rather than the full ${formatEther(run.bigBuyWei)}`
      );
      if (bleedPct > 20) {
        warnings.push(
          `that ${bleedPct.toFixed(1)}% is high — this big buy is large relative to the curve. A smaller big buy ` +
            `loses far less on the round trip.`
        );
      }
    }
    if (!feas.feasible) {
      warnings.push(
        'this position may not fund every wallet — the per-wallet average is at or below the gas + buy a cycle ' +
          'needs, so the run could halt partway. Reduce the wallet count, increase the big buy, or pick a token ' +
          'with more room on the curve.'
      );
    }
  }

  return {
    protocol: 'v7',
    token: run.token,
    venue: run.pool.venue,
    curveState: run.pool.state,
    bigBuyEth: formatEther(run.bigBuyWei),
    bigBuyUsd: usd(run.bigBuyWei, price),
    buySlippageBps: run.buySlippageBps,
    ethUsd: price,
    mainWallet: { walletId: run.main.id, address: run.main.address },
    walletCount,
    feasible: feas.feasible,
    // A hard block, distinct from "feasible": the big buy would graduate/saturate the curve,
    // so the console must refuse to start (it would strand the position) — see the start route.
    graduationRisk: feas.graduationRisk,
    // Soft: the quoter could not price the sell. Allowed, warned — sells are structurally
    // guaranteed for a genuine clone. Not a block.
    pricingEstimated: feas.pricingEstimated,
    sellError: feas.sellError,
    graduation: {
      pctSold: soldPct,
      headroomTokens: formatUnits(headroom, 18),
      headroomTokensRaw: headroom.toString(),
      circulatingSupply: formatUnits(run.pool.circulatingSupply ?? 0n, 18),
      dexSupplyThresh: formatUnits(run.pool.dexSupplyThresh ?? 0n, 18),
      maxHeadroomFrac: config.flap.maxHeadroomFrac,
    },
    targets: run.targets.map((x, i) => ({ index: i + 1, walletId: x.walletId, address: x.address })),
    position: {
      tokens: formatUnits(tokensBought, 18),
      tokensRaw: tokensBought.toString(),
      eth: formatEther(positionWei),
      usd: usd(positionWei, price),
      bleedPct: Number(bleedPct.toFixed(2)),
    },
    slice: {
      meanEth: formatEther(meanWei),
      meanUsd: usd(meanWei, price),
      lowEth: formatEther(lowWei),
      lowUsd: usd(lowWei, price),
      highEth: formatEther(highWei),
      highUsd: usd(highWei, price),
    },
    intervalMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS),
    jitterPct: Number(body.jitterPct ?? engine.DEFAULT_JITTER_PCT),
    variancePct,
    estimatedRunMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS) * walletCount,
    minQuoteOut: '0',
    warnings,
  };
}

// ── wallets ─────────────────────────────────────────────────────────────────

// GET /api/v7/wallets — V7's three groups, with balances. Never key material.
router.get('/v7/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const groups = v7roles.all(ks);
    const withBalance = async (w) => (w ? { ...w, balanceEth: formatEther(await provider.getBalance(w.address)) } : null);

    res.json(
      jsonSafe({
        treasury: await withBalance(groups.treasury),
        main: await withBalance(groups.main),
        bundle: await Promise.all(groups.bundle.map(withBalance)),
        roles: v7roles.ROLES,
        running: engine.isRunning(req.user.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/wallets/generate — fresh wallets in one of V7's three roles.
router.post('/v7/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, role, label } = req.body || {};
    if (!v7roles.isV7Role(role)) throw new Error(`role must be one of ${Object.values(v7roles.ROLES).join(', ')}`);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be between 1 and 100');

    const made = keystoreFor(req.user.id).generate(n, { role, label });
    activityFor(req.user.id).record('v7', `[v7] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/wallets/import — an existing key into one of V7's roles.
router.post('/v7/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, role, label } = req.body || {};
    if (!v7roles.isV7Role(role)) throw new Error(`role must be one of ${Object.values(v7roles.ROLES).join(', ')}`);
    const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys].filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');

    const made = keystoreFor(req.user.id).importKeys(keys, { role, label });
    activityFor(req.user.id).record('v7', `[v7] imported ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v7/wallets/:id — refused mid-run (the engine resolves wallets by id every
// cycle; deleting one under a running job halts it).
router.delete('/v7/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) throw new Error('a v7 run is in progress — stop it before deleting a wallet');
    const ks = keystoreFor(req.user.id);
    const wallet = ks.list().find((w) => w.id === req.params.id);
    if (!wallet) throw new Error(`no wallet ${req.params.id}`);
    if (!v7roles.isV7Role(wallet.role)) throw new Error(`${req.params.id} is not a v7 wallet — delete it from its own tab`);
    ks.remove(req.params.id);
    activityFor(req.user.id).record('v7', `[v7] deleted ${wallet.role} wallet ${wallet.address}`, {
      role: wallet.role,
      address: wallet.address,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/fund — treasury → main, through Relay.
router.post('/v7/fund', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const from = v7roles.treasury(ks);
    const to = v7roles.main(ks);
    const amountWei = parseAmount(req.body?.amountEth, 'the funding amount');

    const out = await relay.transfer({ fromWallet: from, toAddress: to.address, amountWei }, { keystore: ks });

    let fill = { filled: null, status: null };
    if (out.hash && out.requestId) fill = await relay.confirmFill(out.requestId);
    const result = { ...out, filled: fill.filled, relayStatus: fill.status };
    if (fill.filled === false) {
      result.warning =
        `Deposit broadcast but Relay has not filled it (status: ${fill.status}). The ${formatEther(amountWei)} ETH ` +
        `is at deposit address ${out.depositAddress} and is refundable to the treasury ${from.address}. Keep ` +
        `requestId ${out.requestId} for a Relay ticket.`;
    }

    activityFor(req.user.id).record(
      'v7',
      `[v7] funded the main wallet with ${formatEther(amountWei)} ETH through Relay` +
        (fill.filled === false ? ` — NOT filled (${fill.status})` : ''),
      { from: from.address, to: to.address, requestId: out.requestId, hash: out.hash, filled: fill.filled }
    );
    res.json(jsonSafe(result));
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/wallets/backup — V7 keys for an offline backup.
//
// Whole-tab by default (no filter in the body) — byte-identical to before.
// Optionally narrowed by an OPTIONAL `role` (one panel's own wallets) and/or an
// OPTIONAL `walletIds` array (a hand-picked selection); see selectBackupWallets.
// Either way it is V7's wallets only — isV7Role gates the set BEFORE any filter,
// never another tab's keys. Same two locks as the whole-keystore export: an API
// key, and a configured credential so a keyless deployment fails closed rather
// than serving keys.
router.post('/v7/wallets/backup', requireApiKey, requireAuthConfigured, (req, res, next) => {
  try {
    if ((req.body || {}).confirm !== true) throw new Error('backup requires { confirm: true }');
    const ks = keystoreFor(req.user.id);
    const all = ks.exportAll().filter((w) => v7roles.isV7Role(w.role));
    const wallets = selectBackupWallets(all, req.body || {});
    console.warn(`[pons-launcher] V7 KEYSTORE BACKUP EXPORTED — ${wallets.length} private keys`);
    activityFor(req.user.id).record('export', `[v7] downloaded a backup of ${wallets.length} v7 private key(s)`, {
      count: wallets.length,
    });
    res.json({
      exportedAt: new Date().toISOString(),
      chainId: config.chainId,
      count: wallets.length,
      warning:
        'These private keys control real funds. Anyone holding this file can spend every wallet in it. Store it ' +
        'offline. There are no mnemonics: the keystore holds private keys only.',
      wallets,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/wallets/claim-seasoned — pull N finished-seasoning wallets into V7's bundle
// role (from this account's OWN seasoning pool). Refused mid-run.
router.post('/v7/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) throw new Error('a v7 run is in progress — stop it before claiming wallets');
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    if (take.length === 0) return res.json(jsonSafe({ claimed: [], available: pool.length, shortfall: want }));
    const out = seasoned.claim(ks, store, take.map((w) => w.id), { toRole: v7roles.ROLES.bundle, toTab: 'v7', now: Date.now() });
    activityFor(req.user.id).record('v7', `[v7] claimed ${out.claimed.length} seasoned wallet(s) into the bundle`, {
      count: out.claimed.length,
    });
    res.json(jsonSafe({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) }));
  } catch (err) {
    next(err);
  }
});

// ── the chain ───────────────────────────────────────────────────────────────

// GET /api/v7/chain — the current job, or an idle shape. The panel polls this.
router.get('/v7/chain', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.status(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/chain/plan — everything start would check, plus what cycle one would sell and
// how close the token is to graduation. Broadcasts nothing.
router.post('/v7/chain/plan', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(await withDeadline(buildPlan(req.body || {}, keystoreFor(req.user.id)), PREFLIGHT_TIMEOUT_MS, 'the plan'))
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v7/chain/start — irreversible, moves the whole position, no sell floor.
router.post('/v7/chain/start', requireApiKey, async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error(
        'starting a v7 run sells and re-buys the whole position with no sell floor — requires { confirm: true }'
      );
    }
    // Both resolve + feasibility under ONE deadline, so a slow RPC fails cleanly here (before
    // engine.start) instead of hanging past the gateway and starting the run minutes later.
    const { run, feas } = await withDeadline(
      (async () => {
        const run = await resolveRun(req.body || {}, keystoreFor(req.user.id));
        const feas = await feasibilityOf(run);
        return { run, feas };
      })(),
      PREFLIGHT_TIMEOUT_MS,
      'validating the run'
    );
    // A HARD refusal — no force bypass. If the big buy would graduate/saturate the curve, the
    // token would move to a V2 pair V7 does not trade, stranding the whole position. This is
    // the flap-specific analog of v6's sells-revert guard.
    if (feas.graduationRisk) {
      throw new Error(
        `refusing to start: this big buy would take ~${formatUnits(feas.tokensBought, 18)} tokens, of the ` +
          `${formatUnits(feas.headroomTokens, 18)} left before this token graduates (${pctSold(run.pool)}% sold). ` +
          `It would saturate the curve and could graduate the token mid-run, moving it to a V2 pair V7 does not ` +
          `trade and stranding the whole position. Reduce the big buy, or pick a token further from graduation.`
      );
    }
    if (!feas.feasible && req.body?.force !== true) {
      throw new Error(
        "this position's per-wallet average is at or below the gas + buy a cycle needs — the run would halt " +
          'partway. Reduce the wallet count (or increase the big buy, or pick a token with more room on the ' +
          'curve), or pass { force: true } to run it anyway.'
      );
    }
    res.json(
      jsonSafe(
        await engine.start(req.user.id, {
          token: run.token,
          pool: run.pool,
          symbol: run.symbol,
          bigBuyWei: run.bigBuyWei,
          targets: run.targets,
          intervalMs: run.intervalMs,
          jitterPct: run.jitterPct,
          variancePct: run.variancePct,
          buySlippageBps: run.buySlippageBps,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v7/chain/stop', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.stop(req.user.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/v7/chain/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.resume(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// ── the exit ────────────────────────────────────────────────────────────────

router.get('/v7/exit/preview', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await exit.preview(req.user.id, { token: req.query.token })));
  } catch (err) {
    next(err);
  }
});

router.post('/v7/exit', requireApiKey, async (req, res, next) => {
  try {
    // Refused mid-run: the exit sells the MAIN wallet too (exit.js includes it), and a live
    // cycle is signing sells on that same wallet — firing both races the nonce and can sell
    // main's position out from under a pending cycle. Stop the run first (the engine keeps
    // its state; the exit is still there afterwards).
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v7 run is in progress — stop it before selling everything, or the exit will race the engine on the main wallet');
    }
    // exit.readPositions calls trade.readCurve, which verifies a real flap curve — the same
    // dusting guard the start takes (the exit approves every wallet's balance).
    res.json(jsonSafe(await exit.run(req.user.id, { token: req.body?.token, confirm: req.body?.confirm })));
  } catch (err) {
    next(err);
  }
});

// ── the sweep ───────────────────────────────────────────────────────────────

router.get('/v7/sweep/preview', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(await sweep.preview(req.user.id, { destination: req.query.destination || 'main', minSweepEth: req.query.minSweepEth }))
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v7/sweep', requireApiKey, async (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v7 run is in progress — sweeping now would take the ETH a pending cycle is about to buy with. Stop the run first.');
    }
    res.json(
      jsonSafe(
        await sweep.run(req.user.id, {
          destination: req.body?.destination || 'main',
          minSweepEth: req.body?.minSweepEth,
          confirm: req.body?.confirm,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._private = { jsonSafe, parseAmount, resolveRun, buildPlan, feasibilityOf, selectBackupWallets };
