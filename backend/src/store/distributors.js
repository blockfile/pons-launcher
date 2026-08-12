'use strict';

// Which BundleDistributor contract a user triggers their buy through.
//
// One per user, not a list. The dispersers are plural because splitting a
// funding run across several contracts limits what one failure costs; this one
// is a single atomic buy, so a second contract would only ever sit idle.
//
// Same file-not-env reasoning as store/dispersers.js: the console deploys it,
// and it has to be live on the next trigger without restarting a process that
// might be mid-launch.

const fs = require('fs');
const path = require('path');
const { getAddress } = require('ethers');
const config = require('../config');

const DEFAULT_ID = 'default';
const instances = new Map();

function pathFor(userId) {
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  return userId === DEFAULT_ID
    ? path.join(dir, 'distributor.json')
    : path.join(dir, `distributor.${userId}.json`);
}

function build(userId) {
  const file = pathFor(userId);

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed.address === 'string' ? parsed : null;
    } catch (_err) {
      return null;
    }
  }

  function save(record) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...record }, null, 2));
  }

  return {
    /** The recorded distributor, or null on a fresh account. */
    get: () => load(),

    /** Record a freshly deployed contract, replacing any previous one. */
    set(address, extra = {}) {
      const rec = { address: getAddress(address), deployedAt: new Date().toISOString(), ...extra };
      save(rec);
      return rec;
    },

    /** Forget it. The contract stays on chain; this only stops using it. */
    clear() {
      try {
        fs.unlinkSync(file);
      } catch (_err) {
        /* already gone is the desired state */
      }
    },

    _path: () => file,
  };
}

function distributorFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

module.exports = { distributorFor, pathFor, _reset: () => instances.clear() };
