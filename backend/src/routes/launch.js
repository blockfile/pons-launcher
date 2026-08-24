'use strict';

const express = require('express');
const config = require('../config');
const factory = require('../evm/factory');
const { prepare } = require('../bundle/prepare');
const { fire } = require('../bundle/fire');
const { keystoreFor } = require('../wallets/keystore');
const { DEFAULT_VARIANT } = require('../wallets/variants');
const { historyFor } = require('../store/history');
const { requireApiKey } = require('../middleware/auth');
const { uploadImage, ACCEPTED, MAX_BYTES } = require('../ipfs/upload');
const v2factory = require('../evm/v2/factory');
const { prepareV2 } = require('../bundle/prepareV2');
const { fireV2 } = require('../bundle/fireV2');
const { ethPriceUsd } = require('../ethPrice');
const { getFees } = require('../evm/fees');
const { formatEther } = require('ethers');
const { APPROVE_GAS, SELL_GAS } = require('../bundle/prepareSell');

const router = express.Router();

// One launch at a time per account. Two launches overlapping would read the
// same pending nonce for the shared dev wallet and sign two different launches
// (different salts, different predicted curves) against it — and if a
// load-balanced RPC ACKs both before their mempools sync, the losing launch's
// buys can fire at a curve that never gets deployed and strand. A second launch
// while one is in flight is never intended (a double-click, a second tab, a
// client retry), so it is refused rather than raced. In-memory is sufficient:
// the keystore and the process are one per deployment.
const launching = new Set();

function withLaunchLock(handler) {
  return async (req, res, next) => {
    const id = req.user.id;
    if (launching.has(id)) {
      return res
        .status(409)
        .json({ error: 'a launch is already in progress for this account — wait for it to finish' });
    }
    launching.add(id);
    try {
      await handler(req, res, next);
    } finally {
      launching.delete(id);
    }
  };
}

/**
 * A plan safe to return over HTTP. Signed transactions are stripped: anyone
 * holding a raw signed buy could broadcast it, so it never leaves the server.
 */
function publicPlan(plan) {
  // Strip every signed raw before the plan leaves the server — the launch, the
  // buys, AND the approves the ERC-20 pair path adds (a signed approve is just as
  // broadcastable as a signed buy). The launch object may itself carry a dev
  // approve; the buys may each carry one.
  const stripApprove = (approve) => (approve ? { ...approve, raw: undefined } : approve);
  return jsonSafe({
    ...plan,
    launch: { ...plan.launch, raw: undefined, ...(plan.launch?.approve ? { approve: stripApprove(plan.launch.approve) } : {}) },
    buys: plan.buys.map((b) => ({
      ...b,
      raw: undefined,
      ...(b.approve ? { approve: stripApprove(b.approve) } : {}),
    })),
  });
}

/**
 * BigInt -> string, everywhere in the tree.
 *
 * JSON.stringify throws on a BigInt rather than skipping it, so one stray wei
 * value turns a perfectly good plan into "Do not know how to serialize a
 * BigInt" with nothing to say where it came from. Callers should not have to
 * remember which fields are wei; this makes forgetting harmless.
 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

// GET /api/configs — launch configs, dex configs and the current launch fee,
// read live from the factory rather than hardcoded.
// The native token's live USD price, for the market-cap dollar figures. A price
// outage is a 503 the console treats as "keep the typed value", never a launch
// blocker — so it is deliberately outside the try/catch that would 400 it.
router.get('/eth-price', async (req, res) => {
  try {
    res.json(await ethPriceUsd());
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// GET /api/gas — what a buy and a sell cost right now, in ETH, so the console can
// size a "reserve gas for N sells" fund without knowing the gas limits (those
// live here). Fees carry the same +25% headroom a launch uses, so the reserve
// errs high rather than leaving a wallet unable to sell.
router.get('/gas', async (req, res, next) => {
  try {
    const fees = await getFees(25);
    const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const buyGasWei = BigInt(config.buyGasLimit) * perGas;
    const sellGasWei = (APPROVE_GAS + SELL_GAS) * perGas;
    res.json({
      maxFeePerGasWei: perGas.toString(),
      buyGasEth: formatEther(buyGasWei),
      sellGasEth: formatEther(sellGasWei),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/configs', async (req, res, next) => {
  try {
    const configs = await factory.getConfigs();
    res.json({ factory: config.factoryAddress, chainId: config.chainId, ...configs });
  } catch (err) {
    next(err);
  }
});

// POST /api/logo — pin an image and hand back its ipfs:// URI, which the form
// then submits as params.logo. Proxied rather than uploaded straight from the
// browser: the pons worker's CORS is scoped to their own origin, and going
// through here keeps the API key gate in front of it.
//
// express.raw is mounted per-route so the global 1 MB JSON limit is untouched.
router.post(
  '/logo',
  requireApiKey,
  // Same accepted types and size ceiling uploadImage itself enforces — one
  // source of truth instead of a second hardcoded list drifting from it.
  express.raw({ type: [...ACCEPTED.keys()], limit: MAX_BYTES }),
  async (req, res, next) => {
    try {
      // A content-type express.raw did not match leaves req.body as {} — the
      // MIME check inside uploadImage rejects it with the right message.
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await uploadImage(buf, req.get('content-type')));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/preflight — build and sign the whole bundle, broadcast nothing.
// This is the rehearsal: it proves balances, gas and the predicted token
// address before any money moves.
router.post('/preflight', requireApiKey, async (req, res, next) => {
  try {
    const variant = req.body?.variant || DEFAULT_VARIANT;
    res.json(publicPlan(await prepare(req.body || {}, { keystore: keystoreFor(req.user.id), variant })));
  } catch (err) {
    next(err);
  }
});

// POST /api/launch — prepare, then fire. DRY_RUN still returns a full plan and
// simulated results without touching the chain.
router.post('/launch', requireApiKey, withLaunchLock(async (req, res, next) => {
  try {
    const variant = req.body?.variant || DEFAULT_VARIANT;
    const plan = await prepare(req.body || {}, { keystore: keystoreFor(req.user.id), variant });
    const result = await fire(plan);
    const entry = historyFor(req.user.id).record({ plan, result });
    res.json({ plan: publicPlan(plan), result, recorded: entry.at });
  } catch (err) {
    next(err);
  }
}));

// ── pons v2 ────────────────────────────────────────────────────────────────
// A separate protocol behind separate routes, so nothing about v1 changes.
// v2 has no dev buy and no address prediction: buys are signed after the launch
// receipt names the curve. See prepareV2/fireV2 for why.

// GET /api/v2/configs — launch configs, fee, whether launching is even open, and
// the quote assets the factory currently approves (native ETH first). The pair
// list is resolved separately and best-effort, and it is cached, so a slow or
// unhappy RPC on that read never blocks the rest of the config the form needs.
// `?refresh=1` forces a fresh read of the (rarely-changing) approved list.
router.get('/v2/configs', async (req, res, next) => {
  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const [configs, pairTokens] = await Promise.all([
      v2factory.getConfigs(),
      v2factory.getPairTokens({ refresh }).catch(() => null),
    ]);
    res.json({ chainId: config.chainId, ...configs, pairTokens: pairTokens || undefined });
  } catch (err) {
    next(err);
  }
});

router.post('/v2/preflight', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      publicPlan(
        await prepareV2(req.body || {}, {
          keystore: keystoreFor(req.user.id),
          variant: req.body?.variant || DEFAULT_VARIANT,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

router.post('/v2/launch', requireApiKey, withLaunchLock(async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const plan = await prepareV2(req.body || {}, {
      keystore: ks,
      variant: req.body?.variant || DEFAULT_VARIANT,
    });

    // Refuse rather than burn the fee. canLaunch() is the factory's own gate;
    // reading whitelistedLaunchers instead reports false for wallets that can
    // launch perfectly well.
    if (!plan.canLaunch) {
      throw new Error('the pons v2 factory will not let this dev wallet launch — canLaunch() is false');
    }
    if (!plan.pairApproved) {
      throw new Error(`pons v2 has not approved ${plan.pairToken} as a pair token — the factory would revert`);
    }

    const result = await fireV2(plan, { keystore: ks });
    const entry = historyFor(req.user.id).record({ plan, result });
    res.json({ plan: publicPlan(plan), result, recorded: entry.at });
  } catch (err) {
    next(err);
  }
}));

router.get('/launches', (req, res, next) => {
  try {
    // Filtered by launcher. Without this v2's step 5 reads v1's launches as
    // its own and reports DONE for a run it never made — the history is one
    // store per user, and the variant is what separates the two inside it.
    const want = req.query.variant || DEFAULT_VARIANT;
    const all = historyFor(req.user.id).list(500);
    const mine = all.filter((e) => (e?.plan?.variant || DEFAULT_VARIANT) === want);
    res.json(mine.slice(0, Number(req.query.limit) || 50));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.jsonSafe = jsonSafe;
module.exports.withLaunchLock = withLaunchLock;
