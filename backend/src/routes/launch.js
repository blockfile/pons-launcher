'use strict';

const express = require('express');
const config = require('../config');
const factory = require('../evm/factory');
const { prepare } = require('../bundle/prepare');
const { fire } = require('../bundle/fire');
const { keystoreFor } = require('../wallets/keystore');
const { historyFor } = require('../store/history');
const { requireApiKey } = require('../middleware/auth');
const { uploadImage, ACCEPTED, MAX_BYTES } = require('../ipfs/upload');

const router = express.Router();

/**
 * A plan safe to return over HTTP. Signed transactions are stripped: anyone
 * holding a raw signed buy could broadcast it, so it never leaves the server.
 */
function publicPlan(plan) {
  return {
    ...plan,
    launch: { ...plan.launch, raw: undefined },
    buys: plan.buys.map((b) => ({ ...b, raw: undefined })),
  };
}

// GET /api/configs — launch configs, dex configs and the current launch fee,
// read live from the factory rather than hardcoded.
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
    res.json(publicPlan(await prepare(req.body || {}, { keystore: keystoreFor(req.user.id) })));
  } catch (err) {
    next(err);
  }
});

// POST /api/launch — prepare, then fire. DRY_RUN still returns a full plan and
// simulated results without touching the chain.
router.post('/launch', requireApiKey, async (req, res, next) => {
  try {
    const plan = await prepare(req.body || {}, { keystore: keystoreFor(req.user.id) });
    const result = await fire(plan);
    const entry = historyFor(req.user.id).record({ plan, result });
    res.json({ plan: publicPlan(plan), result, recorded: entry.at });
  } catch (err) {
    next(err);
  }
});

router.get('/launches', (req, res, next) => {
  try {
    res.json(historyFor(req.user.id).list(Number(req.query.limit) || 50));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
