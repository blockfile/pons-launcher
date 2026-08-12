'use strict';

// The v2 bundler: launch quiet, wait, then buy once through a contract.
//
// SEPARATE FROM THE V1 PATH BY DESIGN. Nothing in here touches routes/launch.js
// or bundle/prepare.js — the v1 flow (dev buy + a bundle racing for the tick)
// keeps working exactly as it did, and this sits alongside it. The two are
// different strategies against the same factory, not two versions of one, so
// sharing code between them would only make each harder to reason about.
//
// The strategy is documented at the top of evm/distributor.js. The short form:
// v1 races the snipers for the open block and loses by ~300ms; this declines
// the race entirely, lets them take a position into a pool with nothing behind
// it, and buys after they have sold it back.

const express = require('express');
const { formatEther, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { keystoreFor } = require('../wallets/keystore');
const { distributorFor } = require('../store/distributors');
const { activityFor } = require('../store/activity');
const { deploy, estimate } = require('../evm/deploy');
const { requireApiKey } = require('../middleware/auth');
const {
  dexParams,
  quoteTrigger,
  buildTriggerTx,
  amountOutFrom,
  sharesFromWeights,
  equalShares,
} = require('../evm/distributor');

const router = express.Router();

/** Resolve the wallets a trigger will pay out to, and their shares. */
function resolveRecipients(ks, body) {
  const ids = Array.isArray(body?.walletIds) ? body.walletIds : [];
  const known = ks.list();
  const chosen = ids.length
    ? ids.map((id) => {
        const w = known.find((k) => k.id === id);
        if (!w) throw new Error(`no wallet ${id}`);
        return w;
      })
    : known.filter((w) => !w.isDev);

  if (!chosen.length) throw new Error('no bundle wallets to distribute to');

  const weights = Array.isArray(body?.weights) && body.weights.length === chosen.length
    ? body.weights
    : null;

  return {
    wallets: chosen.map((w) => w.address),
    shares: weights ? sharesFromWeights(weights) : equalShares(chosen.length),
    chosen,
  };
}

// GET /api/distributor — what this user has, and what it would cost to get one.
router.get('/distributor', requireApiKey, async (req, res, next) => {
  try {
    const store = distributorFor(req.user.id);
    const record = store.get();
    const dex = await dexParams().catch(() => null);

    let quote = null;
    try {
      const ks = keystoreFor(req.user.id);
      const signer = ks.signer(ks.devWallet().id, provider);
      const e = await estimate('BundleDistributor', 1, signer);
      quote = {
        costEth: formatEther(e.each),
        balanceEth: formatEther(e.balance),
        affordable: e.affordable,
      };
    } catch (err) {
      quote = { error: err.message };
    }

    res.json({ distributor: record, dex, quote });
  } catch (err) {
    next(err);
  }
});

// POST /api/distributor/deploy — deploy the BundleDistributor. Spends ETH.
router.post('/distributor/deploy', requireApiKey, async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      throw new Error('deploying spends ETH — requires { confirm: true }');
    }
    if (config.dryRun) throw new Error('DRY_RUN is on — nothing would be deployed');

    const ks = keystoreFor(req.user.id);
    const signer = ks.signer(ks.devWallet().id, provider);
    const [deployed] = await deploy('BundleDistributor', 1, signer);

    const record = distributorFor(req.user.id).set(deployed.address, {
      txHash: deployed.txHash,
      gasUsed: String(deployed.gasUsed ?? ''),
    });
    activityFor(req.user.id).record('deploy', 'deployed a BundleDistributor', {
      contracts: [{ address: deployed.address, txHash: deployed.txHash }],
    });
    res.json({ distributor: record });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/distributor — stop using it. The contract stays on chain.
router.delete('/distributor', requireApiKey, (req, res, next) => {
  try {
    distributorFor(req.user.id).clear();
    res.json({ distributor: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/distributor/quote — what would a trigger of this size receive?
//
// A real eth_call against the live pool, not a curve estimate. By now the pool
// exists, and the entire point of this strategy is buying after other people
// have moved the price — so a modelled opening price would answer the wrong
// question. It also detects the one mistake that matters: triggering before
// the restriction window lifts, where the buy is capped at ~5% of supply.
router.post('/distributor/quote', requireApiKey, async (req, res, next) => {
  try {
    const { token, amountEth } = req.body || {};
    if (!token) throw new Error('token is required');
    if (!(Number(amountEth) > 0)) throw new Error('amountEth must be positive');

    const store = distributorFor(req.user.id);
    const record = store.get();
    if (!record) throw new Error('no distributor deployed — deploy one first');

    const ks = keystoreFor(req.user.id);
    const dev = ks.devWallet();
    const { wallets, shares, chosen } = resolveRecipients(ks, req.body);

    const q = await quoteTrigger({
      distributor: record.address,
      token,
      amountEth,
      wallets,
      shares,
      from: dev.address,
    });

    res.json({
      ok: q.ok,
      reason: q.reason,
      amountOut: q.amountOut.toString(),
      wallets: chosen.map((w, i) => ({ id: w.id, address: w.address, shareBps: shares[i] })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/distributor/trigger — buy once and fan out. Spends real ETH.
router.post('/distributor/trigger', requireApiKey, async (req, res, next) => {
  try {
    const { token, amountEth, slippageBps = 1500, confirm } = req.body || {};
    if (confirm !== true) throw new Error('this spends ETH — requires { confirm: true }');
    if (!token) throw new Error('token is required');
    if (!(Number(amountEth) > 0)) throw new Error('amountEth must be positive');
    if (config.dryRun) throw new Error('DRY_RUN is on — nothing would be sent');

    const record = distributorFor(req.user.id).get();
    if (!record) throw new Error('no distributor deployed — deploy one first');

    const ks = keystoreFor(req.user.id);
    const dev = ks.devWallet();
    const signer = ks.signer(dev.id, provider);
    const { wallets, shares, chosen } = resolveRecipients(ks, req.body);

    // Quote first, always. It is one eth_call and it is the difference between
    // a clean revert and spending gas to find out the window has not lifted.
    const q = await quoteTrigger({
      distributor: record.address,
      token,
      amountEth,
      wallets,
      shares,
      from: dev.address,
    });
    if (!q.ok) throw new Error(`refusing to send — ${q.reason}`);

    // The floor is derived from the quote taken moments ago, so it tracks the
    // live pool rather than a model. Never zero: a zero floor fills at whatever
    // price somebody else has just moved it to.
    const bps = BigInt(Math.max(1, Math.min(9000, Number(slippageBps))));
    const minOut = (q.amountOut * (10_000n - bps)) / 10_000n;
    if (!(minOut > 0n)) throw new Error('quote came back empty — refusing to send');

    const { router: dexRouter, weth, poolFee } = await dexParams();
    const tx = buildTriggerTx({
      distributor: record.address,
      router: dexRouter,
      weth,
      token,
      poolFee,
      minOut,
      wallets,
      shares,
      amountEth,
    });

    const sent = await signer.sendTransaction(tx);
    const receipt = await sent.wait(1);
    const amountOut = amountOutFrom(receipt);

    const out = {
      hash: sent.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      amountOut: amountOut ? amountOut.toString() : null,
      quoted: q.amountOut.toString(),
      minOut: minOut.toString(),
      wallets: chosen.map((w, i) => ({ id: w.id, address: w.address, shareBps: shares[i] })),
    };

    activityFor(req.user.id).record(
      'fund',
      `v2 bundler: bought ${amountEth} ETH of ${token} and split it ${chosen.length} ways`,
      { results: [{ address: record.address, hash: sent.hash }] }
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
