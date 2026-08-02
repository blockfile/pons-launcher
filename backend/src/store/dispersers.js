'use strict';

// Which Disperse contracts a user funds through.
//
// This is a file rather than an env var because the alternative — the console
// rewriting backend/.env and restarting the process to pick it up — means the
// API can kill itself, and a restart landing mid-launch would drop a bundle
// that has already spent money. Read at call time, so a contract deployed from
// the console is live on the next funding run with nothing to restart.
//
// DISPERSER_ADDRESSES stays as the fallback: an existing deployment that has
// never opened the panel keeps working exactly as before. Once a user has
// recorded contracts of their own, those win outright — otherwise a stale env
// entry could not be removed from the UI.

const fs = require('fs');
const path = require('path');
const { getAddress } = require('ethers');
const config = require('../config');

const DEFAULT_ID = 'default';
const instances = new Map();

/** Where a user's disperser list lives. */
function pathFor(userId) {
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  return userId === DEFAULT_ID
    ? path.join(dir, 'dispersers.json')
    : path.join(dir, `dispersers.${userId}.json`);
}

function build(userId) {
  const file = pathFor(userId);

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed?.dispersers) ? parsed.dispersers : [];
    } catch (_err) {
      // Missing is the normal first-run state; unreadable is not worth failing
      // a funding run over when there is a working fallback.
      return [];
    }
  }

  function save(dispersers) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, dispersers }, null, 2));
  }

  /** Full records, newest last. Empty when the user has recorded none. */
  function records() {
    return load();
  }

  /** Addresses actually in force, falling back to the env var. */
  function addresses() {
    const own = load().map((d) => d.address);
    return own.length ? own : config.disperserAddresses;
  }

  /** True when addresses() is coming from DISPERSER_ADDRESSES, not this file. */
  function usingFallback() {
    return load().length === 0 && config.disperserAddresses.length > 0;
  }

  /**
   * Record newly deployed contracts. Rejects duplicates rather than letting a
   * double-click list the same contract twice — which would send it two of the
   * chunks in a split and defeat the point of having several.
   */
  function add(entries) {
    const current = load();
    const seen = new Set(current.map((d) => d.address.toLowerCase()));

    for (const entry of entries) {
      const address = getAddress(entry.address);
      if (seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      current.push({
        address,
        txHash: entry.txHash || null,
        deployer: entry.deployer ? getAddress(entry.deployer) : null,
        deployedAt: entry.deployedAt || new Date().toISOString(),
      });
    }

    save(current);
    return current;
  }

  function remove(address) {
    const target = String(address).toLowerCase();
    const current = load();
    const kept = current.filter((d) => d.address.toLowerCase() !== target);
    if (kept.length === current.length) throw new Error(`${address} is not in the list`);
    save(kept);
    return kept;
  }

  return { records, addresses, usingFallback, add, remove, _path: () => file };
}

function dispersersFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

module.exports = {
  dispersersFor,
  pathFor,
  _reset: () => instances.clear(),
};
