'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

function load() {
  if (!fs.existsSync(config.historyPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(config.historyPath, 'utf8'));
  } catch (_err) {
    return [];
  }
}

function persist(entries) {
  fs.mkdirSync(path.dirname(config.historyPath), { recursive: true });
  fs.writeFileSync(config.historyPath, JSON.stringify(entries, null, 2));
}

/** Record a launch. Raw signed transactions are never stored. */
function record({ plan, result }) {
  const entries = load();
  const entry = {
    at: new Date().toISOString(),
    dryRun: Boolean(plan.dryRun),
    token: plan.token,
    salt: plan.salt,
    params: plan.params,
    launchConfigId: plan.launchConfigId,
    dexId: plan.dexId,
    devBuyEth: plan.launch.devBuyEth,
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

module.exports = { record, list };
