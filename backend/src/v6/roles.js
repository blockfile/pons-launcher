'use strict';

/**
 * Which wallets V6 owns.
 *
 * V6 is the letscash (CashCat) RELAY CHAIN — the v3 strategy ported onto a
 * Uniswap-V4 launch. It is NOT a launcher: it works an already-live letscash
 * token. A "main" wallet makes one big buy, then a server-side loop sells a slice,
 * Relays the proceeds to the next bundle wallet (so no direct seller→buyer link
 * exists on-chain), and that wallet buys — one wallet per cycle, paced apart, until
 * the position is distributed.
 *
 * DELIBERATELY NOT AN ENTRY IN wallets/variants.js and NOT SHARED WITH v3/v5. Every
 * tab owns its own role strings so a request on one tab can never resolve another
 * tab's wallets (the isolation rule). A v6 request cannot reach v3/v5 wallets and
 * vice-versa, because neither table has ever heard of the other's strings.
 *
 * THREE ROLES, AND WHY THE MIDDLE ONE EXISTS (same as v3):
 *
 *   v6dev     the treasury. Funds v6main through Relay and does nothing else —
 *             never buys, never sells, never holds supply.
 *   v6main    makes the one big buy, holds the position, makes every sell.
 *   v6bundle  the receivers. Each takes one Relay transfer and makes one buy.
 *
 * v6main is a role of its own rather than a job for the treasury because the whole
 * point of the strategy is that the big buyer is not the wallet that funded it. If
 * v6dev bought, sold and paid for everything, the funding edge the Relay hop exists
 * to break would be drawn straight back in by the first person to read the chain.
 *
 * The strings must ALSO be in ROLES in wallets/keystore.js — the one edit V6 makes
 * outside this directory. add() resolves an unknown role to 'bundle', so without it
 * every V6 wallet would be created holding v1's bundle role and appear on the V1 tab.
 */

const ROLES = {
  treasury: 'v6dev',
  main: 'v6main',
  bundle: 'v6bundle',
};

/** Is this one of V6's three? Used to refuse V6 routes a wallet they don't own. */
function isV6Role(role) {
  return role === ROLES.treasury || role === ROLES.main || role === ROLES.bundle;
}

/**
 * The treasury wallet, or throw. Throwing rather than returning null so a null can
 * never flow into a signer and fail further along without naming what was missing.
 */
function treasury(ks) {
  const found = ks.walletWithRole(ROLES.treasury);
  if (!found) throw new Error(`no ${ROLES.treasury} wallet — create the V6 treasury wallet first`);
  return found;
}

/** The main wallet — the one that buys big, holds the position and sells. */
function main(ks) {
  const found = ks.walletWithRole(ROLES.main);
  if (!found) throw new Error(`no ${ROLES.main} wallet — create the V6 main wallet first`);
  return found;
}

/**
 * Every bundle wallet. Empty is not an error here: it is the state the tab starts
 * in, and the run itself is what refuses to start without any. No cap — letscash
 * has no launch exemption list to bound (v6 buys after the fact), so the only cost
 * of more wallets is a longer run.
 */
function bundle(ks) {
  return ks.walletsWithRole(ROLES.bundle);
}

/**
 * All three groups at once, tolerating absence — what GET /v6/wallets reads before
 * anything has been created, so it answers "none yet" rather than refusing to draw.
 */
function all(ks) {
  return {
    treasury: ks.walletWithRole(ROLES.treasury) || null,
    main: ks.walletWithRole(ROLES.main) || null,
    bundle: bundle(ks),
  };
}

module.exports = { ROLES, isV6Role, treasury, main, bundle, all };
