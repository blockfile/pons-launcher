'use strict';

/**
 * Which wallets V3 owns.
 *
 * DELIBERATELY NOT AN ENTRY IN wallets/variants.js. That file is the table v1
 * and v2 share, and every money path on both launchers resolves through it. A
 * third row in it would put V3 on the same lookup as the launcher that moves
 * real money today, and the first typo or fallback in that lookup would be a
 * V3 request spending v1's wallets.
 *
 * Two tables that share nothing cannot confuse each other. A v1 request cannot
 * resolve a V3 wallet because variants.js has never heard of these strings, and
 * a V3 request cannot resolve v1's because this file has never heard of theirs.
 * The test beside this one asserts exactly that, over every role in the
 * keystore.
 *
 * THREE ROLES, AND WHY THE MIDDLE ONE EXISTS:
 *
 *   v3dev     the treasury. Funds v3main through Relay and does nothing else —
 *             never buys, never sells, never holds supply.
 *   v3main    makes the one big buy, holds the position, makes every sell.
 *   v3bundle  the receivers. Each takes one Relay transfer and makes one buy.
 *
 * v3main is a role of its own rather than a job for the treasury because the
 * whole point of this strategy is that the big buyer is not the wallet that
 * funded it. If v3dev bought, sold and paid for everything, the funding edge
 * the Relay hop exists to break would be drawn straight back in by the first
 * person to look at the chain.
 *
 * The strings themselves must also be in ROLES in wallets/keystore.js. That is
 * the one edit V3 makes outside this directory, and it is not optional: add()
 * resolves an unknown role to 'bundle', so without it every V3 wallet would be
 * created holding v1's bundle role and appear on the V1 tab.
 */

const ROLES = {
  treasury: 'v3dev',
  main: 'v3main',
  bundle: 'v3bundle',
};

/** Is this one of V3's three? Used to refuse V3 routes a wallet they don't own. */
function isV3Role(role) {
  return role === ROLES.treasury || role === ROLES.main || role === ROLES.bundle;
}

/**
 * The treasury wallet, or throw.
 *
 * Throwing rather than returning null is the same choice variants.js makes for
 * the same reason: every caller of this is about to spend, and a null that
 * flowed into a signer would fail somewhere further along with a message that
 * did not name what was actually missing.
 */
function treasury(ks) {
  const found = ks.walletWithRole(ROLES.treasury);
  if (!found) {
    throw new Error(`no ${ROLES.treasury} wallet — create the V3 treasury wallet first`);
  }
  return found;
}

/** The main wallet — the one that buys big, holds the position and sells. */
function main(ks) {
  const found = ks.walletWithRole(ROLES.main);
  if (!found) {
    throw new Error(`no ${ROLES.main} wallet — create the V3 main wallet first`);
  }
  return found;
}

/**
 * Every bundle wallet. Empty is not an error here: it is the state the tab
 * starts in, and the run itself is what refuses to start without any.
 *
 * There is no cap. The 31 that binds a launch is the length of the factory's
 * snipe-tax exemption list, and V3 never launches — its wallets buy after the
 * fact and are not on any list. The only cost of more wallets is a longer run.
 */
function bundle(ks) {
  return ks.walletsWithRole(ROLES.bundle);
}

/**
 * All three groups at once, tolerating absence.
 *
 * This is what GET /v3/wallets reads, and it is called before anything has been
 * created — so unlike the accessors above it answers "none yet" rather than
 * refusing to draw the page.
 */
function all(ks) {
  return {
    treasury: ks.walletWithRole(ROLES.treasury) || null,
    main: ks.walletWithRole(ROLES.main) || null,
    bundle: bundle(ks),
  };
}

module.exports = { ROLES, isV3Role, treasury, main, bundle, all };
