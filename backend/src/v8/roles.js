'use strict';

/**
 * Which wallets V8 owns.
 *
 * V8 — "relay transfer" — is the smallest tab in the console and the only one with no
 * launchpad in it at all. There is no launch, no token, no curve, no buy and no sell.
 * It does exactly one thing: move ETH from ONE main wallet out to many bundle wallets
 * THROUGH RELAY, so that no on-chain transaction ever connects the payer to the
 * recipients — and, when the operator is done, sweep the ETH back the same way.
 *
 * DELIBERATELY ITS OWN TABLE, sharing nothing with wallets/variants.js or with
 * v3/v4/v5/v6/v7's role modules. That is the isolation rule every tab here keeps, and
 * the reason is mechanical rather than stylistic: two tables that share no strings
 * cannot resolve each other's wallets. A v1..v7 request cannot reach a V8 wallet because
 * their tables have never heard of these names, and a V8 request cannot reach theirs.
 * The test beside this asserts exactly that, over every role in the keystore.
 *
 * TWO ROLES:
 *
 *   v8main    the source. The one wallet that holds the ETH and pays for every Relay
 *             order, and the wallet a sweep returns everything to. A SINGLETON: the
 *             tab is "one wallet fans out to many", so a second main would be ETH
 *             sitting somewhere the tab never looks. It joins SINGLETON_ROLES in
 *             wallets/keystore.js.
 *   v8bundle  the receivers. Each one takes a Relay transfer and holds the ETH. Plural,
 *             and see the note on bundle() below: there is NO CAP on how many.
 *
 * The two strings MUST also be in ROLES in wallets/keystore.js (and v8main in
 * SINGLETON_ROLES). That is the one edit V8 makes outside this directory and it is not
 * optional: keystore.add() resolves an unknown role to 'bundle', so without it every V8
 * wallet would be created holding v1's bundle role, appear on the V1 tab, and be
 * spendable by v1's launcher.
 */

const ROLES = {
  main: 'v8main',
  bundle: 'v8bundle',
};

/** Is this one of V8's two? Used to refuse V8 routes a wallet they don't own. */
function isV8Role(role) {
  return role === ROLES.main || role === ROLES.bundle;
}

/**
 * The main wallet — the source of every transfer and the destination of every sweep.
 *
 * Throws rather than returning null, for the same reason variants.js does: every caller
 * of this is about to spend, and a null that flowed into a signer would fail somewhere
 * further along with a message that did not name what was actually missing.
 */
function main(ks) {
  const found = ks.walletWithRole(ROLES.main);
  if (!found) throw new Error(`no ${ROLES.main} wallet — create the V8 main wallet first`);
  return found;
}

/**
 * Every bundle wallet. Empty is not an error: it is the state the tab starts in, and the
 * transfer itself is what refuses to run without any.
 *
 * THERE IS NO CAP HERE, AND v8bundle IS DELIBERATELY NOT IN BUNDLE_ROLES IN
 * routes/wallets.js. It is tempting to add one — every other bundle role on this server
 * has 31 written next to it — but that 31 is a LAUNCHPAD constraint, not a policy: the
 * pons factory takes a 32-slot snipe-tax exemption list and the forwarder appends its own
 * buy recipient to it, so a launch can exempt at most 31 of our wallets, and a 32nd is the
 * ExemptionListTooLong revert that once stranded a bundle's ETH.
 *
 * V8 never launches anything. There is no exemption list for its wallets to overflow, so
 * there is nothing for a cap to protect — it would only stop an operator from fanning ETH
 * out to as many wallets as they wanted, which is the entire tab. The only cost of more
 * wallets is a longer, more paced run. DO NOT add v8bundle to BUNDLE_ROLES.
 */
function bundle(ks) {
  return ks.walletsWithRole(ROLES.bundle);
}

/**
 * Both groups at once, tolerating absence.
 *
 * This is what GET /api/v8/wallets reads, and it is called before anything has been
 * created — so unlike main() above it answers "none yet" rather than refusing to draw
 * the page.
 */
function all(ks) {
  return {
    main: ks.walletWithRole(ROLES.main) || null,
    bundle: bundle(ks),
  };
}

module.exports = { ROLES, isV8Role, main, bundle, all };
