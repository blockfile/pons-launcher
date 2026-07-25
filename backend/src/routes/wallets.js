'use strict';

const express = require('express');
const keystore = require('../wallets/keystore');
const funding = require('../wallets/funding');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// GET /api/wallets — addresses, roles and balances. Never key material.
router.get('/wallets', async (req, res, next) => {
  try {
    res.json(await funding.balances());
  } catch (err) {
    next(err);
  }
});

router.post('/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, label, role = 'bundle' } = req.body || {};
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be 1-100');
    res.json(keystore.generate(n, { label, role }));
  } catch (err) {
    next(err);
  }
});

router.post('/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, label, role = 'bundle' } = req.body || {};
    const keys = Array.isArray(privateKeys)
      ? privateKeys
      : String(privateKeys || '').split(/[\s,]+/);
    if (!keys.filter(Boolean).length) throw new Error('privateKeys is required');
    res.json(keystore.importKeys(keys, { label, role }));
  } catch (err) {
    next(err);
  }
});

router.delete('/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    res.json(keystore.remove(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Deliberate key export — requires the API key AND an explicit confirm flag,
// because this is the one route that puts a private key on the wire.
router.post('/wallets/export', requireApiKey, (req, res, next) => {
  try {
    const { id, confirm } = req.body || {};
    if (confirm !== true) throw new Error('export requires { confirm: true }');
    console.warn(`[pons-launcher] PRIVATE KEY EXPORTED for wallet ${id}`);
    res.json(keystore.exportKey(id));
  } catch (err) {
    next(err);
  }
});

// POST /api/fund — disperse native ETH from the dev wallet to bundle wallets.
router.post('/fund', requireApiKey, async (req, res, next) => {
  try {
    const { targets } = req.body || {};
    if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');
    res.json(await funding.disperse(targets));
  } catch (err) {
    next(err);
  }
});

// POST /api/sweep — return funds to the dev wallet. ETH only unless asked.
router.post('/sweep', requireApiKey, async (req, res, next) => {
  try {
    const { includeTokens = false, tokenAddress = null } = req.body || {};
    res.json(await funding.sweep({ includeTokens, tokenAddress }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
