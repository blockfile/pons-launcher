'use strict';

/**
 * Which wallets V4 owns.
 *
 * DELIBERATELY NOT AN ENTRY IN wallets/variants.js, and deliberately not an
 * entry in v3/roles.js either. Those are other strategies' tables. Two tables
 * that share nothing cannot confuse each other: a v1 request cannot resolve a
 * V4 wallet because variants.js has never heard of these strings, and a V4
 * request cannot resolve v1's, v2's or V3's because this file has never heard
 * of theirs. The test beside this asserts exactly that, over every role in the
 * keystore.
 *
 * TWO ROLES, NOT THREE:
 *
 *   v4master  the funding wallets. Pay for a campaign and do nothing else —
 *             never buy, never sell, never hold supply.
 *   v4seed    the fresh wallets. Receive exactly one transfer, then sit.
 *
 * There is no equivalent of v3main because nothing here trades.
 *
 * v4master IS PLURAL, and that is the whole of how parallel campaigns work.
 * Every other treasury role in the keystore is a singleton — one dev, one
 * v3dev — because those strategies have one position and one payer. V4 runs
 * several campaigns at once and each needs a payer with no connection to the
 * others, so `v4master` is deliberately NOT in SINGLETON_ROLES.
 *
 * The strings must also be in ROLES in wallets/keystore.js. That is the one
 * edit V4 makes to that file, and it is not optional: add() resolves an unknown
 * role to 'bundle', so without it every V4 wallet would be created holding v1's
 * bundle role and appear on the V1 tab, spendable by v1's launcher.
 */

const ROLES = {
  master: 'v4master',
  seed: 'v4seed',
};

/** Is this one of V4's two? Used to refuse V4 routes a wallet they don't own. */
function isV4Role(role) {
  return role === ROLES.master || role === ROLES.seed;
}

/**
 * Every funding wallet. Empty is not an error: it is the state the tab starts
 * in, and a campaign is what refuses to start without one.
 */
function masters(ks) {
  return ks.walletsWithRole(ROLES.master);
}

/** Every seed wallet, claimed or not. The store decides which are spoken for. */
function seeds(ks) {
  return ks.walletsWithRole(ROLES.seed);
}

/** Both groups at once — what GET /v4/wallets reads. */
function all(ks) {
  return { masters: masters(ks), seeds: seeds(ks) };
}

module.exports = { ROLES, isV4Role, masters, seeds, all };
