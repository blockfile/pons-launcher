'use strict';

const express = require('express');
const config = require('../config');
const factory = require('../evm/factory');
const { prepare } = require('../bundle/prepare');
const { fire } = require('../bundle/fire');
const history = require('../store/history');
const { requireApiKey } = require('../middleware/auth');

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

// POST /api/preflight — build and sign the whole bundle, broadcast nothing.
// This is the rehearsal: it proves balances, gas and the predicted token
// address before any money moves.
router.post('/preflight', requireApiKey, async (req, res, next) => {
  try {
    res.json(publicPlan(await prepare(req.body || {})));
  } catch (err) {
    next(err);
  }
});

// POST /api/launch — prepare, then fire. DRY_RUN still returns a full plan and
// simulated results without touching the chain.
router.post('/launch', requireApiKey, async (req, res, next) => {
  try {
    const plan = await prepare(req.body || {});
    const result = await fire(plan);
    const entry = history.record({ plan, result });
    res.json({ plan: publicPlan(plan), result, recorded: entry.at });
  } catch (err) {
    next(err);
  }
});

router.get('/launches', (req, res, next) => {
  try {
    res.json(history.list(Number(req.query.limit) || 50));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
