'use strict';

/**
 * Every /api/v6/* endpoint — the letscash relay chain's whole surface.
 *
 * Mounted beside the others and detachable in one line (the isolation rule). This
 * is routes/v3.js ported to letscash: the engine validates the SHAPE of a run
 * (intervals, jitter, positive amounts, no duplicate wallets); everything that
 * needs the chain is validated HERE first.
 *
 * WHERE THE DUSTING GUARD LIVES. v3 refuses a token the pons-v2 factory has no
 * record of, launched by a wallet the account never held — because a run signs token
 * approvals and an approval to a hostile ERC-20 is the dusting attack. V6's guard is
 * trade.readPool(), and it mirrors v3's SPEED — one factory-authoritative read, no
 * getLogs scan: (1) eth_getCode(token) must be an EIP-1167 clone of a factory tokenMaster
 * (a decoy ERC-20 has its own bytecode and is rejected); (2) the pool must be initialised
 * and liquid under one of the factory's legit hooks (the probe is restricted to them, so a
 * look-alike pool under an unrelated hook can't be selected). findLaunch remains only as a
 * time-bounded fallback for a future/vanity hook. An operator-supplied hook is never used.
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
const v6roles = require('../v6/roles');
const trade = require('../v6/trade');
const relay = require('../v6/relay');
const sizing = require('../v6/sizing');
const engine = require('../v6/engine');
const exit = require('../v6/exit');
const sweep = require('../v6/sweep');
const { storeFor } = require('../v4/store');
const seasoned = require('../v4/seasoned');

const router = express.Router();

// A hard ceiling on how long the pre-flight (resolve + feasibility) may run before a
// chain route answers. A degraded / rate-limited RPC can make the pool read and the live
// quotes retry for minutes — long past the 60s gateway — during which the operator sees
// only "working…", then the modal gives up, WHILE the handler keeps running and eventually
// starts the run anyway (the big buy fires minutes later, out of nowhere — the desync a
// operator hit). Bounding it FAIL-CLOSED: if validation cannot finish in time the route
// throws and NOTHING is started, so the operator gets a clear "try again" instead of a run
// that begins long after they gave up. Env-overridable; kept under the 60s gateway.
const PREFLIGHT_TIMEOUT_MS = Number(process.env.V6_PREFLIGHT_TIMEOUT_MS) || 45_000;

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
 * Turn a request body into what the engine takes, refusing everything that cannot be
 * checked without reading the chain first. readPool is the load-bearing gate.
 */
async function resolveRun(body = {}, ks, deps = {}) {
  const t = deps.trade || trade;
  const rpc = deps.rpc || provider;
  const getFeesFn = deps.getFeesFn || getFees;

  if (!body.token) throw new Error('token is required');
  const token = getAddress(body.token);

  // The dusting guard + the pool the run trades: resolve + VERIFY a live letscash
  // pool. Throws if there is no initialised, liquid pool — so no approval is ever
  // signed for a token that does not really trade on letscash.
  const pool = await t.readPool({ token, quote: 'eth' }, deps);

  const main = v6roles.main(ks); // throws naming v6main
  const bundle = v6roles.bundle(ks);
  if (!bundle.length) throw new Error('no v6 bundle wallet — generate some on the V6 tab first');

  // No per-wallet amount: the position is divided across however many wallets are in
  // the run, one cycle each, sized as it goes. Omitting `targets` means every bundle
  // wallet, which is what the console sends.
  const requested =
    Array.isArray(body.targets) && body.targets.length ? body.targets : bundle.map((w) => ({ walletId: w.id }));
  const known = new Map(bundle.map((w) => [w.id, w]));
  const targets = requested.map((tt) => {
    const wallet = known.get(tt.walletId);
    if (!wallet) throw new Error(`wallet ${tt.walletId} is not a v6 bundle wallet`);
    return { walletId: wallet.id, address: wallet.address };
  });

  const bigBuyWei = parseAmount(body.bigBuyEth, 'the big buy');
  if (bigBuyWei <= 0n) throw new Error('the big buy must be positive');

  const fees = await getFeesFn(trade.FEE_BUMP_PCT);
  const bigBuyGas = gasCost(fees, trade.BUY_GAS);
  const balance = BigInt(await rpc.getBalance(main.address));
  if (balance < bigBuyWei + bigBuyGas) {
    throw new Error(
      `the v6 main wallet has ${formatEther(balance)} ETH but the big buy needs ` +
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
 * Can this run fund every wallet? V6 cannot replay a V4 pool offline (no curve
 * formula), so it QUOTES the round trip live — buy the big buy, sell the position
 * back — and checks the per-wallet average clears the per-cycle cost, using the SAME
 * gas the engine reserves. An estimate (the big buy moves the price the quotes do not
 * see, so the real tail raises less); the engine's per-cycle running mean self-
 * corrects. Returns positionWei/tokensBought so the plan need not re-quote.
 */
async function feasibilityOf(run, deps = {}) {
  const t = deps.trade || trade;
  const s = deps.sizing || sizing;
  const getFeesFn = deps.getFeesFn || getFees;
  const walletCount = run.targets.length;
  const tokensBought = await t.quoteBuyOut({ token: run.token, pool: run.pool, amountWei: run.bigBuyWei }, deps);

  // Quoting the sell back PRICES the position — but a reverting sell quote is NOT proof
  // the token is unsellable. The letscash CashCat hook reverts the QUOTER's sell
  // simulation (its quote-side tax) even for tokens that sell perfectly well through the
  // real UniversalRouter; v6's actual sells use no quote. So when the sell quote reverts
  // we fall back to the pool's on-chain history: if a sell has ever LANDED, the token is
  // sellable and we only lose the precise price (a soft, estimated plan). Only a token
  // whose pool shows buys but NEVER a sell is treated as a buy-only honeypot and blocked.
  let positionWei = 0n;
  let sellsRevert = false;
  let pricingEstimated = false;
  let sellUnverified = false;
  let sellError = null;
  if (tokensBought > 0n) {
    try {
      positionWei = await t.quoteSellOut({ token: run.token, pool: run.pool, tokensIn: tokensBought }, deps);
    } catch (err) {
      sellError = revertSelector(err);
      try {
        const sellable = await t.hasRecentSell({ pool: run.pool }, deps);
        if (sellable) {
          // Sells DO land on this pool — the quoter just can't price them. Estimate the
          // position as roughly the ETH put in (tax/impact aside); the engine sizes each
          // cycle from the ACTUAL balance anyway, so this only affects the preview figures.
          pricingEstimated = true;
          positionWei = run.bigBuyWei;
        } else {
          sellsRevert = true; // whole history read, NO sell has ever landed → buy-only honeypot
          positionWei = 0n;
        }
      } catch {
        // Could not verify sellability (the node refused the range or it timed out). Do NOT
        // block a possibly-fine token on an inconclusive scan, and do NOT hang toward a 504 —
        // allow with an estimate and a warning; the first real sell is the ground truth.
        pricingEstimated = true;
        sellUnverified = true;
        positionWei = run.bigBuyWei;
      }
    }
  }

  if (!walletCount) return { feasible: false, perWalletWei: 0n, reason: 'no-wallets', positionWei, tokensBought, sellsRevert, pricingEstimated, sellUnverified, sellError };
  if (sellsRevert) return { feasible: false, perWalletWei: 0n, reason: 'sells-revert', positionWei: 0n, tokensBought, sellsRevert, pricingEstimated: false, sellUnverified: false, sellError };

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
  return { ...est, positionWei, tokensBought, sellsRevert: false, pricingEstimated, sellUnverified, sellError };
}

/**
 * A dry preview. Everything resolveRun checks, plus what the run would look like —
 * the position after the big buy, an average slice, and the current pool tax.
 * Broadcasts nothing.
 */
async function buildPlan(body, ks, deps = {}) {
  const run = await resolveRun(body, ks, deps);
  const t = deps.trade || trade;
  const priceFn = deps.ethPriceUsd || ethPriceUsd;

  const feas = await feasibilityOf(run, deps);
  const { positionWei, tokensBought } = feas;
  const walletCount = run.targets.length;
  const meanWei = walletCount > 0 ? positionWei / BigInt(walletCount) : 0n;

  const variancePct = Number(body.variancePct ?? sizing.DEFAULT_VARIANCE_PCT);
  const lowWei = (meanWei * BigInt(Math.round(10_000 - variancePct * 100))) / 10_000n;
  const highWei = (meanWei * BigInt(Math.round(10_000 + variancePct * 100))) / 10_000n;

  const price = await priceFn().then((p) => p.usd).catch(() => null);

  // The live pool tax (flat for letscash — no decay window). Advisory only.
  let poolTax = null;
  try {
    poolTax = await t.poolFee({ token: run.token, pool: run.pool }, deps);
  } catch {
    /* informational; never fails the plan */
  }

  const bleedPct = run.bigBuyWei > 0n ? Number(((run.bigBuyWei - positionWei) * 10_000n) / run.bigBuyWei) / 100 : 0;

  const warnings = [];
  if (feas.sellsRevert) {
    // The buy quote worked but the sell quote reverted — the token cannot be sold out of.
    warnings.push(
      `THIS TOKEN'S SELLS REVERT${feas.sellError ? ` (custom error ${feas.sellError})` : ''}, so this run ` +
        'CANNOT be started on it. A buy succeeds but every sell reverts — the big buy would land and then ' +
        'every cycle sell, AND the exit, would fail, stranding your ETH in tokens you cannot sell back. ' +
        'This is a honeypot or the token locks sells to a specific router (letscash sells may need their ' +
        'own sell router, not a direct swap).'
    );
  } else {
    if (feas.sellUnverified) {
      warnings.push(
        `letscash's quoter could not price the sell${feas.sellError ? ` (custom error ${feas.sellError})` : ''} AND ` +
          "the sell-history check could not complete (the RPC refused the range or timed out), so sellability " +
          "was NOT verified. The position value here is a rough estimate. The run is allowed — most letscash " +
          'tokens sell fine — but confirm you can sell this one; the first cycle sell is the real test.'
      );
    } else if (feas.pricingEstimated) {
      warnings.push(
        `letscash's quoter reverts on sells for this pool${feas.sellError ? ` (custom error ${feas.sellError})` : ''}, ` +
          'so the position value here is a ROUGH ESTIMATE (about the ETH put in). This does NOT mean the token ' +
          "cannot be sold — sells HAVE landed on this pool on-chain, and the run's own sells use no quote, so " +
          'they work. Only these preview figures are approximate; the engine sizes each cycle from the real balance.'
      );
    }
    warnings.push(
      'the sells in this run have NO slippage floor — every sell exits at whatever price it gets. The ' +
        `buys carry a ${run.buySlippageBps}bps floor (letscash buys require one).`
    );
    if (!feas.pricingEstimated) {
      warnings.push(
        `buying the position and selling it back costs about ${bleedPct.toFixed(1)}% to the pool tax and ` +
          `your own price impact, so the wallets share roughly ${formatEther(positionWei)} ETH rather than ` +
          `the full ${formatEther(run.bigBuyWei)}`
      );
      if (bleedPct > 20) {
        warnings.push(
          `that ${bleedPct.toFixed(1)}% is high, and it is price impact: this big buy is large relative to ` +
            'the pool. A smaller big buy loses far less on the round trip.'
        );
      }
    }
    if (!feas.feasible) {
      warnings.push(
        'this position may not fund every wallet — the per-wallet average is at or below the gas + buy a ' +
          'cycle needs, so the run could halt partway. Reduce the wallet count, increase the big buy, or ' +
          'pick a deeper-liquidity pool.'
      );
    }
  }
  if (poolTax && poolTax.currentPct > 0) {
    warnings.push(
      `the pool tax is ${poolTax.currentPct}% right now, and v6's wallets are NOT exempt — every buy and ` +
        'sell in this run pays it (it is flat on letscash; there is no window to wait out).'
    );
  }

  return {
    protocol: 'v6',
    token: run.token,
    poolId: run.pool.poolId,
    hook: run.pool.hook,
    bigBuyEth: formatEther(run.bigBuyWei),
    bigBuyUsd: usd(run.bigBuyWei, price),
    buySlippageBps: run.buySlippageBps,
    ethUsd: price,
    mainWallet: { walletId: run.main.id, address: run.main.address },
    walletCount,
    feasible: feas.feasible,
    // A hard block, distinct from "feasible": the token cannot be sold out of, so the
    // console must refuse to start (it would strand the big buy) — see the start route.
    sellsRevert: feas.sellsRevert,
    // Soft: the quoter could not price the sell, but sells DO land on-chain — the token
    // is sellable and the position figures are estimated. Not a block.
    pricingEstimated: feas.pricingEstimated,
    // Soft: sellability could not be verified (RPC refused/timed out). Allowed, warned.
    sellUnverified: feas.sellUnverified,
    sellError: feas.sellError,
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
    poolTax,
    intervalMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS),
    jitterPct: Number(body.jitterPct ?? engine.DEFAULT_JITTER_PCT),
    variancePct,
    estimatedRunMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS) * walletCount,
    minQuoteOut: '0',
    warnings,
  };
}

// ── wallets ─────────────────────────────────────────────────────────────────

// GET /api/v6/wallets — V6's three groups, with balances. Never key material.
router.get('/v6/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const groups = v6roles.all(ks);
    const withBalance = async (w) => (w ? { ...w, balanceEth: formatEther(await provider.getBalance(w.address)) } : null);

    res.json(
      jsonSafe({
        treasury: await withBalance(groups.treasury),
        main: await withBalance(groups.main),
        bundle: await Promise.all(groups.bundle.map(withBalance)),
        roles: v6roles.ROLES,
        running: engine.isRunning(req.user.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/wallets/generate — fresh wallets in one of V6's three roles.
router.post('/v6/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, role, label } = req.body || {};
    if (!v6roles.isV6Role(role)) throw new Error(`role must be one of ${Object.values(v6roles.ROLES).join(', ')}`);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be between 1 and 100');

    const made = keystoreFor(req.user.id).generate(n, { role, label });
    activityFor(req.user.id).record('v6', `[v6] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/wallets/import — an existing key into one of V6's roles.
router.post('/v6/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, role, label } = req.body || {};
    if (!v6roles.isV6Role(role)) throw new Error(`role must be one of ${Object.values(v6roles.ROLES).join(', ')}`);
    const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys].filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');

    const made = keystoreFor(req.user.id).importKeys(keys, { role, label });
    activityFor(req.user.id).record('v6', `[v6] imported ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v6/wallets/:id — refused mid-run (the engine resolves wallets by id
// every cycle; deleting one under a running job halts it).
router.delete('/v6/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) throw new Error('a v6 run is in progress — stop it before deleting a wallet');
    const ks = keystoreFor(req.user.id);
    const wallet = ks.list().find((w) => w.id === req.params.id);
    if (!wallet) throw new Error(`no wallet ${req.params.id}`);
    if (!v6roles.isV6Role(wallet.role)) throw new Error(`${req.params.id} is not a v6 wallet — delete it from its own tab`);
    ks.remove(req.params.id);
    activityFor(req.user.id).record('v6', `[v6] deleted ${wallet.role} wallet ${wallet.address}`, {
      role: wallet.role,
      address: wallet.address,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/fund — treasury → main, through Relay.
router.post('/v6/fund', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const from = v6roles.treasury(ks);
    const to = v6roles.main(ks);
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
      'v6',
      `[v6] funded the main wallet with ${formatEther(amountWei)} ETH through Relay` +
        (fill.filled === false ? ` — NOT filled (${fill.status})` : ''),
      { from: from.address, to: to.address, requestId: out.requestId, hash: out.hash, filled: fill.filled }
    );
    res.json(jsonSafe(result));
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/wallets/backup — every V6 key at once, for an offline backup.
router.post('/v6/wallets/backup', requireApiKey, requireAuthConfigured, (req, res, next) => {
  try {
    if ((req.body || {}).confirm !== true) throw new Error('backup requires { confirm: true }');
    const ks = keystoreFor(req.user.id);
    const wallets = ks.exportAll().filter((w) => v6roles.isV6Role(w.role));
    console.warn(`[pons-launcher] V6 KEYSTORE BACKUP EXPORTED — ${wallets.length} private keys`);
    activityFor(req.user.id).record('export', `[v6] downloaded a backup of ${wallets.length} v6 private key(s)`, {
      count: wallets.length,
    });
    res.json({
      exportedAt: new Date().toISOString(),
      chainId: config.chainId,
      count: wallets.length,
      warning:
        'These private keys control real funds. Anyone holding this file can spend every wallet in it. ' +
        'Store it offline. There are no mnemonics: the keystore holds private keys only.',
      wallets,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/wallets/claim-seasoned — pull N finished-seasoning wallets into V6's
// bundle role (from this account's OWN seasoning pool). Refused mid-run.
router.post('/v6/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) throw new Error('a v6 run is in progress — stop it before claiming wallets');
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    if (take.length === 0) return res.json(jsonSafe({ claimed: [], available: pool.length, shortfall: want }));
    const out = seasoned.claim(ks, store, take.map((w) => w.id), { toRole: v6roles.ROLES.bundle, toTab: 'v6', now: Date.now() });
    activityFor(req.user.id).record('v6', `[v6] claimed ${out.claimed.length} seasoned wallet(s) into the bundle`, {
      count: out.claimed.length,
    });
    res.json(jsonSafe({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) }));
  } catch (err) {
    next(err);
  }
});

// ── the chain ───────────────────────────────────────────────────────────────

// GET /api/v6/chain — the current job, or an idle shape. The panel polls this.
router.get('/v6/chain', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.status(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/chain/plan — everything start would check, plus what cycle one would
// sell and the current pool tax. Broadcasts nothing.
router.post('/v6/chain/plan', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(await withDeadline(buildPlan(req.body || {}, keystoreFor(req.user.id)), PREFLIGHT_TIMEOUT_MS, 'the plan'))
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v6/chain/start — irreversible, moves the whole position, no sell floor.
router.post('/v6/chain/start', requireApiKey, async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error(
        'starting a v6 run sells and re-buys the whole position with no sell floor — requires { confirm: true }'
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
    // A HARD refusal — no force bypass. If the token's sells revert, the big buy would
    // land and then every sell (and the exit) would fail, stranding the ETH in tokens
    // that cannot be sold. This is the exit-side dusting guard.
    if (feas.sellsRevert) {
      throw new Error(
        `refusing to start: this token's SELLS revert${feas.sellError ? ` (custom error ${feas.sellError})` : ''}. ` +
          'A buy succeeds but every sell fails, so the run would strand the big buy in tokens you cannot sell ' +
          'back — the exit could not recover them either. It is a honeypot or the token locks sells to a ' +
          'specific router. Do NOT buy it with this strategy.'
      );
    }
    if (!feas.feasible && req.body?.force !== true) {
      throw new Error(
        "this position's per-wallet average is at or below the gas + buy a cycle needs — the run would halt " +
          'partway. Reduce the wallet count (or increase the big buy, or pick a deeper-liquidity pool), or ' +
          'pass { force: true } to run it anyway.'
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

router.post('/v6/chain/stop', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.stop(req.user.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/v6/chain/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.resume(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// ── the exit ────────────────────────────────────────────────────────────────

router.get('/v6/exit/preview', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await exit.preview(req.user.id, { token: req.query.token })));
  } catch (err) {
    next(err);
  }
});

router.post('/v6/exit', requireApiKey, async (req, res, next) => {
  try {
    // Refused mid-run: the exit sells the MAIN wallet too (exit.js includes it), and a
    // live cycle is signing sells on that same wallet — firing both races the nonce and
    // can sell main's position out from under a pending cycle. Stop the run first (the
    // engine keeps its state; the exit is still there afterwards).
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v6 run is in progress — stop it before selling everything, or the exit will race the engine on the main wallet');
    }
    // exit.readPositions calls trade.readPool, which verifies a real letscash pool —
    // the same dusting guard the start takes (the exit approves every wallet's balance).
    res.json(jsonSafe(await exit.run(req.user.id, { token: req.body?.token, confirm: req.body?.confirm })));
  } catch (err) {
    next(err);
  }
});

// ── the sweep ───────────────────────────────────────────────────────────────

router.get('/v6/sweep/preview', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(await sweep.preview(req.user.id, { destination: req.query.destination || 'main', minSweepEth: req.query.minSweepEth }))
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v6/sweep', requireApiKey, async (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v6 run is in progress — sweeping now would take the ETH a pending cycle is about to buy with. Stop the run first.');
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
module.exports._private = { jsonSafe, parseAmount, resolveRun, buildPlan, feasibilityOf };
