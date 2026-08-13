'use strict';

// The v2 bundler: take the supply inside the launch transaction itself.
//
// SEPARATE FROM THE V1 PATH BY DESIGN. Nothing in here touches routes/launch.js
// or bundle/prepare.js — the v1 flow (dev buy + a bundle racing for the tick)
// keeps working exactly as it did, and this sits alongside it. The two are
// different strategies against the same factory, not two versions of one, so
// sharing code between them would only make each harder to reason about.
//
// v1 races the snipers for the first legal block and loses it by ~300ms. This
// declines the race: the factory's initial buy runs INSIDE launchToken, where
// every other pool buy reverts, and the distributor fans it out before the
// transaction ends. Nothing can precede it, so there is nothing to be late for.
//
// THREE ROLES, DELIBERATELY SEPARATE:
//   dev wallet      deploys the contract and signs the launch. Pays gas and the
//                   launch fee, never the buy, never holds supply.
//   funding wallet  stages the buy by sending ETH to the contract. Can be any
//                   address, or several — both spending paths read the whole
//                   balance, so no single wallet ever holds the full amount.
//   bundle wallets  receive the supply. They never buy, so they never need ETH
//                   before a launch — which is also what removes the disperser
//                   fingerprint that used to announce a launch 8-22 min early.

const express = require('express');
const { formatEther, parseEther, hexlify, randomBytes } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { keystoreFor } = require('../wallets/keystore');
const { distributorFor } = require('../store/distributors');
const { activityFor } = require('../store/activity');
const { deploy, estimate } = require('../evm/deploy');
const { getConfigs } = require('../evm/factory');
const { requireApiKey } = require('../middleware/auth');
const {
  dexParams,
  quoteTrigger,
  buildTriggerTx,
  buildLaunchTx,
  launchedTokenFrom,
  explainRevert,
  amountOutFrom,
  sharesFromWeights,
  equalShares,
} = require('../evm/distributor');

const router = express.Router();

/**
 * The wallet that signs on this path — v2's own, never v1's dev wallet.
 *
 * It pays gas and the launch fee and nothing else: the buy is staged in the
 * contract by the v2 funding wallet, and the supply goes to the v2 bundle
 * wallets. Three roles, three addresses, none of them shared with v1.
 */
function v2Signer(ks) {
  const signer = ks.walletWithRole('v2dev');
  if (!signer) {
    throw new Error('no v2 dev wallet — generate one on the V2 tab first');
  }
  return signer;
}

/**
 * Resolve the wallets a buy will pay out to, and their shares.
 *
 * v2bundle ONLY. These are not v1's bundle wallets and must never be: the two
 * strategies fund and spend differently, and an operator who cannot tell from
 * the screen which set a button is about to move is one click from mixing them.
 *
 * An earlier version filtered on `w.isDev`, which publicView does not set — so
 * it silently returned every wallet in the keystore, dev included. Filtering on
 * the role is both correct and the thing that keeps the tabs separate.
 */
function resolveRecipients(ks, body) {
  const ids = Array.isArray(body?.walletIds) ? body.walletIds : [];
  const known = ks.walletsWithRole('v2bundle');
  const chosen = ids.length
    ? ids.map((id) => {
        const w = known.find((k) => k.id === id);
        if (!w) throw new Error(`no v2 bundle wallet ${id}`);
        return w;
      })
    : known;

  if (!chosen.length) {
    throw new Error('no v2 bundle wallets — generate them on the V2 tab first');
  }

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
      const signer = ks.signer(v2Signer(ks).id, provider);
      const e = await estimate('BundleDistributor', 1, signer);
      quote = {
        costEth: formatEther(e.each),
        balanceEth: formatEther(e.balance),
        affordable: e.affordable,
      };
    } catch (err) {
      quote = { error: err.message };
    }

    // What the contract is already holding. The launch spends its whole
    // balance, so this is capital that can arrive from ANY wallet — the dev
    // wallet never has to hold the buy, and the funding wallet never has to be
    // the one that launches.
    let staged = null;
    if (record) {
      try {
        staged = formatEther(await provider.getBalance(record.address));
      } catch (_err) {
        staged = null;
      }
    }

    res.json({ distributor: record, dex, quote, stagedEth: staged });
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
    const signer = ks.signer(v2Signer(ks).id, provider);
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
    const dev = v2Signer(ks);
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

// POST /api/distributor/stage — move ETH from the v2 funding wallet into the
// contract, ready for the launch to spend.
//
// The contract also accepts a plain transfer from anywhere, which is the point
// of staging: capital can arrive from an exchange or from several wallets and
// no single address ever holds the whole amount. This route is the convenience
// for the common case, where the funder is a wallet this keystore already has.
router.post('/distributor/stage', requireApiKey, async (req, res, next) => {
  try {
    const { amountEth, confirm } = req.body || {};
    if (confirm !== true) throw new Error('this moves ETH — requires { confirm: true }');
    if (!(Number(amountEth) > 0)) throw new Error('amountEth must be positive');
    if (config.dryRun) throw new Error('DRY_RUN is on — nothing would be sent');

    const record = distributorFor(req.user.id).get();
    if (!record) throw new Error('no distributor deployed — deploy one first');

    const ks = keystoreFor(req.user.id);
    const funder = ks.walletWithRole('v2funding');
    if (!funder) throw new Error('no v2 funding wallet — create one on the V2 tab first');

    const value = parseEther(String(amountEth));
    const balance = await provider.getBalance(funder.address);
    // Named, not just refused: "insufficient funds" from the node says nothing
    // about which wallet or how short it is, and the funder is easy to confuse
    // with the signer when both are new.
    if (balance <= value) {
      throw new Error(
        `the funding wallet holds ${formatEther(balance)} ETH and this would send ${amountEth} — ` +
          'it also needs gas left over. Fund it first, or send less.'
      );
    }

    const signer = ks.signer(funder.id, provider);
    const tx = await signer.sendTransaction({ to: record.address, value });
    const receipt = await tx.wait(1);
    const staged = await provider.getBalance(record.address);

    activityFor(req.user.id).record('fund', `staged ${amountEth} ETH into the distributor`, {
      results: [{ address: record.address, hash: tx.hash }],
    });

    res.json({
      hash: tx.hash,
      status: receipt.status,
      stagedEth: formatEther(staged),
      from: funder.address,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/distributor/launch — the atomic path. Launch, take the whole
// initial buy, and fan it across the bundle wallets, all in one transaction.
//
// This is the one the evidence supports. Across 242,815 launches, taking
// 60-90% of supply through the atomic buy lost 0.08% of float to snipers;
// taking the same share through a post-launch bundle lost 3.06%. Nothing can
// precede it — the token does not exist until this call runs — so there is no
// race to lose and no timing to get right.
router.post('/distributor/launch', requireApiKey, async (req, res, next) => {
  try {
    const { params, devBuyEth = 0, launchConfigId = 0, dexId = 0, confirm } = req.body || {};
    if (confirm !== true) throw new Error('this spends ETH — requires { confirm: true }');
    if (!params?.name || !params?.symbol) throw new Error('name and symbol are required');
    if (config.dryRun) throw new Error('DRY_RUN is on — nothing would be sent');

    const record = distributorFor(req.user.id).get();
    if (!record) throw new Error('no distributor deployed — deploy one first');

    const ks = keystoreFor(req.user.id);
    const dev = v2Signer(ks);
    const signer = ks.signer(dev.id, provider);
    const { wallets, shares, chosen } = resolveRecipients(ks, req.body);

    const { launchFee } = await getConfigs();
    const addedNow = parseEther(String(devBuyEth || 0));

    // THE DEV WALLET DOES NOT HAVE TO CARRY THE BUY. The contract spends its
    // whole balance, so the capital can be staged there beforehand from any
    // wallet — or several — and this call adds nothing but the launch fee. That
    // separation is the point: whoever funds is not whoever launches, and no
    // single address ever holds the full amount.
    const staged = await provider.getBalance(record.address);
    const total = staged + addedNow;
    if (total <= BigInt(launchFee)) {
      throw new Error(
        `the distributor holds ${formatEther(staged)} ETH and this call adds ${formatEther(addedNow)} — ` +
          `that leaves nothing for the buy after the ${formatEther(launchFee)} launch fee. ` +
          'Send ETH to the contract first, or pass devBuyEth.'
      );
    }

    const value = addedNow + BigInt(launchFee);
    const salt = hexlify(randomBytes(32));

    const tx = buildLaunchTx({
      distributor: record.address,
      factory: config.factoryAddress,
      params,
      launchConfigId: Number(launchConfigId),
      dexId: Number(dexId),
      salt,
      wallets,
      shares,
      valueWei: value,
    });

    // Simulated before it is sent, always. A launch that reverts has still
    // spent the fee, and the one mistake this path allows — a non-zero
    // feeWallet, which would send the supply somewhere else and leave nothing
    // to distribute — is only visible here.
    try {
      await provider.call({ ...tx, from: dev.address });
    } catch (err) {
      throw new Error(`simulation failed, refusing to send — ${explainRevert(err)}`);
    }

    const sent = await signer.sendTransaction(tx);
    const receipt = await sent.wait(1);
    const token = launchedTokenFrom(receipt);

    activityFor(req.user.id).record(
      'deploy',
      `v2 atomic launch: ${params.symbol} with a ${devBuyEth} ETH buy split ${chosen.length} ways`,
      { contracts: token ? [{ address: token, txHash: sent.hash }] : [] }
    );

    res.json({
      hash: sent.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      token,
      devBuyEth: String(devBuyEth),
      wallets: chosen.map((w, i) => ({ id: w.id, address: w.address, shareBps: shares[i] })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/distributor/trigger — buy once and fan out. Spends real ETH.
router.post('/distributor/trigger', requireApiKey, async (req, res, next) => {
  try {
    const { token, amountEth = 0, slippageBps = 1500, confirm } = req.body || {};
    if (confirm !== true) throw new Error('this spends ETH — requires { confirm: true }');
    if (!token) throw new Error('token is required');
    if (config.dryRun) throw new Error('DRY_RUN is on — nothing would be sent');

    const record = distributorFor(req.user.id).get();
    if (!record) throw new Error('no distributor deployed — deploy one first');

    const ks = keystoreFor(req.user.id);
    const dev = v2Signer(ks);
    const signer = ks.signer(dev.id, provider);
    const { wallets, shares, chosen } = resolveRecipients(ks, req.body);

    // Same role split as the launch: the contract spends its WHOLE balance, so
    // the ETH can be staged by a funding wallet and the dev wallet need only
    // pay gas. Passing amountEth still works and simply adds to what is there.
    const held = await provider.getBalance(record.address);
    if (held + parseEther(String(amountEth || 0)) === 0n) {
      throw new Error('the distributor holds nothing and this call adds nothing — stage ETH first');
    }

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
