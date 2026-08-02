'use strict';

const express = require('express');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const funding = require('../wallets/funding');
const { dispersersFor } = require('../store/dispersers');
const { BATCH_THRESHOLD } = require('../evm/disperse');
const { estimate, deploy } = require('../evm/deploy');
const { provider } = require('../evm/provider');
const { formatEther } = require('ethers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// GET /api/wallets — addresses, roles and balances. Never key material.
router.get('/wallets', async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    res.json(await funding.balances({ keystore: ks }));
  } catch (err) {
    next(err);
  }
});

router.post('/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { count = 1, label, role = 'bundle' } = req.body || {};
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be 1-100');
    res.json(ks.generate(n, { label, role }));
  } catch (err) {
    next(err);
  }
});

router.post('/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { privateKeys, label, role = 'bundle' } = req.body || {};
    const keys = Array.isArray(privateKeys)
      ? privateKeys
      : String(privateKeys || '').split(/[\s,]+/);
    if (!keys.filter(Boolean).length) throw new Error('privateKeys is required');
    res.json(ks.importKeys(keys, { label, role }));
  } catch (err) {
    next(err);
  }
});

router.delete('/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    res.json(ks.remove(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Deliberate key export — requires the API key AND an explicit confirm flag,
// because this is the one route that puts a private key on the wire.
router.post('/wallets/export', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { id, confirm } = req.body || {};
    if (confirm !== true) throw new Error('export requires { confirm: true }');
    console.warn(`[pons-launcher] PRIVATE KEY EXPORTED for wallet ${id}`);
    res.json(ks.exportKey(id));
  } catch (err) {
    next(err);
  }
});

// POST /api/wallets/backup — every key at once, for an offline backup. Same
// two locks as the single export, and logged the same way: whoever holds the
// file this produces controls every wallet in it.
router.post('/wallets/backup', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    if ((req.body || {}).confirm !== true) throw new Error('backup requires { confirm: true }');
    const wallets = ks.exportAll();
    console.warn(`[pons-launcher] FULL KEYSTORE EXPORTED — ${wallets.length} private keys`);
    res.json({
      exportedAt: new Date().toISOString(),
      chainId: config.chainId,
      count: wallets.length,
      // Stated in the file itself, because a backup outlives the session that
      // produced it and the person opening it may not be the one who made it.
      warning:
        'These private keys control real funds. Anyone holding this file can spend every wallet in it. ' +
        'Store it offline. There are no mnemonics: the keystore holds private keys only.',
      wallets,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/fund — disperse native ETH from the dev wallet to bundle wallets.
router.post('/fund', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { targets } = req.body || {};
    if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');
    res.json(await funding.disperse(targets, { keystore: ks, userId: req.user.id }));
  } catch (err) {
    next(err);
  }
});

// POST /api/sweep — return funds to the dev wallet. ETH only unless asked.
router.post('/sweep', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { includeTokens = false, tokenAddress = null } = req.body || {};
    res.json(await funding.sweep({ includeTokens, tokenAddress }, { keystore: ks }));
  } catch (err) {
    next(err);
  }
});

// ── disperser contracts ───────────────────────────────────────────────────
// Deploying from the console rather than the shell, and recorded in a file
// rather than .env: the process reads the list per funding run, so a new
// contract is live immediately and nothing has to be restarted. See
// src/store/dispersers.js for why that matters.

// GET /api/dispersers — what this user funds through, and what it would cost
// to deploy one more.
router.get('/dispersers', async (req, res, next) => {
  try {
    const store = dispersersFor(req.user.id);
    const out = {
      dispersers: store.records(),
      addresses: store.addresses(),
      usingFallback: store.usingFallback(),
      batchThreshold: BATCH_THRESHOLD,
    };

    // Best effort: the panel is still useful when the node is unreachable, and
    // a failed price quote must not hide the list of contracts.
    try {
      const ks = keystoreFor(req.user.id);
      const signer = ks.signer(ks.devWallet().id, provider);
      const { each, from, balance } = await estimate('Disperse', 1, signer);
      out.quote = {
        deployer: from,
        balanceEth: formatEther(balance),
        costEachEth: formatEther(each),
      };
    } catch (err) {
      out.quote = { error: err.message };
    }

    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST /api/dispersers/deploy — deploy and record N new Disperse contracts.
// Spends real ETH, so it takes the same explicit confirm as a key export.
router.post('/dispersers/deploy', requireApiKey, async (req, res, next) => {
  try {
    const { count = 1, confirm } = req.body || {};
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('count must be 1-10');
    if (confirm !== true) throw new Error('deploying spends ETH — requires { confirm: true }');
    if (config.dryRun) throw new Error('DRY_RUN is on — nothing would be deployed');

    const ks = keystoreFor(req.user.id);
    const signer = ks.signer(ks.devWallet().id, provider);
    const store = dispersersFor(req.user.id);

    try {
      const deployed = await deploy('Disperse', n, signer);
      store.add(deployed);
      console.warn(`[pons-launcher] ${req.user.id} deployed ${deployed.length} disperser(s)`);
      res.json({ deployed, dispersers: store.records(), addresses: store.addresses() });
    } catch (err) {
      // Contracts that landed before the failure are paid for. Record them
      // before reporting the error, or they are lost and paid for twice.
      if (err.deployed?.length) store.add(err.deployed);
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/dispersers/:address — stop funding through one. The contract
// stays on chain; nothing is destroyed and nothing is held in it.
router.delete('/dispersers/:address', requireApiKey, (req, res, next) => {
  try {
    const store = dispersersFor(req.user.id);
    store.remove(req.params.address);
    res.json({ dispersers: store.records(), addresses: store.addresses() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
