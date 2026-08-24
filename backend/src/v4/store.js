'use strict';

/**
 * Where a seasoning campaign lives between restarts.
 *
 * ONE FILE PER USER, holding an ARRAY of campaigns — not one. Campaigns run in
 * parallel, one per funding wallet, so a store shaped around a single job would
 * have made the feature impossible.
 *
 * Written temp-then-rename, for the same reason keystore.js is: a three-week
 * campaign is written to several thousand times, and a process killed during
 * any one of those writes must not be able to leave a half-serialised file
 * where the plan used to be. Losing the plan means losing the record of which
 * of 400 wallets have been funded.
 *
 * The path mirrors store/history.js so a deployment has one data directory and
 * one backup story, not two.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_ID = 'default';
const instances = new Map();

/** Where a user's campaigns live, beside their launches. */
function pathFor(userId) {
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  const name = userId === DEFAULT_ID ? 'seasoning.json' : `seasoning.${userId}.json`;
  return path.join(dir, name);
}

function build(userId) {
  const file = pathFor(userId);
  let cache = null;

  function load() {
    if (cache) return cache;
    if (!fs.existsSync(file)) {
      cache = { version: 1, campaigns: [], backups: [], graduated: [], withdrawn: [] };
      return cache;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        version: parsed.version || 1,
        campaigns: parsed.campaigns || [],
        backups: parsed.backups || [],
        graduated: parsed.graduated || [],
        withdrawn: parsed.withdrawn || [],
      };
    } catch (_err) {
      // A corrupt file must not take the server down — but it must not be
      // silently overwritten either, so it is moved aside with a timestamp.
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      cache = { version: 1, campaigns: [], backups: [], graduated: [], withdrawn: [] };
    }
    return cache;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ATOMIC, and not merely tidy. A campaign is patched or has a transfer
    // updated many times over the several weeks it runs, and each call
    // rewrites the WHOLE file. A process killed partway through a plain
    // writeFileSync leaves a truncated file where the plan used to be —
    // losing the record of which of 400 wallets have already been funded.
    // Writing to a sibling and renaming makes the swap a single filesystem
    // operation: the path either holds the old complete file or the new
    // complete file, never half of either.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function campaigns() {
    return load().campaigns.slice();
  }

  function get(id) {
    return load().campaigns.find((c) => c.id === id) || null;
  }

  function create(campaign) {
    const store = load();
    if (store.campaigns.some((c) => c.id === campaign.id)) {
      throw new Error(`campaign ${campaign.id} already exists`);
    }
    store.campaigns.unshift(campaign);
    persist();
    return campaign;
  }

  function update(id, patch) {
    const store = load();
    const c = store.campaigns.find((x) => x.id === id);
    if (!c) throw new Error(`no campaign ${id}`);
    Object.assign(c, patch);
    persist();
    return c;
  }

  function updateTransfer(id, transferId, patch) {
    const store = load();
    const c = store.campaigns.find((x) => x.id === id);
    if (!c) throw new Error(`no campaign ${id}`);
    const t = c.transfers.find((x) => x.id === transferId);
    if (!t) throw new Error(`no transfer ${transferId} in campaign ${id}`);
    Object.assign(t, patch);
    persist();
    return t;
  }

  /** Campaigns the runner should be holding a timer for. */
  function running() {
    return load().campaigns.filter((c) => c.status === 'running');
  }

  /**
   * Every seed wallet spoken for by any SEASONING campaign, in any state.
   *
   * Not just the running ones. A wallet funded by a completed campaign has a
   * funding edge already; funding it again from a second source would give it
   * two, which is worse than one.
   *
   * SPLIT CAMPAIGNS ARE EXCLUDED, and the asymmetry is the point. The claim
   * rule protects the property that makes a seed wallet worth seasoning: one
   * transfer, from one place, ever. A split pays FUNDING wallets, which are
   * plumbing — an operator will legitimately top the same funder up again next
   * month, and a claim would block that forever in exchange for protecting
   * nothing. `kind` is absent on every campaign written before splits existed,
   * so it reads as 'season', which is what those campaigns were.
   */
  function claimedSeedIds() {
    const claimed = new Set();
    for (const c of load().campaigns) {
      if ((c.kind || 'season') !== 'season') continue;
      for (const t of c.transfers) claimed.add(t.walletId);
    }
    return claimed;
  }

  /** Note that these wallets' keys have been exported. */
  function recordBackup(walletIds) {
    const store = load();
    store.backups.push({ at: new Date().toISOString(), walletIds: [...walletIds] });
    persist();
  }

  /**
   * Which of these wallets have NO backup on record.
   *
   * Returns the gap rather than a boolean so the refusal can name the wallets
   * the operator still has to protect.
   */
  function backedUp(walletIds) {
    const seen = new Set();
    for (const b of load().backups) for (const id of b.walletIds) seen.add(id);
    return walletIds.filter((id) => !seen.has(id));
  }

  /** Record wallets handed off to another tab, and read them back newest-first. */
  function recordGraduated(entries) {
    const store = load();
    store.graduated.unshift(...entries.map((e) => ({ ...e })));
    persist();
  }

  function graduated() {
    return load().graduated.slice();
  }

  /**
   * Withdraw seed wallets from the seasoning pool WITHOUT deleting them — an
   * operator who has exported a wallet's key to use it elsewhere marks it here so
   * a V1/V3 claim can never grab it out from under them. Unlike a claim it does
   * NOT re-role or archive: the wallet stays in the keystore and its backups, it
   * is only skipped by seasoned.available(). Reversible with restoreWithdrawn.
   * Idempotent: an id already withdrawn is not added twice.
   */
  function withdraw(entries) {
    const store = load();
    const have = new Set(store.withdrawn.map((e) => e.id));
    const fresh = entries.filter((e) => !have.has(e.id)).map((e) => ({ ...e }));
    if (fresh.length === 0) return;
    store.withdrawn.unshift(...fresh);
    persist();
  }

  /** Return the given ids to the seasoning pool. */
  function restoreWithdrawn(ids) {
    const store = load();
    const drop = new Set(ids);
    const before = store.withdrawn.length;
    store.withdrawn = store.withdrawn.filter((e) => !drop.has(e.id));
    if (store.withdrawn.length !== before) persist();
  }

  /** The set of seed-wallet ids currently withdrawn from the pool. */
  function withdrawnSeedIds() {
    return new Set(load().withdrawn.map((e) => e.id));
  }

  /** The withdrawn records, newest-first. */
  function withdrawn() {
    return load().withdrawn.slice();
  }

  function _reset() {
    cache = null;
  }

  return {
    campaigns,
    get,
    create,
    update,
    updateTransfer,
    running,
    claimedSeedIds,
    recordBackup,
    backedUp,
    recordGraduated,
    graduated,
    withdraw,
    restoreWithdrawn,
    withdrawnSeedIds,
    withdrawn,
    _reset,
  };
}

function storeFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

/** Test seam — drops every memoised store. */
function _reset() {
  instances.clear();
}

module.exports = { storeFor, pathFor, _reset };
