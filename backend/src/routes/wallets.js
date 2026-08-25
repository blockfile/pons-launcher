'use strict';

const express = require('express');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const funding = require('../wallets/funding');
const {
  DEFAULT_VARIANT,
  devWalletFor,
  bundleWalletsFor,
  usesDispersers,
} = require('../wallets/variants');
const { dispersersFor } = require('../store/dispersers');
const { distributorFor } = require('../store/distributors');
const { activityFor, viewFor, summariseTransfers } = require('../store/activity');
const users = require('../users/users');
const { historyFor } = require('../store/history');
const { BATCH_THRESHOLD } = require('../evm/disperse');
const { estimate, deploy } = require('../evm/deploy');
const { provider } = require('../evm/provider');
const { formatEther } = require('ethers');
const { requireApiKey, requireAuthConfigured } = require('../middleware/auth');
const { findSellable, withDeadline } = require('../evm/v2/holdings');
const { prepareSell } = require('../bundle/prepareSell');
const { fireSell } = require('../bundle/fireSell');
const { jsonSafe } = require('./launch');
const relayFunding = require('../relay/funding');
const timedRelayFunding = require('../relay/timedFunding');
const { storeFor } = require('../v4/store');
const seasoned = require('../v4/seasoned');

const router = express.Router();

// The most bundle wallets a launch can carry. A launch with a dev buy goes
// through the forwarder, which appends its own buy recipient before handing the
// snipe-tax exemption list to the factory — so the factory's 32 leaves room for
// only 31 of ours. Passing 32 is the ExemptionListTooLong revert that stranded a
// bundle's ETH, so the wallets are capped here rather than left to be caught at
// launch: an operator cannot even create a 32nd bundle wallet.
const MAX_BUNDLE_WALLETS = 31;

// Every bundle role, not just v1's. The 31 is a property of the FACTORY — the
// forwarder appends its own recipient to a 32-slot exemption list — so it binds
// any launcher pointed at it, and a v2 bundle of 32 would strand its ETH on the
// same revert that stranded v1's. Counted per role rather than across both, so
// the two launchers each get their own 31 instead of eating each other's.
const BUNDLE_ROLES = new Set(['bundle', 'v2bundle']);

function assertBundleRoom(ks, role, adding) {
  if (!BUNDLE_ROLES.has(role)) return;
  const have = ks.walletsWithRole(role).length;
  if (have + adding > MAX_BUNDLE_WALLETS) {
    throw new Error(
      `a launch exempts at most ${MAX_BUNDLE_WALLETS} ${role} wallets (the dev wallet is separate). ` +
        `You have ${have}; ${adding} more would be ${have + adding}. Remove some first, or add up to ${
          MAX_BUNDLE_WALLETS - have
        }.`
    );
  }
}

// GET /api/wallets — addresses, roles and balances. Never key material.
router.get('/wallets', requireApiKey, async (req, res, next) => {
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
    assertBundleRoom(ks, role, n);
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
    assertBundleRoom(ks, role, keys.filter(Boolean).length);
    const added = ks.importKeys(keys, { label, role });
    activityFor(req.user.id).record('wallets', `imported ${added.length} ${role} wallet(s)`, {
      addresses: added.map((w) => w.address),
    });
    res.json(added);
  } catch (err) {
    next(err);
  }
});

// POST /api/wallets/:id/role — move a wallet between roles.
//
// A key already in the keystore cannot be imported a second time, so this is
// how an existing wallet becomes the v2 signer or funder without generating a
// fresh one and transferring its balance across for nothing.
router.post('/wallets/:id/role', requireApiKey, (req, res, next) => {
  try {
    const { role } = req.body || {};
    if (!role) throw new Error('role is required');
    const ks = keystoreFor(req.user.id);
    const out = ks.setRole(req.params.id, role);
    activityFor(req.user.id).record('wallets', `moved ${out.address} to the ${role} role`, {
      address: out.address,
      role,
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST /api/wallets/claim-seasoned — pull N of V4's finished-seasoning wallets
// into V1's bundle role, most-aged first. They arrive pre-aged and pre-funded.
router.post('/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    if (take.length === 0) {
      return res.json({ claimed: [], available: pool.length, shortfall: want });
    }
    assertBundleRoom(ks, 'bundle', take.length); // refuses before any re-role
    const out = seasoned.claim(ks, store, take.map((w) => w.id), { toRole: 'bundle', toTab: 'v1', now: Date.now() });
    activityFor(req.user.id).record('wallets', `claimed ${out.claimed.length} seasoned wallet(s) into v1 bundle`, {
      count: out.claimed.length,
    });
    res.json({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) });
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
router.post('/wallets/export', requireApiKey, requireAuthConfigured, (req, res, next) => {
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
router.post('/wallets/backup', requireApiKey, requireAuthConfigured, (req, res, next) => {
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
    // viaDisperser: the paced v1 path — one disperser transaction for the
    // targets in THIS request (the panel posts one wallet at a time). The
    // disperser address is validated inside disperse() against the user's own
    // list; a foreign address is refused before anything is signed.
    const { targets, variant = DEFAULT_VARIANT, viaDisperser = false, disperser } = req.body || {};
    if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');
    // Bound the work before it starts: disperse does an O(n) keystore lookup per
    // target, so an unbounded list is O(n²) CPU on the request path. A real
    // bundle is tens of wallets; 500 is far above that and far below abusive.
    if (targets.length > 500) throw new Error(`targets[] is capped at 500 (got ${targets.length})`);
    const out = await funding.disperse(targets, {
      keystore: ks,
      userId: req.user.id,
      variant,
      viaDisperser: viaDisperser === true,
      disperser,
    });
    const s = summariseTransfers(out);
    // The variant is on the log line, not only in the payload: an operator
    // reading the activity log after a bad run needs to know WHICH launcher
    // spent, and "funded 27 wallets" reads identically for both.
    activityFor(req.user.id).record(
      'fund',
      `[${variant}] funded ${s.sent}/${s.wallets} wallet(s)` +
        (viaDisperser === true ? ' via disperser' : '') +
        (s.failed ? `, ${s.failed} failed` : ''),
      { ...s, variant, viaDisperser: viaDisperser === true }
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST /api/v2/relay/fund — fund v2 bundle wallets through Relay solver orders.
//
// This is intentionally a v2-only route rather than a new option on /api/fund:
// v1's funding path is the old direct/disperser path, and this endpoint refuses
// any target that is not a v2bundle wallet before asking Relay for quotes.
router.post('/v2/relay/fund', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { targets } = req.body || {};
    const out = await relayFunding.fundV2Bundle(targets, { keystore: ks });
    const sent = out.results.filter((r) => r.hash || r.simulated).length;
    const failed = out.results.length - sent;
    activityFor(req.user.id).record(
      'fund',
      `[v2] Relay solver funding ${sent}/${out.results.length} wallet(s)` +
        (failed ? `, ${failed} failed before deposit` : ''),
      {
        mode: out.mode,
        from: out.from,
        totalDepositEth: out.totalDepositEth,
        results: out.results.map((r) => ({
          walletId: r.walletId,
          address: r.address,
          amountEth: r.amountEth,
          requestId: r.requestId,
          depositAddress: r.depositAddress,
          hash: r.hash,
          error: r.error,
        })),
      }
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// GET /api/v2/relay/status?requestId=0x... — Relay intent status.
router.get('/v2/relay/status', requireApiKey, async (req, res, next) => {
  try {
    res.json(await relayFunding.status(req.query?.requestId));
  } catch (err) {
    next(err);
  }
});

// Server-held timed funding for v2 bundle wallets. The browser can close after
// starting it; only stopping/resuming needs the web UI to be open.
router.get('/v2/relay/timed-fund', requireApiKey, (req, res, next) => {
  try {
    res.json(timedRelayFunding.status(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.post('/v2/relay/timed-fund/start', requireApiKey, (req, res, next) => {
  try {
    const { targets, intervalMinutes } = req.body || {};
    res.json(timedRelayFunding.start(req.user.id, targets, { intervalMinutes }));
  } catch (err) {
    next(err);
  }
});

router.post('/v2/relay/timed-fund/stop', requireApiKey, (req, res, next) => {
  try {
    res.json(timedRelayFunding.stop(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.post('/v2/relay/timed-fund/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(timedRelayFunding.resume(req.user.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/sweep — return funds to the dev wallet. ETH only unless asked.
router.post('/sweep', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const { includeTokens = false, tokenAddress = null, variant = DEFAULT_VARIANT } = req.body || {};
    const out = await funding.sweep({ includeTokens, tokenAddress }, { keystore: ks, variant });
    const s = summariseTransfers(out);
    activityFor(req.user.id).record(
      'sweep',
      `[${variant}] swept ${s.sent}/${s.wallets} wallet(s) to the dev wallet` +
        (s.failed ? `, ${s.failed} failed` : ''),
      { ...s, includeTokens, tokenAddress, variant }
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
router.get('/sellable', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    // Which launcher is asking. A v2 sell must scan v2 bundle wallets, or the
    // picker offers tokens the v2 signer cannot sell.
    const sellVariant = req.query?.variant || DEFAULT_VARIANT;
    const out = await withDeadline(
      findSellable({
        deployer: devWalletFor(ks, sellVariant).address,
        wallets: bundleWalletsFor(ks, sellVariant),
        knownTokens: historyTokens(req.user.id),
        // Every wallet this account holds or has held, so rotating the dev
        // wallet does not orphan everything launched before the rotation — the
        // factory names the deployer of the day forever. Per-user by
        // construction: this is THIS user's keystore and THIS user's archive.
        //
        // The v2 distributor belongs here for the same reason and is easy to
        // miss: on that path the CONTRACT calls launchToken, so the factory
        // records the contract as deployer and no keystore wallet matches.
        // Without this line every atomic launch would be invisible to the sell
        // panel — launched fine, then unsellable. It is this user's own
        // contract, so it widens the set by exactly one address they control.
        owners: [...ks.ownedAddresses(), distributorFor(req.user.id).get()?.address].filter(
          Boolean
        ),
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
    const plan = await prepareSell({ token }, { keystore: keystoreFor(req.user.id), variant: req.body?.variant || DEFAULT_VARIANT });
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
    const plan = await prepareSell({ token }, { keystore: ks, variant: req.body?.variant || DEFAULT_VARIANT });
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
router.get('/dispersers', requireApiKey, async (req, res, next) => {
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
      // The quote is for whichever dev wallet would actually pay for the deploy.
      const signer = ks.signer(devWalletFor(ks, req.query?.variant || DEFAULT_VARIANT).id, provider);
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

    const deployVariant = req.body?.variant || DEFAULT_VARIANT;
    // Refused rather than quietly allowed: a launcher that funds with
    // individual transfers has nothing to batch, so a contract deployed for it
    // would cost gas and then never be called.
    if (!usesDispersers(deployVariant)) {
      throw new Error(`the ${deployVariant} launcher funds with individual transfers and uses no disperser`);
    }
    const ks = keystoreFor(req.user.id);
    const signer = ks.signer(devWalletFor(ks, deployVariant).id, provider);
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
router.get('/activity', requireApiKey, (req, res, next) => {
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
