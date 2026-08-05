'use strict';

// A per-user record of everything that moved money or keys.
//
// Launches already have their own store (history.js) because a launch has a
// large, launch-shaped payload worth keeping in full. Everything else — funding
// runs, sweeps, contract deployments, wallets appearing and leaving, key
// exports — left no trace at all once the browser tab was closed. A funding run
// that half-failed was reconstructable only from the console log, which is not
// per user and rotates.
//
// Same isolation rule as the keystore and the history: a user sees their own
// and nobody else's. There is no admin view, because there is no admin — whoever
// can read another user's activity can see their addresses and amounts, and
// nothing in this app needs that.
//
// PRIVATE KEYS ARE NEVER WRITTEN HERE. An export is recorded as the fact that
// an export happened, with a count. Anything else would turn an audit trail
// into a second copy of the keystore, in plaintext.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_ID = 'default';
const instances = new Map();

// Old entries are dropped rather than kept forever. This is an operational log,
// not an accounting record, and an unbounded file gets read and rewritten on
// every single action.
const MAX_ENTRIES = 500;

/** Where a user's activity log lives. */
function pathFor(userId) {
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  return userId === DEFAULT_ID
    ? path.join(dir, 'activity.json')
    : path.join(dir, `activity.${userId}.json`);
}

function build(userId) {
  const file = pathFor(userId);

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      // Missing is the normal first-run state, and a corrupt log must never
      // fail the action it is only observing.
      return [];
    }
  }

  function persist(entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
  }

  /**
   * Append one entry.
   *
   * Never throws. This is called from inside routes that have already done the
   * real work — a transfer is on chain whether or not we managed to write a
   * line about it, and failing the response at that point would tell the
   * operator their funding failed when it did not.
   *
   * @param {string} kind fund | sweep | deploy | wallets | export
   * @param {string} summary one line, already human-readable
   * @param {object} [detail] anything structured worth keeping. No key material.
   */
  function record(kind, summary, detail = {}) {
    try {
      const entry = { at: new Date().toISOString(), kind, summary, ...detail };
      const entries = load();
      entries.unshift(entry);
      persist(entries);
      return entry;
    } catch (err) {
      console.error(`[pons-launcher] could not write activity log: ${err.message}`);
      return null;
    }
  }

  function list({ limit = 100, kind = null } = {}) {
    const all = load();
    const filtered = kind ? all.filter((e) => e.kind === kind) : all;
    return filtered.slice(0, limit);
  }

  return { record, list, _path: () => file };
}

function activityFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

/**
 * Condense a funding or sweep result into something worth reading back.
 * Keeps per-wallet outcomes — which is the whole point, since the failures are
 * what you come back for — but drops nothing else into the file.
 */
function summariseTransfers(results) {
  const rows = Array.isArray(results) ? results : results?.results || [];
  const failed = rows.filter((r) => r.error).length;
  const sent = rows.filter((r) => r.hash || r.eth?.hash || r.tokens?.hash).length;
  return { wallets: rows.length, sent, failed, results: rows };
}

module.exports = {
  activityFor,
  pathFor,
  summariseTransfers,
  MAX_ENTRIES,
  _reset: () => instances.clear(),
};
