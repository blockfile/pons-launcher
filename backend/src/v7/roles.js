'use strict';

/**
 * Which wallets V7 owns.
 *
 * V7 is the flap.sh RELAY CHAIN — the v6 strategy ported onto a flap BONDING CURVE
 * (non-graduated, native-quoted flap tokens). It is NOT a launcher: it works an
 * already-live flap token that is still on its curve. A "main" wallet makes one big
 * buy, then a server-side loop sells a slice, Relays the proceeds to the next bundle
 * wallet (so no direct seller→buyer link exists on-chain), and that wallet buys — one
 * wallet per cycle, paced apart, until the position is distributed.
 *
 * DELIBERATELY NOT AN ENTRY IN wallets/variants.js and NOT SHARED WITH v3/v5/v6. Every
 * tab owns its own role strings so a request on one tab can never resolve another tab's
 * wallets (the isolation rule). A v7 request cannot reach v6 wallets and vice-versa,
 * because neither table has ever heard of the other's strings.
 *
 * THREE ROLES, AND WHY THE MIDDLE ONE EXISTS (same as v3/v6):
 *
 *   v7dev     the treasury. Funds v7main through Relay and does nothing else —
 *             never buys, never sells, never holds supply.
 *   v7main    makes the one big buy, holds the position, makes every sell.
 *   v7bundle  the receivers. Each takes one Relay transfer and makes one buy.
 *
 * v7main is a role of its own rather than a job for the treasury because the whole point
 * of the strategy is that the big buyer is not the wallet that funded it. If v7dev bought,
 * sold and paid for everything, the funding edge the Relay hop exists to break would be
 * drawn straight back in by the first person to read the chain.
 *
 * The strings must ALSO be in ROLES in wallets/keystore.js — the one edit V7 makes
 * outside this directory. add() resolves an unknown role to 'bundle', so without it every
 * V7 wallet would be created holding v1's bundle role and appear on the V1 tab.
 */

const ROLES = {
  treasury: 'v7dev',
  main: 'v7main',
  bundle: 'v7bundle',
};

/** Is this one of V7's three? Used to refuse V7 routes a wallet they don't own. */
function isV7Role(role) {
  return role === ROLES.treasury || role === ROLES.main || role === ROLES.bundle;
}

/**
 * The treasury wallet, or throw. Throwing rather than returning null so a null can never
 * flow into a signer and fail further along without naming what was missing.
 */
function treasury(ks) {
  const found = ks.walletWithRole(ROLES.treasury);
  if (!found) throw new Error(`no ${ROLES.treasury} wallet — create the V7 treasury wallet first`);
  return found;
}

/** The main wallet — the one that buys big, holds the position and sells. */
function main(ks) {
  const found = ks.walletWithRole(ROLES.main);
  if (!found) throw new Error(`no ${ROLES.main} wallet — create the V7 main wallet first`);
  return found;
}

/**
 * Every bundle wallet. Empty is not an error here: it is the state the tab starts in, and
 * the run itself is what refuses to start without any. No cap — flap has no launch
 * exemption list to bound (v7 buys after the fact), so the only cost of more wallets is a
 * longer run.
 */
function bundle(ks) {
  return ks.walletsWithRole(ROLES.bundle);
}

/**
 * All three groups at once, tolerating absence — what GET /v7/wallets reads before
 * anything has been created, so it answers "none yet" rather than refusing to draw.
 */
function all(ks) {
  return {
    treasury: ks.walletWithRole(ROLES.treasury) || null,
    main: ks.walletWithRole(ROLES.main) || null,
    bundle: bundle(ks),
  };
}

module.exports = { ROLES, isV7Role, treasury, main, bundle, all };
