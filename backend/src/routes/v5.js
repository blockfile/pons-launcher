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

const router = express.Router();

// GET /api/v5/config — the letscash contract map + chain, for the console.
router.get('/v5/config', requireApiKey, (req, res) => {
  res.json({
    chainId: config.chainId,
    explorerUrl: config.explorerUrl,
    letscash: config.letscash,
    roles: v5roles.ROLES,
  });
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

module.exports = router;
