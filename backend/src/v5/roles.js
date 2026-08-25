'use strict';

/**
 * Which wallets v5 — the letscash.fun (CashCat) bundler — owns.
 *
 * DELIBERATELY its own table, sharing nothing with wallets/variants.js,
 * v3/roles.js or v4/roles.js — the same isolation the other tabs keep, and for
 * the same reason: two tables that share no strings cannot resolve each other's
 * wallets. A v1/v2/v3/v4 request cannot reach a v5 wallet because their tables
 * have never heard of these names, and a v5 request cannot reach theirs. The
 * test beside this asserts exactly that over every role in the keystore.
 *
 * TWO ROLES:
 *
 *   v5dev     the launcher wallet. Signs the letscash `launch` (with its atomic
 *             `firstBuyIn` — the unfront-runnable, guaranteed-first entry), and
 *             so is where the first-buy supply lands before it is fanned out.
 *             A SINGLETON: one launch, one position, one payer.
 *   v5bundle  the wallets the first-buy supply is distributed to (token→token
 *             transfers are untaxed on letscash), and that make any optional
 *             extra on-curve buys. Plural.
 *
 * There is no snipe-tax exemption on letscash (the active CashCatHookV2 exempts
 * nobody), so — unlike pons v2 — the bundle wallets are NOT declared to the
 * launch. The edge is the atomic first buy, not a whitelist. See the letscash
 * contract-map notes.
 *
 * The two strings MUST also be added to ROLES in wallets/keystore.js, and v5dev
 * to SINGLETON_ROLES. That is the one edit v5 makes to that file and it is NOT
 * optional: keystore.add() resolves an unknown role to 'bundle', so without it
 * every v5 wallet would be created holding v1's bundle role and appear on the V1
 * tab, spendable by v1's launcher.
 */

const ROLES = {
  dev: 'v5dev',
  bundle: 'v5bundle',
};

/** Is this one of v5's two? Used to refuse v5 routes a wallet they don't own. */
function isV5Role(role) {
  return role === ROLES.dev || role === ROLES.bundle;
}

/** The launcher wallet, or null. Singleton — see SINGLETON_ROLES in keystore.js. */
function dev(ks) {
  return ks.walletWithRole(ROLES.dev);
}

/** Every bundle wallet. Empty is the state the tab starts in, not an error. */
function bundle(ks) {
  return ks.walletsWithRole(ROLES.bundle);
}

/** Both at once — what GET /v5/wallets reads. */
function all(ks) {
  return { dev: dev(ks), bundle: bundle(ks) };
}

module.exports = { ROLES, isV5Role, dev, bundle, all };
