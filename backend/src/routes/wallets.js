'use strict';

const express = require('express');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const funding = require('../wallets/funding');
const { dispersersFor } = require('../store/dispersers');
const { activityFor, viewFor, summariseTransfers } = require('../store/activity');
const users = require('../users/users');
const { historyFor } = require('../store/history');
const { BATCH_THRESHOLD } = require('../evm/disperse');
const { estimate, deploy } = require('../evm/deploy');
const { provider } = require('../evm/provider');
const { formatEther } = require('ethers');
const { requireApiKey } = require('../middleware/auth');
const { findSellable, withDeadline } = require('../evm/v2/holdings');
const { prepareSell } = require('../bundle/prepareSell');
const { fireSell } = require('../bundle/fireSell');
const { jsonSafe } = require('./launch');

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
    const made = ks.generate(n, { label, role });
    activityFor(req.user.id).record('wallets', `generated ${made.length} ${role} wallet(s)`, {
      addresses: made.map((w) => w.address),
    });
    res.json(made);
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
    const added = ks.importKeys(keys, { label, role });
    activityFor(req.user.id).record('wallets', `imported ${added.length} ${role} wallet(s)`, {
      addresses: added.map((w) => w.address),
    });
    res.json(added);
  } catch (err) {
    next(err);
  }
});

// ── the archive is not on this API ────────────────────────────────────────
// A delete moves the wallet into an archive encrypted exactly as the live
// keystore is, rather than dropping the key (see keystore.remove). Reading that
// archive, restoring from it and purging it are SERVER-SIDE ONLY — three
// `npm run archive:*` commands in backend/scripts/archive.js — and there are
// deliberately no routes here for them.
//
// The archive is the recovery path for a wallet compromise, so it must not be
// reachable by the credential a compromise is most likely to yield. Whoever
// holds the API key can already delete wallets; they must not also be able to
// list what was deleted, put a revoked key back into the live keystore, or
// destroy the copies that make the deletes survivable. That last one is the
// point: an attacker who could purge could make a mistaken or malicious delete
// permanent, and the archive would have bought nothing.
//
// Deleting a wallet is still an archive write, and stays on this API — it is
// what the console's delete does.

// DELETE /api/wallets/:id — remove from the live keystore. The key is not
// destroyed: it moves to the archive, and the console's dialog says so.
// `npm run archive:restore` on the server is the way back, and
// `npm run archive:purge` is what destroys it.
router.delete('/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const out = ks.remove(req.params.id);
    activityFor(req.user.id).record(
      'wallets',
      `archived wallet ${out.address} — recoverable from the server until purged`,
      { address: out.address }
    );
    // The archive is capped, so this delete may have destroyed an OLDER key to
    // make room — an irreversible loss nobody asked for, on a request that was
    // about a different wallet. One line per evicted address, because that line
    // is very likely the only remaining trace the key ever existed. Never fold
    // these into a count: an address is what an operator can act on.
    for (const gone of out.evicted || []) {
      activityFor(req.user.id).record(
        'wallets',
        `evicted wallet ${gone.address} from a full archive — its key is destroyed`,
        { address: gone.address, deletedAt: gone.deletedAt, reason: 'archive full' }
      );
    }
    res.json(out);
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
    const out = ks.exportKey(id);
    // The fact, never the key.
    activityFor(req.user.id).record('export', `exported the private key for ${out.address}`, {
      address: out.address,
    });
    res.json(out);
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
    // The count and the fact, never the keys — an audit trail that is itself a
    // copy of the keystore would be worse than no audit trail.
    activityFor(req.user.id).record('export', `downloaded a full backup of ${wallets.length} private key(s)`, {
      count: wallets.length,
    });
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
    const out = await funding.disperse(targets, { keystore: ks, userId: req.user.id });
    const s = summariseTransfers(out);
    activityFor(req.user.id).record(
      'fund',
      `funded ${s.sent}/${s.wallets} wallet(s)` + (s.failed ? `, ${s.failed} failed` : ''),
      s
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST /api/sweep — return funds to the dev wallet. ETH only unless asked.
router.post('/sweep', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { includeTokens = false, tokenAddress = null } = req.body || {};
    const out = await funding.sweep({ includeTokens, tokenAddress }, { keystore: ks });
    const s = summariseTransfers(out);
    activityFor(req.user.id).record(
      'sweep',
      `swept ${s.sent}/${s.wallets} wallet(s) to the dev wallet` + (s.failed ? `, ${s.failed} failed` : ''),
      { ...s, includeTokens, tokenAddress }
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ── selling out ───────────────────────────────────────────────────────────
// Exit 100% of a launched token from every bundle wallet holding it, in one
// action. See docs/superpowers/specs/2026-08-06-sell-all-design.md — every
// decision there was made deliberately, with the risk stated.

/**
 * A sell plan safe to return over HTTP. The signed transactions are stripped:
 * anyone holding a raw signed sell could broadcast it, so they never leave the
 * server. Same rule as the launch preflight.
 */
function publicSellPlan(plan) {
  return jsonSafe({
    ...plan,
    wallets: plan.wallets.map((w) => ({
      ...w,
      approve: { ...w.approve, raw: undefined },
      sell: { ...w.sell, raw: undefined },
    })),
  });
}

/**
 * Every token this user has launched through the console, newest first.
 *
 * THIS IS THE PRIMARY SOURCE FOR THE PICKER, not a top-up. data/launches.<user>
 * .json already records the token and the curve for every launch this console
 * made, so reading it answers the common case with no chain calls at all — and
 * the alternative, enumerating TokenLaunched over 28.7M blocks, is what hung
 * this route in production. It is still only a hint about WHERE TO LOOK:
 * findSellable re-checks every one of these against the factory.
 *
 * `protocol` rides along so a v1 launch is looked up in the v1 registry and a v2
 * one in v2's. It is a hint and nothing more: entries written before that field
 * existed carry none, and findSellable asks both registries regardless.
 */
function historyTokens(userId) {
  try {
    return historyFor(userId)
      .list(200)
      .filter((e) => e.token)
      .map((e) => ({ token: e.token, protocol: e.protocol || null }));
  } catch (_err) {
    // A missing or corrupt history file costs speed, not correctness — the
    // bounded log scan still runs.
    return [];
  }
}

// The route's own last line of defence. findSellable already bounds its scan and
// swallows its own failures, so reaching this means something below it stalled
// (a socket with no timeout, a multicall that never answers). AN EMPTY LIST IS A
// BETTER ANSWER THAN NO ANSWER: the operator sees "nothing to sell" and can
// retry, instead of watching a spinner that never resolves. That is exactly the
// bug this replaced.
const SELLABLE_TIMEOUT_MS = 30_000;

// GET /api/sellable — what this bundle could exit right now.
//
// launched-by-us INTERSECT held-by-bundle, and the first half is the safety
// property: a token is NEVER listed because a wallet holds it. Bundle wallets
// get dusted, and selling an unknown token means approving an unknown contract.
// "Us" is every wallet this account holds or has held, not only today's dev
// wallet: the factory records the deployer of the day and never updates it, so
// a rotation would otherwise orphan every earlier launch. See the header of
// evm/v2/holdings.js for the full reasoning before changing anything here.
// The console renders this as a plain list, so the list is what it gets. The
// scan's own diagnostics go to the server log rather than into the array —
// there is nowhere in a row to put "the scan was partial", and inventing a
// wrapper object would leave the picker rendering nothing at all.
router.get('/sellable', async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const out = await withDeadline(
      findSellable({
        deployer: ks.devWallet().address,
        wallets: ks.bundleWallets(),
        knownTokens: historyTokens(req.user.id),
        // Every wallet this account holds or has held, so rotating the dev
        // wallet does not orphan everything launched before the rotation — the
        // factory names the deployer of the day forever. Per-user by
        // construction: this is THIS user's keystore and THIS user's archive.
        owners: ks.ownedAddresses(),
      }),
      SELLABLE_TIMEOUT_MS,
      {
        tokens: [],
        warnings: [
          `listing sellable tokens took longer than ${SELLABLE_TIMEOUT_MS}ms — answered empty ` +
            'rather than leaving the request open; retry',
        ],
      }
    );
    for (const w of out.warnings) console.warn(`[pons-launcher] sellable: ${w}`);
    res.json(jsonSafe(out.tokens));
  } catch (err) {
    next(err);
  }
});

// POST /api/sell/preflight — build and sign the whole exit, broadcast nothing.
// Worth running: it is where the ETH estimate comes from, and arming a
// floor-less irreversible sell without one is not a decision anyone can make.
router.post('/sell/preflight', requireApiKey, async (req, res, next) => {
  try {
    const { token } = req.body || {};
    const plan = await prepareSell({ token }, { keystore: keystoreFor(req.user.id) });
    res.json(publicSellPlan(plan));
  } catch (err) {
    next(err);
  }
});

// POST /api/sell — prepare, then fire. Irreversible and touches every wallet,
// so it takes an explicit confirm as well as the API key, the same two locks a
// key export takes.
router.post('/sell', requireApiKey, async (req, res, next) => {
  try {
    const { token, confirm } = req.body || {};
    if (confirm !== true) {
      throw new Error('selling is irreversible and has no slippage floor — requires { confirm: true }');
    }

    const ks = keystoreFor(req.user.id);
    const plan = await prepareSell({ token }, { keystore: ks });
    const result = await fireSell(plan);

    // The failures are why anyone comes back to this log, so the per-wallet
    // results go in whole rather than as a count.
    const t = result.totals;
    // A dry run says so first. "sold X from 0/2 wallets" is true of a
    // simulation and of a total failure, and the log is read long afterwards.
    const summary = result.simulated
      ? `DRY RUN — would sell ${plan.totalTokens} ${plan.symbol} from ${t.wallets} wallet(s)`
      : `sold ${plan.symbol} from ${t.sold}/${t.wallets} wallet(s)` +
        (t.failed ? `, ${t.failed} failed` : '') +
        (t.ethReceived ? ` — ${t.ethReceived} ETH` : '');
    activityFor(req.user.id).record(
      'sell',
      summary,
      jsonSafe({
        token: plan.token,
        symbol: plan.symbol,
        curve: plan.curve,
        route: plan.route,
        dryRun: Boolean(result.simulated),
        minQuoteOut: '0',
        totals: t,
        fill: result.fill,
        results: result.results,
        skipped: result.skipped,
      })
    );

    // The result IS the response, with the plan hung off it. The console reads
    // response.results/totalEth/bestPrice directly — burying it under a
    // `result` key showed an empty table after an irreversible sell.
    res.json(jsonSafe({ ...result, plan: publicSellPlan(plan) }));
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
      activityFor(req.user.id).record('deploy', `deployed ${deployed.length} disperser contract(s)`, {
        contracts: deployed.map((d) => ({ address: d.address, txHash: d.txHash, gasUsed: d.gasUsed })),
      });
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

// GET /api/activity — this user's own record of funding, sweeps, deploys,
// wallets and exports.
//
// ?user=<id> is the admin exception, and it is honoured ONLY for a caller named
// in ADMIN_USERS. For anyone else the parameter is ignored outright — they get
// their own log, exactly as if they had not passed it. That is not laziness:
// an error would tell a caller holding a stolen key that admins exist here and
// let them enumerate who. See the header of store/activity.js.
router.get('/activity', (req, res, next) => {
  try {
    const { limit = 100, kind = null, user = null } = req.query;
    res.json(viewFor(req.user.id, { user, limit: Number(limit), kind }).entries);
  } catch (err) {
    next(err);
  }
});

// GET /api/users — who exists, so an admin's console can offer a selector.
// Admin only, and ids and names only: no keys, no hashes, no counts of what
// anyone holds.
router.get('/users', (req, res) => {
  if (!users.isAdmin(req.user.id)) return res.status(403).json({ error: 'not permitted' });
  return res.json(users.list().map((u) => ({ id: u.id, name: u.name })));
});

module.exports = router;
