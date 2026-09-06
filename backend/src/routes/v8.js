'use strict';

/**
 * Every /api/v8/* endpoint — the whole surface of the "relay transfer" tab.
 *
 * V8 IS A PURE ETH MOVER. There is no launchpad in it: no launch, no token, no pool, no
 * buy, no sell, no curve. It makes wallets, claims seasoned ones from V4, sends ETH from
 * one main wallet out to many bundle wallets THROUGH RELAY so nothing on-chain connects
 * them, and sweeps the ETH back. That is the entire tab, and that is why this router is
 * the shortest one here.
 *
 * NO BUNDLE CAP, ANYWHERE IN THIS FILE. routes/wallets.js caps v1's and v2's bundles at
 * 31 because the pons factory takes a 32-slot snipe-tax exemption list and the forwarder
 * appends its own recipient to it — a LAUNCH constraint. V8 has no launch and no
 * exemption list, so v8bundle is deliberately NOT in that file's BUNDLE_ROLES and nothing
 * here re-imposes the limit. See v8/roles.js bundle() for the long version.
 *
 * Mounted beside the others and detachable in one line (the isolation rule): unmounting
 * this router removes the tab whole, and no other tab's money path is touched by it.
 */

const express = require('express');
const { formatEther } = require('ethers');
const config = require('../config');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const { requireApiKey, requireAuthConfigured } = require('../middleware/auth');
const { provider } = require('../evm/provider');
const v8roles = require('../v8/roles');
const relayTransfer = require('../v8/relayTransfer');
const timedTransfer = require('../v8/timedTransfer');
const sweep = require('../v8/sweep');
const { storeFor } = require('../v4/store');
const seasoned = require('../v4/seasoned');

const router = express.Router();

/** BigInts out of the response — a local copy so this file stays detachable. */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/**
 * Narrow a full V8-wallet list to what a backup request asked for.
 *
 * With neither filter present the whole list comes back, so the plain "Download backup"
 * button is unchanged. The list handed in is ALREADY gated to V8's own roles, so a filter
 * can only ever NARROW it — an id this tab does not own, or another tab's role, simply
 * matches nothing rather than reaching for it. A filter can never widen the export.
 */
function selectBackupWallets(wallets, body = {}) {
  const ids = Array.isArray(body.walletIds) && body.walletIds.length ? new Set(body.walletIds.map(String)) : null;
  const role = typeof body.role === 'string' && v8roles.isV8Role(body.role) ? body.role : null;
  let out = wallets;
  if (role) out = out.filter((w) => w.role === role);
  if (ids) out = out.filter((w) => ids.has(String(w.id)));
  return out;
}

// ── wallets ─────────────────────────────────────────────────────────────────

// GET /api/v8/wallets — the source wallet and the receivers, with balances. Never key
// material.
router.get('/v8/wallets', requireApiKey, async (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const groups = v8roles.all(ks);
    const withBalance = async (w) =>
      w ? { ...w, balanceEth: formatEther(await provider.getBalance(w.address)) } : null;

    res.json(
      jsonSafe({
        main: await withBalance(groups.main),
        bundle: await Promise.all(groups.bundle.map(withBalance)),
        roles: v8roles.ROLES,
        running: timedTransfer.isRunning(req.user.id),
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/wallets/generate — fresh wallets in one of V8's two roles.
//
// The 1..100 bound is a per-REQUEST sanity bound on one call, NOT a cap on how many
// bundle wallets this tab may hold: repeated calls accumulate without limit, which is the
// point of a tab that has no exemption list to overflow.
router.post('/v8/wallets/generate', requireApiKey, (req, res, next) => {
  try {
    const { count = 1, role, label } = req.body || {};
    if (!v8roles.isV8Role(role)) throw new Error(`role must be one of ${Object.values(v8roles.ROLES).join(', ')}`);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('count must be between 1 and 100');

    const made = keystoreFor(req.user.id).generate(n, { role, label });
    activityFor(req.user.id).record('wallets', `[v8] generated ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/wallets/import — existing keys into one of V8's roles.
//
// NO CAP. An import of 50, or 500, v8bundle wallets is accepted: there is no launch here
// and so no 31-slot exemption list for them to overflow. Do not add one.
router.post('/v8/wallets/import', requireApiKey, (req, res, next) => {
  try {
    const { privateKeys, role, label } = req.body || {};
    if (!v8roles.isV8Role(role)) throw new Error(`role must be one of ${Object.values(v8roles.ROLES).join(', ')}`);
    const keys = Array.isArray(privateKeys) ? privateKeys : [privateKeys].filter(Boolean);
    if (!keys.length) throw new Error('privateKeys is required');

    const made = keystoreFor(req.user.id).importKeys(keys, { role, label });
    activityFor(req.user.id).record('wallets', `[v8] imported ${made.length} ${role} wallet(s)`, {
      role,
      addresses: made.map((w) => w.address),
    });
    res.json(jsonSafe(made));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v8/wallets/:id — refused mid-run (a timed job resolves its wallets by id
// every tick, so deleting one under it would strand the rest of the schedule), and
// refused for any wallet this tab does not own.
router.delete('/v8/wallets/:id', requireApiKey, (req, res, next) => {
  try {
    if (timedTransfer.isRunning(req.user.id)) {
      throw new Error('a v8 timed transfer is in progress — stop it before deleting a wallet');
    }
    const ks = keystoreFor(req.user.id);
    const wallet = ks.list().find((w) => w.id === req.params.id);
    if (!wallet) throw new Error(`no wallet ${req.params.id}`);
    if (!v8roles.isV8Role(wallet.role)) {
      throw new Error(`${req.params.id} is not a v8 wallet — delete it from its own tab`);
    }
    ks.remove(req.params.id);
    activityFor(req.user.id).record('wallets', `[v8] deleted ${wallet.role} wallet ${wallet.address}`, {
      role: wallet.role,
      address: wallet.address,
    });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/wallets/backup — V8's keys for an offline backup.
//
// Two locks, the same as every other key export here: an API key, and a CONFIGURED
// credential, so a keyless deployment fails closed rather than serving private keys to
// anyone who can reach the port. V8's own wallets only — isV8Role gates the set BEFORE
// any filter is applied, so this can never return another tab's keys.
router.post('/v8/wallets/backup', requireApiKey, requireAuthConfigured, (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.confirm !== true) throw new Error('backup requires { confirm: true }');
    if (body.role !== undefined && !v8roles.isV8Role(body.role)) {
      throw new Error(`role must be one of ${Object.values(v8roles.ROLES).join(', ')}`);
    }
    const ks = keystoreFor(req.user.id);
    // Every V8 wallet is the floor this never exports past.
    const all = ks.exportAll().filter((w) => v8roles.isV8Role(w.role));
    const wallets = selectBackupWallets(all, body);

    console.warn(`[pons-launcher] V8 KEYSTORE BACKUP EXPORTED — ${wallets.length} private keys`);
    activityFor(req.user.id).record('export', `[v8] downloaded a backup of ${wallets.length} v8 private key(s)`, {
      count: wallets.length,
    });
    res.json({
      exportedAt: new Date().toISOString(),
      chainId: config.chainId,
      count: wallets.length,
      // Says what the file is when it is opened months later by someone who no longer
      // remembers which button produced it.
      note:
        wallets.length === all.length
          ? `Full V8 export — every one of this tab's ${all.length} wallet(s).`
          : `Partial V8 export — ${wallets.length} of ${all.length} V8 wallet(s). The rest are NOT in this file.`,
      warning:
        'These private keys control real funds. Anyone holding this file can spend every wallet in it. Store it ' +
        'offline. There are no mnemonics: the keystore holds private keys only.',
      wallets,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/wallets/claim-seasoned — pull N finished-seasoning wallets out of THIS
// account's own V4 pool and re-role them as v8bundle. Refused mid-run for the same reason
// a delete is.
router.post('/v8/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    if (timedTransfer.isRunning(req.user.id)) {
      throw new Error('a v8 timed transfer is in progress — stop it before claiming wallets');
    }
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    if (take.length === 0) return res.json(jsonSafe({ claimed: [], available: pool.length, shortfall: want }));

    const out = seasoned.claim(
      ks,
      store,
      take.map((w) => w.id),
      { toRole: v8roles.ROLES.bundle, toTab: 'v8', now: Date.now() }
    );
    activityFor(req.user.id).record('wallets', `[v8] claimed ${out.claimed.length} seasoned wallet(s) into the bundle`, {
      count: out.claimed.length,
    });
    res.json(jsonSafe({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) }));
  } catch (err) {
    next(err);
  }
});

// ── the transfer ────────────────────────────────────────────────────────────

// POST /api/v8/transfer — the one-shot fan-out: main → each named bundle wallet, one
// Relay order each, paced inside the request. Every target is reported, including the
// ones that failed.
router.post('/v8/transfer', requireApiKey, async (req, res, next) => {
  try {
    if (timedTransfer.isRunning(req.user.id)) {
      throw new Error('a v8 timed transfer is in progress — stop it before sending by hand');
    }
    const ks = keystoreFor(req.user.id);
    const out = await relayTransfer.transfer((req.body || {}).targets, { keystore: ks });

    const sent = out.results.filter((r) => r.hash || r.simulated).length;
    const failed = out.results.filter((r) => r.error).length;
    activityFor(req.user.id).record(
      'fund',
      `[v8] sent ${sent}/${out.results.length} Relay transfer(s) from the main wallet` +
        (failed ? `, ${failed} failed` : ''),
      { from: out.from, totalDepositEth: out.totalDepositEth, results: out.results }
    );
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
});

// GET /api/v8/transfer/timed — the current job, or an idle shape. The panel polls this.
router.get('/v8/transfer/timed', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(timedTransfer.status(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/transfer/timed/start — hand the schedule to the server so the browser can
// close. One target per interval, over the same money path as the one-shot.
router.post('/v8/transfer/timed/start', requireApiKey, (req, res, next) => {
  try {
    const { targets, intervalMinutes } = req.body || {};
    res.json(jsonSafe(timedTransfer.start(req.user.id, targets, { intervalMinutes })));
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/transfer/timed/stop — stop after the wallet currently in flight. What has
// been sent stays sent, and is still in the status.
router.post('/v8/transfer/timed/stop', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(timedTransfer.stop(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v8/transfer/timed/resume — pick a stopped job back up where it left off. The
// wallets already paid are not paid again.
router.post('/v8/transfer/timed/resume', requireApiKey, (req, res, next) => {
  try {
    res.json(jsonSafe(timedTransfer.resume(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// ── the sweep ───────────────────────────────────────────────────────────────

// POST /api/v8/sweep — every bundle wallet's balance, minus its own gas and Relay's fee,
// back to main THROUGH RELAY. Wallets too small to be worth an order are skipped and
// named rather than sent directly — see the header of v8/sweep.js for why there is no
// direct path.
router.post('/v8/sweep', requireApiKey, async (req, res, next) => {
  try {
    if (timedTransfer.isRunning(req.user.id)) {
      throw new Error('a v8 timed transfer is in progress — stop it before sweeping');
    }
    const out = await sweep.run(req.user.id, req.body || {});
    res.json(jsonSafe(out));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._private = { jsonSafe, selectBackupWallets };
