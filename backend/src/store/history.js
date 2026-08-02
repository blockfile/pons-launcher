'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_ID = 'default';
const instances = new Map();

/** Where a user's launch history lives. 'default' keeps the original path exactly. */
function pathFor(userId) {
  if (userId === DEFAULT_ID) return config.historyPath;
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  return path.join(dir, `launches.${userId}.json`);
}

function build(userId) {
  const file = pathFor(userId);

  function load() {
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_err) {
      return [];
    }
  }

  function persist(entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  }

  /** Record a launch. Raw signed transactions are never stored. */
  function record({ plan, result }) {
    const entries = load();
    const entry = {
      at: new Date().toISOString(),
      protocol: plan.protocol || 'v1',
      dryRun: Boolean(plan.dryRun),
      // v1 predicts the token before launching; v2 cannot, so the address only
      // exists on the result. Take whichever the protocol actually produced.
      token: plan.token ?? result.token ?? null,
      curve: result.curve ?? null,
      salt: plan.salt ?? null,
      params: plan.params,
      launchConfigId: plan.launchConfigId,
      dexId: plan.dexId ?? null,
      pairToken: plan.pairToken ?? null,
      // v2 has no dev buy at all — recording 0 would imply one was possible.
      devBuyEth: plan.launch.devBuyEth ?? null,
      creatorTaxBps: plan.creatorTaxBps ?? null,
      totalBuyEth: plan.totalBuyEth,
      launch: result.launch,
      buys: result.buys,
      sameBlock: result.sameBlock ?? 0,
    };
    entries.unshift(entry);
    persist(entries);
    return entry;
  }

  function list(limit = 50) {
    return load().slice(0, limit);
  }

  return { record, list };
}

function historyFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

module.exports = {
  historyFor,
  // Exposed so adoptLegacy (keystore.js) can move the history file to the
  // same path a user's history will be read from, without duplicating the
  // naming scheme in two places.
  pathFor,
  // Bound to the default user so every existing caller keeps working.
  record: (...a) => historyFor(DEFAULT_ID).record(...a),
  list: (...a) => historyFor(DEFAULT_ID).list(...a),
};
