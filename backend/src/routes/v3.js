'use strict';

/**
 * Every /api/v3/* endpoint — the Relay chain's whole surface.
 *
 * SEPARATE FROM routes/wallets.js AND routes/launch.js BY DESIGN, and mounted
 * beside them rather than inside them. V3 is a strategy of its own; the rule for
 * this feature is that v1 and v2 are not touched, and a router that can be
 * unmounted in one line is the strongest form of that promise.
 *
 * WHERE THE REFUSALS LIVE. The engine validates the SHAPE of a run — intervals,
 * jitter, positive amounts, no duplicate wallets. Everything that requires
 * reading the chain is validated here, before the engine is ever started:
 *
 *   · the token is a pons v2 launch the factory has a record of
 *   · a wallet this account holds or has held launched it
 *   · the curve has not graduated and is not about to
 *   · v3main exists and can cover the big buy
 *   · every target is genuinely a v3 bundle wallet
 *
 * The ownership check is the one that matters most, and it is the same gate
 * prepareSell enforces for the same reason: a run signs approvals, and an
 * approval to a hostile ERC-20 is the whole dusting attack. "A wallet of ours"
 * is the live keystore plus the deleted-wallet archive, so rotating a dev wallet
 * does not orphan the tokens it launched.
 */

const express = require('express');
const { formatEther, formatUnits, getAddress, parseEther } = require('ethers');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const config = require('../config');
const holdings = require('../evm/v2/holdings');
const v3roles = require('../v3/roles');
const trade = require('../v3/trade');
const relay = require('../v3/relay');
const sizing = require('../v3/sizing');
const engine = require('../v3/engine');
const exit = require('../v3/exit');

const router = express.Router();

/**
 * BigInts out of the response.
 *
 * Copied rather than imported from routes/launch.js: importing a route module
 * to borrow a seven-line helper pulls its whole router in as a side effect, and
 * this file is meant to be detachable in one line.
 */
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
  if (!raw || !/^\d*\.?\d+$/.test(raw)) {
    throw new Error(`${what} must be a number of ETH`);
  }
  return parseEther(raw);
}

/**
 * Turn a request body into what the engine takes, refusing everything that
 * cannot be checked without reading the chain first.
 */
async function resolveRun(body = {}, ks, deps = {}) {
  const describe = deps.describeToken || ((t) => holdings.describeToken(t));
  const readCurve = (deps.trade || trade).readCurve;
  const rpc = deps.rpc || provider;
  const getFeesFn = deps.getFeesFn || getFees;

  if (!body.token) throw new Error('token is required');
  const token = getAddress(body.token);

  // ── is this a token we may touch ──────────────────────────────────────────
  const record = await describe(token);
  if (!record.exists) {
    throw new Error(`${token} is not a pons v2 launch — the factory has no record of it`);
  }
  const ours = holdings.ownerSet(ks.ownedAddresses());
  if (!ours.has(getAddress(record.deployer).toLowerCase())) {
    throw new Error(
      `${token} was not launched by a wallet this account holds or has held — the factory says ` +
        `${record.deployer} launched it. Refusing to approve a contract we did not create.`
    );
  }

  // ── is the curve still a curve ────────────────────────────────────────────
  const curve = await readCurve(record.curve, deps);
  if (curve.graduated) {
    throw new Error(`${token} has graduated to a Uniswap v4 pool — V3 cannot trade it`);
  }
  if (curve.readyToGraduate) {
    // Refused rather than warned: a run that graduates halfway leaves the rest
    // of the position somewhere this code cannot sell, and the operator would
    // discover that at the exit rather than at the start.
    throw new Error(
      `${token} is ready to graduate — a run started now would strand the remaining position in ` +
        'a pool V3 cannot sell into'
    );
  }

  // ── the wallets ───────────────────────────────────────────────────────────
  const main = v3roles.main(ks); // throws naming v3main
  const bundle = v3roles.bundle(ks);
  if (!bundle.length) {
    throw new Error('no v3 bundle wallet — generate some on the V3 tab first');
  }

  const requested = Array.isArray(body.targets) && body.targets.length
    ? body.targets
    : bundle.map((w) => ({ walletId: w.id, buyEth: body.defaultBuyEth }));

  const known = new Map(bundle.map((w) => [w.id, w]));
  const targets = requested.map((t) => {
    const wallet = known.get(t.walletId);
    if (!wallet) throw new Error(`wallet ${t.walletId} is not a v3 bundle wallet`);
    const buyWei = parseAmount(t.buyEth, `the buy amount for ${wallet.address}`);
    if (buyWei <= 0n) throw new Error(`wallet ${t.walletId} needs a positive buy amount`);
    return { walletId: wallet.id, address: wallet.address, buyWei };
  });

  // ── can the main wallet start ─────────────────────────────────────────────
  const bigBuyWei = parseAmount(body.bigBuyEth, 'the big buy');
  if (bigBuyWei <= 0n) throw new Error('the big buy must be positive');

  const fees = await getFeesFn(trade.FEE_BUMP_PCT);
  const bigBuyGas = gasCost(fees, BigInt(config.buyGasLimit));
  const balance = BigInt(await rpc.getBalance(main.address));
  if (balance < bigBuyWei + bigBuyGas) {
    throw new Error(
      `the v3 main wallet has ${formatEther(balance)} ETH but the big buy needs ` +
        `${formatEther(bigBuyWei + bigBuyGas)} (buy + gas) — fund it first`
    );
  }

  return {
    token,
    curve: getAddress(record.curve),
    symbol: body.symbol || null,
    bigBuyWei,
    targets,
    main,
    curveState: curve,
    intervalMs: body.intervalMs,
    jitterPct: body.jitterPct,
  };
}

/**
 * A dry preview. Everything resolveRun checks, plus what cycle one would sell
 * and what the opening tax would cost. Broadcasts nothing.
 */
async function buildPlan(body, ks, deps = {}) {
  const run = await resolveRun(body, ks, deps);
  const t = deps.trade || trade;
  const s = deps.sizing || sizing;
  const getFeesFn = deps.getFeesFn || getFees;

  const fees = await getFeesFn(trade.FEE_BUMP_PCT);
  const recipientGas =
    gasCost(fees, BigInt(config.buyGasLimit)) + parseEther(String(config.gasBufferEth));
  const mainGas = gasCost(fees, trade.APPROVE_GAS + trade.SELL_GAS + engine.RELAY_DEPOSIT_GAS);

  const first = run.targets[0];
  const targetWei = first.buyWei + recipientGas + mainGas;
  const tokensIn = s.tokensToRaise({
    targetWei,
    quoteReserve: run.curveState.quoteReserve,
    tokenReserve: run.curveState.tokenReserve,
    feeBps: run.curveState.feeBps,
    creatorTaxBps: run.curveState.creatorTaxBps,
  });

  // Per the FIRST bundle wallet: the tax is a function of the recipient and the
  // clock, and every wallet in this run is in the same position.
  const snipeTax = await t.snipeTax(run.curve, first.address, deps);

  const totalBuy = run.targets.reduce((sum, x) => sum + x.buyWei, 0n);
  const warnings = [
    'there is no slippage floor on any trade in this run — every sell and every buy takes ' +
      'whatever price it gets',
  ];
  if (snipeTax.bps > 0) {
    warnings.push(
      `the opening snipe tax is still live at ${snipeTax.bps} bps and V3's wallets are NOT exempt — ` +
        'they were not known when the launch declared its exemption list, so every buy in this run ' +
        `pays it. The window is ${snipeTax.windowSeconds}s from the launch; wait it out to avoid the tax.`
    );
  }

  return {
    token: run.token,
    curve: run.curve,
    graduated: run.curveState.graduated,
    readyToGraduate: run.curveState.readyToGraduate,
    feeBps: run.curveState.feeBps,
    creatorTaxBps: run.curveState.creatorTaxBps,
    bigBuyEth: formatEther(run.bigBuyWei),
    mainWallet: { walletId: run.main.id, address: run.main.address },
    targets: run.targets.map((x, i) => ({
      index: i + 1,
      walletId: x.walletId,
      address: x.address,
      buyEth: formatEther(x.buyWei),
      fundEth: formatEther(x.buyWei + recipientGas),
    })),
    totalBuyEth: formatEther(totalBuy),
    totalWithGasEth: formatEther(totalBuy + recipientGas * BigInt(run.targets.length)),
    firstCycle: {
      walletId: first.walletId,
      raiseEth: formatEther(targetWei),
      tokens: formatUnits(tokensIn, 18),
      tokensRaw: tokensIn.toString(),
    },
    snipeTax,
    intervalMs: Number(body.intervalMs ?? engine.DEFAULT_INTERVAL_MS),
    jitterPct: Number(body.jitterPct ?? engine.DEFAULT_JITTER_PCT),
    minQuoteOut: '0',
    warnings,
  };
}

// ── wallets ─────────────────────────────────────────────────────────────────

// GET /api/v3/wallets — V3's three groups, with balances. Never key material.
router.get('/v3/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const groups = v3roles.all(ks);
    const withBalance = async (w) =>
      w ? { ...w, balanceEth: formatEther(await provider.getBalance(w.address)) } : null;

    res.json(
      jsonSafe({
        treasury: await withBalance(groups.treasury),
        main: await withBalance(groups.main),
        bundle: await Promise.all(groups.bundle.map(withBalance)),
        roles: v3roles.ROLES,
        running: engine.isRunning(req.user.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/wallets/generate — fresh wallets in one of V3's three roles.
router.post('/v3/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, role, label } = req.body || {};
    if (!v3roles.isV3Role(role)) {
      throw new Error(`role must be one of ${Object.values(v3roles.ROLES).join(', ')}`);
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be between 1 and 100');

    const made = keystoreFor(req.user.id).generate(n, { role, label });
    activityFor(req.user.id).record('v3', `[v3] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/wallets/import — an existing key into one of V3's roles.
router.post('/v3/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, role, label } = req.body || {};
    if (!v3roles.isV3Role(role)) {
      throw new Error(`role must be one of ${Object.values(v3roles.ROLES).join(', ')}`);
    }
    const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys].filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');

    const made = keystoreFor(req.user.id).importKeys(keys, { role, label });
    activityFor(req.user.id).record('v3', `[v3] imported ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v3/wallets/:id — refused mid-run: the engine resolves wallets by
// id every cycle, and deleting one under a running job fails that cycle and
// halts the whole thing.
router.delete('/v3/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v3 run is in progress — stop it before deleting a wallet');
    }
    const ks = keystoreFor(req.user.id);
    const wallet = ks.list().find((w) => w.id === req.params.id);
    if (!wallet) throw new Error(`no wallet ${req.params.id}`);
    if (!v3roles.isV3Role(wallet.role)) {
      throw new Error(`${req.params.id} is not a v3 wallet — delete it from its own tab`);
    }
    ks.remove(req.params.id);
    activityFor(req.user.id).record('v3', `[v3] deleted ${wallet.role} wallet ${wallet.address}`, {
      role: wallet.role,
      address: wallet.address,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/fund — treasury → main, through Relay.
router.post('/v3/fund', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const from = v3roles.treasury(ks);
    const to = v3roles.main(ks);
    const amountWei = parseAmount(req.body?.amountEth, 'the funding amount');

    const out = await relay.transfer({ fromWallet: from, toAddress: to.address, amountWei }, { keystore: ks });
    activityFor(req.user.id).record(
      'v3',
      `[v3] funded the main wallet with ${formatEther(amountWei)} ETH through Relay`,
      { from: from.address, to: to.address, requestId: out.requestId, hash: out.hash }
    );
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
});

// ── the chain ───────────────────────────────────────────────────────────────

// GET /api/v3/chain — the current job, or an idle shape. The panel polls this.
router.get('/v3/chain', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.status(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/chain/plan — everything start would check, plus what cycle one
// would sell and what the opening tax would cost. Broadcasts nothing.
router.post('/v3/chain/plan', requireApiKey, async (req, res, next) => {
  try {
    res.json(jsonSafe(await buildPlan(req.body || {}, keystoreFor(req.user.id))));
  } catch (err) {
    next(err);
  }
});

// POST /api/v3/chain/start — irreversible, moves the whole position, no
// slippage floor. Takes confirm the same way the v1 sell does.
router.post('/v3/chain/start', requireApiKey, async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error(
        'starting a v3 run sells and re-buys the whole position with no slippage floor — ' +
          'requires { confirm: true }'
      );
    }
    const run = await resolveRun(req.body || {}, keystoreFor(req.user.id));
    res.json(
      jsonSafe(
        await engine.start(req.user.id, {
          token: run.token,
          curve: run.curve,
          symbol: run.symbol,
          bigBuyWei: run.bigBuyWei,
          targets: run.targets,
          intervalMs: run.intervalMs,
          jitterPct: run.jitterPct,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v3/chain/stop', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.stop(req.user.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/v3/chain/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(engine.resume(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// ── the exit ────────────────────────────────────────────────────────────────

router.get('/v3/exit/preview', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const record = await holdings.describeToken(req.query.token);
    if (!record.exists) throw new Error(`${req.query.token} is not a pons v2 launch`);
    res.json(
      jsonSafe(await exit.preview(req.user.id, { token: record.token, curve: record.curve }))
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v3/exit', requireApiKey, async (req, res, next) => {
  try {
    const record = await holdings.describeToken(req.body?.token);
    if (!record.exists) throw new Error(`${req.body?.token} is not a pons v2 launch`);
    // The same ownership gate the start takes. An exit approves every wallet's
    // balance to the curve, so it is the same risk and takes the same check.
    const ks = keystoreFor(req.user.id);
    const ours = holdings.ownerSet(ks.ownedAddresses());
    if (!ours.has(getAddress(record.deployer).toLowerCase())) {
      throw new Error(`${record.token} was not launched by a wallet this account holds or has held`);
    }
    res.json(
      jsonSafe(
        await exit.run(req.user.id, {
          token: record.token,
          curve: record.curve,
          confirm: req.body?.confirm,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._private = { jsonSafe, parseAmount, resolveRun, buildPlan };
