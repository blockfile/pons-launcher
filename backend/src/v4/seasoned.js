'use strict';

const config = require('../config');
const roles = require('./roles');

const HOUR_MS = 3600_000;

// When each funded seed last received its single seasoning transfer. Mirrors the
// 'sent' derivation in routes/v4.js fundingFacts, kept dependency-light here so
// this helper stays pure over (ks, store, now) and needs no RPC.
function fundedAtByWallet(store) {
  const byWallet = new Map();
  for (const c of store.campaigns()) {
    for (const t of c.transfers || []) {
      if (t.status !== 'sent' || !t.sentAt) continue;
      byWallet.set(t.walletId, t.sentAt);
    }
  }
  return byWallet;
}

/**
 * The V4 seed wallets V1/V3 may claim: funded, and aged at least `minHours`.
 * Most-aged first. Pure over its inputs — pass `now` in ms.
 */
function available(ks, store, now, { minHours = config.seasonedMinHours } = {}) {
  const fundedAt = fundedAtByWallet(store);
  return ks
    .walletsWithRole(roles.ROLES.seed)
    .map((w) => {
      const at = fundedAt.get(w.id);
      if (!at) return null;
      const hoursSinceFunded = Math.floor((now - Date.parse(at)) / HOUR_MS);
      return hoursSinceFunded >= minHours
        ? { id: w.id, address: w.address, label: w.label, fundedAt: at, hoursSinceFunded }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.hoursSinceFunded - a.hoursSinceFunded);
}

module.exports = { available, HOUR_MS, _private: { fundedAtByWallet } };
